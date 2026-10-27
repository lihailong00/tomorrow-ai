"""Windows host lifecycle for unmodified Toolathlon task state/evaluators.

Only the Pi host loop calls a model. This module never sends model requests.
It uses the official artifact guard to withhold and restore grading artifacts.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import uuid


REPO_ROOT = Path(__file__).resolve().parents[1]
OFFICIAL_ROOT = REPO_ROOT / '.tools' / 'toolathlon'


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')


def ensure_separate_paths(public_root: Path, private_root: Path) -> None:
    # Resolve both actual roots before creating or removing any file.
    if private_root == public_root or private_root.is_relative_to(public_root):
        raise ValueError('PrivateRoot must be outside the agent-visible OutputRoot.')
    if public_root.is_relative_to(private_root):
        raise ValueError('OutputRoot must also be outside PrivateRoot.')


def load_guard():
    path = OFFICIAL_ROOT / 'scripts' / 'containerized' / 'task_artifact_guard.py'
    spec = importlib.util.spec_from_file_location('toolathlon_official_artifact_guard', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Runtime:
    def __init__(self, context: str, container: str):
        self.context = context
        self.container = container

    def run(self, *args: str, check: bool = True, timeout: int = 300):
        result = subprocess.run(
            ['docker', '--context', self.context, *map(str, args)],
            text=True, encoding='utf-8', errors='replace', capture_output=True,
            timeout=timeout, check=False,
        )
        if check and result.returncode:
            raise RuntimeError(f'Docker command failed ({result.returncode}): {(result.stderr or result.stdout)[-2000:]}')
        return result

    def guard_runner(self, command, **kwargs):
        # The official guard supplies argv beginning with "docker". Preserve
        # every other argument and only select this task's Docker context.
        kwargs.update(encoding='utf-8', errors='replace')
        return subprocess.run(
            [command[0], '--context', self.context, *command[1:]], **kwargs,
        )

    def python(self, code: str, *args: str, **kwargs):
        return self.run('exec', self.container, 'uv', 'run', '--no-sync',
                        'python', '-c', code, *args, **kwargs)

    def copy_in(self, source: Path, target: str):
        return self.run('cp', str(source), f'{self.container}:{target}')

    def copy_out(self, source: str, target: Path):
        return self.run('cp', f'{self.container}:{source}', str(target))


def public_bundle(trusted: dict, output: Path) -> dict:
    allowed = (
        'schema_version', 'task_dir', 'task_str', 'launch_time',
        'single_turn_mode', 'cn_mode', 'system_prompts',
        'needed_mcp_servers', 'needed_local_tools', 'stop',
        'max_turns', 'max_steps_under_single_turn_mode', 'container_paths',
    )
    result = {key: trusted[key] for key in allowed if key in trusted}
    result['host_paths'] = {
        'task_root': str(output),
        'agent_workspace': str(output / 'workspace'),
        'log_file': str(output / 'traj_log.json'),
    }
    return result


def prepare(args, runtime: Runtime, public: Path, private: Path) -> dict:
    private.mkdir(parents=True, exist_ok=True)
    public.mkdir(parents=True, exist_ok=True)
    state_path = private / 'lifecycle.json'
    if state_path.exists():
        raise RuntimeError('This task lifecycle already exists; use a fresh run root.')

    # No real credential exists in either generated config. The provider
    # clients are constructed during official preprocess but never invoked.
    global_config = private / 'global_configs.py'
    global_config.write_text(
        'from addict import Dict\n'
        'global_configs = Dict(aihubmix_key="benchmark-disabled", '
        'podman_or_docker="docker", notion_preprocess_with_playwright=False)\n',
        encoding='utf-8',
    )
    token_config = private / 'token_key_session.py'
    token_config.write_text(
        'from addict import Dict\nall_token_key_session = Dict(timezone="Asia/Shanghai")\n',
        encoding='utf-8',
    )
    runtime.copy_in(global_config, '/workspace/configs/global_configs.py')
    runtime.copy_in(token_config, '/workspace/configs/token_key_session.py')

    config = json.loads((OFFICIAL_ROOT / 'scripts' / 'formal_run_v0.json').read_text(encoding='utf-8'))
    config['global_task_config'].update(
        dump_path='/workspace/dumps', direct_to_dumps=True,
        max_steps_under_single_turn_mode=args.max_steps,
    )
    config['agent']['model'] = {'short_name': 'deepseek-flash', 'provider': 'unified'}
    config_path = private / 'eval_config.json'
    write_json(config_path, config)
    runtime.copy_in(config_path, '/workspace/benchmark_eval_config.json')

    bundle_inside = f'/run/toolathlon-bundle-{uuid.uuid4().hex}.json'
    command = [
        'exec', '-e', 'TOOLATHLON_OPENAI_BASE_URL=http://127.0.0.1:9/v1',
        '-e', 'TOOLATHLON_OPENAI_API_KEY=benchmark-disabled',
        runtime.container, 'uv', 'run', '--no-sync', 'python', '-m',
        'scripts.decoupled.container_preprocess',
        '--eval_config', '/workspace/benchmark_eval_config.json',
        '--task_dir', f'finalpool/{args.task}', '--model_short_name', 'deepseek-flash',
        '--provider', 'unified', '--max_steps_under_single_turn_mode', str(args.max_steps),
        '--bundle_file', bundle_inside, '--host_output_folder', str(public),
    ]
    prep = runtime.run(*command, check=False, timeout=600)
    (public / 'preprocess.log').write_text(prep.stdout + prep.stderr, encoding='utf-8')
    if prep.returncode:
        raise RuntimeError(f'Official preprocess failed; inspect {public / "preprocess.log"}')
    trusted_path = private / 'trusted_bundle.json'
    runtime.copy_out(bundle_inside, trusted_path)
    trusted = json.loads(trusted_path.read_text(encoding='utf-8'))
    if trusted.get('schema_version') != 2 or trusted.get('task_dir') != f'finalpool/{args.task}':
        raise RuntimeError('Official preprocess returned an unexpected task bundle.')
    if trusted.get('container_paths', {}).get('agent_workspace') != '/workspace/dumps/workspace':
        raise RuntimeError('Official workspace is outside the expected task bind mount.')
    if not trusted.get('resolved_task_config'):
        raise RuntimeError('Trusted resolved task configuration is required.')
    agent_path = private / 'agent_bundle.json'
    write_json(agent_path, public_bundle(trusted, public))

    guard = load_guard()
    client = guard.ContainerRuntimeClient('docker', runtime.container,
                                          command_runner=runtime.guard_runner)
    stash = guard.stash_artifacts(
        'docker', runtime.container, f'/workspace/tasks/finalpool/{args.task}',
        stash_root=private / 'artifact-stash', client=client,
    )
    state = {
        'container': runtime.container, 'task': args.task,
        'docker_context': args.docker_context,
        'public_output': str(public), 'private_output': str(private),
        'trusted_bundle': str(trusted_path), 'agent_bundle': str(agent_path),
        'artifact_stash': str(stash), 'gateway_pid': None,
        'gateway_port': args.gateway_port,
        'gateway_url': f'http://127.0.0.1:{args.gateway_port}/sse',
        'source_commit': (OFFICIAL_ROOT / 'SOURCE_COMMIT.txt').read_text().strip(),
        'phase': 'artifacts_withheld',
    }
    write_json(state_path, state)

    # The official gateway resolves its complete bundle at startup. Remove
    # the source immediately after health proves it has been loaded.
    spawn_code = (
        'import subprocess,sys; '
        'log=open("/workspace/dumps/gateway.log","w"); '
        'p=subprocess.Popen(["uv","run","--no-sync","python","-m",'
        '"scripts.decoupled.container_tool_gateway","--bundle_file",sys.argv[1],'
        '"--host","0.0.0.0","--port",sys.argv[2]],'
        'stdout=log,stderr=subprocess.STDOUT,start_new_session=True); print(p.pid)'
    )
    spawned = runtime.python(spawn_code, bundle_inside, str(args.gateway_port))
    state['gateway_pid'] = int(spawned.stdout.strip())
    write_json(state_path, state)
    health_url = f'http://127.0.0.1:{args.gateway_port}/health'
    deadline = time.monotonic() + 240
    health = None
    while time.monotonic() < deadline:
        try:
            with urlopen(health_url, timeout=3) as response:
                health = json.load(response)
            if health.get('ok'):
                break
        except (URLError, TimeoutError, json.JSONDecodeError, ConnectionError):
            pass
        time.sleep(1)
    runtime.run('exec', runtime.container, 'rm', '-f', '--', bundle_inside)
    if not health or not health.get('ok'):
        raise RuntimeError(f'Official gateway did not become healthy; inspect {public / "gateway.log"}')
    needed = set(trusted['needed_mcp_servers'])
    connected = set(health.get('connected_servers') or [])
    if not needed.issubset(connected):
        raise RuntimeError(f'Missing MCP servers: {sorted(needed - connected)}')
    state.update(phase='ready', gateway_health=health,
                 candidate_tool_count=health['tool_count'])
    write_json(state_path, state)
    write_json(public / 'environment.json', {
        key: state[key] for key in (
            'container', 'task', 'gateway_url', 'source_commit',
            'candidate_tool_count', 'gateway_health', 'phase',
        )
    })
    return state


def evaluate(args, runtime: Runtime, public: Path, private: Path) -> dict:
    state_path = private / 'lifecycle.json'
    state = json.loads(state_path.read_text(encoding='utf-8'))
    if state['container'] != runtime.container or state['task'] != args.task:
        raise RuntimeError('Lifecycle identity mismatch.')
    gateway_pid = state.get('gateway_pid')
    if gateway_pid:
        # PID originated from the trusted host lifecycle, never from the agent.
        runtime.python(
            'import os,signal,sys; '
            'pid=int(sys.argv[1]); '
            '\ntry: os.killpg(pid,signal.SIGTERM)'
            '\nexcept ProcessLookupError: pass',
            str(gateway_pid),
        )
        time.sleep(1)
    guard = load_guard()
    client = guard.ContainerRuntimeClient('docker', runtime.container,
                                          command_runner=runtime.guard_runner)
    guard.restore_artifacts(
        'docker', runtime.container, f'/workspace/tasks/finalpool/{args.task}',
        state['artifact_stash'], client=client,
    )
    trusted_inside = f'/run/toolathlon-eval-{uuid.uuid4().hex}.json'
    runtime.copy_in(Path(state['trusted_bundle']), trusted_inside)
    result = runtime.run(
        'exec', runtime.container, 'uv', 'run', '--no-sync', 'python', '-m',
        'scripts.decoupled.container_eval', '--bundle_file', trusted_inside,
        '--require_resolved_task_config', '--boolean_evaluation_status',
        '--consume_bundle', '--agent_exit_code', str(args.agent_exit_code),
        check=False, timeout=600,
    )
    (public / 'eval.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    state.update(phase='evaluated', official_eval_exit_code=result.returncode,
                 agent_exit_code=args.agent_exit_code)
    if (public / 'eval_res.json').exists():
        state['evaluation'] = json.loads((public / 'eval_res.json').read_text(encoding='utf-8'))
    else:
        state.update(phase='evaluation_error')
    write_json(state_path, state)
    if state['phase'] == 'evaluation_error':
        raise RuntimeError(f'Official evaluation did not produce a result; inspect {public / "eval.log"}')
    # A failed task is a valid evaluation result, not a lifecycle exception.
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'evaluate'])
    parser.add_argument('--container', required=True)
    parser.add_argument('--task', required=True)
    parser.add_argument('--output-root', required=True)
    parser.add_argument('--private-root', required=True)
    parser.add_argument('--gateway-port', type=int, default=18761)
    parser.add_argument('--max-steps', type=int, default=80)
    parser.add_argument('--agent-exit-code', type=int, default=0)
    parser.add_argument('--docker-context', default='desktop-linux')
    args = parser.parse_args()
    if not re.fullmatch(r'tomorrow-toolathlon-[a-z0-9-]+', args.container):
        raise ValueError('Only tomorrow-toolathlon-* test containers are allowed.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]+', args.task):
        raise ValueError('Unsafe task name.')
    if not 1024 <= args.gateway_port <= 65535 or not 1 <= args.max_steps <= 2000:
        raise ValueError('Invalid gateway port or step limit.')
    if args.agent_exit_code < 0:
        raise ValueError('Agent exit code must be non-negative.')
    output_root = Path(args.output_root).resolve()
    private_root = Path(args.private_root).resolve()
    ensure_separate_paths(output_root, private_root)
    public, private = output_root / args.task, private_root / args.task
    runtime = Runtime(args.docker_context, args.container)
    state = (prepare if args.action == 'prepare' else evaluate)(args, runtime, public, private)
    # Windows PowerShell can launch Python with a GBK stdout code page.
    # The lifecycle JSON may include Unicode grader output (for example ✓).
    # ASCII JSON escapes preserve all data and decode consistently through
    # both GBK and UTF-8 consumers, without changing the evaluator verdict.
    print(json.dumps(state, ensure_ascii=True, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f'Toolathlon lifecycle error: {error}', file=sys.stderr)
        raise SystemExit(1)

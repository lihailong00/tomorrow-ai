/** Opt-in local acceptance: compiled Rust API + real DSH child + controlled streaming model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const a = s.address(); assert.ok(a && typeof a === 'object'); await new Promise<void>(r => s.close(() => r())); return a.port; }
async function stop(child?: ChildProcess) { if (!child || child.exitCode !== null) return;
  const ended = once(child, 'exit'); child.kill(); await ended; }
async function ready(url: string, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, 'acceptance process exited during startup');
    try { const r = await fetch(url); if (r.ok) return; } catch { /* Starting. */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('acceptance service did not become ready');
}
const sse = (res: ServerResponse, delta: unknown, reason: string | null = null) => res.write(`data: ${JSON.stringify({
  id: 'acceptance', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: reason }],
})}\n\n`);

test('Rust -> DSH -> durable tool -> live SSE, replay and owner isolation', {
  skip: process.env.TADA_DSH_RUST_E2E !== '1', timeout: 120000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'tada-dsh-e2e-')); const port = await freePort(), agentPort = await freePort();
  const base = `http://127.0.0.1:${port}`; let calls = 0, upstreamFinished = false, live = false;
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const value = JSON.parse(raw); calls++;
    assert.ok(value.tools.some((tool: { function: { name: string } }) => tool.function.name === 'save_memory'));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) {
      sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'save-fixture', type: 'function', function: {
        name: 'save_memory', arguments: JSON.stringify({ title: 'DSH验证', content: 'DSH测试项目代号为星桥', kind: 'fact' }),
      } }] }); sse(response, {}, 'tool_calls');
    } else {
      assert.match(raw, /星桥/); sse(response, { role: 'assistant', content: '已保存' });
      await new Promise(r => setTimeout(r, 1200)); sse(response, { content: '测试事实。' }); sse(response, {}, 'stop'); upstreamFinished = true;
    }
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 8 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening'); const address = model.address(); assert.ok(address && typeof address === 'object');
  const secret = randomBytes(32).toString('hex'); const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) env[key] = process.env[key];
  Object.assign(env, { TEMP: home, TMP: home, HOME: home, USERPROFILE: home, DATABASE_URL: `sqlite:${join(home, 'acceptance.db').replaceAll('\\', '/')}`,
    TADA_CONFIG_DIR: join(home, 'config'), TADA_CONFIG_MASTER_KEY: randomBytes(32).toString('hex'), UPLOAD_DIR: join(home, 'uploads'),
    AGENT_MODE: 'dsh', AGENT_URL: `http://127.0.0.1:${agentPort}`, AGENT_PORT: String(agentPort), AGENT_SERVICE_TOKEN: secret,
    API_BIND: `127.0.0.1:${port}`, RUST_API_URL: base, TADA_RUNTIME_CONFIG: 'disabled',
    REGISTRATION_POLICY: 'open', EMAIL_PASSWORD_ENABLED: 'true', PHONE_PASSWORD_ENABLED: 'false',
    MODEL_NAME: 'test-model', MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_API_KEY: 'fixture-key',
    DEEPSEEK_API_KEY: '', DEEPSEEK_WEB_ENABLED: 'false' });
  let api: ChildProcess | undefined, agent: ChildProcess | undefined; let logs = '';
  const launch = (bin: string, args: string[]) => {
    const child = spawn(bin, args, { cwd: home, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.on('data', b => { logs = (logs + b).slice(-4000); }); return child;
  };
  try {
    agent = launch(process.execPath, [join(repo, 'services/agent/dist/server.js')]);
    api = launch(join(repo, 'target/debug', process.platform === 'win32' ? 'tomorrow-api.exe' : 'tomorrow-api'), []);
    await ready(`${base}/v1/health`, api); await ready(`${env.AGENT_URL}/health`, agent);
    const apiJson = async (path: string, body?: unknown, token?: string) => {
      const result = await fetch(base + '/v1' + path, { method: body ? 'POST' : 'GET', headers: {
        'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const value = await result.json(); assert.ok(result.ok, `${path}: ${JSON.stringify(value)}`); return value;
    };
    const health = await apiJson('/health'); assert.equal(health.runtime.agent_harness, 'dsh');
    const register = () => apiJson('/auth/register', { email: `${randomUUID()}@fixture.local`, password: randomBytes(16).toString('hex'), name: '验收用户' });
    const owner = await register(), other = await register();
    const body = { message: '请保存测试事实：DSH测试项目代号为星桥。仅保存一次，然后简短告诉我。', client_request_id: randomUUID(), remember: false };
    const stream = async () => {
      const result = await fetch(base + '/v1/chat/stream', { method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.ok(result.ok); const reader = result.body!.getReader(); const decoder = new TextDecoder(); let pending = ''; const events: { kind: string; body: any }[] = [];
      for (;;) { const part = await reader.read(); if (part.done) break; pending += decoder.decode(part.value, { stream: true });
        let end: number; while ((end = pending.indexOf('\n\n')) >= 0) { const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const kind = frame.match(/^event:\s*(.+)$/m)?.[1]; const data = frame.match(/^data:\s*(.+)$/m)?.[1];
          if (kind && data) { events.push({ kind, body: JSON.parse(data) }); if (kind === 'text_delta' && !upstreamFinished) live = true; }
        }
      } return events;
    };
    const events = await stream();
    assert.ok(events.some(event => event.kind === 'tool_start')); assert.ok(events.some(event => event.kind === 'tool_end'));
    assert.ok(!events.some(event => event.kind === 'error'), JSON.stringify(events));
    const done = events.find(event => event.kind === 'done')?.body.response; assert.ok(done, JSON.stringify(events));
    assert.equal(done.message.content, '已保存测试事实。'); assert.equal(live, true);
    const memories = await apiJson('/memories', undefined, owner.token); assert.equal(memories.items.length, 1);
    assert.equal((await apiJson('/memories', undefined, other.token)).items.length, 0);
    const trace = await apiJson(`/agent-runs/${done.agent_run_id}`, undefined, owner.token);
    assert.equal(trace.status, 'succeeded'); assert.equal(trace.events[0].body.harness, 'dsh'); assert.equal(trace.operations.length, 1);
    const denied = await fetch(`${base}/v1/agent-runs/${done.agent_run_id}`, { headers: { Authorization: `Bearer ${other.token}` } }); assert.ok(!denied.ok);
    await stream(); assert.equal(calls, 2); assert.equal((await apiJson('/memories', undefined, owner.token)).items.length, 1);
    const report = { passed: true, harness: 'dsh', version: '0.2.1-rc.5', model: 'controlled OpenAI-compatible SSE fixture',
      real_rust_api: true, real_dsh_process: true, live_delta_before_model_end: live, model_requests: calls,
      durable_writes: trace.operations.length, duplicate_request_replayed: true, other_user_isolated: true, completed_at: new Date().toISOString() };
    await writeFile(join(repo, 'artifacts/dsh-integration-20261103/rust-e2e.json'), JSON.stringify(report, null, 2));
  } catch (error) { if (logs) console.error(logs); throw error; }
  finally { await stop(agent); await stop(api); model.closeAllConnections(); await new Promise<void>(r => model.close(() => r())); await rm(home, { recursive: true, force: true }); }
});

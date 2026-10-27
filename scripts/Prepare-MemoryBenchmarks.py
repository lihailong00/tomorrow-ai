"""Prepare pinned public memory benchmarks. Does not call any model or read credentials."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1] / 'research' / 'benchmarks'
SEED = 'tomorrow-public-benchmark-v1'
LME_REV = '98d7416c24c778c2fee6e6f3006e7a073259d48f'
LME_CODE_REV = '9e0b455f4ef0e2ab8f2e582289761153549043fc'
MEM_REV = 'c935c65be9aa19c930b60657c0c4b2b7ea13a34a'
LME_HASH = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def fetch(relative, url, expected=None):
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        request = urllib.request.Request(url, headers={'User-Agent': 'TomorrowBenchmarkResearch/1.0'})
        with urllib.request.urlopen(request, timeout=120) as response, path.open('wb') as out:
            while block := response.read(1024 * 1024):
                out.write(block)
    sha = digest(path)
    if expected and sha != expected:
        raise ValueError(f'Hash mismatch for {relative}')
    return {'file': relative, 'url': url, 'bytes': path.stat().st_size, 'sha256': sha}


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    files = [fetch('longmemeval_s_cleaned.json',
                   f'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/{LME_REV}/longmemeval_s_cleaned.json', LME_HASH)]
    for source, name in [('LICENSE', 'LICENSE'), ('README.md', 'README.md'),
                         ('src/evaluation/evaluate_qa.py', 'evaluate_qa.py')]:
        files.append(fetch(f'longmemeval/{name}',
                           f'https://raw.githubusercontent.com/xiaowu0162/LongMemEval/{LME_CODE_REV}/{source}'))
    for name in ['Mem2ACT_conversation.jsonl', 'qa_dataset.jsonl', 'README.md', 'benchmark_statistics.json']:
        files.append(fetch(f'mem2act/{name}',
                           f'https://raw.githubusercontent.com/Cantaloupe-M/Mem2ActBench/{MEM_REV}/Mem2ACTBench_small/{name}'))
    rows = json.loads((ROOT / 'longmemeval_s_cleaned.json').read_text(encoding='utf8'))
    rank = lambda row: hashlib.sha256(f"{SEED}|{row['question_id']}".encode()).hexdigest()
    types = ['single-session-user', 'single-session-assistant', 'single-session-preference',
             'temporal-reasoning', 'knowledge-update', 'multi-session']
    selected = [sorted([r for r in rows if r['question_type'] == t and not r['question_id'].endswith('_abs')], key=rank)[0]
                for t in types]
    selected.append(sorted([r for r in rows if r['question_type'] == 'multi-session'], key=rank)[1])
    selected.append(sorted([r for r in rows if r['question_id'].endswith('_abs')], key=rank)[0])
    lme = [{'id': f'LME{i+1:02}', 'source_id': r['question_id'], 'question_type': r['question_type'],
            'abstention': r['question_id'].endswith('_abs'),
            'sessions': len(r['haystack_sessions']), 'turns': sum(map(len, r['haystack_sessions'])),
            'raw_history_characters': sum(len(m['content']) for s in r['haystack_sessions'] for m in s)}
           for i, r in enumerate(selected)]
    qas = [json.loads(x) for x in (ROOT / 'mem2act/qa_dataset.jsonl').read_text(encoding='utf8').splitlines() if x.strip()]
    mem = []
    for i, level in enumerate(['L1', 'L2', 'L3', 'L4']):
        q = next(q for q in qas if q['complexity_metadata']['level'] == level)
        mem.append({'id': f'M2A{i+1:02}', 'source_id': q['qa_id'], 'level': level})
    manifest = {
        'selection_seed': SEED,
        'selection_rule': 'LongMemEval: lowest SHA256(seed|question_id) in each non-abstention type; next multi-session; lowest abstention hash. Mem2Act: first row for L1/L2/L3/L4 in official small dataset.',
        'longmemeval_revision': LME_REV, 'longmemeval_code_revision': LME_CODE_REV,
        'mem2act_revision': MEM_REV, 'files': files, 'longmemeval': lme, 'mem2act': mem,
        'scope': 'Selected original English questions, full associated history, no oracle/evidence filtering. Full-context Pi+DeepSeek baseline, not a Tomorrow automatic-long-term-memory score.',
        'production_limits': {'chat_history_messages': 40, 'pi_input_characters': 200000, 'tool_result_characters': 48000},
    }
    (ROOT / 'memory-provenance.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'prepared': len(lme) + len(mem), 'longmemeval': lme, 'mem2act': mem}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

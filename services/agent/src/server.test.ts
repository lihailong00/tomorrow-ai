import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const serviceToken = 'server-auth-fixture-only'.repeat(3);
const input = { run_id: '11111111-1111-4111-8111-111111111111', run_token: 'a'.repeat(64),
  scope: 'chat', messages: [{ role: 'user', content: 'fixture' }], tools: [] };

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture could not listen');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function start(extra: NodeJS.ProcessEnv = {}): Promise<{ child: ChildProcess; url: string; logs(): string; stop(): Promise<void> }> {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_SERVICE_TOKEN: serviceToken, AGENT_PORT: String(port),
    TADA_RUNTIME_CONFIG: 'disabled', MODEL_BASE_URL: '', MODEL_API_KEY: '', MODEL_NAME: '', DEEPSEEK_BASE_URL: '',
    DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: '', DEEPSEEK_SEARCH_API_KEY: '', DEEPSEEK_WEB_ENABLED: '',
    RUST_API_URL: 'http://127.0.0.1:1', ...extra };
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('fixture startup timeout')); }, 15000);
    const collect = (chunk: Buffer) => {
      log += chunk.toString('utf8');
      if (log.includes('"event":"ready"')) { clearTimeout(timer); resolve(); }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (!log.includes('"event":"ready"')) reject(new Error(`fixture exited ${code}`)); });
  });
  await ready;
  return { child, url: `http://127.0.0.1:${port}`, logs: () => log, async stop() {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  } };
}

async function run(url: string, authorized = true) {
  return fetch(`${url}/v1/runs`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${serviceToken}` } : {}) },
    body: JSON.stringify(input), signal: AbortSignal.timeout(8000) });
}

test('Pi starts without model keys; health is live and execution fails with a clear sanitized configuration code', { timeout: 25000 }, async () => {
  const fixture = await start();
  try {
    const health = await fetch(`${fixture.url}/health`).then(result => result.json()) as Record<string, unknown>;
    assert.equal(health.ok, true);
    assert.equal(health.configured, false);
    assert.equal(health.model_name, null);
    assert.equal(health.config_revision, null);
    assert.equal(health.config_status, 'model_not_configured');
    assert.equal((await run(fixture.url, false)).status, 401);
    const result = await run(fixture.url);
    assert.equal(result.status, 503);
    assert.equal((await result.json() as { error: { code: string } }).error.code, 'model_not_configured');
    assert.equal(fixture.logs().includes(serviceToken), false);
    assert.equal(fixture.logs().includes(input.run_token), false);
  } finally { await fixture.stop(); }
});

test('Pi reflects dashboard revisions, honors cleared keys, and fails closed when the config service becomes unavailable', { timeout: 30000 }, async () => {
  let values: Record<string, string> = { MODEL_BASE_URL: 'https://fixture-provider.test/v1', MODEL_NAME: 'dashboard-model',
    MODEL_API_KEY: 'dashboard-key-never-log', DEEPSEEK_WEB_ENABLED: 'false' };
  let revision = 1;
  let reads = 0;
  const backend = createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/internal/config/runtime');
    assert.equal(request.headers['x-agent-service'], serviceToken);
    reads++;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ revision, values }));
  });
  const port = await listen(backend);
  const fixture = await start({ TADA_RUNTIME_CONFIG: 'enabled', RUST_API_URL: `http://127.0.0.1:${port}`,
    DEEPSEEK_API_KEY: 'stale-environment-key-must-not-fallback' });
  let backendClosed = false;
  try {
    const ready = await fetch(`${fixture.url}/health`).then(result => result.json()) as Record<string, unknown>;
    assert.equal(ready.configured, true);
    assert.equal(ready.model_name, 'dashboard-model');
    assert.equal(ready.config_revision, '1');
    values = {}; revision++;
    const result = await run(fixture.url);
    assert.equal(result.status, 503);
    assert.equal((await result.json() as { error: { code: string } }).error.code, 'model_not_configured');
    assert.equal(reads, 2);
    await closeServer(backend); backendClosed = true;
    const missing = await fetch(`${fixture.url}/health`).then(result => result.json()) as Record<string, unknown>;
    assert.equal(missing.ok, true);
    assert.equal(missing.configured, false);
    assert.equal(missing.config_revision, null);
    assert.equal(missing.config_status, 'runtime_config_unavailable');
    const unavailable = await run(fixture.url);
    assert.equal(unavailable.status, 503);
    const encoded = JSON.stringify(await unavailable.json());
    assert.ok(encoded.includes('runtime_config_unavailable'));
    for (const forbidden of ['dashboard-key-never-log', 'stale-environment-key-must-not-fallback', serviceToken]) {
      assert.equal(encoded.includes(forbidden), false);
      assert.equal(fixture.logs().includes(forbidden), false);
    }
  } finally {
    await fixture.stop();
    if (!backendClosed) await closeServer(backend);
  }
});

test('the configured run deadline cancels real state, journal and tool HTTP callbacks', { timeout: 25000 }, async () => {
  let phase = 'state'; let modelCalls = 0; let toolCalls = 0;
  const aborted: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const backend = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    const kind = request.url?.endsWith('/state') ? 'state' : request.url?.endsWith('/tools') ? 'tool' : String(body.kind);
    if (kind === 'tool') toolCalls++;
    const send = () => {
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(kind === 'state' ? { next_sequence: 1 } : { ok: true }));
    };
    if (kind === phase) {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 850);
      timers.add(timer);
      response.on('close', () => {
        clearTimeout(timer); timers.delete(timer);
        if (!response.writableEnded) aborted.push(kind);
      });
    } else send();
  });
  const backendPort = await listen(backend);
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the bounded fixture body. */ }
    modelCalls++;
    const tool = phase === 'tool';
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function',
      function: { name: 'save_memory', arguments: '{"content":"fixture"}' } }] } : { role: 'assistant', content: 'fixture complete' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const common = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deadline-fixture' };
    chunk({ ...common, choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({ ...common, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end('data: [DONE]\n\n');
  });
  const providerPort = await listen(provider);
  const fixture = await start({ RUST_API_URL: `http://127.0.0.1:${backendPort}`,
    MODEL_BASE_URL: `http://127.0.0.1:${providerPort}/v1`, MODEL_NAME: 'deadline-fixture', MODEL_API_KEY: 'fixture-only',
    AGENT_TIMEOUT_MS: '100', AGENT_MAX_CONCURRENT: '1' });
  try {
    for (phase of ['state', 'started', 'finished', 'tool']) {
      modelCalls = 0; toolCalls = 0;
      const value = { ...input, tools: phase === 'tool' ? [{ name: 'save_memory', description: 'fixture only',
        parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } }] : [] };
      const began = performance.now();
      const result = await fetch(`${fixture.url}/v1/runs`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken}` },
        body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
      assert.equal(result.status, 502, phase);
      assert.equal((await result.json() as { error: { code: string } }).error.code, 'timeout', phase);
      assert.ok(performance.now() - began < 600, `${phase} callback exceeded the run deadline`);
      for (let i = 0; i < 20 && !aborted.includes(phase); i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(aborted.includes(phase), `${phase} HTTP callback was not cancelled`);
      if (phase === 'state' || phase === 'started') assert.equal(modelCalls, 0);
      if (phase === 'tool') { assert.equal(toolCalls, 1); assert.equal(modelCalls, 1); }
    }
    phase = 'none';
    const recovered = await run(fixture.url);
    assert.equal(recovered.status, 200, 'the timed-out run must release its concurrency slot');
    assert.equal((await recovered.json() as { content: string }).content, 'fixture complete');
  } finally {
    await fixture.stop();
    for (const timer of timers) clearTimeout(timer);
    await closeServer(provider); await closeServer(backend);
  }
});

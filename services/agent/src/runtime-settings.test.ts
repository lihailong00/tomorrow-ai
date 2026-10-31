import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeSettingsProvider, RuntimeSettingsError } from './runtime-settings.js';

const secret = 'runtime-service-fixture-not-a-real-secret'.repeat(2);
const url = 'http://127.0.0.1:8080';
const configured = { DEEPSEEK_API_KEY: 'runtime-provider-fixture', DEEPSEEK_MODEL: 'deepseek-flash' };
const response = (revision: unknown, values: unknown) => new Response(JSON.stringify({ revision, values }),
  { headers: { 'Content-Type': 'application/json' } });

test('a fresh install and incomplete environment remain bootable without model fallback', async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('must not fetch'); };
  for (const env of [{}, { MODEL_NAME: 'unfinished' }, { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }]) {
    const provider = createRuntimeSettingsProvider(env, url, secret, transport);
    const snapshot = await provider.snapshot();
    assert.equal(provider.mode, 'environment');
    assert.equal(snapshot.revision, null);
    assert.equal(snapshot.model, undefined);
    assert.equal(snapshot.web, undefined);
    assert.equal(snapshot.error, 'model_not_configured');
  }
  assert.equal(calls, 0);
});

test('legacy mode pins its initial environment, and disabled mode never calls Rust', async () => {
  const env = { TADA_RUNTIME_CONFIG: 'disabled', DEEPSEEK_API_KEY: 'initial-model-key', DEEPSEEK_WEB_ENABLED: 'false' };
  const provider = createRuntimeSettingsProvider(env, url, secret, async () => { throw new Error('not called'); });
  env.DEEPSEEK_API_KEY = 'changed-key';
  const snapshot = await provider.snapshot();
  assert.equal(snapshot.model?.apiKey, 'initial-model-key');
  assert.equal(snapshot.web, undefined);
  assert.equal(snapshot.error, undefined);
  assert.throws(() => createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'yes' }, url, secret));
});

test('runtime requests use only the fixed private endpoint and internal authentication', async () => {
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, `${url}/internal/config/runtime`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('X-Agent-Service'), secret);
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    assert.ok(init?.signal);
    return response(42, configured);
  };
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret, transport);
  const snapshot = await provider.snapshot();
  assert.equal(provider.mode, 'runtime');
  assert.equal(calls, 1);
  assert.equal(snapshot.revision, '42');
  assert.equal(snapshot.model?.apiKey, configured.DEEPSEEK_API_KEY);
  assert.equal(snapshot.model?.model.id, 'deepseek-flash');
});

test('separate runs pin model and search credentials to the same revision', async () => {
  let revision = 0;
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret, async () => {
    revision++;
    return response(revision, { MODEL_BASE_URL: `https://model-${revision}.test/v1`, MODEL_NAME: `model-${revision}`,
      MODEL_API_KEY: `key-${revision}`, DEEPSEEK_SEARCH_API_KEY: `search-${revision}`, DEEPSEEK_WEB_ENABLED: 'true' });
  });
  const first = await provider.snapshot();
  const second = await provider.snapshot();
  assert.equal(first.revision, '1');
  assert.equal(first.model?.model.id, 'model-1');
  assert.equal(first.model?.apiKey, 'key-1');
  assert.equal(first.web?.apiKey, 'search-1');
  assert.equal(second.revision, '2');
  assert.equal(second.model?.model.id, 'model-2');
  assert.equal(second.web?.apiKey, 'search-2');
  assert.equal(first.model?.model.id, 'model-1');
});

test('clearing runtime credentials never revives stale process keys or mixes providers', async () => {
  const values = [configured, {}, { MODEL_BASE_URL: 'https://private-provider.test/v1', MODEL_NAME: 'configured-without-key',
    DEEPSEEK_API_KEY: 'must-not-borrow' }];
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled',
    MODEL_API_KEY: 'old-model-env', DEEPSEEK_API_KEY: 'old-deepseek-env', DEEPSEEK_SEARCH_API_KEY: 'old-search-env' },
  url, secret, async () => response(1, values.shift()));
  assert.ok((await provider.snapshot()).model);
  for (let i = 0; i < 2; i++) {
    const snapshot = await provider.snapshot();
    assert.equal(snapshot.model, undefined);
    assert.equal(snapshot.web, undefined);
    assert.equal(snapshot.error, 'model_not_configured');
  }
});

test('a failed runtime fetch rejects even after a working revision, without leaking upstream errors', async () => {
  let calls = 0;
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled', ...configured }, url, secret, async () => {
    if (calls++ === 0) return response(1, configured);
    throw new Error('upstream credential=must-not-escape');
  });
  assert.ok((await provider.snapshot()).model);
  await assert.rejects(provider.snapshot(), error => error instanceof RuntimeSettingsError &&
    error.code === 'runtime_config_unavailable' && !error.message.includes('must-not-escape'));
});

test('only bounded, versioned string settings are accepted; unknown keys never affect model resolution', async () => {
  const invalid = [response(-1, configured), response(1.5, configured), response('bad-revision', configured),
    response(1, []), response(1, null), response(1, { DEEPSEEK_API_KEY: 5 }),
    response(1, { DEEPSEEK_API_KEY: 'bad\nheader' }), response(1, { MODEL_NAME: 'x'.repeat(8193) }),
    new Response('{"provider":"sensitive upstream error"}', { status: 401 }), new Response('not-json')];
  for (const body of invalid) {
    const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret, async () => body);
    await assert.rejects(provider.snapshot(), error => error instanceof RuntimeSettingsError && error.code === 'runtime_config_unavailable');
  }
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret,
    async () => response('9223372036854775807', { OPENAI_API_KEY: 'unrelated-must-not-fallback', RUST_API_URL: 'https://evil.test' }));
  const snapshot = await provider.snapshot();
  assert.equal(snapshot.revision, '9223372036854775807');
  assert.equal(snapshot.model, undefined);
  assert.equal(snapshot.error, 'model_not_configured');
});

test('runtime response byte limits cancel the body without exposing it', async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { canceled = true; },
  });
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret, async () => new Response(body));
  await assert.rejects(provider.snapshot(), RuntimeSettingsError);
  assert.equal(canceled, true);
});

test('runtime configuration refuses remote, metadata, path, query and credential endpoints before transport', () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return response(1, configured); };
  for (const endpoint of ['https://official.test', 'http://169.254.169.254', 'http://100.100.100.200',
    'http://127.0.0.1:8080/prefix', 'http://127.0.0.1:8080/?key=secret', 'http://user:secret@127.0.0.1:8080',
    'http://127.0.0.1:8080/#secret', 'file:///tmp/settings']) {
    assert.throws(() => createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, endpoint, secret, transport));
  }
  assert.throws(() => createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, 'short'));
  assert.equal(calls, 0);
});

test('invalid model and search settings expose only stable configuration codes', async () => {
  const models = createRuntimeSettingsProvider({ MODEL_API_KEY: 'secret-fixture', MODEL_NAME: 'bad\nmodel',
    MODEL_BASE_URL: 'https://provider.test' }, url, secret);
  assert.equal((await models.snapshot()).error, 'model_configuration_invalid');
  const web = createRuntimeSettingsProvider({ MODEL_API_KEY: 'secret-fixture', MODEL_NAME: 'model',
    MODEL_BASE_URL: 'https://provider.test', DEEPSEEK_WEB_ENABLED: 'true' }, url, secret);
  const snapshot = await web.snapshot();
  assert.equal(snapshot.error, 'web_configuration_invalid');
  assert.equal(snapshot.web, undefined);
  assert.ok(snapshot.model);
});

test('run budgets and admission limits change only with the next pinned revision and keep hard bounds', async () => {
  let revision = 1;
  const provider = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret, async () => response(revision,
    { ...configured, AGENT_MAX_TURNS: String(revision + 2), AGENT_MAX_TOOLS: String(revision + 3),
      AGENT_TIMEOUT_MS: String(1000 * revision), AGENT_MAX_CONCURRENT: String(revision) }));
  const first = await provider.snapshot();
  revision++;
  const second = await provider.snapshot();
  assert.deepEqual(first.limits, { turns: 3, tools: 4, timeoutMs: 1000, maxConcurrent: 1 });
  assert.deepEqual(second.limits, { turns: 4, tools: 5, timeoutMs: 2000, maxConcurrent: 2 });
  assert.deepEqual(first.limits, { turns: 3, tools: 4, timeoutMs: 1000, maxConcurrent: 1 });
  for (const [key, value] of [['AGENT_MAX_TURNS', '21'], ['AGENT_MAX_TOOLS', '41'],
    ['AGENT_TIMEOUT_MS', '105001'], ['AGENT_MAX_CONCURRENT', '33'], ['AGENT_MAX_CONCURRENT', '0']]) {
    const invalid = createRuntimeSettingsProvider({ TADA_RUNTIME_CONFIG: 'enabled' }, url, secret,
      async () => response(3, { ...configured, [key!]: value }));
    const snapshot = await invalid.snapshot();
    assert.equal(snapshot.error, 'runtime_configuration_invalid');
    assert.equal(snapshot.model, undefined);
  }
});

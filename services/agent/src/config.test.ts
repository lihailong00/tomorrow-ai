import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { authenticate, positiveInteger, resolveModel, rustServiceUrl, serviceUrl } from './config.js';

async function captureProviderRequest(env: NodeJS.ProcessEnv, content: string) {
  const { model, apiKey } = resolveModel(env);
  const requests: Record<string, unknown>[] = [];
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    assert.equal(typeof init?.body, 'string');
    requests.push(JSON.parse(init!.body as string) as Record<string, unknown>);
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 0, model: model.id,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
  // Agent thinkingLevel='off' reaches streamSimple with reasoning undefined.
  // Exercise the installed Pi request builder and HTTP transport, without network I/O.
  const result = await streamSimple(model,
    normalizeContext({ messages: [{ role: 'user', content, timestamp: 0 }] }),
    { apiKey, maxTokens: 4096, maxRetries: 0, fetch: fakeFetch }).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.equal(requests.length, 1);
  return requests[0]!;
}

test('DeepSeek defaults use the backend key and correct model', () => {
  const value = resolveModel({ DEEPSEEK_API_KEY: 'fixture-key' });
  assert.equal(value.model.id, 'deepseek-flash');
  assert.equal(value.model.baseUrl, 'https://api.deepseek.com');
  assert.equal(value.apiKey, 'fixture-key');
});

test('official Flash sends thinking disabled and preserves answer space for a full LongMemEval-sized input', async () => {
  // The longest selected full-history LongMemEval input is 508,698 characters.
  // Keep this synthetic fixture independent of downloaded benchmark datasets.
  const history = 'Dated user and assistant history.\n'.repeat(16000);
  assert.ok(history.length > 508698);
  for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions']) {
    const payload = await captureProviderRequest({ DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: base }, history);
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.equal(payload.max_tokens, 4096);
    assert.equal(payload.reasoning_effort, undefined);
    const messages = payload.messages as { content: string }[];
    assert.equal(messages.at(-1)?.content, history);
  }
});

test('unverified models, proxy endpoints and custom providers retain conservative request behavior', async () => {
  const configurations = [
    { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_MODEL: 'deepseek-chat' },
    { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: 'https://proxy.example.test/v1' },
    { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com.evil.test' },
    { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/unverified' },
    { MODEL_API_KEY: 'fixture-key', MODEL_NAME: 'deepseek-flash', MODEL_BASE_URL: 'https://api.deepseek.com' },
  ];
  for (const env of configurations) {
    const payload = await captureProviderRequest(env, 'Historical message.\n'.repeat(28000));
    // These configurations are not assumed to support Flash's official 1M limit
    // or its thinking toggle. The actual Pi request must retain that boundary.
    assert.equal(payload.thinking, undefined);
    assert.equal(payload.max_tokens, 1);
  }
});
test('a partial compatible provider never borrows the DeepSeek credential', () => {
  assert.throws(() => resolveModel({ MODEL_BASE_URL: 'https://example.test/v1', DEEPSEEK_API_KEY: 'must-not-borrow' }));
  const value = resolveModel({ MODEL_BASE_URL: 'https://example.test/v1/chat/completions', MODEL_API_KEY: 'compatible-key', MODEL_NAME: 'custom', DEEPSEEK_API_KEY: 'unused' });
  assert.equal(value.apiKey, 'compatible-key');
  assert.equal(value.model.baseUrl, 'https://example.test/v1');
});
test('service addresses reject credentials, query strings and insecure remote HTTP', () => {
  for (const value of ['http://remote.test', 'https://user:pass@example.test', 'https://example.test/?token=secret', 'https://example.test/#secret']) {
    assert.throws(() => serviceUrl(value, 'fixture'));
  }
  assert.equal(serviceUrl('http://127.0.0.1:8080/', 'fixture'), 'http://127.0.0.1:8080');
});
test('service authentication and budget parsing fail closed', () => {
  assert.equal(authenticate('Bearer fixture', 'Bearer fixture'), true);
  assert.equal(authenticate(undefined, 'Bearer fixture'), false);
  assert.equal(authenticate('Bearer other', 'Bearer fixture'), false);
  assert.equal(positiveInteger(undefined, 10, 20), 10);
  for (const value of ['-1', '0', 'NaN', '21', '1.5']) assert.throws(() => positiveInteger(value, 10, 20));
  assert.throws(() => resolveModel({ DEEPSEEK_API_KEY: 'bad\nheader' }));
});

test('self-hosted private models support an explicit keyless endpoint without borrowing a cloud credential', () => {
  for (const host of ['127.0.0.1:11434', 'localhost:11434', '192.168.1.20:8000', '10.0.0.2:8000',
    '172.20.0.3:8000', '[::1]:11434', '[fd00::2]:8000', 'ollama:11434', 'vllm:8000', 'lmstudio:1234']) {
    const settings = resolveModel({ MODEL_BASE_URL: `http://${host}/v1`, MODEL_NAME: 'local-model',
      DEEPSEEK_API_KEY: 'unrelated-cloud-key' });
    assert.equal(settings.apiKey, 'local-no-auth');
    assert.equal(settings.model.baseUrl, `http://${host}/v1`);
    assert.equal(settings.model.provider, 'tomorrow-compatible');
  }
  for (const endpoint of ['https://public.test/v1', 'http://public.test/v1', 'http://169.254.169.254/v1',
    'http://172.32.0.1/v1', 'http://100.100.100.200/v1', 'https://user:pass@127.0.0.1/v1']) {
    assert.throws(() => resolveModel({ MODEL_BASE_URL: endpoint, MODEL_NAME: 'local-model', DEEPSEEK_API_KEY: 'must-not-borrow' }));
  }
  assert.throws(() => resolveModel({ MODEL_BASE_URL: 'http://localhost:11434/v1' }));
  assert.throws(() => resolveModel({ MODEL_NAME: 'unfinished', DEEPSEEK_API_KEY: 'must-not-borrow' }));
});

test('private Rust service roots are valid while runtime secrets never target public hosts', () => {
  for (const endpoint of ['http://api:8080', 'http://backend:8080', 'http://tomorrow-api:8080',
    'http://127.0.0.1:8080/', 'https://10.0.0.1:8443', 'http://[fd00::1]:8080']) {
    assert.equal(rustServiceUrl(endpoint, true), endpoint.replace(/\/$/, ''));
  }
  assert.equal(rustServiceUrl('https://legacy-api.test'), 'https://legacy-api.test');
  assert.throws(() => rustServiceUrl('https://legacy-api.test', true));
  assert.throws(() => rustServiceUrl('http://public.test'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekWeb, resolveWebSettings, type WebSettings } from './web.js';

const settings: WebSettings = { apiKey: 'search-key-never-in-output', searches: 2, fetches: 2 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const active = async () => {};

test('web config reuses only the explicit DeepSeek key, can be disabled, and caps calls', () => {
  assert.deepEqual(resolveWebSettings({ DEEPSEEK_API_KEY: 'fixture' }), { apiKey: 'fixture', searches: 4, fetches: 4 });
  assert.equal(resolveWebSettings({ MODEL_API_KEY: 'other-provider' }), undefined);
  assert.equal(resolveWebSettings({ DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_WEB_ENABLED: 'false' }), undefined);
  assert.equal(resolveWebSettings({ DEEPSEEK_API_KEY: 'fallback', DEEPSEEK_SEARCH_API_KEY: 'dedicated' })?.apiKey, 'dedicated');
  for (const env of [
    { DEEPSEEK_WEB_ENABLED: 'true' }, { DEEPSEEK_WEB_ENABLED: 'yes' },
    { DEEPSEEK_API_KEY: 'bad\nkey' }, { DEEPSEEK_API_KEY: 'fixture', AGENT_MAX_WEB_SEARCHES: '9' },
  ]) assert.throws(() => resolveWebSettings(env));
});

test('search sends the documented request only to the official API and returns dated source links', async () => {
  let checked = 0;
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${settings.apiKey}`);
    assert.deepEqual(JSON.parse(init?.body as string), { query: '纳指 申购 site:chinaamc.com', count: 5, need_content: false });
    return json({ results: [{ title: '申购公告', url: 'https://www.chinaamc.com/notice', summary: '以公告日期和份额类别为准',
      snippet: '限购', date: '2026-10-27T00:00:00+08:00', site_name: '基金公司', content: 'must not pass unused content' },
    { title: 'unsafe', url: 'http://127.0.0.1/private' }] });
  };
  const session = createDeepSeekWeb(settings, transport).session(async () => { checked++; });
  const result = await session.tools[0]!.execute('search', { query: '纳指 申购 site:chinaamc.com' });
  const output = JSON.stringify(result);
  assert.equal(checked, 1); assert.equal(session.usage.web_search_requests, 1);
  assert.ok(output.includes('https://www.chinaamc.com/notice')); assert.ok(output.includes('2026-10-27'));
  assert.ok(output.includes('retrieved_at')); assert.ok(output.includes('untrusted_web_content'));
  assert.equal(output.includes('127.0.0.1'), false); assert.equal(output.includes(settings.apiKey), false);
  assert.equal(output.includes('must not pass'), false);
});

test('fetch reads Markdown through DeepSeek, preserves its source and bounds large pages', async () => {
  const transport: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
    assert.deepEqual(JSON.parse(init?.body as string), { url: 'https://www.chinaamc.com/notice' });
    return json({ title: '公告', content: '# 当日申购限额\n' + '资料'.repeat(15000) });
  };
  const session = createDeepSeekWeb(settings, transport).session(active);
  const result = await session.tools[1]!.execute('fetch', { url: 'https://www.chinaamc.com/notice#section' });
  const content = result.content[0]; assert.equal(content?.type, 'text');
  if (content?.type !== 'text') throw new Error('missing text');
  const output = JSON.parse(content.text) as { url: string; content: string; truncated: boolean };
  assert.equal(output.url, 'https://www.chinaamc.com/notice'); assert.equal(output.content.length, 20000);
  assert.equal(output.truncated, true); assert.equal(session.usage.web_fetch_requests, 1);
});

test('invalid queries and private, credentialed or non-web URLs never cause an outbound request', async () => {
  let attempts = 0;
  const session = createDeepSeekWeb(settings, async () => { attempts++; return json({}); }).session(active);
  for (const query of ['', '   ', '中'.repeat(129), 123]) {
    await assert.rejects(session.tools[0]!.execute('bad-query', { query }));
  }
  await assert.rejects(session.tools[0]!.execute('bad-count', { query: 'test', count: 50 }));
  for (const url of ['http://localhost', 'http://127.1/', 'http://2130706433/', 'http://10.0.0.1/',
    'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://service.internal/',
    'http://host.local./', 'file:///etc/passwd', 'https://user:secret@www.chinaamc.com/',
    'https://www.chinaamc.com:8080/', 'https://www.chinaamc.com/\nsecret', 'x'.repeat(8193)]) {
    await assert.rejects(session.tools[1]!.execute('bad-url', { url }), /网页地址|公开网站/, url);
  }
  assert.equal(attempts, 0);
});

test('provider errors expose a safe reason, consume attempts, and are never automatically retried', async () => {
  let attempts = 0;
  const provider = createDeepSeekWeb({ ...settings, searches: 1 }, async () => {
    attempts++; return json({ error: { message: `provider accidentally echoes ${settings.apiKey}` } }, 402);
  });
  const session = provider.session(active);
  await assert.rejects(session.tools[0]!.execute('error', { query: '公告' }), error => {
    assert.ok(error instanceof Error); assert.ok(error.message.includes('余额不足'));
    assert.equal(error.message.includes(settings.apiKey), false); return true;
  });
  await assert.rejects(session.tools[0]!.execute('budget', { query: '公告' }), /本轮联网调用上限/);
  assert.equal(attempts, 1);
  // Budgets are isolated between runs, not shared mutable state on the provider.
  await assert.rejects(provider.session(active).tools[0]!.execute('new-run', { query: '公告' }), /余额不足/);
  assert.equal(attempts, 2);
});

test('authority loss or a cancelled signal blocks the paid API request', async () => {
  let attempts = 0;
  const provider = createDeepSeekWeb(settings, async () => { attempts++; return json({ results: [] }); });
  await assert.rejects(provider.session(async () => { throw new Error('run cancelled'); })
    .tools[0]!.execute('revoked', { query: '公告' }), /run cancelled/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.session(active).tools[0]!.execute('aborted', { query: '公告' }, controller.signal));
  assert.equal(attempts, 0);
});

test('in-flight cancellation reaches the provider transport without exposing its internal exception', async () => {
  const controller = new AbortController(); let receivedSignal: AbortSignal | undefined;
  const session = createDeepSeekWeb(settings, async (_url, init) => {
    receivedSignal = init?.signal ?? undefined;
    controller.abort(); receivedSignal?.throwIfAborted();
    throw new Error(settings.apiKey);
  }).session(active);
  await assert.rejects(session.tools[1]!.execute('cancel', { url: 'https://www.chinaamc.com/' }, controller.signal), /联网请求已取消/);
  assert.equal(receivedSignal?.aborted, true);
});

test('malformed, oversized and failed-network responses produce bounded safe tool errors', async () => {
  const fixtures: (typeof fetch)[] = [
    async () => new Response('{"broken":' + settings.apiKey),
    async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    async () => { throw new Error(`network debug includes ${settings.apiKey}`); },
    async () => json({ wrong: [] }),
  ];
  for (const transport of fixtures) {
    await assert.rejects(createDeepSeekWeb(settings, transport).session(active).tools[0]!.execute('failure', { query: '公告' }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message.includes(settings.apiKey), false); return true;
    });
  }
});

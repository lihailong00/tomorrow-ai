import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { resolveModel } from './config.js';
import { executeRun, RunError, validateRun, type Bridge, type RunEvent, type RunInput } from './runtime.js';
import { createDeepSeekWeb } from './web.js';

const settings = resolveModel({ DEEPSEEK_API_KEY: 'model-key-never-in-transcript' });
function input(): RunInput {
  return { run_id: '11111111-1111-4111-8111-111111111111', run_token: 'a'.repeat(64), scope: 'chat',
    messages: [{ role: 'user', content: '请记住我喜欢简洁的回答' }],
    tools: [{ name: 'save_memory', description: '保存记忆', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } }] };
}
function fakeStream(replies: AssistantMessage['content'][], observe?: (value: unknown) => void): StreamFn {
  let index = 0;
  return (model, context) => {
    observe?.(context);
    const stream = createAssistantMessageEventStream();
    const content = replies[Math.min(index++, replies.length - 1)]!;
    const tool = content.some(c => c.type === 'toolCall');
    const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: tool ? 'toolUse' : 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message }); });
    return stream;
  };
}
function bridge(fail = false) {
  const events: RunEvent[] = [], effects: unknown[] = [];
  const value: Bridge = { state: async () => ({ next_sequence: 7 }),
    event: async event => { events.push(event); },
    tool: async (name, args) => { if (fail) throw new Error('fixture business failure'); effects.push({ name, args }); return { value: { id: 'saved', content: '喜欢简洁回答' } }; } };
  return { value, events, effects };
}
const call: AssistantMessage['content'] = [{ type: 'toolCall', id: 'call-1', name: 'save_memory', arguments: { content: '喜欢简洁回答' } }];
const final: AssistantMessage['content'] = [{ type: 'text', text: '已保存你的回答偏好。' }];

test('the real Pi loop executes a tool, observes its result and continues', async () => {
  const fixture = bridge(); const contexts: string[] = [];
  const result = await executeRun(input(), settings, fixture.value, undefined, undefined,
    fakeStream([call, final], context => { contexts.push(JSON.stringify(context)); }));
  assert.equal(fixture.effects.length, 1);
  assert.equal(result.content, '已保存你的回答偏好。');
  assert.equal(result.usage.model_requests, 2); assert.equal(result.usage.total_tokens, 30);
  assert.ok(contexts[1]?.includes('toolResult')); assert.ok(contexts[1]?.includes('saved'));
  assert.deepEqual(fixture.events.map(e => e.kind), ['started', 'tool_start', 'tool_end', 'turn', 'turn', 'finished']);
  assert.equal(fixture.events[0]?.sequence, 7);
  assert.equal(contexts.join('').includes(settings.apiKey), false);
  assert.equal(contexts.join('').includes(input().run_token), false);
});
test('Pi validates tool arguments before dispatching a business write', async () => {
  const fixture = bridge();
  const invalid: AssistantMessage['content'] = [{ type: 'toolCall', id: 'bad', name: 'save_memory', arguments: { wrong: 'value' } }];
  await executeRun(input(), settings, fixture.value, undefined, undefined, fakeStream([invalid, [{ type: 'text', text: '参数无效，未能保存。' }]]));
  assert.equal(fixture.effects.length, 0);
  assert.ok(fixture.events.some(e => e.kind === 'tool_end' && e.body.is_error));
});
test('business failures are returned to the model as error tool results', async () => {
  const fixture = bridge(true); let sawError = false;
  const result = await executeRun(input(), settings, fixture.value, undefined, undefined,
    fakeStream([call, [{ type: 'text', text: '保存失败，请稍后再试。' }]], value => { if (JSON.stringify(value).includes('"isError":true')) sawError = true; }));
  assert.equal(fixture.effects.length, 0); assert.equal(sawError, true);
  assert.ok(result.content.includes('失败'));
});
test('a looping model stops at the turn budget and never reports success', async () => {
  const fixture = bridge();
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined, { turns: 2, tools: 5, timeoutMs: 1000 }, fakeStream([call])),
    error => error instanceof RunError && error.code === 'step_limit');
  assert.equal(fixture.effects.length, 2);
});
test('a batch of tools is bounded before further writes can execute', async () => {
  const fixture = bridge();
  const calls: AssistantMessage['content'] = [1, 2, 3].map(i => ({ type: 'toolCall' as const, id: `call-${i}`, name: 'save_memory', arguments: { content: `value ${i}` } }));
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined, { turns: 5, tools: 1, timeoutMs: 1000 }, fakeStream([calls, final])),
    error => error instanceof RunError && error.code === 'step_limit');
  assert.equal(fixture.effects.length, 1);
});
test('an already cancelled request cannot execute tools', async () => {
  const fixture = bridge(); const controller = new AbortController(); controller.abort();
  await assert.rejects(executeRun(input(), settings, fixture.value, controller.signal, undefined, fakeStream([call, final])),
    error => error instanceof RunError && error.code === 'cancelled');
  assert.equal(fixture.effects.length, 0);
});
test('invalid identities and oversized contexts are rejected', () => {
  assert.throws(() => validateRun({ ...input(), run_id: '../other-user' }));
  assert.throws(() => validateRun({ ...input(), messages: [{ role: 'user', content: 'x'.repeat(200001) }] }));
});
test('a stalled provider is aborted by the runtime timeout', async () => {
  const fixture = bridge();
  const stalled: StreamFn = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const abort = () => {
      const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'aborted',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'error', reason: 'aborted', error: message });
    };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
    return stream;
  };
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined, { turns: 5, tools: 5, timeoutMs: 25 }, stalled),
    error => error instanceof RunError && error.code === 'timeout');
  assert.equal(fixture.effects.length, 0);
});

test('the deadline includes initial state reads, even when a custom bridge ignores cancellation', { timeout: 2000 }, async () => {
  const fixture = bridge(); let stateSignal: AbortSignal | undefined;
  fixture.value.state = async signal => { stateSignal = signal; return await new Promise(() => {}); };
  const started = performance.now();
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined,
    { turns: 5, tools: 5, timeoutMs: 35 }, fakeStream([call, final])),
  error => error instanceof RunError && error.code === 'timeout');
  assert.ok(performance.now() - started < 600);
  assert.equal(stateSignal?.aborted, true);
  assert.equal(fixture.events.length, 0); assert.equal(fixture.effects.length, 0);
});

test('the deadline cancels started and finished journal requests without returning late success', { timeout: 2500 }, async () => {
  for (const kind of ['started', 'finished']) {
    const fixture = bridge(); let journalSignal: AbortSignal | undefined;
    fixture.value.event = async (event, signal) => {
      fixture.events.push(event);
      if (event.kind === kind) { journalSignal = signal; await new Promise(() => {}); }
    };
    const started = performance.now();
    await assert.rejects(executeRun(input(), settings, fixture.value, undefined,
      { turns: 5, tools: 5, timeoutMs: 35 }, fakeStream([final])),
    error => error instanceof RunError && error.code === 'timeout');
    assert.ok(performance.now() - started < 600);
    assert.equal(journalSignal?.aborted, true);
  }
});

test('a timed-out tool gets the shared abort signal and cannot continue the model loop', { timeout: 2000 }, async () => {
  const fixture = bridge(); let toolSignal: AbortSignal | undefined; let modelCalls = 0;
  fixture.value.tool = async (_name, _args, signal) => { toolSignal = signal; return await new Promise(() => {}); };
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined,
    { turns: 5, tools: 5, timeoutMs: 35 }, fakeStream([call, final], () => { modelCalls++; })),
  error => error instanceof RunError && error.code === 'timeout');
  assert.equal(toolSignal?.aborted, true);
  assert.equal(modelCalls, 1);
  assert.equal(fixture.events.some(event => event.kind === 'finished'), false);
});

test('caller cancellation interrupts initialization and remains classified as cancellation', { timeout: 2000 }, async () => {
  const fixture = bridge(); const controller = new AbortController(); let stateSignal: AbortSignal | undefined;
  fixture.value.state = async signal => { stateSignal = signal; return await new Promise(() => {}); };
  const running = executeRun(input(), settings, fixture.value, controller.signal,
    { turns: 5, tools: 5, timeoutMs: 1000 }, fakeStream([final]));
  const assertion = assert.rejects(running, error => error instanceof RunError && error.code === 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 15)); controller.abort();
  await assertion;
  assert.equal(stateSignal?.aborted, true); assert.equal(fixture.events.length, 0);
});
test('a replay conflict stops the remaining batch instead of trying a new write', async () => {
  const fixture = bridge(); let attempts = 0;
  fixture.value.tool = async () => { attempts++; throw new RunError('agent_replay_conflict', 'changed replay arguments'); };
  const calls: AssistantMessage['content'] = [1, 2].map(i => ({ type: 'toolCall' as const, id: `conflict-${i}`, name: 'save_memory', arguments: { content: `value ${i}` } }));
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined, undefined, fakeStream([calls, final])),
    error => error instanceof RunError && error.code === 'agent_replay_conflict');
  assert.equal(attempts, 1);
});

test('the real Pi loop searches, reads an official page and sees source URLs without using the business bridge', async () => {
  const fixture = bridge(); const contexts: string[] = []; const requests: string[] = [];
  const searchKey = 'search-secret-not-for-model';
  const web = createDeepSeekWeb({ apiKey: searchKey, searches: 4, fetches: 4 }, async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${searchKey}`);
    return Response.json(String(url).endsWith('/search') ?
      { results: [{ title: '基金公司公告', url: 'https://www.chinaamc.com/notice', summary: '请核实公告正文', date: '2026-10-27' }] } :
      { title: '基金公司公告', content: '# 测试用虚构公告\n指定份额当日限额为 100 元。' });
  });
  const source = 'https://www.chinaamc.com/notice';
  const result = await executeRun({ ...input(), messages: [{ role: 'user', content: '查询纳斯达克基金的申购限额，附公告来源' }] },
    settings, fixture.value, undefined, undefined, fakeStream([
      [{ type: 'toolCall', id: 'search-1', name: 'web_search', arguments: { query: '纳斯达克基金 申购公告' } }],
      [{ type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: source } }],
      [{ type: 'text', text: `测试份额当日限额 100 元。[基金公司公告](${source})` }],
    ], context => { contexts.push(JSON.stringify(context)); }), web);
  assert.equal(requests.length, 2); assert.equal(fixture.effects.length, 0);
  assert.ok(contexts[0]?.includes('已提供 web_search 和 web_fetch'));
  assert.ok(contexts[1]?.includes('toolResult')); assert.ok(contexts[1]?.includes(source));
  assert.ok(contexts[2]?.includes('当日限额为 100 元'));
  assert.ok(result.content.includes(source));
  assert.equal(result.usage.web_search_requests, 1); assert.equal(result.usage.web_fetch_requests, 1);
  assert.equal(result.usage.tool_calls, 2); assert.equal(result.usage.model_requests, 3);
  assert.deepEqual(fixture.events.filter(e => e.kind === 'tool_start').map(e => e.body.tool), ['web_search', 'web_fetch']);
  assert.equal(fixture.events.at(-1)?.body.web_fetch_requests, 1);
  assert.equal(contexts.join('').includes(searchKey), false);
  assert.equal(JSON.stringify(fixture.events).includes(searchKey), false);
});

test('without search configuration Pi is told truthfully that no web tools are available', async () => {
  const contexts: string[] = [];
  await executeRun(input(), settings, bridge().value, undefined, undefined,
    fakeStream([final], value => { contexts.push(JSON.stringify(value)); }));
  assert.ok(contexts[0]?.includes('当前未配置联网搜索'));
  assert.equal(contexts[0]?.includes('已提供 web_search'), false);
});

test('web tool schema validation and total tool budget stop API calls before dispatch', async () => {
  let requests = 0;
  const web = createDeepSeekWeb({ apiKey: 'fixture', searches: 4, fetches: 4 }, async () => {
    requests++; return Response.json({ results: [] });
  });
  const searchCall = (id: string, args: { query: string; count?: number }) => ({ type: 'toolCall' as const, id, name: 'web_search', arguments: args });
  await executeRun(input(), settings, bridge().value, undefined, undefined,
    fakeStream([[searchCall('invalid', { query: '公告', count: 100 })], final]), web);
  assert.equal(requests, 0);
  await assert.rejects(executeRun(input(), settings, bridge().value, undefined, { turns: 5, tools: 1, timeoutMs: 1000 },
    fakeStream([[searchCall('first', { query: '公告' }), searchCall('second', { query: '公告' })], final]), web),
  error => error instanceof RunError && error.code === 'step_limit');
  assert.equal(requests, 1);
});

test('reserved web tool names cannot be replaced by a business tool definition', async () => {
  const fixture = bridge();
  await assert.rejects(executeRun({ ...input(), tools: [{ name: 'web_search', description: 'untrusted', parameters: { type: 'object' } }] },
    settings, fixture.value, undefined, undefined, fakeStream([final])),
  error => error instanceof RunError && error.code === 'invalid_request');
  assert.equal(fixture.effects.length, 0); assert.equal(fixture.events.length, 0);
});

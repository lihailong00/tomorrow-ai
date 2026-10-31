import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { resolveModel } from './config.js';
import { executeRun, RunError, safeToolResult, validateRun, type Bridge, type RunEvent, type RunInput } from './runtime.js';
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

function deltaStream(replies: AssistantMessage['content'][], deltas?: (string[] | null)[]): StreamFn {
  let index = 0;
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const turn = Math.min(index++, replies.length - 1);
    const content = replies[turn]!;
    const tool = content.some(c => c.type === 'toolCall');
    const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), stopReason: tool ? 'toolUse' : 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      content.forEach((part, contentIndex) => {
        if (part.type !== 'text') return;
        if (deltas?.[turn] === null) return;
        stream.push({ type: 'text_start', contentIndex, partial: message });
        for (const delta of deltas?.[turn] ?? [part.text]) {
          stream.push({ type: 'text_delta', contentIndex, delta, partial: message });
        }
        stream.push({ type: 'text_end', contentIndex, content: part.text, partial: message });
      });
      stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message });
    });
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

test('personal MCP bridge can discover tools at runtime and preserves user confirmation boundary', async () => {
  const request = input();
  request.messages = [{ role: 'user', content: '查看我的滴滴车型，并准备叫车。' }];
  request.tools = ['list_mcp_connections', 'list_mcp_tools', 'call_mcp_tool', 'get_mcp_action'].map(name => ({
    name, description: name, parameters: { type: 'object', properties: {
      provider: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' }, id: { type: 'string' },
    } },
  }));
  validateRun(request);
  const called: { name: string; args: unknown }[] = [];
  const contexts: string[] = [];
  const fixture = bridge();
  fixture.value.tool = async (name, args) => {
    called.push({ name, args });
    if (name === 'list_mcp_connections') return { items: [{ id: 'didi', status: 'connected' }] };
    if (name === 'list_mcp_tools') return { items: [{ name: 'taxi_estimate', inputSchema: { type: 'object' } },
      { name: 'taxi_create_order', inputSchema: { type: 'object' } }] };
    if ((args as { tool?: string }).tool === 'taxi_estimate') return { content: [{ type: 'text', text: '快车预估 30 元' }] };
    return { status: 'confirmation_required', action: { id: 'pending-operation', status: 'pending', tool: 'taxi_create_order' } };
  };
  const toolCall = (name: string, args: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>['arguments'], id: number): AssistantMessage['content'] =>
    [{ type: 'toolCall', id: `mcp-${id}`, name, arguments: args }];
  const result = await executeRun(request, settings, fixture.value, undefined, undefined, fakeStream([
    toolCall('list_mcp_connections', {}, 1),
    toolCall('list_mcp_tools', { provider: 'didi' }, 2),
    toolCall('call_mcp_tool', { provider: 'didi', tool: 'taxi_estimate', arguments: {} }, 3),
    toolCall('call_mcp_tool', { provider: 'didi', tool: 'taxi_create_order', arguments: { estimate_trace_id: 'estimate-id' } }, 4),
    [{ type: 'text', text: '快车预估 30 元。叫车请求尚未执行，请到“我的连接”检查并确认。' }],
  ], context => contexts.push(JSON.stringify(context))));
  assert.equal(called.length, 4);
  assert.deepEqual(called.map(item => item.name), ['list_mcp_connections', 'list_mcp_tools', 'call_mcp_tool', 'call_mcp_tool']);
  assert.ok(contexts.at(-1)?.includes('confirmation_required'));
  assert.ok(contexts[0]?.includes('不能代替用户确认'));
  assert.ok(result.content.includes('尚未执行'));
  assert.ok(!request.tools.some(tool => /confirm|credential|token/.test(tool.name)));
});

test('run validation permits the integrated MCP tool set and retains a bounded tool budget', () => {
  const request = input();
  request.tools = Array.from({ length: 64 }, () => ({ ...request.tools[0]! }));
  assert.doesNotThrow(() => validateRun(request));
  request.tools.push({ ...request.tools[0]! });
  assert.throws(() => validateRun(request), (error: unknown) => error instanceof RunError && error.code === 'invalid_request');
});

test('oversized MCP reads report omitted content instead of claiming the whole document was read', () => {
  const result = JSON.parse(safeToolResult({ status: 'completed', result: {
    content: [{ type: 'text', text: 'x'.repeat(60000) }],
  } }, 'call_mcp_tool'));
  assert.equal(result.error.code, 'tool_result_too_large');
  assert.equal(result.truncated, true);
  assert.equal(result.operation_succeeded, undefined);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
});

test('large read pages remain valid JSON with continuation at the first omitted item', () => {
  const value = { items: Array.from({ length: 30 }, (_, id) => ({ id: `id-${id}`, content: '中文😀\\\"\n'.repeat(200) })),
    offset: 500, next_offset: 530, has_more: true, detail_tool: 'get_memory' };
  const text = safeToolResult(value, 'list_memories');
  assert.ok(text.length <= 48000);
  const result = JSON.parse(text);
  assert.ok(result.items.length > 0 && result.items.length < 30);
  assert.equal(result.next_offset, 500 + result.items.length);
  assert.equal(result.detail_tool, 'get_memory');
  assert.equal(result.has_more, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.items, value.items.slice(0, result.items.length));
});

test('a single oversized read result is explicit and never advances past unread data', () => {
  const result = JSON.parse(safeToolResult({ items: [{ id: 'long', content: '😀'.repeat(50000) }],
    offset: 500, next_offset: 501, has_more: true, detail_tool: 'get_memory' }, 'list_memories'));
  assert.equal(result.error.code, 'tool_result_too_large');
  assert.equal(result.next_offset, 500);
  assert.equal(result.source_next_offset, 501);
  assert.equal(result.detail_tool, 'get_memory');
});

test('large committed mutation responses preserve confirmation, operation identity and retrieval', () => {
  for (const [tool, read] of [['save_memory', 'get_memory'], ['create_task', 'get_task'], ['create_schedule', 'get_schedule']]) {
    const result = JSON.parse(safeToolResult({ value: { id: 'committed-id', status: 'waiting_approval',
      enabled: false, version: 4, content: 'x'.repeat(60000) }, replayed: false, operation_id: 'effect-id' }, tool!));
    assert.equal(result.operation_succeeded, true);
    assert.equal(result.operation_id, 'effect-id');
    assert.equal(result.value.id, 'committed-id');
    assert.equal(result.value.status, 'waiting_approval');
    assert.equal(result.value.enabled, false);
    assert.equal(result.value.version, 4);
    assert.equal(result.replayed, false);
    assert.equal(result.retrieval.tool, read);
  }
});

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

test('the real Pi loop completes 100 searches plus 100 reads beyond the old tool, turn and task-event caps', { timeout: 15000 }, async () => {
  const fixture = bridge(); let searches = 0, fetches = 0;
  const replies: AssistantMessage['content'][] = [];
  for (let i = 1; i <= 100; i++) {
    replies.push([{ type: 'toolCall', id: `research-search-${i}`, name: 'web_search', arguments: { query: `synthetic notice ${i}` } }]);
    replies.push([{ type: 'toolCall', id: `research-fetch-${i}`, name: 'web_fetch', arguments: { url: `https://www.chinaamc.com/fixture-${i}` } }]);
  }
  replies.push([{ type: 'text', text: 'Completed the 100 synthetic searches and 100 synthetic page reads.' }]);
  const web = createDeepSeekWeb({ apiKey: 'never-paid-fixture-key', searches: 100, fetches: 100 }, async url => {
    if (String(url).endsWith('/search')) { searches++; return Response.json({ results: [] }); }
    fetches++; return Response.json({ title: 'Synthetic notice', content: 'This is synthetic local test data.' });
  });
  let observedInitialBudget = false, observedFinalBudget = false, observedRequests = 0;
  const result = await executeRun({ ...input(), scope: 'task' }, settings, fixture.value, undefined, undefined,
    fakeStream(replies, context => {
      const messages = (context as { messages: Message[] }).messages;
      if (observedRequests++ === 0) observedInitialBudget = JSON.stringify(context).includes('最多搜索 100 次、网页读取 100 次');
      const last = messages.at(-1);
      if (last?.role === 'toolResult' && last.toolCallId === 'research-fetch-100') {
        const part = last.content.find(item => item.type === 'text');
        if (part?.type === 'text') {
          const budget = JSON.parse(part.text).web_budget;
          observedFinalBudget = budget.search.remaining === 0 && budget.fetch.remaining === 0;
        }
      }
    }), web);
  assert.equal(searches, 100); assert.equal(fetches, 100);
  assert.equal(result.usage.web_search_requests, 100); assert.equal(result.usage.web_fetch_requests, 100);
  assert.equal(result.usage.tool_calls, 200); assert.equal(result.usage.model_requests, 201);
  assert.equal(observedRequests, 201);
  assert.equal(fixture.effects.length, 0);
  assert.equal(fixture.events.filter(event => event.kind === 'tool_start').length, 200);
  assert.equal(fixture.events.filter(event => event.kind === 'tool_end').length, 200);
  assert.ok(fixture.events.length > 500); assert.ok(fixture.events.length <= 2000);
  assert.equal(fixture.events.at(-1)?.kind, 'finished');
  assert.equal(fixture.events.at(-1)?.body.web_search_requests, 100);
  assert.equal(observedInitialBudget, true); assert.equal(observedFinalBudget, true);
  assert.equal(JSON.stringify(fixture.events).includes('never-paid-fixture-key'), false);
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

test('real timed provider SSE reaches the bridge before upstream completion and preserves tool-turn order', { timeout: 8000 }, async () => {
  const fixture = bridge();
  let requests = 0, firstTextAt = 0, firstUpstreamEndAt = 0, callbackActive = 0, callbackMaximum = 0;
  let providerFailure: unknown;
  let releaseFirstText!: () => void;
  const firstTextDelivered = new Promise<void>(resolve => { releaseFirstText = resolve; });
  const provider = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* Consume only local fixture input. */ }
      const turn = ++requests;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const common = { id: `timed-${turn}`, object: 'chat.completion.chunk', created: 1, model: 'timed-fixture' };
      const chunk = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({
        ...common, choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
      })}\n\n`);
      if (turn === 1) {
        chunk({ role: 'assistant', reasoning_content: 'private-reasoning-never-publish' });
        chunk({ content: '先检查。' });
        // The provider deliberately cannot finish until real text has crossed
        // the callback boundary. A final-response typing effect cannot pass.
        await firstTextDelivered;
        chunk({ tool_calls: [{ index: 0, id: 'timed-save', type: 'function', function: {
          name: 'save_memory', arguments: '{"content":"private-raw-tool-arguments"}',
        } }] });
        chunk({}, 'tool_calls');
        firstUpstreamEndAt = performance.now();
      } else {
        chunk({ role: 'assistant', content: '已' });
        await new Promise(resolve => setTimeout(resolve, 20)); chunk({ content: '保' });
        await new Promise(resolve => setTimeout(resolve, 20)); chunk({ content: '存' });
        await new Promise(resolve => setTimeout(resolve, 85)); chunk({ content: '。' });
        chunk({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    })().catch(error => { providerFailure = error; response.destroy(); });
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  const localSettings = resolveModel({ MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    MODEL_NAME: 'timed-fixture', MODEL_API_KEY: 'local-fixture-key-never-publish' });
  fixture.value.event = async event => {
    callbackMaximum = Math.max(callbackMaximum, ++callbackActive);
    await new Promise(resolve => setTimeout(resolve, 3));
    fixture.events.push(event);
    callbackActive--;
    if (event.kind === 'text_delta' && !firstTextAt) { firstTextAt = performance.now(); releaseFirstText(); }
  };
  fixture.value.tool = async (name, args, _signal, operationIndex) => {
    assert.equal(fixture.events.at(-1)?.kind, 'tool_start');
    assert.equal(operationIndex, 1);
    fixture.effects.push({ name, args });
    return { value: { id: 'fixture-memory' } };
  };
  try {
    const result = await executeRun(input(), localSettings, fixture.value, undefined,
      { turns: 5, tools: 5, timeoutMs: 5000 });
    assert.equal(providerFailure, undefined);
    assert.equal(requests, 2); assert.equal(fixture.effects.length, 1);
    assert.equal(result.content, '先检查。\n\n已保存。');
    assert.ok(firstTextAt > 0 && firstTextAt < firstUpstreamEndAt);
    assert.equal(callbackMaximum, 1);
    assert.deepEqual(fixture.events.map(event => event.sequence), fixture.events.map((_event, index) => index + 7));
    const texts = new Map<number, string>();
    for (const event of fixture.events.filter(event => event.kind === 'text_delta')) {
      const turn = event.body.turn as number;
      texts.set(turn, (texts.get(turn) ?? '') + event.body.delta);
    }
    assert.equal([...texts.values()].join('\n\n'), result.content);
    const kinds = fixture.events.map(event => event.kind);
    assert.ok(kinds.indexOf('text_delta') < kinds.indexOf('tool_start'));
    assert.ok(kinds.indexOf('tool_start') < kinds.indexOf('tool_end'));
    assert.ok(kinds.indexOf('tool_end') < kinds.indexOf('turn'));
    assert.equal(kinds.at(-1), 'finished');
    assert.deepEqual(fixture.events.filter(event => event.kind === 'text_start').map(event => event.body.turn), [1, 2]);
    for (const forbidden of ['private-reasoning-never-publish', 'private-raw-tool-arguments',
      localSettings.apiKey, input().run_token, '"arguments"']) {
      assert.equal(JSON.stringify(fixture.events).includes(forbidden), false);
    }
  } finally {
    releaseFirstText();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
});

test('chat keeps genuine visible tool-turn text while task output retains the final answer contract', async () => {
  const replies: AssistantMessage['content'][] = [[{ type: 'text', text: '先保存偏好。' }, ...call],
    [{ type: 'text', text: '\n已保存。\n' }]];
  const chat = bridge();
  const result = await executeRun(input(), settings, chat.value, undefined, undefined, deltaStream(replies));
  assert.equal(result.content, '先保存偏好。\n\n\n已保存。\n');
  assert.equal(chat.events.filter(event => event.kind === 'text_delta').map(event => event.body.delta).join('\n\n'), result.content);
  const task = bridge();
  const taskResult = await executeRun({ ...input(), scope: 'task' }, settings, task.value, undefined, undefined, deltaStream(replies));
  assert.equal(taskResult.content, '已保存。');
  assert.equal(task.events.some(event => event.kind.startsWith('text_')), false);
});

test('large genuine deltas stay Unicode-safe and bounded before the final event', async () => {
  const fixture = bridge();
  const text = '中文😀'.repeat(10000);
  const result = await executeRun(input(), settings, fixture.value, undefined,
    { turns: 20, tools: 40, timeoutMs: 5000 }, deltaStream([[{ type: 'text', text }]]));
  const deltas = fixture.events.filter(event => event.kind === 'text_delta').map(event => event.body.delta as string);
  assert.equal(deltas.join(''), text); assert.equal(result.content, text);
  assert.ok(deltas.length > 1);
  assert.ok(deltas.every(delta => Buffer.byteLength(delta, 'utf8') <= 12000 && !delta.includes('\ufffd')));
  assert.ok(fixture.events.length <= 500);
  assert.equal(fixture.events.at(-1)?.kind, 'finished');
});

test('a failed text callback is observed and stops before any business operation', async () => {
  const fixture = bridge();
  fixture.value.event = async event => {
    fixture.events.push(event);
    if (event.kind === 'text_delta') throw new Error('fixture callback failure with private details');
  };
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined, undefined,
    deltaStream([[{ type: 'text', text: '先保存。' }, ...call], final])),
  error => error instanceof RunError && error.code === 'event_failed');
  assert.equal(fixture.effects.length, 0);
  assert.equal(fixture.events.some(event => event.kind === 'tool_start' || event.kind === 'finished'), false);
});

test('cancelling a pending text batch clears its timer and never emits late text or success', { timeout: 3000 }, async () => {
  const fixture = bridge(); const controller = new AbortController();
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const source: StreamFn = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '先' }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: '先', partial: message }); });
    void first.then(() => {
      message.content = [{ type: 'text', text: '先稍等' }];
      stream.push({ type: 'text_delta', contentIndex: 0, delta: '稍等', partial: message });
      releaseSecond();
    });
    options?.signal?.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
    }, { once: true });
    return stream;
  };
  fixture.value.event = async event => {
    fixture.events.push(event);
    if (event.kind === 'text_delta') releaseFirst();
  };
  const running = executeRun(input(), settings, fixture.value, controller.signal,
    { turns: 5, tools: 5, timeoutMs: 1500 }, source);
  const rejected = assert.rejects(running, error => error instanceof RunError && error.code === 'cancelled');
  await second;
  // Let Pi observe the second actual upstream delta before aborting its batch.
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await rejected;
  const count = fixture.events.length;
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(fixture.events.length, count);
  assert.equal(fixture.events.filter(event => event.kind === 'text_delta').map(event => event.body.delta).join(''), '先');
  assert.equal(fixture.events.some(event => event.kind === 'finished'), false);
  assert.equal(fixture.effects.length, 0);
});

test('mixed delta and final-only provider turns cannot finalize text absent from the stream', async () => {
  for (const deltas of [[null, ['已保存。']], [['先保存。'], null]]) {
    const fixture = bridge();
    await assert.rejects(executeRun(input(), settings, fixture.value, undefined, undefined,
      deltaStream([[{ type: 'text', text: '先保存。' }, ...call], [{ type: 'text', text: '已保存。' }]], deltas)),
    error => error instanceof RunError && error.code === 'model_failed');
    assert.equal(fixture.events.some(event => event.kind === 'finished'), false);
    assert.equal(fixture.effects.length, 1);
  }
});

test('a provider splitting an emoji between JSON chunks never posts a lone surrogate', async () => {
  const fixture = bridge();
  const result = await executeRun(input(), settings, fixture.value, undefined, undefined,
    deltaStream([[{ type: 'text', text: '😀完成。' }]], [['\ud83d', '\ude00', '完成。']]));
  const deltas = fixture.events.filter(event => event.kind === 'text_delta').map(event => event.body.delta as string);
  assert.equal(deltas[0], '😀');
  assert.equal(deltas.join(''), result.content);
  assert.equal(result.content, '😀完成。');
  assert.equal(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/.test(JSON.stringify(fixture.events)), false);
  const invalid = bridge();
  await assert.rejects(executeRun(input(), settings, invalid.value, undefined, undefined,
    deltaStream([[{ type: 'text', text: '\ud83d' }]], [['\ud83d']])),
  error => error instanceof RunError && error.code === 'model_failed');
  assert.equal(invalid.events.some(event => event.kind === 'text_delta' || event.kind === 'finished'), false);
});

test('a delayed batch timer observes the deadline without an uncaught timer exception', { timeout: 3000 }, async () => {
  const fixture = bridge();
  let releaseFirst!: () => void;
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const source: StreamFn = (model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: '先后' }], api: model.api,
      provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: '先', partial: message }); });
    void first.then(() => {
      stream.push({ type: 'text_delta', contentIndex: 0, delta: '后', partial: message });
      setImmediate(() => {
        // Make the 60ms batch timer due before the 100ms run timer, then delay
        // both until past the monotonic deadline. No external work is involved.
        const until = performance.now() + 125;
        while (performance.now() < until) { /* Deliberate fixture event-loop delay. */ }
      });
    });
    options?.signal?.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
    }, { once: true });
    return stream;
  };
  fixture.value.event = async event => {
    fixture.events.push(event);
    if (event.kind === 'text_delta') releaseFirst();
  };
  await assert.rejects(executeRun(input(), settings, fixture.value, undefined,
    { turns: 5, tools: 5, timeoutMs: 100 }, source),
  error => error instanceof RunError && error.code === 'timeout');
  assert.equal(fixture.events.filter(event => event.kind === 'text_delta').map(event => event.body.delta).join(''), '先');
  assert.equal(fixture.events.some(event => event.kind === 'finished'), false);
});

test('opt-in chats add global mutation slots while preserving existing per-tool indices', async () => {
  const mixedInput: RunInput = { ...input(), operation_slots: true, tools: [...input().tools,
    { name: 'create_task', description: 'fixture task', parameters: input().tools[0]!.parameters },
    { name: 'list_memories', description: 'fixture read', parameters: { type: 'object', properties: {}, additionalProperties: false } }] };
  const mixedCalls: AssistantMessage['content'] = [
    { type: 'toolCall', id: 'read-first', name: 'list_memories', arguments: {} },
    { type: 'toolCall', id: 'save-first', name: 'save_memory', arguments: { content: 'one' } },
    { type: 'toolCall', id: 'task-first', name: 'create_task', arguments: { content: 'two' } },
    { type: 'toolCall', id: 'save-second', name: 'save_memory', arguments: { content: 'three' } },
  ];
  for (const request of [mixedInput, { ...mixedInput, operation_slots: false },
    { ...mixedInput, operation_slots: undefined }, { ...mixedInput, scope: 'task' as const }]) {
    const fixture = bridge();
    const observed: { name: string; index?: number; slot?: number }[] = [];
    fixture.value.tool = async (name, _args, _signal, index, slot) => {
      observed.push({ name, index, slot }); return { value: { id: 'fixture' } };
    };
    await executeRun(request, settings, fixture.value, undefined, undefined, fakeStream([mixedCalls, final]));
    assert.deepEqual(observed.map(value => value.index), [1, 1, 1, 2]);
    assert.deepEqual(observed.map(value => value.slot), request.scope === 'chat' && request.operation_slots
      ? [undefined, 1, 2, 3] : [undefined, undefined, undefined, undefined]);
  }
  assert.throws(() => validateRun({ ...mixedInput, operation_slots: 'true' }));
});

test('an opt-in retry changing the tool in an existing mutation slot stops without a second write', async () => {
  const request: RunInput = { ...input(), operation_slots: true, tools: [...input().tools,
    { name: 'create_task', description: 'fixture task', parameters: input().tools[0]!.parameters }] };
  const receipts = new Map<number, string>();
  let effects = 0;
  const fixture = bridge();
  fixture.value.tool = async (name, args, _signal, index, slot) => {
    assert.ok(slot);
    const identity = JSON.stringify({ name, args, index });
    if (receipts.has(slot)) {
      if (receipts.get(slot) !== identity) throw new RunError('agent_replay_conflict', 'fixture changed mutation slot');
      return { value: { id: 'fixture' }, replayed: true };
    }
    receipts.set(slot, identity); effects++;
    return { value: { id: 'fixture' }, replayed: false };
  };
  await executeRun(request, settings, fixture.value, undefined, undefined, fakeStream([call, final]));
  await executeRun(request, settings, fixture.value, undefined, undefined, fakeStream([call, final]));
  assert.equal(effects, 1);
  fixture.events.length = 0;
  await assert.rejects(executeRun(request, settings, fixture.value, undefined, undefined,
    fakeStream([[{ type: 'toolCall', id: 'changed-tool', name: 'create_task', arguments: { content: '喜欢简洁回答' } }], final])),
  error => error instanceof RunError && error.code === 'agent_replay_conflict');
  assert.equal(effects, 1);
  assert.equal(fixture.events.some(event => event.kind === 'finished'), false);
});

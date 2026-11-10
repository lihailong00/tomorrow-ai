import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveModel } from './config.js';
import { queryPreparation } from './query-rewrite.js';
import type { RunInput } from './runtime.js';
import { captureRuntimeContext } from './request-context.js';
import { ToolSearchSession } from './tool-search.js';

const settings = resolveModel({ DEEPSEEK_API_KEY: 'fixture-only-key' });
const user = (content: string) => ({ role: 'user', content });
const run = (...messages: RunInput['messages']): RunInput => ({
  run_id: '11111111-1111-4111-8111-111111111111', run_token: '0'.repeat(64), scope: 'chat', tools: [], messages,
});
const complex = run(user('查飞猪去成都的航班，找到最低价后再查它落地机场附近的酒店。'));
const planned = { steps: [{ query: '飞猪查询航班最低价', after: [] }, { query: '飞猪搜索落地机场附近酒店', after: [1] }] };

test('simple, standalone and background requests skip extra model calls', () => {
  for (const request of [run(user('你好')), run(user('查询我的邮箱')), run(user('查一下测试资料，然后简短回答。')),
    run(user('查飞猪航班'), user('解释一下什么叫中转航班')), { ...complex, scope: 'task' as const }]) {
    assert.equal(queryPreparation(request, settings), undefined);
  }
  assert.ok(queryPreparation(run(user('在我导入的 Claude 对话里，哪一条讨论了北辰备份？'),
    { role: 'assistant', content: '可能是北辰备份复盘' }, user('还是刚才那条，读正文。')), settings));
});

test('trusted location can resolve a simple reference while cross-app requests still plan', () => {
  const ride = run(user('从我这里打车去机场多少钱？'));
  assert.ok(queryPreparation(ride, settings));
  const context = captureRuntimeContext();
  assert.equal(queryPreparation({ ...ride, runtime_context: { ...context, location_status: 'available',
    location: { source: 'manual', observed_at: context.server_time_utc, label: '测试地标' } } }, settings), undefined);
  assert.ok(queryPreparation(run(user('查我的邮件，再看看腾讯文档有没有同名纪要。')), settings));
});

test('planner sends bounded conversational data and accepts dependencies only between actual steps', async () => {
  const input = { ...complex, messages: [{ role: 'system', content: 'SYSTEM_ONLY_ATTACHMENT' }, ...complex.messages] };
  const prepare = queryPreparation(input, settings)!;
  const prepared = await prepare(async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, false);
    assert.equal(body.thinking.type, 'disabled');
    assert.doesNotMatch(String(init?.body), /SYSTEM_ONLY_ATTACHMENT|fixture-only-key/);
    assert.match(String(init?.body), /成都/);
    return Response.json({ choices: [{ message: { content: JSON.stringify(planned) } }],
      usage: { prompt_tokens: 22, completion_tokens: 9 } });
  }, new AbortController().signal);
  assert.deepEqual(prepared.queries, planned.steps.map(step => step.query));
  assert.match(prepared.instruction, /"after":\[1\]/);
  assert.equal(prepared.measurements.output_tokens, 9);
  assert.deepEqual(input.messages.at(-1), complex.messages.at(-1));
});

test('invalid plans and unavailable providers fall back, while run cancellation propagates', async () => {
  const prepare = queryPreparation(complex, settings)!;
  const controller = new AbortController();
  for (const body of ['not-json', '{"steps":[{"query":"搜索航班","after":[1]}]}']) {
    const response = Response.json({ choices: [{ message: { content: body } }] });
    assert.equal((await prepare(async () => response, controller.signal)).instruction, '');
  }
  assert.equal((await prepare(async () => new Response(null, { status: 503 }), controller.signal)).instruction, '');
  controller.abort();
  await assert.rejects(prepare(async () => assert.fail('network must not be called'), controller.signal), { name: 'AbortError' });
});

test('preselection only exposes read tools present in this run and performs no provider calls', () => {
  const definitions = ['search_ai_history', 'read_ai_history', 'save_memory', 'list_mcp_tools'].map(name =>
    ({ name, description: '搜索导入的 Claude 对话、读取历史 AI 对话正文', parameters: { type: 'object' } }));
  const search = new ToolSearchSession(definitions, async () => assert.fail('preselection cannot execute discovery'));
  search.primeReadTools(['搜索导入的 Claude 对话', '读取历史 AI 对话正文']);
  assert.deepEqual(search.loaded.map(tool => tool.name).sort(), ['read_ai_history', 'search_ai_history']);
});

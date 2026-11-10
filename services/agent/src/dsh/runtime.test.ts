import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { executeDshRun, childEnvironment, dshPatches } from './runtime.js';
import { resolveModel } from '../config.js';
import { executeHarness, selectHarness } from '../harness.js';
import { createDeepSeekWeb } from '../web.js';
import { renderNews } from '../daily-news.js';
import { StreamTextBuffer } from './text-buffer.js';
import { executeRun, RunError, type Bridge, type RunEvent, type RunInput } from '../runtime.js';
import { ToolSearchSession } from '../tool-search.js';

const input: RunInput = { run_id: '12345678-1234-1234-1234-123456789abc', run_token: 'a'.repeat(64),
  scope: 'chat', operation_slots: true, messages: [{ role: 'user', content: '帮我查一下测试资料，然后简短回答。' }],
  tools: [{ name: 'lookup', description: '查询测试资料', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }] };
const chunk = (res: ServerResponse, delta: unknown, reason: string | null = null) => res.write(`data: ${JSON.stringify({
  id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'test-model',
  choices: [{ index: 0, delta, finish_reason: reason }],
})}\n\n`);

for (const harness of ['pi', 'dsh'] as const) {
  test(`${harness} continues the original task after a personal-data action returns a real address ID`, { timeout: 90000 }, async () => {
    const events: RunEvent[] = []; const calls: string[] = []; let turns = 0;
    const definitions = ['prepare_personal_tool', 'call_mcp_tool'].map(name => ({ name, description: name,
      parameters: { type: 'object', properties: { provider: { type: 'string' }, tool: { type: 'string' }, purpose: { type: 'string' }, subject: { type: 'string' }, arguments: { type: 'object' } } } }));
    const lazy = new ToolSearchSession(definitions, async () => { throw new Error('unexpected discovery'); });
    assert.ok(lazy.loaded.some(tool => tool.name === 'prepare_personal_tool'));
    const fixture = await modelFixture((request, res) => {
      turns++;
      assert.ok(!JSON.stringify(request.messages).includes('13800000000'));
      if (turns === 2) assert.match(JSON.stringify(request.messages), /fixture-address-1/);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const step = turns === 1 ? { name: 'prepare_personal_tool', arguments: { provider: 'mcdonalds', tool: 'delivery-create-address', purpose: '配送到家', subject: 'home' } }
        : turns === 2 ? { name: 'call_mcp_tool', arguments: { provider: 'mcdonalds', tool: 'delivery-query-stores', arguments: { addressId: 'fixture-address-1' } } } : null;
      if (step) chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: `personal-${turns}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] });
      else chunk(res, { role: 'assistant', content: '配送地址已保存，已继续查到可配送门店。' });
      chunk(res, {}, step ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
    });
    try {
      const request = { ...input, tools: definitions, messages: [{ role: 'user', content: '帮我查麦当劳送到家' }] };
      const bridge: Bridge = { state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); },
        tool: async (name, args, _signal, operation) => {
          calls.push(name); assert.equal(operation, 1);
          if (name === 'prepare_personal_tool') return { status: 'completed', receipt: { result: { addressId: 'fixture-address-1' } } };
          assert.deepEqual(args, { provider: 'mcdonalds', tool: 'delivery-query-stores', arguments: { addressId: 'fixture-address-1' } });
          return { status: 'completed', result: { stores: [{ name: '合成配送门店' }] } };
        } };
      const result = harness === 'dsh'
        ? await executeDshRun(request, fixture.settings, bridge, undefined, { turns: 4, tools: 3, timeoutMs: 60000 })
        : await executeRun(request, fixture.settings, bridge, undefined, { turns: 4, tools: 3, timeoutMs: 60000 });
      assert.deepEqual(calls, ['prepare_personal_tool', 'call_mcp_tool']);
      assert.match(result.content, /继续查到/);
      assert.ok(!JSON.stringify(events).includes('fixture-address-1'));
    } finally { await fixture.close(); }
  });
}

test('DSH prepares a personal Alipay order and queries its state without any authorization or payment-confirm tool', { timeout: 90000 }, async () => {
  const events: RunEvent[]=[];const calls:string[]=[];let turns=0;
  const definitions=['alipay_wallet_status','prepare_alipay_payment','get_alipay_payment','list_alipay_transactions'].map(name=>({name,description:name,parameters:{type:'object',properties:{title:{type:'string'},merchant:{type:'string'},amount:{type:'string'},payment_link:{type:'string'},id:{type:'string'}}}}));
  const fixture=await modelFixture((request,res)=>{
    turns++;const tools=request.tools as {function:{name:string}}[];
    assert.deepEqual(tools.map(tool=>tool.function.name).sort(),definitions.map(tool=>tool.name).sort());
    assert.match(JSON.stringify(request.messages),/支付宝个人钱包/);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const step= turns===1 ? {name:'alipay_wallet_status',arguments:{}} : turns===2 ? {name:'prepare_alipay_payment',arguments:{title:'测试咖啡',merchant:'示例门店',amount:'12.30',payment_link:'https://cashier.alipay.com/fixture'}} : turns===3 ? {name:'get_alipay_payment',arguments:{id:'synthetic-payment'}} : null;
    if(step) chunk(res,{role:'assistant',tool_calls:[{index:0,id:`wallet-${turns}`,type:'function',function:{name:step.name,arguments:JSON.stringify(step.arguments)}}]});
    else chunk(res,{role:'assistant',content:'付款请求已准备好，请核对当前对话中的付款确认卡。'});
    chunk(res,{},step?'tool_calls':'stop');res.end('data: [DONE]\n\n');
  });
  try {
    const result=await executeDshRun({...input,messages:[{role:'user',content:'请准备这份测试咖啡订单，先不要付款'}],tools:definitions},fixture.settings,{
      state:async()=>({next_sequence:events.length}),event:async event=>{events.push(event);},
      tool:async(name)=>{calls.push(name);return name==='alipay_wallet_status'?{id:'alipay',status:'connected',binding_available:true,payment_available:true}:{id:'synthetic-payment',status:'pending',title:'测试咖啡',merchant:'示例门店',amount:'12.30'};},
    },undefined,{turns:5,tools:4,timeoutMs:60000});
    assert.deepEqual(calls,['alipay_wallet_status','prepare_alipay_payment','get_alipay_payment']);
    assert.match(result.content,/当前对话中的付款确认卡/);assert.equal(turns,4);
    assert.ok(!JSON.stringify(events).includes('cashier.alipay.com/fixture'));
  } finally {await fixture.close();}
});

test('DSH daily news uses current real source IDs and renders only trusted URLs', { timeout: 90000 }, async () => {
  const events: RunEvent[] = [];
  const web = createDeepSeekWeb({ apiKey: 'fixture', searches: 4, fetches: 1 }, async (_url, request) => {
    assert.match(String(request?.body), /人工智能/);
    return Response.json({ results: [
      { title: '测试新闻', url: 'https://news.example.org/today', date: '2026-11-05', summary: '来源中的可核实事实。' },
      { title: '过期新闻', url: 'https://news.example.org/old', date: '2026-10-05', summary: '过期资料。' },
    ] });
  });
  const fixture = await modelFixture((request, res) => {
    const messages = JSON.stringify(request.messages);
    assert.match(messages, /每日新闻简报编辑/);
    assert.match(messages, /来源中的可核实事实/);
    assert.doesNotMatch(messages, /过期新闻/);
    assert.deepEqual(request.tools ?? [], []);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { role: 'assistant', content: '{"items":[{"source_id":"s1","summary":"根据来源整理的一句话。"}]}' });
    chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n');
  });
  try {
    const result = await executeHarness({ ...input, harness: 'dsh', scope: 'task', tools: [],
      daily_news: { topics: ['人工智能'], date: '2026-11-05' } }, fixture.settings, {
      state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); },
      tool: async () => { throw new Error('unexpected business tool'); },
    }, undefined, { turns: 4, tools: 3, timeoutMs: 60000 }, web);
    assert.match(result.content, /\[阅读原文\]\(https:\/\/news\.example\.org\/today\)/);
    assert.equal(result.usage.web_search_requests, 1);
    assert.throws(() => renderNews('2026-11-05', '{"items":[{"source_id":"invented","summary":"虚构引用"}]}', []));
  } finally { await fixture.close(); }
});

test('manual engine selection and scrubbed child credentials', () => {
  assert.equal(selectHarness(undefined), 'pi'); assert.equal(selectHarness('dsh'), 'dsh');
  assert.throws(() => selectHarness('unknown'));
  const env = childEnvironment('/run', 'http://127.0.0.1:123', 'nonce', 'system', { PATH: 'bin',
    MODEL_API_KEY: 'secret', AGENT_SERVICE_TOKEN: 'secret', NODE_OPTIONS: '--require malicious', HTTP_PROXY: 'secret' });
  assert.equal(env.MODEL_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AGENT_SERVICE_TOKEN, undefined); assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HOME, '/run'); assert.equal(env.PATH, 'bin');
});

test('DSH waits for the location card and passes the nearby map result to the model', { timeout: 90000 }, async () => {
  const calls: { name: string; args: unknown }[] = [];
  let request: Record<string, unknown> = {};
  const fixture = await modelFixture((incoming, response) => {
    request = incoming;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseText(response, '已查到示例宠物医院。');
  });
  const events: RunEvent[] = [];
  const tools = ['request_location', 'list_integrations', 'read_integration'].map(name => ({ name, description: name,
    parameters: { type: 'object', properties: {} } }));
  try {
    const result = await executeDshRun({ ...input, tools, messages: [{ role: 'user', content: '那你看下附近有什么宠物医院吧，我想赶紧去。' }] },
      fixture.settings, { state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); },
        tool: async (name, args) => {
          calls.push({ name, args });
          if (name === 'request_location') return { status: 'answered', location: { source: 'manual', label: '上海张江地铁站' } };
          if (name === 'list_integrations') return { items: [{ id: 'amap', status: 'connected' }] };
          return { source: 'amap', operation: 'nearby', status: 'completed', items: [{ title: '示例宠物医院' }] };
        } });
    assert.equal(result.content, '已查到示例宠物医院。');
    assert.deepEqual(calls, [
      { name: 'request_location', args: {} }, { name: 'list_integrations', args: {} },
      { name: 'read_integration', args: { provider: 'amap', query: { operation: 'nearby', keywords: '宠物医院', address: '上海张江地铁站', limit: 5 } } },
    ]);
    assert.match(JSON.stringify(request.messages), /示例宠物医院/);
    assert.doesNotMatch(JSON.stringify(request.tools), /request_location/);
    assert.equal(events[0]?.kind, 'started');
  } finally { await fixture.close(); }
});

test('live text batching preserves split emoji and bounds a large provider delta', () => {
  const text = new StreamTextBuffer();
  text.append('开始\uD83D'); assert.deepEqual(text.drain(), ['开始']);
  text.append('\uDE80' + '中文'.repeat(12000)); text.assertComplete();
  const chunks = text.drain(); assert.ok(chunks.every(chunk => chunk.length <= 2048));
  assert.equal(chunks.join(''), '🚀' + '中文'.repeat(12000));
  assert.throws(() => { text.append('\uD83D'); text.assertComplete(); });
});

async function modelFixture(handler: (request: Record<string, unknown>, response: ServerResponse) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    await handler(JSON.parse(raw), res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { settings: resolveModel({ MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_NAME: 'test-model' }),
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('cancel preserves emitted text and closes the live upstream without switching to Pi', { timeout: 90000 }, async () => {
  let requests = 0, disconnected = false; const events: RunEvent[] = []; const cancel = new AbortController();
  const fixture = await modelFixture((request, res) => {
    requests++; assert.ok(!request.tools || (request.tools as unknown[]).length === 0, 'no native shell/file tools');
    res.on('close', () => { disconnected = true; });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(res, { role: 'assistant', content: '保留这段' });
  });
  try {
    await assert.rejects(executeDshRun({ ...input, tools: [] }, fixture.settings, {
      state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); if (event.kind === 'text_delta') cancel.abort(); },
      tool: async () => { throw new Error('unexpected tool'); },
    }, cancel.signal, { turns: 3, tools: 3, timeoutMs: 60000 }), (error: unknown) => error instanceof RunError && error.code === 'cancelled');
    assert.equal(requests, 1); assert.equal(disconnected, true);
    assert.ok(events.some(event => event.kind === 'text_delta' && event.body.delta === '保留这段'));
    assert.ok(!events.some(event => event.kind === 'finished'));
  } finally { await fixture.close(); }
});

test('DeepSeek retains system role, max_tokens and thinking-off behind the private model gateway', { timeout: 90000 }, async () => {
  const fixture = await modelFixture((request, res) => {
    const messages = request.messages as { role: string }[];
    assert.ok(!messages.some(message => message.role === 'developer'));
    assert.equal(request.max_tokens, 4096); assert.equal(request.max_completion_tokens, undefined);
    assert.ok(request.store !== true); assert.deepEqual(request.thinking, { type: 'disabled' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sseText(res, '协议已验证');
  });
  try {
    const settings = { ...fixture.settings, model: { ...fixture.settings.model, provider: 'deepseek', reasoning: true,
      compat: { thinkingFormat: 'deepseek' as const, supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true } } };
    const result = await executeDshRun({ ...input, tools: [] }, settings, {
      state: async () => ({ next_sequence: 10000 }), event: async () => {}, tool: async () => { throw Error('unexpected'); },
    }, undefined, { turns: 2, tools: 1, timeoutMs: 60000 });
    assert.equal(result.content, '协议已验证'); // A retry's durable sequence may exceed this attempt's event budget.
  } finally { await fixture.close(); }
});

function sseText(res: ServerResponse, text: string) { chunk(res, { role: 'assistant', content: text }); chunk(res, {}, 'stop'); res.end('data: [DONE]\n\n'); }

test('DSH binds location on demand, looks up a real store ID and resumes until it has a meal price', { timeout: 90000 }, async () => {
  const events: RunEvent[] = [];
  const calls: string[] = [];
  let turn = 0;
  const fixture = await modelFixture((request, res) => {
    const history = JSON.stringify(request.messages);
    const steps = [
      { name: 'list_mcp_tools', args: { provider: 'mcdonalds' } },
      { name: 'call_mcp_tool', args: { provider: 'mcdonalds', tool: 'query-nearby-stores', arguments: {
        searchType: 2, city: '北京', keyword: '北京',
      } } },
      { name: 'call_mcp_tool', args: { provider: 'mcdonalds', tool: 'query-meals', arguments: { storeCode: 'fixture-store' } } },
      null,
      { name: 'call_mcp_tool', args: { provider: 'mcdonalds', tool: 'calculate-price', arguments: {
        storeCode: 'fixture-store', items: [{ productCode: '11002', quantity: 1 }],
      } } },
    ];
    const step = steps[turn++];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (turn === 3) assert.match(history, /fixture-store/);
    if (turn === 4) {
      assert.match(history, /11002/); assert.doesNotMatch(history, /x{100}/);
      return sseText(res, '你想先选哪个套餐？');
    }
    if (turn === 5) assert.match(history, /无需请用户先选菜/);
    if (!step) return sseText(res, '推荐双人套餐，已核价 59.90 元。');
    chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: `meal-${turn}`, type: 'function',
      function: { name: step.name, arguments: JSON.stringify(step.args) } }] });
    chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  try {
    const result = await executeDshRun({ ...input, messages: [
      { role: 'user', content: '有点饿了，我现在想点一份麦当劳，你推荐什么？' },
    ], tools: ['list_mcp_tools', 'call_mcp_tool', 'request_location'].map(name => ({ name, description: name, parameters: {
      type: 'object', properties: { provider: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } },
    } })) }, fixture.settings, {
      state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); },
      tool: async (name, args) => {
        if (name === 'list_mcp_tools') return { items: [{ name: 'calculate-price' }, {
          name: 'query-nearby-stores', inputSchema: { properties: { searchType: { type: 'string' } } },
        }] };
        if (name === 'request_location') {
          calls.push(name);
          return { status: 'answered', location: { source: 'device', latitude: 31.2, longitude: 121.4,
            map_coordinates: { coordinate_system: 'gcj02', latitude: 31.21, longitude: 121.41 } } };
        }
        const call = args as { tool: string; arguments: { items?: unknown } };
        calls.push(call.tool);
        if (call.tool === 'query-nearby-stores') {
          assert.deepEqual(call.arguments, { searchType: '3', beType: 1, latitude: 31.21, longitude: 121.41 });
          return { status: 'completed', result: { structuredContent: { success: true, data: [{ storeCode: 'fixture-store' }] } } };
        }
        if (call.tool === 'query-meals') return { status: 'completed', result: { content: [{ type: 'text',
          text: JSON.stringify({ success: true, data: { meals: { 11002: { name: '双人套餐', image: 'x'.repeat(300000) } } } }),
        }] } };
        assert.deepEqual(call.arguments.items, [{ productCode: '11002', quantity: 1 }]);
        return { status: 'completed', result: { structuredContent: { success: true, data: { price: 5990 } } } };
      },
    }, undefined, { turns: 7, tools: 6, timeoutMs: 60000 });
    assert.deepEqual(calls, ['request_location', 'query-nearby-stores', 'query-meals', 'calculate-price']);
    assert.equal(result.content, '推荐双人套餐，已核价 59.90 元。');
    assert.ok(events.some(event => event.kind === 'text_start' && event.body.replace === true));
  } finally { await fixture.close(); }
});

for (const harness of ['pi', 'dsh'] as const) {
  test(`${harness} records a provider rejection and avoids repeating the same nearby request`, { timeout: 90000 }, async () => {
    const events: RunEvent[] = [];
    let dispatches = 0, turn = 0;
    const fixture = await modelFixture((_request, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (++turn > 2) return sseText(res, '暂时无法核实门店。');
      chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: `nearby-${turn}`, type: 'function', function: {
        name: 'call_mcp_tool', arguments: JSON.stringify({ provider: 'mcdonalds', tool: 'query-nearby-stores',
          arguments: { searchType: 2, city: '北京', keyword: '西单' } }),
      } }] });
      chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
    });
    try {
      const request = { ...input, messages: [{ role: 'user', content: '查北京西单附近的麦当劳套餐' }],
        tools: [{ name: 'call_mcp_tool', description: '查询已连接的服务', parameters: { type: 'object',
          properties: { provider: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'object' } } } }] };
      const bridge: Bridge = { state: async () => ({ next_sequence: events.length }), event: async event => { events.push(event); },
        tool: async () => {
          dispatches++;
          return { status: 'completed', result: { structuredContent: { success: false } } };
        } };
      const execute = harness === 'dsh' ? executeDshRun : executeRun;
      const result = await execute(request, fixture.settings, bridge, undefined, { turns: 4, tools: 4, timeoutMs: 60000 });
      assert.equal(result.content, '暂时无法核实门店。');
      assert.equal(dispatches, 1);
      assert.deepEqual(events.filter(event => event.kind === 'tool_end').map(event =>
        [event.body.is_error, event.body.failure]), [[true, 'provider'], [true, 'provider']]);
    } finally { await fixture.close(); }
  });
}

test('a truncated provider answer never becomes a successful completed reply', { timeout: 90000 }, async () => {
  const events: RunEvent[] = [];
  const fixture = await modelFixture((_request, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { role: 'assistant', content: '这只是半句' }); chunk(res, {}, 'length'); res.end('data: [DONE]\n\n');
  });
  try {
    await assert.rejects(executeDshRun({ ...input, tools: [] }, fixture.settings, {
      state: async () => ({ next_sequence: events.length + 1 }), event: async event => { events.push(event); }, tool: async () => ({}),
    }, undefined, { turns: 2, tools: 1, timeoutMs: 60000 }));
    assert.ok(!events.some(event => event.kind === 'finished'));
    assert.ok(events.some(event => event.kind === 'text_delta'));
  } finally { await fixture.close(); }
});

test('a replay conflict stops the DSH loop before it can repeat a side effect', { timeout: 90000 }, async () => {
  let requests = 0, calls = 0;
  const fixture = await modelFixture((_request, res) => {
    requests++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'conflict', type: 'function', function: { name: 'lookup', arguments: '{"query":"资料"}' } }] });
    chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  try {
    await assert.rejects(executeDshRun(input, fixture.settings, { state: async () => ({ next_sequence: 0 }), event: async () => {},
      tool: async () => { calls++; throw new RunError('agent_replay_conflict', 'conflict'); },
    }, undefined, { turns: 3, tools: 3, timeoutMs: 60000 }), (error: unknown) => error instanceof RunError && error.code === 'agent_replay_conflict');
    assert.equal(requests, 1); assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('tool budget stops a real DSH loop before a second business call', { timeout: 90000 }, async () => {
  let requests = 0, calls = 0;
  const fixture = await modelFixture((_request, res) => {
    requests++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: `loop-${requests}`, type: 'function', function: { name: 'lookup', arguments: '{"query":"资料"}' } }] });
    chunk(res, {}, 'tool_calls'); res.end('data: [DONE]\n\n');
  });
  try {
    await assert.rejects(executeDshRun(input, fixture.settings, { state: async () => ({ next_sequence: 0 }), event: async () => {},
      tool: async () => { calls++; return { text: '资料' }; },
    }, undefined, { turns: 3, tools: 1, timeoutMs: 60000 }), (error: unknown) => error instanceof RunError && error.code === 'step_limit');
    assert.equal(requests, 2); assert.equal(calls, 1);
  } finally { await fixture.close(); }
});

test('real DSH process runs a tool then delivers live deltas before provider completion', { timeout: 90000 }, async () => {
  const events: RunEvent[] = []; let modelCalls = 0, effects = 0, firstDeltaBeforeEnd = false;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const data of req) text += data;
    const request = JSON.parse(text);
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.equal(request.model, 'test-model');
    assert.deepEqual(request.tools.map((tool: { function: { name: string } }) => tool.function.name), ['lookup']);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (++modelCalls === 1) {
      chunk(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{"query":"资料"}' } }] });
      chunk(res, {}, 'tool_calls');
    } else {
      assert.match(text, /真实的工具资料/);
      chunk(res, { role: 'assistant', content: '已查到，' });
      await new Promise(resolve => setTimeout(resolve, 400));
      firstDeltaBeforeEnd = events.some(event => event.kind === 'text_delta' && event.body.delta === '已查到，');
      chunk(res, { content: '可以继续。' }); chunk(res, {}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const settings = resolveModel({ MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_API_KEY: 'fixture-key', MODEL_NAME: 'test-model' });
  const bridge: Bridge = { state: async () => ({ next_sequence: events.length }),
    event: async event => { assert.equal(event.sequence, events.length); events.push(event); },
    tool: async (name, args, _signal, index) => { effects++; assert.equal(name, 'lookup'); assert.deepEqual(args, { query: '资料' }); assert.equal(index, 1); return { text: '真实的工具资料' }; } };
  try {
    const result = await executeDshRun(input, settings, bridge, undefined, { turns: 4, tools: 3, timeoutMs: 60000 });
    assert.equal(result.content, '已查到，可以继续。'); assert.equal(effects, 1); assert.equal(modelCalls, 2);
    assert.equal(firstDeltaBeforeEnd, true, 'must stream while upstream is still generating');
    assert.ok(events.some(event => event.kind === 'tool_start')); assert.ok(events.some(event => event.kind === 'tool_end'));
    assert.equal(events.at(-1)?.kind, 'finished');
    assert.equal(result.usage.model_requests, 2);
    const patches = dshPatches('http://127.0.0.1:1', settings.model);
    assert.ok(patches.some(row => 'id' in row && row.id === 'persistent-pwsh' && 'disabled' in row && row.disabled));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

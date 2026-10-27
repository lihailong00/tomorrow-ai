import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { McpGatewayClient, aliasTools, consumeSse, runBundle, trajectoryMessages } from './pi-host.mjs';

const parameters = { type: 'object', properties: {}, additionalProperties: false };
const settings = { apiKey: 'proxy-test-secret', model: { id: 'deepseek-flash', provider: 'deepseek',
  api: 'openai-completions', reasoning: true, input: ['text'], baseUrl: 'http://127.0.0.1:1/v1',
  contextWindow: 1000000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } };
const bundle = { schema_version: 2, task_dir: 'finalpool/test-only', single_turn_mode: true,
  task_str: 'Perform the task using the sandbox tools.', system_prompts: { agent: 'Official test prompt.' },
  container_paths: { agent_workspace: '/workspace/dumps/workspace' }, stop: { tool_names: ['local-claim_done'] } };
function response(content, stopReason = 'toolUse') {
  return { role: 'assistant', content, model: 'deepseek-flash', provider: 'deepseek', api: 'openai-completions',
    stopReason, timestamp: Date.now(), usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function streamResult(message) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: message.stopReason, message });
  return stream;
}
const call = name => ({ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: {} });

test('tool aliases preserve every schema and use distinct reversible valid names', () => {
  const definitions = ['valid-tool', 'read.file', 'read_file', 'a'.repeat(100)].map(name => ({ name, inputSchema: parameters }));
  const aliases = aliasTools(definitions);
  assert.equal(aliases.length, definitions.length);
  assert.equal(aliases[0].name, 'valid-tool');
  assert.equal(aliases[2].name, 'read_file');
  assert.equal(new Set(aliases.map(item => item.name)).size, definitions.length);
  for (const tool of aliases) {
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.strictEqual(tool.inputSchema, parameters);
  }
});

test('SSE parser handles fragmented UTF-8, CRLF, comments and multiline data', async () => {
  const bytes = new TextEncoder().encode(': ping\r\nevent: message\r\ndata: {"value":\r\ndata: "你好"}\r\n\r\n');
  const body = new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += 2) controller.enqueue(bytes.slice(index, index + 2));
    controller.close();
  } });
  const events = [];
  await consumeSse(body, event => events.push(event));
  assert.deepEqual(events, [{ event: 'message', data: '{"value":\n"你好"}' }]);
});

test('official gateway SSE handshake, list and actual tool call exchange', async t => {
  let connection;
  const calls = [];
  const server = createServer(async (request, reply) => {
    if (request.url === '/sse') {
      reply.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.write('event: endpoint\ndata: /messages/?session_id=test-session\n\n');
      connection = reply;
      return;
    }
    if (request.method === 'POST' && request.url === '/messages/?session_id=test-session') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(payload);
      let result;
      if (payload.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} } };
      if (payload.method === 'tools/list') result = { tools: [{ name: 'sandbox-read', inputSchema: parameters }] };
      if (payload.method === 'tools/call') result = { content: [{ type: 'text', text: 'actual sandbox response' }], isError: false };
      if (payload.id) connection.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result })}\n\n`);
      reply.writeHead(202); reply.end(); return;
    }
    reply.writeHead(404); reply.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new McpGatewayClient(`http://127.0.0.1:${server.address().port}/sse`, { requestTimeoutMs: 1000 });
  try {
    await client.connect();
    assert.equal((await client.listTools()).length, 1);
    assert.equal((await client.callTool('sandbox-read', {})).content[0].text, 'actual sandbox response');
    assert.deepEqual(calls.map(item => item.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally { await client.close(); }
});

test('streamable HTTP uses returned session ID and accepts JSON-RPC responses', async () => {
  const requests = [];
  const client = new McpGatewayClient('http://127.0.0.1:9999/mcp', { transport: 'streamable-http',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); requests.push({ body, headers: options.headers });
      if (!body.id) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: {} } : { tools: [] } }),
      { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-http-session' } });
    } });
  await client.connect(); await client.listTools(); await client.close();
  assert.equal(requests[1].headers['Mcp-Session-Id'], 'test-http-session');
  assert.equal(requests[2].headers['Mcp-Session-Id'], 'test-http-session');
});

test('Pi runs full tool-result loop, retains decoys, refreshes tools and stops on claim_done', async () => {
  let listed = 0, requested = 0;
  const executed = [];
  const definitions = names => names.map(name => ({ name, description: name, inputSchema: parameters }));
  const fakeClient = { connect: async () => {}, close: async () => {},
    listTools: async () => definitions(++listed === 1
      ? ['sandbox-read', 'decoy-unused', 'local-claim_done']
      : ['sandbox-read', 'decoy-unused', 'later-unlocked', 'local-claim_done']),
    callTool: async name => { executed.push(name); return { content: [{ type: 'text', text: `real-${name}-result` }], isError: false }; } };
  const result = await runBundle({ bundle, settings, client: fakeClient,
    streamFn: (_model, context) => {
      requested++;
      if (requested === 1) {
        assert.match(JSON.stringify(context), /decoy-unused/);
        return streamResult(response([{ type: 'thinking', thinking: 'secret reasoning never persist' }, call('sandbox-read')]));
      }
      if (requested === 2) {
        assert.match(JSON.stringify(context), /real-sandbox-read-result/);
        assert.match(JSON.stringify(context), /later-unlocked/);
        return streamResult(response([call('later-unlocked')]));
      }
      return streamResult(response([call('local-claim_done')]));
    } });
  assert.equal(result.status, 'success');
  assert.equal(result.tomorrow_pi.stop_reason, 'claim_done');
  assert.equal(result.tomorrow_pi.claimed_done, true);
  assert.equal(requested, 3);
  assert.deepEqual(executed, ['sandbox-read', 'later-unlocked', 'local-claim_done']);
  assert.deepEqual(result.tomorrow_pi.catalogs.map(item => item.count), [3, 4]);
  assert.equal(result.tomorrow_pi.usage.model_requests, 3);
  assert.doesNotMatch(JSON.stringify(result), /secret reasoning never persist/);
});

test('step limit is a failed official run rather than a passing partial trajectory', async () => {
  let requested = 0;
  const result = await runBundle({ bundle, settings, maxTurns: 2,
    client: { connect: async () => {}, close: async () => {},
      listTools: async () => [{ name: 'sandbox-read', inputSchema: parameters }],
      callTool: async () => ({ content: [{ type: 'text', text: 'continue' }] }) },
    streamFn: () => { requested++; return streamResult(response([call('sandbox-read')])); } });
  assert.equal(requested, 2);
  assert.equal(result.status, 'max_turns_reached');
  assert.equal(result.tomorrow_pi.error, 'benchmark_step_limit');
});

test('plain assistant completion stops and strips reasoning and proxy credentials', async () => {
  const result = await runBundle({ bundle, settings,
    client: { connect: async () => {}, close: async () => {}, listTools: async () => [] },
    streamFn: () => streamResult(response([{ type: 'thinking', thinking: 'private reasoning' },
      { type: 'text', text: `Done. ${settings.apiKey}` }], 'stop')) });
  assert.equal(result.status, 'success');
  assert.equal(result.tomorrow_pi.stop_reason, 'assistant_no_tool_call');
  assert.doesNotMatch(JSON.stringify(result), /private reasoning|proxy-test-secret/);
  assert.match(result.messages.at(-1).content, /REDACTED/);
});

test('adapter refuses to pretend interactive user simulation has been implemented', async () => {
  await assert.rejects(runBundle({ bundle: { ...bundle, single_turn_mode: false }, settings }), /Interactive user simulation/);
});

test('trajectory keeps official names and tool results while discarding thinking blocks', () => {
  const history = trajectoryMessages([response([{ type: 'thinking', thinking: 'private' }, call('safe_alias')]),
    { role: 'toolResult', toolCallId: 'id', toolName: 'safe_alias', content: [{ type: 'text', text: 'result' }] }],
  new Map([['safe_alias', 'original.tool.name']]));
  assert.equal(history[0].tool_calls[0].function.name, 'original.tool.name');
  assert.equal(history[1].content, 'result');
  assert.doesNotMatch(JSON.stringify(history), /private/);
});

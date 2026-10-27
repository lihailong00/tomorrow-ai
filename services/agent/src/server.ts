import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { authenticate, positiveInteger, resolveModel, serviceUrl } from './config.js';
import { DEFAULT_LIMITS, executeRun, RunError, validateRun, type Bridge } from './runtime.js';
import { createDeepSeekWeb, resolveWebSettings } from './web.js';

dotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const secret = process.env.AGENT_SERVICE_TOKEN ?? '';
if (secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('缺少有效的 AGENT_SERVICE_TOKEN，请使用启动脚本');
const apiUrl = serviceUrl(process.env.RUST_API_URL ?? 'http://127.0.0.1:8080', 'Rust 服务地址');
const settings = resolveModel(process.env);
const webSettings = resolveWebSettings(process.env);
const webProvider = webSettings ? createDeepSeekWeb(webSettings) : undefined;
const port = positiveInteger(process.env.AGENT_PORT, 8090, 65535);
const limits = {
  turns: positiveInteger(process.env.AGENT_MAX_TURNS, DEFAULT_LIMITS.turns, 20),
  tools: positiveInteger(process.env.AGENT_MAX_TOOLS, DEFAULT_LIMITS.tools, 40),
  timeoutMs: positiveInteger(process.env.AGENT_TIMEOUT_MS, DEFAULT_LIMITS.timeoutMs, 105000),
};
let active = 0;
const maxConcurrent = positiveInteger(process.env.AGENT_MAX_CONCURRENT, 4, 32);

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2 * 1024 * 1024) throw new RunError('body_limit', '请求内容过大');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RunError('invalid_request', '请求格式无效'); }
}

const server = createServer(async (request, response) => {
  const send = (status: number, value: unknown) => {
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    }
  };
  if (request.method === 'GET' && request.url === '/health') {
    send(200, { ok: true, harness: 'pi', version: '1.4.0', model_name: settings.model.id,
      web_search: !!webProvider }); return;
  }
  if (!authenticate(request.headers.authorization, `Bearer ${secret}`)) {
    send(401, { error: { code: 'unauthorized', message: '内部服务认证失败' } }); return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/runs') {
    send(404, { error: { code: 'not_found', message: '接口不存在' } }); return;
  }
  if (active >= maxConcurrent) {
    send(503, { error: { code: 'busy', message: 'Agent 正忙，请稍后重试' } }); return;
  }
  active++;
  const controller = new AbortController();
  response.on('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const input = await readBody(request);
    validateRun(input);
    const callback = async (path: string, body?: unknown, signal?: AbortSignal) => {
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
      const result = await fetch(`${apiUrl}/internal/agent/runs/${encodeURIComponent(input.run_id)}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.run_token}`, 'X-Agent-Service': secret },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await result.json() as { error?: { code?: string; message?: string } };
      if (!result.ok) throw new RunError(value.error?.code === 'agent_replay_conflict' ? 'agent_replay_conflict' : 'tool_failed', value.error?.message ?? '业务操作失败');
      return value;
    };
    const bridge: Bridge = {
      state: async () => await callback('/state') as { next_sequence: number },
      event: async event => { await callback('/events', event); },
      tool: (name, args, signal, operationIndex) => callback('/tools', { name, arguments: args, operation_index: operationIndex }, signal),
    };
    send(200, await executeRun(input, settings, bridge, controller.signal, limits, undefined, webProvider));
  } catch (error) {
    const code = error instanceof RunError ? error.code : 'execution_failed';
    // Never log upstream SDK errors, request bodies, headers, or provider credentials.
    console.error(JSON.stringify({ event: 'run_failed', code }));
    send(code === 'invalid_request' || code === 'context_limit' || code === 'body_limit' ? 400 : 502,
      { error: { code, message: 'Agent 执行未完成，请查看执行记录后重试' } });
  } finally { active--; }
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', harness: 'pi', port, model: settings.model.id })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
}

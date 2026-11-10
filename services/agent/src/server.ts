import { createServer, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { authenticate, positiveInteger, rustServiceUrl } from './config.js';
import { RunError, validateRun, type Bridge } from './runtime.js';
import { executeHarness, selectHarness, type Harness } from './harness.js';
import { createDeepSeekWeb } from './web.js';
import { createRuntimeSettingsProvider, RuntimeSettingsError } from './runtime-settings.js';
import { travelGuard } from './travel-guard.js';

dotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const secret = process.env.AGENT_SERVICE_TOKEN ?? '';
if (secret.length < 32 || /[\r\n]/.test(secret)) throw new Error('缺少有效的 AGENT_SERVICE_TOKEN，请使用启动脚本');
const apiUrl = rustServiceUrl(process.env.RUST_API_URL ?? 'http://127.0.0.1:8080');
const configuration = createRuntimeSettingsProvider(process.env, apiUrl, secret);
const port = positiveInteger(process.env.AGENT_PORT, 8090, 65535);
const defaultHarness = selectHarness(process.env.AGENT_MODE === 'dsh' ? 'dsh' : 'pi');
let active = 0;
let pending = 0;

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
    try {
      const snapshot = await configuration.snapshot();
      send(200, { ok: true, harness: defaultHarness, version: defaultHarness === 'dsh' ? '0.2.1-rc.5' : '1.4.0', available_harnesses: ['pi', 'dsh'], configured: !!snapshot.model && !snapshot.error,
        model_name: snapshot.model?.model.id ?? null, web_search: !!snapshot.web && !snapshot.error,
        config_source: configuration.mode, config_revision: snapshot.revision,
        config_status: snapshot.error ?? 'ready' });
    } catch {
      // Liveness remains available before the Rust API starts, while readiness
      // explicitly reports that no valid run configuration can be loaded.
      send(200, { ok: true, harness: defaultHarness, version: defaultHarness === 'dsh' ? '0.2.1-rc.5' : '1.4.0', available_harnesses: ['pi', 'dsh'], configured: false,
        model_name: null, web_search: false, config_source: configuration.mode,
        config_revision: null, config_status: 'runtime_config_unavailable' });
    }
    return;
  }
  if (!authenticate(request.headers.authorization, `Bearer ${secret}`)) {
    send(401, { error: { code: 'unauthorized', message: '内部服务认证失败' } }); return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/runs') {
    send(404, { error: { code: 'not_found', message: '接口不存在' } }); return;
  }
  // A fixed admission bound also limits configuration/body reads while the
  // actual run concurrency is resolved from this request's settings snapshot.
  if (active + pending >= 32) {
    send(503, { error: { code: 'busy', message: 'Agent 正忙，请稍后重试' } }); return;
  }
  pending++;
  let awaitingAdmission = true;
  const controller = new AbortController();
  response.on('close', () => { if (!response.writableEnded) controller.abort(); });
  try {
    const input = await readBody(request);
    validateRun(input);
    // Each run receives one resolved revision. A dashboard update applies to
    // the next run, never halfway through a tool loop or a provider request.
    const snapshot = await configuration.snapshot(controller.signal);
    if (snapshot.error) throw new RuntimeSettingsError(snapshot.error);
    if (!snapshot.model) throw new RuntimeSettingsError('model_not_configured');
    if (active >= snapshot.limits.maxConcurrent) {
      send(503, { error: { code: 'busy', message: 'Agent 正忙，请稍后重试' } }); return;
    }
    pending--; awaitingAdmission = false; active++;
    const settings = snapshot.model;
    const webProvider = snapshot.web ? createDeepSeekWeb(snapshot.web) : undefined;
    const callback = async (path: string, body?: unknown, signal?: AbortSignal, lateUsage = false) => {
      const tool = path === '/tools' && body && typeof body === 'object' ? body as { name?: string; arguments?: { provider?: string; tool?: string } } : undefined;
      const toolName = tool?.name;
      const deliveryAutofill = toolName === 'call_mcp_tool' && tool?.arguments?.provider === 'mcdonalds' && tool.arguments.tool === 'delivery-query-addresses';
      // A confirmation can wait 90s before the provider call. Alipay can also
      // wait for the official checkout and then make a read-only status call.
      const timeout = deliveryAutofill ? 230000 : toolName === 'prepare_alipay_payment' ? 280000
        : toolName === 'prepare_personal_tool' || toolName === 'call_mcp_tool' ? 150000
        : ['request_location', 'ask_user_choice', 'inspect_app_permissions', 'open_system_settings'].includes(toolName ?? '') ? 100000
        : toolName === 'list_mcp_tools' || toolName === 'get_akshare_market_data' ? 50000 : 15000;
      const combined = AbortSignal.any([...(lateUsage ? [] : [controller.signal]), AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
      const result = await fetch(`${apiUrl}/internal/agent/runs/${encodeURIComponent(input.run_id)}${path}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.run_token}`, 'X-Agent-Service': secret },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await result.json() as { error?: { code?: string; message?: string } };
      if (!result.ok) throw new RunError(value.error?.code === 'agent_replay_conflict' ? 'agent_replay_conflict' : 'tool_failed', value.error?.message ?? '业务操作失败');
      return value;
    };
    const guardTravel = travelGuard(input);
    const bridge: Bridge = {
      usage: async (message, signal) => { await callback('/usage', message, signal, message.kind === 'finish'); },
      state: async signal => await callback('/state', undefined, signal) as { next_sequence: number },
      event: async (event, signal) => { await callback('/events', event, signal); },
      tool: (name, args, signal, operationIndex, operationSlot) => guardTravel(name, args, checked => callback('/tools', {
        name, arguments: checked, operation_index: operationIndex, client_model: settings.model.id,
        ...(operationSlot === undefined ? {} : { operation_slot: operationSlot }),
      }, signal)),
    };
    const harness = selectHarness((input as typeof input & { harness?: Harness }).harness, defaultHarness);
    send(200, await executeHarness({ ...input, harness }, settings, bridge, controller.signal, snapshot.limits, webProvider));
  } catch (error) {
    const code = error instanceof RunError || error instanceof RuntimeSettingsError ? error.code : 'execution_failed';
    // Never log upstream SDK errors, request bodies, headers, or provider credentials.
    console.error(JSON.stringify({ event: 'run_failed', code }));
    send(error instanceof RuntimeSettingsError ? 503 : code === 'invalid_request' || code === 'context_limit' || code === 'body_limit' || code === 'unsupported_reasoning' ? 400 : 502,
      { error: { code, message: error instanceof RuntimeSettingsError ? error.message : 'Agent 执行未完成，请查看执行记录后重试' } });
  } finally { if (awaitingAdmission) pending--; else active--; }
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ event: 'ready', harness: defaultHarness, port, config_source: configuration.mode })));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
}

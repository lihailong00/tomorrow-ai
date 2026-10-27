import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Official decoupled protocol: the benchmark owns preprocessing, tools and grading.
// This module changes only the host-side agent scaffold to Pi. It never reads
// ground truth, task evaluation code, or a real user's connected applications.
const VERSION = '2024-11-05';
const ZERO_COST = { total_cost: 0, total_input_tokens: 0, total_output_tokens: 0,
  total_cached_input_tokens: 0, total_non_cached_input_tokens: 0, total_requests: 0 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A connection can fail before its first consumer is ready.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function checkedGatewayUrl(value, origin) {
  const url = new URL(value, origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username || url.password || url.hash || (origin && url.origin !== new URL(origin).origin)) {
    throw new Error('MCP gateway must use localhost HTTP or HTTPS; SSE endpoint must retain its origin');
  }
  return url;
}

/** Decode SSE incrementally, including CRLF boundaries and multiline data. */
export async function consumeSse(body, onEvent) {
  if (!body) throw new Error('MCP SSE response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', event = '', data = [];
  const dispatch = async () => {
    if (!data.length) { event = ''; return true; }
    const keepReading = await onEvent({ event: event || 'message', data: data.join('\n') });
    event = ''; data = [];
    return keepReading !== false;
  };
  const line = async value => {
    if (value === '') return dispatch();
    if (value.startsWith(':')) return true;
    const separator = value.indexOf(':');
    const field = separator < 0 ? value : value.slice(0, separator);
    let text = separator < 0 ? '' : value.slice(separator + 1);
    if (text.startsWith(' ')) text = text.slice(1);
    if (field === 'event') event = text;
    if (field === 'data') data.push(text);
    return true;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let position;
      while ((position = buffer.indexOf('\n')) >= 0) {
        const part = buffer.slice(0, position).replace(/\r$/, '');
        buffer = buffer.slice(position + 1);
        if (!await line(part)) return;
      }
      if (done) {
        if (buffer) await line(buffer.replace(/\r$/, ''));
        await dispatch();
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** No SDK/model calls occur here; MCP requests are never automatically retried. */
export class McpGatewayClient {
  constructor(url, { transport = 'sse', requestTimeoutMs = 180000, connectTimeoutMs = 30000,
    fetchImpl = fetch, signal, onNotification } = {}) {
    this.url = checkedGatewayUrl(url);
    this.transport = transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.fetch = fetchImpl;
    this.onNotification = onNotification;
    this.controller = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.pending = new Map();
    this.nextId = 1;
    this.endpointReady = deferred();
    this.closed = false;
  }

  receive(payload) {
    if (Array.isArray(payload)) { payload.forEach(item => this.receive(item)); return; }
    if (!payload || payload.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC response');
    if (Object.hasOwn(payload, 'id') && this.pending.has(payload.id)) {
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(`MCP ${payload.error.code}: ${payload.error.message}`));
      else pending.resolve(payload.result);
    } else if (payload.method && !Object.hasOwn(payload, 'id')) {
      this.onNotification?.(payload);
    }
  }

  fail(error) {
    this.connectionError = error;
    this.endpointReady.reject(error);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async connect() {
    if (this.transport === 'sse') {
      const connectController = new AbortController();
      const timer = setTimeout(() => connectController.abort(new Error('MCP SSE connection timeout')), this.connectTimeoutMs);
      try {
        const response = await this.fetch(this.url, { headers: { Accept: 'text/event-stream' },
          signal: AbortSignal.any([this.signal, connectController.signal]), redirect: 'error' });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new Error(`MCP SSE connection returned HTTP ${response.status}`);
        }
        this.readTask = consumeSse(response.body, async packet => {
          if (packet.event === 'endpoint') {
            this.endpoint = checkedGatewayUrl(packet.data, this.url);
            this.endpointReady.resolve(this.endpoint);
          } else if (packet.event === 'message') this.receive(JSON.parse(packet.data));
        }).then(() => { if (!this.closed) this.fail(new Error('MCP SSE connection closed')); })
          .catch(error => { if (!this.closed) this.fail(error); });
        await this.endpointReady.promise;
      } finally { clearTimeout(timer); }
    } else if (this.transport === 'streamable-http') {
      this.endpoint = this.url;
    } else throw new Error('Unsupported MCP transport');

    this.server = await this.request('initialize', { protocolVersion: VERSION,
      capabilities: {}, clientInfo: { name: 'tomorrow-pi-toolathlon', version: '1.0.0' } });
    await this.notify('notifications/initialized');
    return this.server;
  }

  async post(payload, signal) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.transport === 'streamable-http') headers['MCP-Protocol-Version'] = this.server?.protocolVersion ?? VERSION;
    const response = await this.fetch(this.endpoint, { method: 'POST', headers,
      body: JSON.stringify(payload), signal, redirect: 'error' });
    if (!response.ok) throw new Error(`MCP ${payload.method} returned HTTP ${response.status}`);
    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.sessionId = session;
    if (response.status === 202 || response.status === 204) return;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) this.receive(await response.json());
    else if (contentType.includes('text/event-stream')) {
      await consumeSse(response.body, packet => {
        if (packet.event !== 'message') return;
        this.receive(JSON.parse(packet.data));
        return this.pending.has(payload.id);
      });
    } else if (this.transport === 'streamable-http' && Object.hasOwn(payload, 'id')) {
      throw new Error('MCP request returned an unsupported response content type');
    }
  }

  async request(method, params = {}, signal) {
    if (this.connectionError) throw this.connectionError;
    if (this.closed || !this.endpoint) throw new Error('MCP gateway is not connected');
    const id = this.nextId++;
    const waiter = deferred();
    this.pending.set(id, waiter);
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const abort = signal ? AbortSignal.any([signal, this.signal, timeout]) : AbortSignal.any([this.signal, timeout]);
    const rejectOnAbort = () => waiter.reject(abort.reason ?? new Error('MCP request aborted'));
    abort.addEventListener('abort', rejectOnAbort, { once: true });
    try {
      if (abort.aborted) rejectOnAbort();
      const [, result] = await Promise.all([this.post({ jsonrpc: '2.0', id, method, params }, abort), waiter.promise]);
      return result;
    } finally {
      abort.removeEventListener('abort', rejectOnAbort);
      this.pending.delete(id);
    }
  }

  async notify(method, params = {}) {
    await this.post({ jsonrpc: '2.0', method, params }, this.signal);
  }

  async listTools(signal) {
    const tools = [], names = new Set(), cursors = new Set();
    let cursor;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {}, signal);
      if (!Array.isArray(result?.tools)) throw new Error('MCP tools/list did not return tools');
      for (const tool of result.tools) {
        if (typeof tool.name !== 'string' || !tool.name || !tool.inputSchema || names.has(tool.name)) {
          throw new Error('MCP returned an invalid or duplicate tool definition');
        }
        names.add(tool.name); tools.push(tool);
      }
      cursor = result.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('MCP tool cursor cycle');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tools;
  }

  callTool(name, args, signal) { return this.request('tools/call', { name, arguments: args }, signal); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.fail(new Error('MCP gateway closed'));
    await this.readTask;
  }
}

/** Preserve valid official names; map only provider-incompatible names, reversibly. */
export function aliasTools(definitions) {
  const used = new Set(definitions.filter(t => /^[A-Za-z0-9_-]{1,64}$/.test(t.name)).map(t => t.name));
  return definitions.map(definition => {
    let name = definition.name;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      const base = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 47) || 'tool';
      const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
      name = `${base}_${hash}`;
      let collision = 1;
      while (used.has(name)) name = `${base.slice(0, 43)}_${hash}_${collision++}`;
    }
    used.add(name);
    return { ...definition, originalName: definition.name, name };
  });
}

function toolContent(result, supportsImages) {
  const content = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text') content.push({ type: 'text', text: item.text ?? '' });
    else if (item.type === 'image' && supportsImages) {
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    } else if (item.type === 'image') {
      content.push({ type: 'text', text: JSON.stringify({ type: item.type, mimeType: item.mimeType,
        unsupported_by_model: true, reason: 'Configured model supports text input only.' }) });
    } else content.push({ type: 'text', text: JSON.stringify(item) });
  }
  if (!content.length) content.push({ type: 'text', text: JSON.stringify(result?.structuredContent ?? result ?? null) });
  return content;
}

function scrub(value, secrets = []) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((s, secret) => s.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['thinking', 'reasoning_content', 'thinkingSignature', 'reasoningSignature'].includes(key))
    .map(([key, item]) => [key, /^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)$/i.test(key)
      ? '[REDACTED]' : scrub(item, secrets)]));
  return value;
}

export function trajectoryMessages(messages, originalNames = new Map()) {
  return messages.flatMap(message => {
    if (message.role === 'system') return [];
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    if (message.role === 'assistant') {
      const calls = message.content.filter(item => item.type === 'toolCall').map(call => ({ id: call.id,
        type: 'function', function: { name: originalNames.get(call.name) ?? call.name, arguments: JSON.stringify(call.arguments) } }));
      return [{ role: 'assistant', content: message.content.filter(item => item.type === 'text').map(item => item.text).join('\n'),
        ...(calls.length ? { tool_calls: calls } : {}), stop_reason: message.stopReason }];
    }
    if (message.role === 'toolResult') return [{ role: 'tool', tool_call_id: message.toolCallId,
      name: originalNames.get(message.toolName) ?? message.toolName,
      content: message.content.map(item => item.type === 'text' ? item.text : '[image]').join('\n'), is_error: message.isError }];
    return [];
  });
}

async function atomicJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temp, filename);
}

/** Execute an official preprocessed bundle through Pi; settings should point at the budget proxy. */
export async function runBundle({ bundle, gatewayUrl, settings, streamFn, outputDir,
  maxTurns = 80, maxToolCalls = 1000, maxOutputTokens = 4096, timeoutMs = 1800000,
  toolTimeoutMs = 180000, transport = 'sse', signal, client: suppliedClient,
  refreshTools = true, onEvent, runId } = {}) {
  if (typeof bundle === 'string') bundle = JSON.parse(await readFile(bundle, 'utf8'));
  if (bundle?.schema_version !== 2 || typeof bundle.task_str !== 'string' ||
      typeof bundle.system_prompts?.agent !== 'string') {
    throw new Error('An official schema-version-2 task bundle with agent system prompt is required');
  }
  if (bundle.single_turn_mode !== true) throw new Error('Interactive user simulation is not implemented; use official single_turn_mode=true');
  for (const [label, number] of Object.entries({ maxTurns, maxToolCalls, maxOutputTokens, timeoutMs, toolTimeoutMs })) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${label}`);
  }
  if (!settings?.model || !settings.apiKey) throw new Error('Model settings are required');
  const started = Date.now(), startedAt = new Date(started).toISOString();
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const client = suppliedClient ?? new McpGatewayClient(gatewayUrl, { transport,
    requestTimeoutMs: toolTimeoutMs, signal: combinedSignal });
  const events = [], catalogs = [], originals = new Map();
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, model_requests: 0, tool_calls: 0 };
  const emit = async event => {
    const safe = scrub({ timestamp: new Date().toISOString(), ...event }, [settings.apiKey]);
    events.push(safe); await onEvent?.(safe);
  };
  const stopNames = new Set(bundle.stop?.tool_names ?? ['local-claim_done']);
  let agent, tools = [], rawTools = [], claimedDone = false, limitHit = false, timedOut = false;
  let turns = 0, calls = 0, error, stopReason = 'not_started';
  const isStopTool = name => stopNames.has(name) || name === 'local-claim_done';
  const loadTools = async () => {
    const definitions = await client.listTools(combinedSignal);
    const hash = createHash('sha256').update(JSON.stringify(definitions)).digest('hex');
    if (catalogs.at(-1)?.sha256 === hash) return tools;
    rawTools = definitions;
    catalogs.push({ at_turn: turns, count: definitions.length, sha256: hash });
    tools = aliasTools(definitions).map(definition => {
      originals.set(definition.name, definition.originalName);
      return { name: definition.name, label: definition.originalName, description: definition.description ?? '',
        parameters: definition.inputSchema, executionMode: 'sequential',
        execute: async (id, args, toolSignal) => {
          const result = await client.callTool(definition.originalName, args, toolSignal);
          await emit({ type: 'tool_result', tool_call_id: id, name: definition.originalName, result });
          if (isStopTool(definition.originalName) && !result.isError) claimedDone = true;
          return { content: toolContent(result, settings.model.input.includes('image')),
            details: { original_tool_name: definition.originalName },
            ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
            isError: !!result.isError };
        } };
    });
    await emit({ type: 'tool_catalog', count: definitions.length, sha256: hash,
      aliases: Object.fromEntries(tools.map(tool => [tool.name, originals.get(tool.name)])) });
    return tools;
  };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); agent?.abort(); }, timeoutMs);
  const abort = () => agent?.abort();
  combinedSignal.addEventListener('abort', abort, { once: true });
  try {
    await client.connect();
    await loadTools();
    agent = new Agent({
      initialState: { model: settings.model, thinkingLevel: 'off', tools,
        messages: [{ role: 'system', content: bundle.system_prompts.agent, timestamp: Date.now() },
          { role: 'user', content: bundle.task_str, timestamp: Date.now() }] },
      streamFn: streamFn ?? ((model, context, options) => streamSimple(model, context, {
        ...options, apiKey: settings.apiKey, maxTokens: maxOutputTokens, temperature: 0,
        headers: { ...options.headers, 'X-Toolathlon-Run': runId ?? bundle.task_dir },
        maxRetries: 0, maxRetryDelayMs: 1000, timeoutMs: Math.min(timeoutMs, 300000) })),
      toolExecution: 'sequential',
      beforeToolCall: async ({ toolCall }) => {
        calls++;
        if (calls > maxToolCalls || claimedDone || combinedSignal.aborted) {
          if (calls > maxToolCalls) limitHit = true;
          return { block: true, reason: 'Benchmark run terminated or reached its tool limit', terminate: true };
        }
        await emit({ type: 'tool_call', tool_call_id: toolCall.id,
          name: originals.get(toolCall.name) ?? toolCall.name, arguments: toolCall.arguments });
      },
      finishTurn: ({ message }) => {
        turns++;
        if (limitHit) { stopReason = 'tool_limit'; return { action: 'end' }; }
        if (claimedDone) { stopReason = 'claim_done'; return { action: 'end' }; }
        if (!message.content.some(item => item.type === 'toolCall')) { stopReason = 'assistant_no_tool_call'; return { action: 'end' }; }
        if (turns >= maxTurns) { limitHit = true; stopReason = 'turn_limit'; return { action: 'end' }; }
      },
      // Pi announces additions/removals correctly when tools change here, before
      // preparing the next provider request. No target-based tool filtering.
      prepareNextTurnWithContext: refreshTools ? async ({ context }) => ({ context: { ...context, tools: await loadTools() } }) : undefined,
    });
    agent.subscribe(async event => {
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const message = event.message, u = message.usage;
        usage.input += u.input; usage.output += u.output; usage.cache_read += u.cacheRead;
        usage.cache_write += u.cacheWrite; usage.total_tokens += u.totalTokens; usage.model_requests++;
        await emit({ type: 'assistant_turn', turn: usage.model_requests, stop_reason: message.stopReason,
          content: message.content.filter(item => item.type === 'text' || item.type === 'toolCall'), usage: u,
          ...(message.errorMessage ? { error: message.errorMessage } : {}) });
      }
    });
    await emit({ type: 'started', harness: 'pi-agent-core@1.4.0', model: settings.model.id,
      task_dir: bundle.task_dir, user_turns: 1, max_turns: maxTurns });
    if (combinedSignal.aborted) throw combinedSignal.reason;
    await agent.continue();
    const last = [...agent.state.messages].reverse().find(message => message.role === 'assistant');
    if (!last || ['error', 'aborted', 'length'].includes(last.stopReason)) {
      throw new Error(last?.errorMessage ?? `Model did not complete: ${last?.stopReason ?? 'no assistant response'}`);
    }
  } catch (caught) {
    error = scrub(caught instanceof Error ? caught.message : String(caught), [settings.apiKey]);
  } finally {
    clearTimeout(timer); combinedSignal.removeEventListener('abort', abort); agent?.abort();
    await client.close().catch(closeError => { error ??= scrub(String(closeError), [settings.apiKey]); });
  }
  if (timedOut) { error = 'benchmark_timeout'; stopReason = 'timeout'; }
  else if (signal?.aborted) { error = 'benchmark_cancelled'; stopReason = 'cancelled'; }
  else if (limitHit) { error = 'benchmark_step_limit'; stopReason = turns >= maxTurns ? 'turn_limit' : 'tool_limit'; }
  const status = error ? (limitHit ? 'max_turns_reached' : signal?.aborted ? 'interrupted' : 'failed') : 'success';
  usage.tool_calls = Math.min(calls, maxToolCalls);
  const allMessages = agent?.state.messages ?? [{ role: 'user', content: bundle.task_str }];
  const cost = { ...ZERO_COST, total_input_tokens: usage.input + usage.cache_read + usage.cache_write,
    total_output_tokens: usage.output, total_cached_input_tokens: usage.cache_read,
    total_non_cached_input_tokens: usage.input + usage.cache_write, total_requests: usage.model_requests,
    total_cost: null, currency: 'CNY', cost_source: 'external_budget_proxy_ledger' };
  const result = scrub({ config: bundle.resolved_task_config ?? { task_dir: bundle.task_dir,
      task_str: bundle.task_str, single_turn_mode: true, system_prompts: bundle.system_prompts,
      needed_mcp_servers: bundle.needed_mcp_servers, ...bundle.container_paths }, request_id: randomUUID(),
    initial_run_time: startedAt, completion_time: new Date().toISOString(), status,
    tool_calls: { tools: rawTools, tool_choice: 'auto' }, messages: trajectoryMessages(allMessages, originals),
    key_stats: { interaction_turns: 1, tool_calls: usage.tool_calls, agent_llm_requests: usage.model_requests,
      input_tokens: cost.total_input_tokens, output_tokens: usage.output, total_tokens: usage.total_tokens },
    agent_cost: cost, user_cost: ZERO_COST, resumed: false, session_id: null, history_file: null,
    tomorrow_pi: { harness: 'pi-agent-core@1.4.0', model: settings.model.id, thinking_level: 'off',
      usage, error, stop_reason: stopReason, claimed_done: claimedDone, catalogs,
      tool_name_aliases: Object.fromEntries(originals), duration_ms: Date.now() - started,
      official_environment: true, official_leaderboard_score: false, events },
  }, [settings.apiKey]);
  if (outputDir) await atomicJson(path.join(outputDir, 'traj_log.json'), result);
  return result;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const position = arg.indexOf('=');
    return position < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, position), arg.slice(position + 1)];
  }));
  if (!args.bundle || !args.gateway || !args.settings || !args.output) {
    throw new Error('Usage: node pi-host.mjs --bundle=... --gateway=http://127.0.0.1:port/sse --settings=proxy-settings.json --output=... [--max-turns=80]');
  }
  const settings = JSON.parse(await readFile(args.settings, 'utf8'));
  // The standalone entrypoint intentionally accepts only a local budget proxy.
  const proxy = new URL(settings.model.baseUrl);
  if (proxy.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(proxy.hostname)) {
    throw new Error('Standalone benchmark requires a localhost budget proxy');
  }
  const result = await runBundle({ bundle: args.bundle, gatewayUrl: args.gateway, settings,
    outputDir: path.resolve(args.output), maxTurns: Number(args['max-turns'] ?? 80),
    maxOutputTokens: Number(args['max-output-tokens'] ?? 4096), timeoutMs: Number(args['timeout-ms'] ?? 1800000) });
  process.stdout.write(JSON.stringify({ status: result.status, usage: result.tomorrow_pi.usage,
    error: result.tomorrow_pi.error, duration_ms: result.tomorrow_pi.duration_ms }) + '\n');
  process.exitCode = result.status === 'success' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Pi benchmark host failed: ${error.message}\n`); process.exitCode = 1; });
}

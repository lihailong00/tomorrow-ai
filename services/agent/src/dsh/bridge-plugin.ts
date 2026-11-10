/** Trusted Cordis plugin. Business tools remain authorized and executed by Rust. */
import type { Context } from '@deepseek-ai/cordis';
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-tools';
import { StreamTextBuffer } from './text-buffer.js';

export const name = 'tada-run-bridge';
export const inject = ['tools', 'llm'];
type Definition = { name: string; description: string; parameters: Record<string, unknown> };
export async function apply(ctx: Context) {
  const url = process.env.TADA_DSH_GATEWAY_URL!;
  const token = process.env.TADA_DSH_GATEWAY_TOKEN!;
  async function call(path: string, value?: unknown, signal?: AbortSignal) {
    const response = await fetch(url + path, { method: value === undefined ? 'GET' : 'POST',
      redirect: 'error', signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    if (!response.ok) throw new Error('Tada run bridge unavailable');
    return response.json();
  }
  const { tools } = await call('/bootstrap') as { tools: Definition[] };
  const allowed = new Set(tools.map(tool => tool.name));
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'This tool is not authorized for this run');
  for (const tool of tools) {
    ctx.tools.register({ ...tool, output: {
      schema: { type: 'object', properties: { result: {} }, required: ['result'] },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
    }, async execute(args, exec) {
      return { result: await call('/tools', { name: tool.name, arguments: args, call_id: exec.callId }, exec.signal) };
    } });
  }
  // These are live adapter chunks, not a typing animation of the saved reply.
  ctx.on('llm/stream', async function* (options, next) {
    if (!isAgentLoopRequest(options)) { yield* next(); return; }
    await call('/events', { type: 'start' }, options.signal);
    const buffer = new StreamTextBuffer(); let last = 0;
    const flush = async () => {
      for (const delta of buffer.drain()) {
        last = performance.now(); await call('/events', { type: 'delta', delta }, options.signal);
      }
    };
    for await (const chunk of next()) {
      if (chunk.type === 'text-delta') {
        buffer.append(chunk.text);
        if (!last || buffer.length >= 256 || performance.now() - last >= 60) await flush();
      } else if (chunk.type === 'finish') {
        buffer.assertComplete();
        await flush();
        await call('/events', { type: 'end', reason: chunk.reason.kind }, options.signal);
      }
      yield chunk;
    }
    buffer.assertComplete(); await flush();
  });
}

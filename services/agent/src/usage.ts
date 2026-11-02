/** Only normalized accounting metadata crosses this bridge. Never SDK prices or content. */
export type Measurements = {
  input_tokens?: number; output_tokens?: number; cache_read_tokens?: number; cache_write_tokens?: number;
};
export type UsageMessage = {
  kind: 'dispatch'; request_index: number; deployment: string; model: string; model_name: string; provider: string;
} | { kind: 'finish'; request_index: number; status: 'succeeded' | 'failed' | 'cancelled'; measurements: Measurements };
export type UsageSink = (message: UsageMessage, signal?: AbortSignal) => Promise<void>;

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** OpenAI prompt_tokens includes cached input. Pi internally subtracts both cache subsets. */
export function normalizeCompatibleUsage(value: unknown): Measurements {
  if (!value || typeof value !== 'object') return {};
  const usage = value as Record<string, unknown>;
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details as Record<string, unknown> : {};
  const input = count(usage.prompt_tokens);
  const cached = details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cached_tokens;
  const write = details.cache_write_tokens;
  return {
    input_tokens: input, output_tokens: count(usage.completion_tokens),
    // Missing cache fields stay unknown for positive input, independently of SDK defaults.
    cache_read_tokens: cached === undefined ? input === 0 ? 0 : undefined : count(cached),
    cache_write_tokens: write === undefined ? input === 0 ? 0 : undefined : count(write),
  };
}

/** Wrap the actual SDK transport, after local validation and before any outbound attempt. */
export function createMeteredFetch(identity: { baseUrl: string; id: string; name: string; provider: string },
  sink: UsageSink, transport: typeof fetch = globalThis.fetch): typeof fetch {
  let index = 0;
  return async (url, init) => {
    const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
    signal?.throwIfAborted();
    const request_index = ++index;
    await sink({ kind: 'dispatch', request_index, deployment: identity.baseUrl,
      model: identity.id, model_name: identity.name, provider: identity.provider }, signal ?? undefined);
    let measurements: Measurements = {};
    const finish = (status: 'succeeded' | 'failed' | 'cancelled') => sink({ kind: 'finish', request_index, status, measurements });
    let response: Response;
    try { response = await transport(url, { ...init, redirect: 'error' }); }
    catch (error) { await finish(signal?.aborted ? 'cancelled' : 'failed'); throw error; }
    if (!response.body) { await finish(response.ok ? 'succeeded' : 'failed'); return response; }
    const reader = response.body.getReader();
    const sse = response.headers.get('content-type')?.includes('text/event-stream');
    const decoder = new TextDecoder();
    let pending = '', failed = !response.ok, complete = false;
    const inspect = async (json: string) => {
      if (json === '[DONE]') { complete = true; return; }
      let value: Record<string, unknown>;
      try { value = JSON.parse(json) as Record<string, unknown>; } catch { return; }
      if (value.error) failed = true;
      const choices = Array.isArray(value.choices) ? value.choices as Record<string, unknown>[] : undefined;
      const finalUsage = !sse || failed || choices?.length === 0 || choices?.some(choice => choice.finish_reason != null);
      if (finalUsage && value.usage && typeof value.usage === 'object') {
        measurements = normalizeCompatibleUsage(value.usage);
        // Checkpoint immediately: later cancellation/content rejection must retain consumed usage.
        await finish(failed ? 'failed' : 'succeeded');
      }
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          pending += decoder.decode(chunk.value, { stream: !chunk.done });
          if (sse) {
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
              if (line.startsWith('data:')) await inspect(line.slice(5).trimStart());
            }
          }
          // Bound retained metadata parsing; provider content is only passed through.
          if (pending.length > 128 * 1024) pending = '';
          if (chunk.done) {
            if (!sse && pending) await inspect(pending);
            if (sse && pending.startsWith('data:')) await inspect(pending.slice(5).trim());
            await finish(failed ? 'failed' : 'succeeded'); controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          try { await finish(signal?.aborted ? 'cancelled' : 'failed'); } finally { controller.error(error); }
        }
      },
      async cancel(reason) {
        try { await reader.cancel(reason); } finally { await finish(signal?.aborted ? 'cancelled' : complete && !failed ? 'succeeded' : 'failed'); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

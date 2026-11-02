import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { resolveModel } from './config.js';
import { createMeteredFetch, normalizeCompatibleUsage, type UsageMessage } from './usage.js';

const model = resolveModel({ MODEL_NAME: 'fixture-model', MODEL_API_KEY: 'synthetic-key' }).model;
const context = normalizeContext({ messages: [{ role: 'user' as const, content: 'fixture', timestamp: 1 }] });

test('positive prompt totals do not imply zero cache subsets; only measured zero input forces zero', () => {
  const missing = normalizeCompatibleUsage({ prompt_tokens: 100, completion_tokens: 10 });
  assert.equal(missing.input_tokens, 100);
  assert.equal(missing.output_tokens, 10);
  assert.equal(missing.cache_read_tokens, undefined);
  assert.equal(missing.cache_write_tokens, undefined);
  const explicit = normalizeCompatibleUsage({ prompt_tokens: 100, completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } });
  assert.equal(explicit.cache_read_tokens, 0);
  assert.equal(explicit.cache_write_tokens, 0);
  const readOnly = normalizeCompatibleUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 30 });
  assert.equal(readOnly.cache_read_tokens, 30);
  assert.equal(readOnly.cache_write_tokens, undefined);
  const zero = normalizeCompatibleUsage({ prompt_tokens: 0, completion_tokens: 0 });
  assert.equal(zero.cache_read_tokens, 0);
  assert.equal(zero.cache_write_tokens, 0);
});

test('installed Pi adapter receives final usage after finish_reason and cache subsets reconcile', async () => {
  const recorded: UsageMessage[] = [];
  let admitted = false, sent = 0;
  const transport: typeof fetch = async (_url, init) => {
    assert.equal(admitted, true);
    sent++;
    const request = JSON.parse(init!.body as string);
    assert.deepEqual(request.stream_options, { include_usage: true });
    return new Response([
      'data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":100,"completion_tokens":0}}\n\n',
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"fixture answer"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":30,"cache_write_tokens":10}}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const metered = createMeteredFetch(model, async message => {
    recorded.push(structuredClone(message));
    if (message.kind === 'dispatch') admitted = true;
  }, transport);
  const stream = streamSimple(model, context, { apiKey: 'synthetic-key', maxRetries: 0, fetch: metered });
  for await (const _event of stream) { /* consume through final usage */ }
  const final = await stream.result();
  assert.equal(sent, 1);
  // This fixture checks the installed adapter's semantics, rather than assuming SDK input includes cache.
  assert.equal(final.usage.input, 60);
  assert.equal(final.usage.cacheRead, 30);
  assert.equal(final.usage.cacheWrite, 10);
  const finishes = recorded.filter(message => message.kind === 'finish');
  assert.ok(finishes.length >= 1);
  assert.ok(finishes.every(message => message.measurements.output_tokens === 7));
  assert.deepEqual(finishes.at(-1)!.measurements,
    { input_tokens: 100, output_tokens: 7, cache_read_tokens: 30, cache_write_tokens: 10 });
  assert.equal(JSON.stringify(recorded).includes('fixture answer'), false);
  assert.equal(JSON.stringify(recorded).includes('synthetic-key'), false);
});

test('installed SDK cache zero defaults do not fill absent raw positive-input cache measurements', async () => {
  const recorded: UsageMessage[] = [];
  const metered = createMeteredFetch(model, async message => { recorded.push(structuredClone(message)); }, async () =>
    new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"fixture"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } }));
  const stream = streamSimple(model, context, { apiKey: 'synthetic-key', maxRetries: 0, fetch: metered });
  for await (const _event of stream) { /* consume the real installed adapter */ }
  const sdk = await stream.result();
  assert.equal(sdk.usage.cacheRead, 0);
  assert.equal(sdk.usage.cacheWrite, 0);
  const final = recorded.filter(message => message.kind === 'finish').at(-1)!;
  assert.equal(final.measurements.input_tokens, 100);
  assert.equal(final.measurements.output_tokens, 10);
  assert.equal(final.measurements.cache_read_tokens, undefined);
  assert.equal(final.measurements.cache_write_tokens, undefined);
  assert.equal(JSON.stringify(final).includes('cache_read_tokens'), false);
  assert.equal(JSON.stringify(final).includes('cache_write_tokens'), false);
});

test('retryable provider failure has one visible attempt with hidden retries disabled', async () => {
  const recorded: UsageMessage[] = [];
  let sent = 0;
  const metered = createMeteredFetch(model, async message => { recorded.push(message); }, async () => {
    sent++;
    return new Response('{"error":{"message":"synthetic failure"}}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  });
  const stream = streamSimple(model, context, { apiKey: 'synthetic-key', maxRetries: 0, fetch: metered });
  for await (const _event of stream) { /* provider failure is an SDK error event */ }
  assert.equal((await stream.result()).stopReason, 'error');
  assert.equal(sent, 1);
  assert.equal(recorded.filter(message => message.kind === 'dispatch').length, 1);
  assert.deepEqual(recorded.filter(message => message.kind === 'finish').at(-1)?.measurements, {});
});

test('dispatch storage failure prevents sending and real subsequent attempts get distinct indices', async () => {
  let sent = 0;
  const denied = createMeteredFetch(model, async () => { throw new Error('ledger unavailable'); }, async () => { sent++; return new Response(); });
  await assert.rejects(denied('https://fixture.invalid'), /ledger unavailable/);
  assert.equal(sent, 0);
  const recorded: UsageMessage[] = [];
  const metered = createMeteredFetch(model, async message => { recorded.push(message); }, async () => {
    sent++; return new Response('{"usage":{"prompt_tokens":0,"completion_tokens":0}}', { headers: { 'Content-Type': 'application/json' } });
  });
  await (await metered('https://fixture.invalid')).text();
  await (await metered('https://fixture.invalid')).text();
  assert.deepEqual(recorded.filter(message => message.kind === 'dispatch').map(message => message.request_index), [1, 2]);
  assert.deepEqual(recorded.filter(message => message.kind === 'finish').at(-1)?.measurements,
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
});

test('known partial usage survives cancellation; absent usage never becomes SDK default zero', async () => {
  const recorded: UsageMessage[] = [];
  const abort = new AbortController();
  const wire = new TextEncoder().encode('data: {"choices":[],"usage":{"prompt_tokens":25}}\n\n');
  const metered = createMeteredFetch(model, async message => { recorded.push(structuredClone(message)); }, async () =>
    new Response(new ReadableStream({ start(controller) { controller.enqueue(wire); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await metered('https://fixture.invalid', { signal: abort.signal });
  const reader = response.body!.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel();
  const last = recorded.filter(message => message.kind === 'finish').at(-1)!;
  assert.equal(last.status, 'cancelled');
  assert.equal(last.measurements.input_tokens, 25);
  assert.equal(last.measurements.output_tokens, undefined);
  assert.deepEqual(normalizeCompatibleUsage(undefined), {});
  assert.equal(normalizeCompatibleUsage({}).input_tokens, undefined);
  assert.equal(normalizeCompatibleUsage({ prompt_tokens: -1, completion_tokens: 1.5 }).input_tokens, undefined);
});

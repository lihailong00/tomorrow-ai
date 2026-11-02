import { describe, expect, it, vi } from 'vitest';
import {
  ApiClient, ApiError, createDesktopTransport, createFetchTransport, initialChatStreamState,
  normalizeServerUrl, reduceChatStream, SseParser,
} from '../src/index';
import type { ChatIntent, ClientTransport, DesktopStreamEvent, TransportRequest } from '../src/index';

const manifest = { id: 'test-a', name: '本机合成测试', api_version: 1, deployment_mode: 'self_hosted', registration_policy: 'open', auth_methods: ['phone_password', 'email_password'], dataflow: {}, public_url: '' };
const json = (value: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const intent: ChatIntent = { message: '测试中文', conversation_id: null, client_request_id: 'test-request', remember: false, upload_ids: [] };
const event = (id: number, name: string, data: unknown) => `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe('server identity and URL policy', () => {
  it('normalizes official URL, v1 suffix and loopback for local use', () => {
    expect(normalizeServerUrl(' HTTPS://Example.COM:443/v1/ ')).toBe('https://example.com');
    expect(normalizeServerUrl('http://127.0.0.1:19329')).toBe('http://127.0.0.1:19329');
    expect(normalizeServerUrl('http://[::1]:19329')).toBe('http://[::1]:19329');
  });
  it.each(['https://user:pass@example.com', 'https://example.com/private', 'https://example.com?token=x', 'https://example.com/#fragment', 'file:///private', 'http://example.com', 'https://example.com\\@evil.test'])('rejects unsafe or ambiguous server %s', value => {
    expect(() => normalizeServerUrl(value)).toThrow(ApiError);
  });
  it('requires explicit opt in to private LAN HTTP and never allows public HTTP', () => {
    expect(() => normalizeServerUrl('http://192.168.1.20')).toThrow();
    expect(normalizeServerUrl('http://192.168.1.20', true)).toBe('http://192.168.1.20');
    expect(() => normalizeServerUrl('http://8.8.8.8', true)).toThrow();
  });
  it('never sends password/token after instance replacement at same origin', async () => {
    let identity = 'test-a'; const calls: TransportRequest[] = [];
    const transport: ClientTransport = { request: async input => {
      calls.push(input);
      return input.url.endsWith('/instance') ? json({ ...manifest, id: identity }) : json({ token: 'secret', user: {} });
    } };
    const client = new ApiClient('http://localhost:19329', { token: 'existing-token', transport });
    await client.inspectInstance(); identity = 'test-b';
    await expect(client.loginWithPhone('17300000001', 'password123')).rejects.toMatchObject({ code: 'identity_changed' });
    expect(calls.every(c => c.url.endsWith('/instance') && !c.headers.Authorization && !c.body)).toBe(true);
  });
  it('rechecks identity before subsequent authenticated requests without retaining passwords', async () => {
    const calls: TransportRequest[] = [];
    const transport: ClientTransport = { request: async input => { calls.push(input); return json(input.url.endsWith('/instance') ? manifest : {}); } };
    const client = new ApiClient('http://localhost', { token: 'test-token', transport });
    await client.me(); await client.today();
    expect(calls.map(c => new URL(c.url).pathname)).toEqual(['/v1/instance', '/v1/me', '/v1/instance', '/v1/today']);
    expect(calls[0].headers.Authorization).toBeUndefined(); expect(calls[1].headers.Authorization).toBe('Bearer test-token');
  });
  it('preserves server rate-limit errors and retry-after', async () => {
    const client = new ApiClient('http://localhost', { transport: { request: async input => input.url.endsWith('/instance') ? json(manifest) : { ...json({ error: { code: 'limited', message: '稍后再试' } }, 429), headers: { 'Retry-After': '60' } } } });
    await expect(client.me()).rejects.toMatchObject({ code: 'limited', message: '稍后再试', retryAfterSeconds: 60, status: 429 });
  });
  it('keeps failed requests disposed after switching servers and suppresses late events', async () => {
    let resolve!: (value: ReturnType<typeof json>) => void;
    const client = new ApiClient('http://localhost', { transport: { request: input => input.url.endsWith('/instance') ? Promise.resolve(json(manifest)) : new Promise(r => { resolve = r; }) } });
    const pending = client.me(); await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    client.dispose(); resolve(json({ name: 'old-user' }));
    await expect(pending).rejects.toMatchObject({ code: 'connection_changed' });
    await expect(client.today()).rejects.toMatchObject({ code: 'connection_changed' });
  });
});

describe('incremental real SSE', () => {
  it('parses fragmented BOM, CRLF, Chinese text and ignores keep-alives', () => {
    const events: unknown[] = []; const parser = new SseParser(e => events.push(e));
    const input = '\uFEFF: keep-alive\r\n\r\n' + event(0, 'snapshot', { status: 'running', content: '' }).replaceAll('\n', '\r\n') + event(1, 'text_delta', { delta: '中文🙂' });
    for (const unit of input) parser.push(unit);
    parser.end();
    expect(events).toEqual([{ id: 0, event: 'snapshot', data: { status: 'running', content: '' } }, { id: 1, event: 'text_delta', data: { delta: '中文🙂' } }]);
  });
  it('rejects invalid progress IDs, malformed JSON and bounded oversized events', () => {
    expect(() => new SseParser(() => {}).push('id: nope\ndata: {}\n\n')).toThrow();
    expect(() => new SseParser(() => {}).push('id: 1\ndata: bad\n\n')).toThrow();
    expect(() => new SseParser(() => {}, 32).push('data: ' + 'a'.repeat(40))).toThrow();
  });
  it('does not emit an unterminated event', () => {
    const callback = vi.fn(); const parser = new SseParser(callback);
    parser.push('id: 1\ndata: {}'); parser.end(); expect(callback).not.toHaveBeenCalled();
  });
  it('replays snapshots by replacement and ignores duplicate deltas', () => {
    let state = initialChatStreamState();
    state = reduceChatStream(state, { id: 3, event: 'snapshot', data: { content: '已经收到', status: 'running' } });
    state = reduceChatStream(state, { id: 4, event: 'text_delta', data: { delta: '的文字' } });
    state = reduceChatStream(state, { id: 4, event: 'text_delta', data: { delta: '的文字' } });
    expect(state.content).toBe('已经收到的文字');
    state = reduceChatStream(state, { id: 4, event: 'snapshot', data: { content: '已经收到的文字', status: 'running' } });
    expect(state.content).toBe('已经收到的文字');
    state = reduceChatStream(state, { id: 5, event: 'text_delta', data: { delta: '新尝试', replace: true } });
    expect(state.content).toBe('新尝试');
  });
  it('sends the exact immutable request on reconnect, preserving cursor and explicit retry', async () => {
    const calls: TransportRequest[] = [];
    const transport: ClientTransport = { request: async input => {
      calls.push(input);
      if (input.url.endsWith('/instance')) return json(manifest);
      input.onChunk?.(event(2, 'snapshot', { status: 'interrupted', content: '已保留' }));
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' };
    } };
    const client = new ApiClient('http://localhost', { transport });
    await client.chatStream(intent, () => {}, { signal: new AbortController().signal, lastEventId: 2, retry: true });
    const request = calls.at(-1)!;
    expect(request.body).toBe(JSON.stringify(intent));
    expect(request.headers['Last-Event-ID']).toBe('2'); expect(request.headers['X-Chat-Retry']).toBe('1');
  });
  it('detects truncation rather than marking a partial reply complete', async () => {
    const chunks: string[] = [];
    const client = new ApiClient('http://localhost', { transport: { request: async input => {
      if (input.url.endsWith('/instance')) return json(manifest);
      input.onChunk?.(event(0, 'snapshot', { status: 'running', content: '' }) + event(1, 'text_delta', { delta: 'partial' }));
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' };
    } } });
    await expect(client.chatStream(intent, e => { if (e.event === 'text_delta') chunks.push(String(e.data.delta)); }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'stream_interrupted' });
    expect(chunks).toEqual(['partial']);
  });
  it('keeps network receipt streaming without buffering the complete response', async () => {
    const encoder = new TextEncoder(); const received: string[] = [];
    let release!: () => void; const deferred = new Promise<void>(r => { release = r; });
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ async start(c) {
      c.enqueue(encoder.encode('一小段')); await deferred; c.enqueue(encoder.encode('第二段')); c.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;
    const pending = createFetchTransport(fetcher).request({ url: 'https://example.com/v1/chat/stream', method: 'POST', headers: {}, onChunk: c => { if (c) received.push(c); } });
    await vi.waitFor(() => expect(received).toEqual(['一小段'])); release();
    const result = await pending; expect(received).toEqual(['一小段', '第二段']); expect(result.body).toBe('');
  });
});

describe('injected desktop transport', () => {
  it('decodes split UTF8 and gates non-SSE error bodies before emitting content', async () => {
    const received: string[] = []; let handler!: (e: DesktopStreamEvent) => void;
    const transport = createDesktopTransport({ createChannel: callback => { handler = callback; return {}; }, invoke: async <T>(command: string) => {
      if (command === 'desktop_stream') {
        handler({ type: 'headers', status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const bytes = new TextEncoder().encode('你好');
        handler({ type: 'chunk', bytes: [...bytes.slice(0, 2)] }); handler({ type: 'chunk', bytes: [...bytes.slice(2)] }); handler({ type: 'end' });
      }
      return undefined as T;
    } });
    const result = await transport.request({ url: 'https://example.com/v1/chat/stream', method: 'POST', headers: {}, onChunk: text => { if (text) received.push(text); } });
    expect(received.join('')).toBe('你好'); expect(result.body).toBe('');
  });
  it('propagates abort to the native request and returns promptly without later data', async () => {
    const controller = new AbortController(); const commands: string[] = [];
    const transport = createDesktopTransport({ createChannel: () => ({}), invoke: <T>(command: string) => {
      commands.push(command);
      return command === 'desktop_cancel' ? Promise.resolve(undefined as T) : new Promise<T>(() => {});
    } });
    const pending = transport.request({ url: 'https://example.com/v1/me', method: 'GET', headers: {}, signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(commands).toEqual(['desktop_request', 'desktop_cancel']);
  });
});

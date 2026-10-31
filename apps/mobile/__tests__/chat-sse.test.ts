import { ApiClient } from '../src/api/client';
import { ChatTransportError, readChatSse, SseParser, SseEvent } from '../src/api/chatSse';

class FakeXhr {
  static instances: FakeXhr[] = [];
  readyState = 0;
  status = 0;
  responseText = '';
  responseURL = '';
  withCredentials = true;
  timeout = 0;
  headers: Record<string, string> = {};
  body?: string;
  url = '';
  contentType = 'text/event-stream';
  onprogress: (() => void) | null = null;
  onreadystatechange: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() { FakeXhr.instances.push(this); }
  open(method: string, url: string) { expect(method).toBe('POST'); this.url = url; this.readyState = 1; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getResponseHeader(name: string) { return name === 'Content-Type' ? this.contentType : null; }
  send(body: string) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  chunk(text: string, status = 200) {
    this.status = status;
    this.readyState = 3;
    this.responseText += text;
    this.onprogress?.();
  }
  end() { this.readyState = 4; this.onload?.(); }
}
const frame = (id: number, event: string, data: unknown) =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const originalXhr = globalThis.XMLHttpRequest;
beforeEach(() => { FakeXhr.instances = []; (globalThis as any).XMLHttpRequest = FakeXhr; });
afterEach(() => { globalThis.XMLHttpRequest = originalXhr; jest.useRealTimers(); });

test('SSE framing handles every character boundary, UTF-8 decoded Chinese/emoji, BOM, CRLF, comments and multiline JSON', () => {
  const events: SseEvent[] = [];
  const parser = new SseParser(event => events.push(event));
  const source = '\uFEFF: keepalive\r\nid: 12\r\nevent: text_delta\r\ndata: {"delta":\r\ndata: "你😀好"}\r\n\r\n';
  for (const character of source.split('')) parser.push(character);
  expect(events).toEqual([{ id: 12, event: 'text_delta', data: { delta: '你😀好' } }]);
  parser.push('id: 13\nevent: done\ndata: {"partial":true}');
  parser.end();
  expect(events).toHaveLength(1);
});
test('SSE CR-only framing and a final CR blank line are recognized without completing an unfinished record', () => {
  const events: SseEvent[] = [];
  const parser = new SseParser(event => events.push(event));
  parser.push('id: 1\revent: accepted\rdata: {"ok":true}\r\r');
  parser.end();
  expect(events).toHaveLength(1);
});
test('invalid IDs, malformed data and oversized incomplete frames fail visibly', () => {
  expect(() => new SseParser(() => {}).push('id: nope\ndata: {}\n\n')).toThrow(ChatTransportError);
  expect(() => new SseParser(() => {}).push('id: 1\ndata: bad\n\n')).toThrow(ChatTransportError);
  expect(() => new SseParser(() => {}, 20).push('data: ' + 'x'.repeat(21))).toThrow(ChatTransportError);
});
test('native XHR publishes a real delayed partial chunk before final response and cleans all handlers', async () => {
  jest.useFakeTimers();
  const signal = new AbortController();
  const received: SseEvent[] = [];
  let finished = false;
  const request = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: { Authorization: 'Bearer synthetic' },
    body: '{}', signal: signal.signal, onEvent: event => received.push(event) }).then(() => { finished = true; });
  const xhr = FakeXhr.instances[0];
  expect(xhr.withCredentials).toBe(false);
  expect(xhr.url).not.toContain('synthetic');
  setTimeout(() => xhr.chunk(frame(1, 'text_delta', { delta: '第一段' })), 30);
  setTimeout(() => { xhr.chunk(frame(2, 'done', { response: {} })); xhr.end(); }, 300);
  await jest.advanceTimersByTimeAsync(30);
  expect(received.map(event => event.data.delta)).toEqual(['第一段']);
  expect(finished).toBe(false);
  await jest.advanceTimersByTimeAsync(270);
  await request;
  expect(received).toHaveLength(2);
  expect(xhr.onprogress).toBeNull();
  expect(xhr.onload).toBeNull();
});
test('cancellation rejects promptly, aborts native work and rejects late bytes', async () => {
  const controller = new AbortController();
  const received = jest.fn();
  const request = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: {}, body: '{}',
    signal: controller.signal, onEvent: received }).catch(error => error);
  const xhr = FakeXhr.instances[0];
  const staleProgress = xhr.onprogress;
  controller.abort();
  expect(await request).toMatchObject({ code: 'cancelled' });
  xhr.responseText = frame(1, 'text_delta', { delta: 'late' });
  staleProgress?.();
  expect(received).not.toHaveBeenCalled();
  expect(xhr.aborted).toBe(true);
});
test.each([['application/json', 200, 'stream_unavailable'], ['text/html', 404, 'stream_unavailable']])(
  'a buffered JSON/unsupported endpoint is actionable, never simulated as streaming (%s)', async (type, status, code) => {
    const received = jest.fn();
    const request = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: {}, body: '{}',
      signal: new AbortController().signal, onEvent: received }).catch(error => error);
    const xhr = FakeXhr.instances[0];
    xhr.contentType = type;
    xhr.chunk('{"message":"all at once"}', status as number);
    xhr.end();
    expect(await request).toMatchObject({ code });
    expect(received).not.toHaveBeenCalled();
  },
);
test('identity verification finishes anonymously before any bearer stream; disposal while verifying sends nothing', async () => {
  let verify!: () => void;
  const verified = new Promise<void>(resolve => { verify = resolve; });
  const api = new ApiClient('https://own.test', 'synthetic-token', undefined, jest.fn(), () => verified);
  const request = api.chatStream({ message: 'hello', conversation_id: null, client_request_id: 'fixed', remember: false, upload_ids: [] },
    jest.fn(), { signal: new AbortController().signal }).catch(error => error);
  expect(FakeXhr.instances).toHaveLength(0);
  api.dispose();
  verify();
  expect(await request).toMatchObject({ code: 'connection_changed' });
  expect(FakeXhr.instances).toHaveLength(0);
});
test('reattachment keeps request fields, cursor and explicit retry header; ApiClient disposal aborts the stream', async () => {
  const api = new ApiClient('https://own.test', 'synthetic-token', undefined, jest.fn(), jest.fn().mockResolvedValue(undefined));
  const intent = { message: 'hello', conversation_id: null, client_request_id: 'fixed', remember: false, upload_ids: ['original'] };
  const request = api.chatStream(intent, jest.fn(), { signal: new AbortController().signal, lastEventId: 6, retry: true }).catch(error => error);
  await Promise.resolve();
  const xhr = FakeXhr.instances[0];
  expect(JSON.parse(xhr.body!)).toEqual(intent);
  expect(xhr.headers).toMatchObject({ Authorization: 'Bearer synthetic-token', 'Last-Event-ID': '6', 'X-Chat-Retry': '1' });
  api.dispose();
  expect(await request).toMatchObject({ code: 'cancelled' });
  expect(xhr.aborted).toBe(true);
});
test('401 invokes unauthorized once and native redirects are rejected', async () => {
  const unauthorized = jest.fn();
  const request = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: {}, body: '{}',
    signal: new AbortController().signal, onEvent: jest.fn(), onUnauthorized: unauthorized }).catch(error => error);
  const xhr = FakeXhr.instances[0]; xhr.chunk('{}', 401); xhr.end();
  expect(await request).toMatchObject({ status: 401 }); expect(unauthorized).toHaveBeenCalledTimes(1);
  const redirected = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: {}, body: '{}',
    signal: new AbortController().signal, onEvent: jest.fn() }).catch(error => error);
  const next = FakeXhr.instances[1]; next.responseURL = 'https://elsewhere.test'; next.chunk(frame(1, 'accepted', {}));
  expect(await redirected).toMatchObject({ code: 'redirect_blocked' });
});


test('a valid maximum astral retry/completion snapshot fits the bounded frame budget', () => {
  const content = '😀'.repeat(60000);
  const body = { content, previous_content: content, response: {
    message: { content }, user_message: { content: '😀'.repeat(20000) },
  } };
  const received = jest.fn(); const parser = new SseParser(received);
  const encoded = frame(500, 'snapshot', body);
  for (let offset = 0; offset < encoded.length; offset += 509) parser.push(encoded.slice(offset, offset + 509));
  expect(received).toHaveBeenCalledTimes(1);
  expect(received.mock.calls[0][0].data.response.message.content).toBe(content);
});
test('the retained native response buffer rotates at its bound without dropping already delivered text', async () => {
  const received = jest.fn();
  const request = readChatSse({ url: 'https://own.test/v1/chat/stream', headers: {}, body: '{}',
    signal: new AbortController().signal, onEvent: received }).catch(error => error);
  const xhr = FakeXhr.instances[0];
  xhr.chunk(frame(1, 'text_delta', { delta: 'kept partial' }));
  xhr.chunk(':keep\n'.repeat(350000));
  expect(await request).toMatchObject({ code: 'stream_rotate' });
  expect(received).toHaveBeenCalledTimes(1);
  expect(received.mock.calls[0][0].data.delta).toBe('kept partial');
  expect(xhr.aborted).toBe(true);
});

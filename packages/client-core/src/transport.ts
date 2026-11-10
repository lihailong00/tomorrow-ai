import { ApiError, cancelled } from './errors';

export interface TransportRequest {
  url: string; method: string; headers: Record<string, string>; body?: string | FormData;
  signal?: AbortSignal; onChunk?: (chunk: string) => void; allowInsecureLan?: boolean;
}
export interface TransportResponse { status: number; headers: Record<string, string>; body: string; url?: string }
export interface ClientTransport { request(input: TransportRequest): Promise<TransportResponse> }
const RESPONSE_LIMIT = 2 * 1024 * 1024;
// The invoke result and ordered Channel messages use separate IPC deliveries.
const CHANNEL_DRAIN_TIMEOUT_MS = 5000;
export function isEventStream(headers: Record<string, string>): boolean {
  return (headers['content-type'] ?? '').toLowerCase().split(';')[0].trim() === 'text/event-stream';
}
export function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

export const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;

/** No cookies, redirects or implicit retries. The server is always user-selected. */
export function createFetchTransport(fetcher: typeof fetch = globalThis.fetch): ClientTransport {
  return {
    async request(input) {
      if (input.signal?.aborted) throw cancelled();
      const response = await fetcher(input.url, {
        method: input.method, headers: input.headers, body: input.body,
        signal: input.signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
      });
      if (response.redirected || (response.url && response.url !== input.url)) throw new ApiError('redirect_blocked', '接口发生跳转，请检查服务地址。');
      const headers = Object.fromEntries(response.headers.entries());
      const streaming = response.ok && !!input.onChunk && isEventStream(headers);
      const reader = response.body?.getReader();
      let body = '';
      if (!reader) {
        if (streaming) throw new ApiError('stream_unavailable', '此环境不支持实时回复。');
        body = await response.text();
        if (body.length > RESPONSE_LIMIT) throw new ApiError('response_too_large', '服务返回的数据过大，请缩小查询范围。');
        return { status: response.status, headers, body, url: response.url || input.url };
      }
      const decoder = new TextDecoder();
      let completed = false;
      const append = (chunk: string) => {
        if (input.signal?.aborted) throw cancelled();
        if (streaming) input.onChunk!(chunk);
        else { body += chunk; if (body.length > RESPONSE_LIMIT) throw new ApiError('response_too_large', '服务返回的数据过大，请缩小查询范围。'); }
      };
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) { completed = true; break; }
          append(decoder.decode(result.value, { stream: true }));
        }
        append(decoder.decode());
      } finally {
        if (!completed) await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { status: response.status, headers, body, url: response.url || input.url };
    },
  };
}

export type DesktopStreamEvent =
  | { type: 'headers'; status: number; headers: Record<string, string> }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' };
export interface DesktopBridge {
  invoke<T>(command: string, args: Record<string, unknown>): Promise<T>;
  createChannel(handler: (event: DesktopStreamEvent) => void): unknown;
}

/** The bridge is injected, keeping @tauri-apps/api out of browser bundles. */
export function createDesktopTransport(bridge: DesktopBridge): ClientTransport {
  return {
    async request(input) {
      if (input.signal?.aborted) throw cancelled();
      const url = new URL(input.url);
      const requestId = globalThis.crypto.randomUUID();
      let body: string | {base64: string} | undefined;
      const headers = normalizeHeaders(input.headers);
      if (input.body instanceof FormData) {
        if (url.pathname !== '/v1/uploads' || input.method !== 'POST' || input.onChunk) {
          throw new ApiError('invalid_upload', '附件只能通过上传接口发送。');
        }
        const multipart = new Response(input.body);
        const bytes = new Uint8Array(await multipart.arrayBuffer());
        if (input.signal?.aborted) throw cancelled();
        if (bytes.length > MAX_CHAT_IMAGE_BYTES + 4096) throw new ApiError('image_too_large', '图片超过 4 MiB，请缩小后重试。');
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        }
        body = {base64: btoa(binary)};
        headers['content-type'] = multipart.headers.get('content-type')!;
      } else {
        body = input.body;
      }
      const request = {
        serverUrl: url.origin, path: url.pathname + url.search, method: input.method,
        headers, body, allowInsecureLan: input.allowInsecureLan ?? false,
      };
      let rejectAbort: (error: unknown) => void = () => {};
      const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
      let finished = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (finished) return;
        void bridge.invoke('desktop_cancel', { requestId }).catch(() => {});
        rejectAbort(cancelled());
      };
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();
      try {
        if (input.signal?.aborted) throw cancelled();
        let operation: Promise<TransportResponse>;
        if (!input.onChunk) {
          operation = bridge.invoke<TransportResponse>('desktop_request', { request, requestId });
        } else {
          let response: TransportResponse = { status: 0, headers: {}, body: '', url: input.url };
          const decoder = new TextDecoder();
          let gotHeaders = false;
          let channelError: unknown;
          let ended = false;
          let finishChannel!: () => void;
          const channelDone = new Promise<void>(resolve => {finishChannel = resolve;});
          const append = (chunk: string) => {
            if (response.status >= 200 && response.status < 300 && isEventStream(response.headers)) input.onChunk!(chunk);
            else { response.body += chunk; if (response.body.length > RESPONSE_LIMIT) throw new ApiError('response_too_large', '服务返回的数据过大。'); }
          };
          const channel = bridge.createChannel(event => {
            if (finished || input.signal?.aborted || channelError) return;
            try {
              if (ended) throw new ApiError('invalid_response', '回复通道提前结束。');
              if (event.type === 'headers') {
                if (gotHeaders) throw new ApiError('invalid_response', '回复通道格式错误。');
                gotHeaders = true;
                response = { ...response, status: event.status, headers: normalizeHeaders(event.headers) };
              } else if (event.type === 'chunk') {
                if (!gotHeaders) throw new ApiError('invalid_response', '回复通道缺少响应头。');
                append(decoder.decode(Uint8Array.from(event.bytes), { stream: true }));
              } else if (event.type === 'end') {
                if (!gotHeaders) throw new ApiError('invalid_response', '回复通道缺少响应头。');
                append(decoder.decode()); ended = true; finishChannel();
              }
            } catch (error) {
              channelError = error;
              void bridge.invoke('desktop_cancel', { requestId }).catch(() => {});
              rejectAbort(error);
            }
          });
          operation = bridge.invoke<void>('desktop_stream', { requestId, request, onEvent: channel }).then(async () => {
            if (finished || input.signal?.aborted) throw cancelled();
            if (channelError) throw channelError;
            // A successful invoke does not mean the WebView has processed the
            // final channel message. Drain it before closing/ignoring callbacks.
            if (!ended) await Promise.race([channelDone, new Promise<never>((_, reject) => {
              drainTimer = setTimeout(() => reject(new ApiError('network', '回复连接已中断，收到的内容已保留。')), CHANNEL_DRAIN_TIMEOUT_MS);
            })]);
            if (channelError) throw channelError;
            if (!gotHeaders || !ended) throw new ApiError('network', '回复连接已中断，收到的内容已保留。');
            return response;
          });
        }
        const response = await Promise.race([operation, abortPromise]);
        if (input.signal?.aborted) throw cancelled();
        if (response.body.length > RESPONSE_LIMIT) throw new ApiError('response_too_large', '服务返回的数据过大。');
        return { ...response, url: response.url ?? input.url, headers: normalizeHeaders(response.headers) };
      } finally {
        finished = true;
        if (drainTimer !== undefined) clearTimeout(drainTimer);
        input.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

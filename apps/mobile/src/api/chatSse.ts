export type SseEvent = { id: number; event: string; data: Record<string, any> };

/** SSE framing is incremental; the native transport already decodes UTF-8. */
export class SseParser {
  private pending = '';
  private scanned = 0;
  private data: string[] = [];
  private event = 'message';
  private id = '';
  private size = 0;
  private first = true;
  // A retry snapshot can contain the 60k-scalar reply three times (current,
  // previous and response), plus a 20k-scalar user message. Count UTF-16 units.
  constructor(private emit: (event: SseEvent) => void, private limit = 1024 * 1024) {}
  push(chunk: string) {
    if (this.first && chunk) {
      this.first = false;
      chunk = chunk.replace(/^\uFEFF/, '');
    }
    this.pending += chunk;
    let start = 0;
    let index = this.scanned;
    for (; index < this.pending.length; index++) {
      const character = this.pending[index];
      if (character !== '\r' && character !== '\n') continue;
      // A CR at a chunk boundary may be followed by LF in the next chunk.
      if (character === '\r' && index === this.pending.length - 1) break;
      this.line(this.pending.slice(start, index));
      if (character === '\r' && this.pending[index + 1] === '\n') index++;
      start = index + 1;
    }
    this.pending = this.pending.slice(start);
    this.scanned = index - start;
    if (this.pending.length + this.size > this.limit) {
      throw new ChatTransportError('invalid_response', '回复数据过大，请重新连接。');
    }
  }
  end() {
    // A final CR is a valid newline. An unterminated data record stays pending.
    if (this.pending.endsWith('\r')) this.push('\n');
  }
  private line(line: string) {
    if (!line) {
      if (this.data.length) {
        if (!/^\d+$/.test(this.id) || !Number.isSafeInteger(Number(this.id))) {
          throw new ChatTransportError('invalid_response', '回复缺少有效进度编号，请检查服务版本。');
        }
        let value: unknown;
        try { value = JSON.parse(this.data.join('\n')); }
        catch { throw new ChatTransportError('invalid_response', '回复数据无法识别，请重新连接。'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ChatTransportError('invalid_response', '回复数据格式不正确。');
        }
        this.emit({ id: Number(this.id), event: this.event, data: value as Record<string, any> });
      }
      this.data = [];
      this.event = 'message';
      this.id = '';
      this.size = 0;
      return;
    }
    if (line.length > this.limit) throw new ChatTransportError('invalid_response', '回复数据过大，请重新连接。');
    if (line.startsWith(':')) return;
    this.size += line.length;
    if (this.size > this.limit) throw new ChatTransportError('invalid_response', '回复数据过大，请重新连接。');
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    if (field === 'event') this.event = value;
    if (field === 'id' && !value.includes('\0')) this.id = value;
  }
}

export class ChatTransportError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
    this.name = 'ChatTransportError';
  }
}

type StreamOptions = {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  onEvent: (event: SseEvent) => void;
  onUnauthorized?: () => void;
  xhrFactory?: () => XMLHttpRequest;
};

/** RN's fetch polyfill buffers text. onprogress enables Android incrementalEvents. */
export function readChatSse(options: StreamOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new ChatTransportError('cancelled', '操作已取消。'));
      return;
    }
    const xhr = options.xhrFactory?.() ?? new XMLHttpRequest();
    let finished = false;
    let offset = 0;
    const parser = new SseParser(options.onEvent);
    const cleanup = () => {
      options.signal.removeEventListener('abort', cancel);
      xhr.onprogress = null;
      xhr.onreadystatechange = null;
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
    };
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) { xhr.abort(); reject(error); } else resolve();
    };
    const cancel = () => finish(new ChatTransportError('cancelled', '操作已取消。'));
    const consume = () => {
      if (finished || xhr.readyState < 2 || xhr.status < 200 || xhr.status >= 300) return;
      if (xhr.responseURL && xhr.responseURL !== options.url) {
        finish(new ChatTransportError('redirect_blocked', '接口发生跳转，请重新检查服务器地址。'));
        return;
      }
      if (!(xhr.getResponseHeader('Content-Type') ?? '').toLowerCase().includes('text/event-stream')) {
        finish(new ChatTransportError('stream_unavailable', '当前服务不支持实时回复，请升级服务后重试。', xhr.status));
        return;
      }
      try {
        const text = xhr.responseText;
        parser.push(text.slice(offset));
        offset = text.length;
        // RN retains responseText internally. Rotate only the connection; the
        // durable request and numeric cursor resume without another model run.
        if (offset > 2 * 1024 * 1024) {
          finish(new ChatTransportError('stream_rotate', '正在重新连接回复…'));
        }
      } catch (error) { finish(error); }
    };
    xhr.open('POST', options.url, true);
    xhr.withCredentials = false;
    xhr.timeout = 150000;
    Object.entries(options.headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.onreadystatechange = consume;
    xhr.onprogress = consume;
    xhr.onerror = () => finish(new ChatTransportError('network', '连接已中断，收到的回复已保留。'));
    xhr.ontimeout = () => finish(new ChatTransportError('timeout', '回复连接超时，收到的内容已保留。'));
    xhr.onabort = cancel;
    xhr.onload = () => {
      if (finished) return;
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) options.onUnauthorized?.();
        let message = xhr.status === 404 || xhr.status === 405
          ? '当前服务不支持实时回复，请升级服务后重试。'
          : `回复未完成（${xhr.status}），收到的内容已保留。`;
        let code = xhr.status === 404 || xhr.status === 405 ? 'stream_unavailable' : 'request_failed';
        try {
          const error = JSON.parse(xhr.responseText)?.error;
          if (typeof error?.message === 'string') message = error.message;
          if (typeof error?.code === 'string') code = error.code;
        } catch {}
        finish(new ChatTransportError(code, message, xhr.status));
        return;
      }
      consume();
      if (!finished) {
        try { parser.end(); } catch (error) { finish(error); return; }
      }
      finish();
    };
    options.signal.addEventListener('abort', cancel);
    if (options.signal.aborted) { cancel(); return; }
    try { xhr.send(options.body); } catch (error) { finish(error); }
  });
}

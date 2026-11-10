import { ApiError, cancelled } from './errors';
import { normalizePhoneNumber, normalizeServerUrl, readInstanceManifest } from './server';
import { SseParser } from './stream';
import { createFetchTransport, isEventStream, normalizeHeaders } from './transport';
import type { ClientTransport, TransportRequest, TransportResponse } from './transport';
import type {
  AuthSession, ChatIntent, ChatStreamEvent, Conversation, CreateTodo, InstanceManifest,
  Memory, MemoryKind, MessagePage, PageOptions, PagedItems, SaveMemory, Task, Today,
  Todo, TodoFilter, UpdateTodo, Upload, User,
} from './types';

export interface ApiClientOptions {
  token?: string; transport?: ClientTransport; onUnauthorized?: () => void;
  expectedInstanceId?: string; allowInsecureLan?: boolean;
}
export interface StreamOptions { signal: AbortSignal; lastEventId?: number; retry?: boolean }
function query(options?: object): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined && value !== null) q.set(key, String(value));
  return q.size ? `?${q}` : '';
}
function password(value: string): void {
  const length = Array.from(value).length;
  if (length < 8 || length > 128) throw new ApiError('invalid_password', '密码需要 8–128 个字符。');
}
function assertPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path) || path.includes('..')) throw new ApiError('invalid_path', '接口路径无效。');
}
function responseError(response: TransportResponse): ApiError {
  let body: { error?: { code?: unknown; message?: unknown } } = {};
  try { body = JSON.parse(response.body); } catch {}
  const retry = Number(response.headers['retry-after']);
  const retryAfter = Number.isSafeInteger(retry) && retry > 0 ? retry : undefined;
  const message = typeof body?.error?.message === 'string' ? body.error.message :
    response.status === 401 ? '登录已失效，请重新登录。' : response.status === 429 ? '操作过于频繁，请稍后重试。' : `请求未完成（${response.status}）。`;
  return new ApiError(typeof body?.error?.code === 'string' ? body.error.code : response.status === 429 ? 'rate_limited' : 'request_failed', message, response.status, retryAfter);
}
function waitFor<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** One account on one confirmed server. Dispose and create a new instance on switching. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly transport: ClientTransport;
  private readonly requests = new Set<AbortController>();
  private disposed = false;
  private instanceId?: string;
  private verifying?: Promise<InstanceManifest>;
  private readonly options: ApiClientOptions;
  constructor(baseUrl: string, options: ApiClientOptions = {}) {
    // Changing the caller's settings object cannot retarget an existing account.
    this.options = { ...options };
    this.baseUrl = normalizeServerUrl(baseUrl, options.allowInsecureLan);
    this.transport = options.transport ?? createFetchTransport();
    this.instanceId = options.expectedInstanceId;
  }
  dispose(): void {
    this.disposed = true;
    for (const request of this.requests) request.abort();
    this.requests.clear();
  }
  private assertActive(signal?: AbortSignal): void {
    if (this.disposed) throw new ApiError('connection_changed', '服务器或账号已变化，请重新操作。');
    if (signal?.aborted) throw cancelled();
  }
  async inspectInstance(signal?: AbortSignal): Promise<InstanceManifest> {
    this.assertActive(signal);
    if (!this.verifying) {
      const operation = this.raw('/instance', 'GET', undefined, undefined, undefined, 12000).then(result => {
        let value: unknown;
        try { value = JSON.parse(result.body); } catch { throw new ApiError('incompatible_server', '服务器没有返回兼容的身份信息。'); }
        const manifest = readInstanceManifest(value);
        this.assertActive();
        if (this.instanceId && this.instanceId !== manifest.id) throw new ApiError('identity_changed', '服务器身份已变化，请重新确认连接；账号信息没有发送。');
        this.instanceId = manifest.id;
        return manifest;
      });
      this.verifying = operation;
      void operation.finally(() => { if (this.verifying === operation) this.verifying = undefined; }).catch(() => {});
    }
    const result = await waitFor(this.verifying, signal);
    this.assertActive(signal);
    return result;
  }
  private async raw(path: string, method: string, body?: string | FormData, signal?: AbortSignal,
    onChunk?: (chunk: string) => void, timeoutMs = 30000, extraHeaders?: Record<string, string>): Promise<TransportResponse> {
    this.assertActive(signal); assertPath(path);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    this.requests.add(controller);
    try {
      const authenticated = path !== '/instance' && path !== '/health';
      const input: TransportRequest = {
        url: `${this.baseUrl}/v1${path}`, method, body, signal: controller.signal,
        allowInsecureLan: this.options.allowInsecureLan,
        headers: {
          Accept: onChunk ? 'text/event-stream' : 'application/json',
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(authenticated && this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}),
          ...extraHeaders,
        },
        onChunk: onChunk ? chunk => { this.assertActive(signal); if (!controller.signal.aborted) onChunk(chunk); } : undefined,
      };
      const response = await this.transport.request(input);
      this.assertActive(signal);
      if (controller.signal.aborted) throw new ApiError('timeout', '服务响应超时。结果可能已保存，请先刷新，避免重复操作。');
      response.headers = normalizeHeaders(response.headers);
      if ((response.url && response.url !== input.url) || (response.status >= 300 && response.status < 400)) throw new ApiError('redirect_blocked', '接口发生跳转，请检查服务地址。');
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 401 && this.options.token) this.options.onUnauthorized?.();
        throw responseError(response);
      }
      return response;
    } catch (error) {
      this.assertActive(signal);
      if (controller.signal.aborted) throw new ApiError('timeout', '服务响应超时。结果可能已保存，请先刷新，避免重复操作。');
      if (error instanceof ApiError) throw error;
      throw new ApiError('network', '暂时连接不上所选服务，请检查网络和服务地址；不会切换到其他服务器。');
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.requests.delete(controller);
    }
  }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    this.assertActive(signal);
    if (path !== '/health' && path !== '/instance') await this.inspectInstance(signal);
    this.assertActive(signal);
    const payload = body === undefined || body instanceof FormData ? body : JSON.stringify(body);
    const response = await this.raw(path, method, payload, signal, undefined, timeoutMs);
    if (!response.body && response.status === 204) return undefined as T;
    try { return JSON.parse(response.body) as T; }
    catch { throw new ApiError('invalid_response', '服务返回的内容无法识别，请检查服务地址和版本。', response.status); }
  }
  health = (signal?: AbortSignal) => this.request<Record<string, unknown>>('/health', 'GET', undefined, signal);
  loginWithPhone = (phone: string, value: string) => {
    password(value);
    return this.request<AuthSession>('/auth/phone/login', 'POST', { phone: normalizePhoneNumber(phone), password: value });
  };
  loginWithEmail = (email: string, value: string) => {
    password(value);
    if (!email.trim() || !email.includes('@')) throw new ApiError('invalid_email', '请输入有效邮箱。');
    return this.request<AuthSession>('/auth/login', 'POST', { email: email.trim(), password: value });
  };
  login = this.loginWithEmail;
  me = (signal?: AbortSignal) => this.request<User>('/me', 'GET', undefined, signal);
  logout = () => this.request<{ ok: boolean }>('/auth/logout', 'POST', {});
  today = (signal?: AbortSignal) => this.request<Today>('/today', 'GET', undefined, signal);
  briefing = () => this.request<Task>('/briefing', 'POST', {});
  task = (id: string, signal?: AbortSignal) => this.request<Task>(`/tasks/${encodeURIComponent(id)}`, 'GET', undefined, signal);
  conversations = (page?: PageOptions, signal?: AbortSignal) => this.request<PagedItems<Conversation>>(`/conversations${query(page)}`, 'GET', undefined, signal);
  messages = (id: string, page?: PageOptions & { before?: string }, signal?: AbortSignal) => this.request<MessagePage>(`/conversations/${encodeURIComponent(id)}/messages${query(page)}`, 'GET', undefined, signal);
  uploadImage = (file: File, signal: AbortSignal) => {
    const form = new FormData();
    form.append('file', file);
    return this.request<Upload>('/uploads', 'POST', form, signal, 45_000);
  };
  analyzeImage = (id: string, signal: AbortSignal) => this.request<{text: string}>(`/uploads/${encodeURIComponent(id)}/analyze`, 'POST', undefined, signal, 120_000);
  deleteUpload = (id: string) => this.request<{ok: boolean}>(`/uploads/${encodeURIComponent(id)}`, 'DELETE');
  deleteMessage = (conversationId: string, messageId: string) => this.request<{ removed_message_ids: string[] }>(`/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`, 'DELETE');
  todos = (filter?: PageOptions & { filter?: TodoFilter; scope?: 'today' | 'all' }, signal?: AbortSignal) => this.request<PagedItems<Todo>>(`/todos${query(filter)}`, 'GET', undefined, signal);
  createTodo = (input: CreateTodo) => this.request<Todo>('/todos', 'POST', input);
  updateTodo = (id: string, input: UpdateTodo) => this.request<Todo>(`/todos/${encodeURIComponent(id)}`, 'PATCH', input);
  deleteTodo = (id: string) => this.request<{ ok: boolean }>(`/todos/${encodeURIComponent(id)}`, 'DELETE');
  prepareTodo = (id: string, clientRequestId: string) => this.request<Todo>(`/todos/${encodeURIComponent(id)}/prepare`, 'POST', { client_request_id: clientRequestId });
  memories = (kind?: MemoryKind, page?: PageOptions, signal?: AbortSignal) => this.request<PagedItems<Memory>>(`/memories${query({ ...page, kind })}`, 'GET', undefined, signal);
  saveMemory = (input: SaveMemory, id?: string) => this.request<Memory>(`/memories${id ? `/${encodeURIComponent(id)}` : ''}`, id ? 'PATCH' : 'POST', input);
  deleteMemory = (id: string) => this.request<{ ok: boolean }>(`/memories/${encodeURIComponent(id)}`, 'DELETE');
  async chatStream(intent: ChatIntent, onEvent: (event: ChatStreamEvent) => void, options: StreamOptions): Promise<void> {
    this.assertActive(options.signal);
    if (!intent.client_request_id || intent.client_request_id.length > 120 || !intent.message.trim() || Array.from(intent.message).length > 20000) throw new ApiError('invalid_message', '消息需要包含 1–20000 个字符和有效请求编号。');
    if (options.lastEventId !== undefined && (!Number.isSafeInteger(options.lastEventId) || options.lastEventId < 0)) throw new ApiError('invalid_cursor', '消息进度编号无效。');
    // Capture the immutable body BEFORE awaiting network. Resume with this exact intent.
    const body = JSON.stringify(intent);
    await this.inspectInstance(options.signal);
    this.assertActive(options.signal);
    let terminal = false;
    const parser = new SseParser(event => {
      if (event.event === 'done' || event.event === 'error' || (event.event === 'snapshot' && ['done', 'interrupted'].includes(String(event.data.status)))) terminal = true;
      onEvent(event);
    });
    const result = await this.raw('/chat/stream', 'POST', body, options.signal, chunk => parser.push(chunk), 30 * 60 * 1000, {
      ...(options.lastEventId !== undefined ? { 'Last-Event-ID': String(options.lastEventId) } : {}),
      ...(options.retry ? { 'X-Chat-Retry': '1' } : {}),
    });
    if (!isEventStream(result.headers)) throw new ApiError('stream_unavailable', '当前服务不支持实时回复，请升级服务后重试。');
    parser.end();
    if (!terminal) throw new ApiError('stream_interrupted', '回复连接已中断，收到的内容已保留。请重新连接此回复。');
  }
}

import type {
  Artifact,
  AuthSession,
  CapabilityResponse,
  ChatResponse,
  Connector,
  ConnectorItem,
  Conversation,
  Memory,
  MemoryKind,
  Message,
  Notification,
  Schedule,
  Task,
  Today,
  Upload,
  User,
} from '../domain/types';
import type { LocalFile } from '../platform/ports';
import { normalizePhoneNumber } from '../domain/phone';
import { validatePassword } from '../domain/password';

export type PhoneCodeChallenge = {
  challenge_id: string;
  expires_in: number;
  retry_after: number;
  test_mode: boolean;
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 0,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function normalizeServerUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!/^https?:\/\/[^\s/?#]+(?::\d+)?(?:\/[^\s?#]*)?$/i.test(value)) {
    throw new Error('请输入完整的服务地址，例如 https://api.example.com');
  }
  const authority = value.replace(/^https?:\/\//i, '').split('/')[0];
  if (authority.includes('@')) {
    throw new Error('服务地址不能包含账号或密码。');
  }
  return value;
}
export function newRequestId(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}
type Fetcher = typeof fetch;
function listQuery(
  options?: Record<string, string | number | boolean | undefined>,
): string {
  const entries = Object.entries(options ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  return entries.length
    ? '?' +
        entries
          .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
          .join('&')
    : '';
}
export class ApiClient {
  readonly baseUrl: string;
  private disposed = false;
  private requests = new Set<AbortController>();
  constructor(
    baseUrl: string,
    private token?: string,
    private onUnauthorized?: () => void,
    private fetcher: Fetcher = fetch,
    private verifyIdentity?: () => Promise<void>,
  ) {
    this.baseUrl = baseUrl ? normalizeServerUrl(baseUrl) : '';
  }
  dispose() {
    this.disposed = true;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }
  async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.disposed || !this.baseUrl) {
      throw new ApiError('connection_required', '请先检查并确认服务器连接。');
    }
    if (signal?.aborted) throw new ApiError('cancelled', '操作已取消。');
    if (this.verifyIdentity) await this.verifyIdentity();
    if (this.disposed)
      throw new ApiError(
        'connection_changed',
        '服务器连接已变化，请重新操作。',
      );
    if (signal?.aborted) throw new ApiError('cancelled', '操作已取消。');
    const controller = new AbortController();
    this.requests.add(controller);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel);
    if (signal?.aborted) {
      controller.abort();
    }
    const multipart =
      typeof FormData !== 'undefined' && body instanceof FormData;
    const smsCodeRequest = path === '/auth/phone/code';
    const timeout = setTimeout(
      () => controller.abort(),
      smsCodeRequest
        ? 45000 // The SMS provider may take up to 30 seconds; allow return-path margin.
        : path === '/chat' || path.endsWith('/transcribe')
        ? 120000
        : multipart
        ? 60000
        : 20000,
    );
    try {
      const response = await this.fetcher(`${this.baseUrl}/v1${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined && !multipart
            ? { 'Content-Type': 'application/json' }
            : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body !== undefined
          ? { body: multipart ? (body as FormData) : JSON.stringify(body) }
          : {}),
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
      } as RequestInit & { redirect: 'error' });
      if (this.disposed)
        throw new ApiError(
          'connection_changed',
          '服务器连接已变化，请重新操作。',
        );
      if (response.redirected)
        throw new ApiError(
          'redirect_blocked',
          '接口发生跳转，请重新检查服务器地址。',
        );
      const text = await response.text();
      const retryHeader = Number(response.headers?.get?.('Retry-After'));
      const retryAfterSeconds =
        Number.isSafeInteger(retryHeader) && retryHeader > 0
          ? retryHeader
          : undefined;
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        if (response.status === 429) {
          throw new ApiError(
            'rate_limited',
            '操作过于频繁，请稍后重试。',
            429,
            retryAfterSeconds,
          );
        }
        throw new ApiError(
          'invalid_response',
          '服务返回的内容无法识别，请检查服务地址和版本。',
          response.status,
          retryAfterSeconds,
        );
      }
      if (!response.ok) {
        if (response.status === 401 && this.token) {
          this.onUnauthorized?.();
        }
        throw new ApiError(
          data?.error?.code ?? 'request_failed',
          data?.error?.message ?? `请求未完成（${response.status}）`,
          response.status,
          retryAfterSeconds,
        );
      }
      if (this.disposed)
        throw new ApiError(
          'connection_changed',
          '服务器连接已变化，请重新操作。',
        );
      return data as T;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (smsCodeRequest) {
        throw new ApiError(
          'sms_send_uncertain',
          '发送结果尚未确认，短信可能仍会到达。请核对收件手机号，等待 60 秒后再试。',
          0,
          60,
        );
      }
      if ((error as Error).name === 'AbortError') {
        throw new ApiError(
          'timeout',
          '服务响应超时。任务可能已经提交，请先刷新列表，避免重复执行。',
        );
      }
      throw new ApiError(
        'network',
        '暂时连接不上服务。请检查网络、服务地址和后端是否启动。',
      );
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
      signal?.removeEventListener('abort', cancel);
    }
  }
  health = () => this.request<Record<string, unknown>>('/health');
  requestPhoneCode = (phone: string, purpose: 'register' | 'reset_password') =>
    this.request<PhoneCodeChallenge>('/auth/phone/code', 'POST', {
      phone: normalizePhoneNumber(phone),
      purpose,
    });
  loginWithPhone = (phone: string, password: string) => {
    validatePassword(password);
    return this.request<AuthSession>('/auth/phone/login', 'POST', {
      phone: normalizePhoneNumber(phone),
      password,
    });
  };
  registerWithPhone = (
    phone: string,
    code: string,
    challengeId: string,
    password: string,
    name: string,
    timezone = 'Asia/Shanghai',
  ) => {
    validatePassword(password);
    return this.request<AuthSession>('/auth/phone/register', 'POST', {
      phone: normalizePhoneNumber(phone),
      code,
      challenge_id: challengeId,
      password,
      name: name.trim(),
      timezone,
    });
  };
  resetPhonePassword = (
    phone: string,
    code: string,
    challengeId: string,
    newPassword: string,
  ) => {
    validatePassword(newPassword);
    return this.request<{ ok: boolean }>('/auth/phone/password/reset', 'POST', {
      phone: normalizePhoneNumber(phone),
      code,
      challenge_id: challengeId,
      new_password: newPassword,
    });
  };
  login = (email: string, password: string) =>
    this.request<AuthSession>('/auth/login', 'POST', {
      email: email.trim(),
      password,
    });
  register = (
    email: string,
    password: string,
    name: string,
    timezone = 'Asia/Shanghai',
    inviteCode?: string,
  ) =>
    this.request<AuthSession>('/auth/register', 'POST', {
      email: email.trim(),
      password,
      name: name.trim(),
      timezone,
      ...(inviteCode ? { invite_code: inviteCode.trim() } : {}),
    });
  me = () => this.request<User>('/me');
  updateMe = (data: Partial<Pick<User, 'name' | 'timezone'>>) =>
    this.request<User>('/me', 'PATCH', data);
  logout = () => this.request<{ ok: boolean }>('/auth/logout', 'POST', {});
  today = () => this.request<Today>('/today');
  briefing = () => this.request<Task>('/briefing', 'POST', {});
  memories = (kind?: MemoryKind, page?: { offset?: number; limit?: number }) =>
    this.request<{ items: Memory[]; next_offset?: number | null }>(
      `/memories${listQuery({ ...page, kind })}`,
    );
  saveMemory = (
    data: {
      content: string;
      title?: string;
      kind: MemoryKind;
      source?: string;
      version?: number;
      client_request_id?: string;
    },
    id?: string,
  ) =>
    this.request<Memory>(
      `/memories${id ? `/${encodeURIComponent(id)}` : ''}`,
      id ? 'PATCH' : 'POST',
      data,
    );
  deleteMemory = (id: string) =>
    this.request<{ ok: boolean }>(
      `/memories/${encodeURIComponent(id)}`,
      'DELETE',
    );
  tasks = (page?: { offset?: number; limit?: number; status?: string }) =>
    this.request<{ items: Task[]; next_offset?: number | null }>(
      `/tasks${listQuery(page)}`,
    );
  task = (id: string) => this.request<Task>(`/tasks/${encodeURIComponent(id)}`);
  createTask = (
    instruction: string,
    approval_required: boolean,
    client_request_id: string,
  ) =>
    this.request<Task>('/tasks', 'POST', {
      instruction,
      approval_required,
      client_request_id,
    });
  cancelTask = (id: string) =>
    this.request<Task>(`/tasks/${encodeURIComponent(id)}/cancel`, 'POST', {});
  approveTask = (id: string) =>
    this.request<Task>(`/tasks/${encodeURIComponent(id)}/approve`, 'POST', {});
  schedules = () => this.request<{ items: Schedule[] }>('/schedules');
  saveSchedule = (
    data: Partial<
      Pick<
        Schedule,
        'title' | 'instruction' | 'frequency' | 'time' | 'timezone' | 'enabled'
      >
    > & { client_request_id?: string },
    id?: string,
  ) =>
    this.request<Schedule>(
      `/schedules${id ? `/${encodeURIComponent(id)}` : ''}`,
      id ? 'PATCH' : 'POST',
      data,
    );
  deleteSchedule = (id: string) =>
    this.request<{ ok: boolean }>(
      `/schedules/${encodeURIComponent(id)}`,
      'DELETE',
    );
  conversations = (page?: { offset?: number; limit?: number }) =>
    this.request<{ items: Conversation[]; next_offset?: number | null }>(`/conversations${listQuery(page)}`);
  messages = (id: string, page?: { offset?: number; limit?: number; before?: string }) =>
    this.request<{ items: Message[]; next_offset?: number | null; next_before?: string | null }>(
      `/conversations/${encodeURIComponent(id)}/messages${listQuery(page)}`,
    );
  chat = (
    message: string,
    conversation_id: string | undefined,
    client_request_id: string,
    upload_ids: string[] = [],
  ) =>
    this.request<ChatResponse>('/chat', 'POST', {
      message,
      conversation_id,
      client_request_id,
      remember: false,
      upload_ids,
    });
  upload = (file: LocalFile, signal?: AbortSignal) => {
    const data = new FormData();
    data.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mime_type,
    } as any);
    return this.request<Upload>('/uploads', 'POST', data, signal);
  };
  uploads = (
    page?: { offset?: number; limit?: number; kind?: 'all' | 'file' | 'audio' },
    signal?: AbortSignal,
  ) =>
    this.request<{
      items: Upload[];
      next_offset?: number | null;
      has_more?: boolean;
    }>(`/uploads${listQuery(page)}`, 'GET', undefined, signal);
  deleteUpload = (id: string) =>
    this.request<{ ok: boolean }>(
      '/uploads/' + encodeURIComponent(id),
      'DELETE',
    );
  transcribe = (id: string, signal?: AbortSignal) =>
    this.request<{ upload_id: string; text: string; model: string }>(
      `/uploads/${encodeURIComponent(id)}/transcribe`,
      'POST',
      {},
      signal,
    );
  capabilities = () => this.request<CapabilityResponse>('/capabilities');
  notifications = (page?: { offset?: number; limit?: number; read?: boolean }) =>
    this.request<{ items: Notification[]; next_offset?: number | null }>(`/notifications${listQuery(page)}`);
  readNotification = (id: string) =>
    this.request<{ ok: boolean }>(
      `/notifications/${encodeURIComponent(id)}/read`,
      'POST',
      {},
    );
  artifacts = (page?: { offset?: number; limit?: number }) =>
    this.request<{ items: Artifact[]; next_offset?: number | null }>(`/artifacts${listQuery(page)}`);
  artifact = (id: string) =>
    this.request<Artifact>(`/artifacts/${encodeURIComponent(id)}`);
  connectors = () => this.request<{ items: Connector[] }>('/connectors');
  authorizeConnector = (id: string) =>
    this.request<{ authorization_url: string }>(
      `/connectors/${encodeURIComponent(id)}/authorize`,
      'POST',
      {},
    );
  disconnectConnector = (id: string) =>
    this.request<{ ok: boolean; revoked: boolean; detail?: string }>(
      `/connectors/${encodeURIComponent(id)}`,
      'DELETE',
    );
  connectorItems = (id: string) => {
    const suffix =
      id === 'google_calendar'
        ? 'events'
        : id === 'gmail'
        ? 'messages'
        : 'files';
    return this.request<{ items: ConnectorItem[]; next_page_token?: string }>(
      `/connectors/${encodeURIComponent(id)}/${suffix}`,
    );
  };
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

import type { ApiClient } from '../api/client';
import { errorMessage } from '../api/client';
import { ChatTransportError, type SseEvent } from '../api/chatSse';
import type { ChatIntent, ChatResponse, Message } from '../domain/types';
import { updateActivity, type ChatActivity } from './chatActivity';

export type ChatProgress = {
  sequence: number;
  phase: 'sending' | 'replying' | 'reconnecting' | 'failed' | 'complete';
  status: string;
  content: string;
  activities?: readonly ChatActivity[];
  conversationId?: string;
  userMessage?: Message;
  assistantId?: string;
  assistantCreatedAt?: string;
  error?: string;
  response?: ChatResponse;
  /** Authoritative turn linkage, including tentative edit accepted events. */
  removedMessageIds?: string[];
};

function toolLabel(tool: unknown) {
  const name = typeof tool === 'string' ? tool.toLowerCase() : '';
  if (name === 'research_plan') return '正在整理调查清单…';
  if (name === 'research_review') return '正在核对来源与未确认事项…';
  if (/create|save|update|delete|cancel|approve|write/.test(name)) return '正在处理操作…';
  if (/search|find/.test(name)) return '正在搜索…';
  if (/read|get|list|fetch|memory|upload/.test(name)) return '正在读取资料…';
  return '正在使用工具…';
}

function toolEndLabel(tool: unknown, isError: unknown) {
  if (isError === true) return '这一步未完成，正在继续…';
  if (tool === 'web_search') return '搜索完成，正在整理资料…';
  if (tool === 'web_fetch') return '网页已读取，正在继续…';
  if (tool === 'research_plan') return '正在查找相关资料…';
  return '正在回复…';
}

type Options = {
  api: Pick<ApiClient, 'chatStream'>;
  intent: ChatIntent;
  isCurrent: () => boolean;
  onChange: (progress: ChatProgress) => void;
  onComplete: (response: ChatResponse) => void;
};

/** A route-owned durable turn. Disconnects never mutate its original payload. */
export function createChatStreamController(options: Options) {
  const intent: ChatIntent = Object.freeze({ ...options.intent,
    upload_ids: Object.freeze([...options.intent.upload_ids]) });
  let progress: ChatProgress = { sequence: -1, phase: 'sending', status: '发送中…', content: '' };
  let disposed = false;
  let generation = 0;
  let active = false;
  let terminal = false;
  let connection: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelWait: (() => void) | undefined;
  const current = () => !disposed && options.isCurrent();
  const publish = (change: Partial<ChatProgress>) => {
    if (!current()) return;
    progress = { ...progress, ...change };
    if (change.phase === 'failed') progress = { ...progress, activities: progress.activities?.map(item =>
      item.state === 'running' ? { ...item, state: 'interrupted' as const } : item) };
    options.onChange(progress);
  };
  const complete = (response: ChatResponse) => {
    if (!response?.message || typeof response.message.content !== 'string' ||
      typeof response.conversation_id !== 'string') {
      throw new ChatTransportError('invalid_response', '回复结果不完整，请重新连接。');
    }
    terminal = true;
    publish({ phase: 'complete', status: '', error: undefined, response,
      activities: progress.activities?.map(item => item.state === 'running' ? { ...item, state: 'interrupted' as const } : item),
      content: response.message.content, conversationId: response.conversation_id,
      userMessage: response.user_message ?? progress.userMessage,
      removedMessageIds: response.removed_message_ids ?? progress.removedMessageIds,
      assistantId: response.message.id, assistantCreatedAt: response.message.created_at });
    if (current()) options.onComplete(response);
    connection?.abort();
  };
  const receive = (event: SseEvent) => {
    if (!current() || terminal) return;
    const body = event.data;
    // A temporary server read failure may reuse the cursor, rather than append
    // a durable event. Reattach before applying the ordinary sequence fence.
    if (event.event === 'error' && body.retryable === true) {
      throw new ChatTransportError('network', String(body.message ?? '连接已中断。'));
    }
    if (event.event === 'snapshot') {
      if (event.id < progress.sequence) return;
      publish({ sequence: event.id,
        activities: body.tool_status?.tool ? updateActivity(progress.activities, body.tool_status, event.id, body.tool_status.status === 'tool_end') : progress.activities,
        content: typeof body.content === 'string' ? body.content : progress.content,
        conversationId: body.conversation_id ?? progress.conversationId,
        userMessage: body.user_message ?? progress.userMessage,
        assistantId: body.message_id ?? progress.assistantId,
        assistantCreatedAt: typeof body.message_created_at === 'string' ? body.message_created_at : progress.assistantCreatedAt,
        removedMessageIds: Array.isArray(body.removed_message_ids) ? body.removed_message_ids : progress.removedMessageIds,
        phase: 'replying', error: undefined,
        status: ['running', 'tool_start'].includes(body.tool_status?.status)
          ? toolLabel(body.tool_status.tool) : body.tool_status?.status === 'tool_end'
            ? toolEndLabel(body.tool_status.tool, body.tool_status.is_error) : '正在回复…' });
      if (body.response) { complete(body.response); return; }
      if (body.status === 'interrupted' || body.status === 'failed') {
        terminal = true;
        publish({ phase: 'failed', status: '', error: body.error || '回复中断，已保留收到的内容，可重试。' });
        connection?.abort();
      }
      return;
    }
    if (event.id <= progress.sequence) return;
    // A lost fragment must trigger a fresh authoritative snapshot. Advancing
    // past a gap would permanently hide text until the entire answer finishes.
    if (progress.sequence >= 0 && event.id !== progress.sequence + 1) {
      throw new ChatTransportError('network', '回复片段暂时缺失，正在重新连接。');
    }
    progress = { ...progress, sequence: event.id };
    switch (event.event) {
      case 'accepted':
        publish({ conversationId: body.conversation_id, userMessage: body.user_message,
          removedMessageIds: Array.isArray(body.removed_message_ids) ? body.removed_message_ids : undefined,
          assistantCreatedAt: typeof body.message_created_at === 'string' ? body.message_created_at : undefined,
          assistantId: body.message_id, phase: 'replying', status: '正在回复…' });
        break;
      case 'text_delta':
        if (typeof body.delta !== 'string') throw new ChatTransportError('invalid_response', '回复片段格式不正确。');
        publish({ content: body.replace === true ? body.delta : progress.content + body.delta,
          phase: 'replying', status: '正在回复…', error: undefined });
        break;
      case 'tool_start':
        publish({ phase: 'replying', status: toolLabel(body.tool), activities: updateActivity(progress.activities, body, event.id, false) });
        break;
      case 'tool_end':
        publish({ status: toolEndLabel(body.tool, body.is_error), activities: updateActivity(progress.activities, body, event.id, true) });
        break;
      case 'retrying':
        publish({ phase: 'replying', status: '正在重试回复…', error: undefined, activities: [] });
        break;
      case 'done': complete(body.response); break;
      case 'error':
        terminal = true;
        publish({ phase: 'failed', status: '', error: body.message || '回复中断，已保留收到的内容，可重试。' });
        connection?.abort();
        break;
    }
  };
  const wait = (milliseconds: number) => new Promise<void>(resolve => {
    cancelWait = resolve;
    timer = setTimeout(() => { timer = undefined; cancelWait = undefined; resolve(); }, milliseconds);
  });
  const connect = async (retry: boolean) => {
    if (!current() || active) return;
    active = true;
    terminal = false;
    const attempt = ++generation;
    publish({ phase: 'sending', status: retry ? '正在重试回复…' : '发送中…', error: undefined,
      ...(retry ? { activities: [] } : {}) });
    let failures = 0;
    let explicitRetry = retry;
    try {
      while (current() && attempt === generation && !terminal) {
        connection = new AbortController();
        try {
          await options.api.chatStream(intent, event => {
            if (current() && attempt === generation) receive(event);
          }, { signal: connection.signal,
            ...(progress.sequence >= 0 ? { lastEventId: progress.sequence } : {}),
            retry: explicitRetry });
          if (terminal || !current() || attempt !== generation) return;
          throw new ChatTransportError('network', '连接已中断，收到的回复已保留。');
        } catch (error) {
          if (terminal || !current() || attempt !== generation) return;
          const code = (error as { code?: string })?.code;
          const reconnect = code === 'network' || code === 'timeout' || code === 'stream_rotate';
          if (reconnect && (code === 'stream_rotate' || failures < 3)) {
            failures++;
            publish({ phase: 'reconnecting', status: '连接中断，正在重新连接…' });
            await wait(code === 'stream_rotate' ? 0 : Math.min(600 * failures, 1800));
          } else {
            terminal = true;
            publish({ phase: 'failed', status: '', error: errorMessage(error) });
          }
        } finally {
          // Only a human Retry starts an additional attempt. An uncertain POST
          // always reconnects as a reader with the identical request fingerprint.
          explicitRetry = false;
        }
      }
    } finally {
      if (attempt === generation) active = false;
    }
  };
  return {
    intent,
    getSnapshot: () => progress,
    start: () => connect(false),
    retry: () => progress.phase === 'failed' ? connect(true) : Promise.resolve(),
    dispose: () => {
      disposed = true;
      generation++;
      connection?.abort();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      cancelWait?.();
      cancelWait = undefined;
    },
  };
}
export type ChatStreamController = ReturnType<typeof createChatStreamController>;

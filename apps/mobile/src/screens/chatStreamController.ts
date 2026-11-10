import type { ApiClient } from '../api/client';
import { errorMessage } from '../api/client';
import { ChatTransportError, type SseEvent } from '../api/chatSse';
import type { ChatIntent, ChatResponse, Message } from '../domain/types';
import { toolActivityLabel, updateActivity, type ChatActivity } from './chatActivity';
import { readChatInteraction, type ChatInteraction } from '../features/location/chatInteraction';
import { detectPermissionInspection, type DeviceAction, type PermissionReport } from '../features/app-permissions/inspection';
import { createPermissionSession, performDeviceAction, type DeviceResult, type PermissionSession } from '../features/app-permissions/session';

export type ChatProgress = {
  interaction?: ChatInteraction;
  permissionApprovalNeeded?: boolean;
  permissionReport?: PermissionReport;
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

function toolLabel(tool: unknown, activity?: unknown) {
  if (tool === 'research_review') return '正在核对来源与未确认事项…';
  return `正在${toolActivityLabel(tool, activity)}…`;
}

function toolEndLabel(tool: unknown, isError: unknown) {
  if (isError === true) return '这一步未完成，正在继续…';
  if (tool === 'web_search') return '搜索完成，正在整理资料…';
  if (tool === 'web_fetch') return '网页已读取，正在继续…';
  if (tool === 'research_plan') return '正在查找相关资料…';
  return '正在回复…';
}

type Options = {
  api: Pick<ApiClient, 'chatStream'> & Partial<Pick<ApiClient, 'request'>>;
  intent: ChatIntent;
  isCurrent: () => boolean;
  onChange: (progress: ChatProgress) => void;
  onComplete: (response: ChatResponse) => void;
  permissionSession?: PermissionSession;
};

function isDeviceAction(card?: ChatInteraction): card is ChatInteraction & DeviceAction {
  return card?.kind === 'app_permission_inspection' || card?.kind === 'system_settings';
}

/** A route-owned durable turn. Disconnects never mutate its original payload. */
export function createChatStreamController(options: Options) {
  const context = options.intent.client_context;
  const intent: ChatIntent = Object.freeze({ ...options.intent,
    ...(context ? { client_context: Object.freeze({ ...context,
      ...(context.location ? { location: Object.freeze({ ...context.location }) } : {}) }) } : {}),
    upload_ids: Object.freeze([...options.intent.upload_ids]) });
  let progress: ChatProgress = { sequence: -1, phase: 'sending', status: '发送中…', content: '' };
  let disposed = false;
  let generation = 0;
  let active = false;
  let terminal = false;
  let connection: AbortController | undefined;
  const device = options.permissionSession ?? createPermissionSession();
  let inspection: Promise<DeviceResult> | undefined;
  let inspectionDecision: { cardId: string; approved: boolean } | undefined;
  let inspectionSubmission: { cardId: string; connection: AbortController } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelWait: (() => void) | undefined;
  const current = () => !disposed && options.isCurrent();
  const needsSelection = (card: DeviceAction) => (card.kind === 'system_settings'
    ? card.destination === 'selected_app' : card.scope === 'selected_app') && !device.selected();
  const needsPermissionApproval = (card?: ChatInteraction) => isDeviceAction(card) &&
    intent.app_permission_tool_supported === true && inspectionDecision?.cardId !== card.id && !needsSelection(card);
  const publish = (change: Partial<ChatProgress>) => {
    if (!current()) return;
    progress = { ...progress, ...change };
    if (change.phase === 'failed') progress = { ...progress, interaction: undefined, activities: progress.activities?.map(item =>
      item.state === 'running' ? { ...item, state: 'interrupted' as const } : item) };
    progress.permissionApprovalNeeded = needsPermissionApproval(progress.interaction);
    options.onChange(progress);
  };
  const complete = (response: ChatResponse) => {
    if (!response?.message || typeof response.message.content !== 'string' ||
      typeof response.conversation_id !== 'string') {
      throw new ChatTransportError('invalid_response', '回复结果不完整，请重新连接。');
    }
    terminal = true;
    publish({ phase: 'complete', status: '', error: undefined, response, interaction: undefined,
      activities: progress.activities?.map(item => item.state === 'running' ? { ...item, state: 'interrupted' as const } : item),
      content: response.message.content, conversationId: response.conversation_id,
      userMessage: response.user_message ?? progress.userMessage,
      removedMessageIds: response.removed_message_ids ?? progress.removedMessageIds,
      assistantId: response.message.id, assistantCreatedAt: response.message.created_at });
    if (current()) options.onComplete(response);
    connection?.abort();
  };
  const readInteraction = (value: unknown) => {
    const card = readChatInteraction(value);
    if (!isDeviceAction(card)) return card;
    const supported = card.kind === 'system_settings' ? intent.device_settings_supported
      : (card.permission || card.scope || card.mode) ? intent.device_settings_supported
      : intent.app_permission_tool_supported || (intent.app_permission_inspection_supported && detectPermissionInspection(intent.message) === card.inspection);
    if (!supported ||
      !connection || !options.api.request || Date.now() >= card.expires_at * 1000) return undefined;
    if (needsPermissionApproval(card)) return card;
    const transport = connection;
    if (inspectionSubmission?.cardId !== card.id || inspectionSubmission.connection !== transport) {
      if (inspectionSubmission?.cardId !== card.id) inspection = undefined;
      inspectionSubmission = { cardId: card.id, connection: transport };
      const cancelled = inspectionDecision?.cardId === card.id && !inspectionDecision.approved;
      const missingSelection = needsSelection(card);
      inspection ??= cancelled || missingSelection ? Promise.resolve({})
        : performDeviceAction(device, card);
      void inspection.then(async ({ report, settings }) => {
        const stillWaiting = () => current() && !terminal && connection === transport &&
          progress.interaction?.id === card.id && !transport.signal.aborted && Date.now() < card.expires_at * 1000;
        if (!stillWaiting()) return;
        if (report) {
          device.remember(report);
          publish({ permissionReport: report, status: '正在同步检查状态…' });
        }
        const result = report ? {
          status: report.unavailable.length > 0 ? 'partial' : 'completed',
          scanned: report.scanned, flagged: report.flagged,
        } : { status: missingSelection ? 'needs_selection' : 'unavailable' };
        const path = `/chat/interactions/${card.run_id}/${card.id}`;
        const body = cancelled ? { kind: 'cancel' } : card.kind === 'system_settings'
          ? { kind: 'system_settings', status: settings === 'requested' ? 'opened' : settings === 'system_settings' ? 'fallback' : result.status }
          : { kind: 'app_permission_inspection', result };
        try {
          await options.api.request?.(path, 'POST', body, transport.signal);
        } catch {
          // The status submission is idempotent, including after an uncertain POST.
          if (!stillWaiting()) return;
          try { await options.api.request?.(path, 'POST', body, transport.signal); }
          catch { if (stillWaiting()) publish({ status: '暂时无法同步检查状态…' }); }
        }
      });
    }
    return card;
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
      const interaction = readInteraction(body.interaction);
      publish({ sequence: event.id, interaction,
        activities: body.tool_status?.tool ? updateActivity(progress.activities, body.tool_status, event.id, body.tool_status.status === 'tool_end') : progress.activities,
        content: typeof body.content === 'string' ? body.content : progress.content,
        conversationId: body.conversation_id ?? progress.conversationId,
        userMessage: body.user_message ?? progress.userMessage,
        assistantId: body.message_id ?? progress.assistantId,
        assistantCreatedAt: typeof body.message_created_at === 'string' ? body.message_created_at : progress.assistantCreatedAt,
        removedMessageIds: Array.isArray(body.removed_message_ids) ? body.removed_message_ids : progress.removedMessageIds,
        phase: 'replying', error: undefined,
        status: isDeviceAction(interaction)
          ? (needsPermissionApproval(interaction) ? '等待确认手机操作…' : '正在处理手机操作…') : ['running', 'tool_start'].includes(body.tool_status?.status)
          ? toolLabel(body.tool_status.tool, body.tool_status.activity) : body.tool_status?.status === 'tool_end'
            ? toolEndLabel(body.tool_status.tool, body.tool_status.is_error) : '正在回复…' });
      if (body.response) { complete(body.response); return; }
      if (body.status === 'interrupted' || body.status === 'failed') {
        terminal = true;
        publish({ phase: 'failed', status: '', error: body.error || '回复中断，已保留收到的内容，可重试。' });
        connection?.abort();
      }
      return;
    }
    if (event.event === 'interaction') {
      if (event.id >= progress.sequence) {
        const interaction = readInteraction(body.card);
        publish({ interaction, ...(isDeviceAction(interaction)
          ? { status: needsPermissionApproval(interaction) ? '等待确认手机操作…' : '正在处理手机操作…' } : {}) });
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
      case 'text_start':
        if (body.replace === true) publish({ content: '', phase: 'replying', status: '正在查询资料…' });
        break;
      case 'text_delta':
        if (typeof body.delta !== 'string') throw new ChatTransportError('invalid_response', '回复片段格式不正确。');
        publish({ content: body.replace === true ? body.delta : progress.content + body.delta,
          phase: 'replying', status: '正在回复…', error: undefined });
        break;
      case 'tool_start':
        publish({ phase: 'replying', status: toolLabel(body.tool, body.activity), activities: updateActivity(progress.activities, body, event.id, false) });
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
      ...(retry ? { activities: [], interaction: undefined } : {}) });
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
    respondToPermissionInspection(cardId: string, approved: boolean) {
      const card = progress.interaction;
      if (!current() || terminal || !connection || card?.id !== cardId || !needsPermissionApproval(card) ||
          Date.now() >= card.expires_at * 1000) return;
      inspectionDecision = { cardId, approved };
      publish({ status: approved ? '正在处理手机操作…' : '正在取消操作…' });
      readInteraction(card);
    },
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

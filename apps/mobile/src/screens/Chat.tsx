import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppState,
  BackHandler,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Text } from '../ui/Text';
import { errorMessage, newRequestId } from '../api/client';
import { useAction, useApp, useResource, type InitialChatInput } from '../app/context';
import type { RetainedRouteScope } from '../app/navigation';
import type { Message, Upload, ReasoningEffort, ChatClientContext } from '../domain/types';
import { ChatReasoningSelector } from '../ui/ChatReasoningSelector';
import { ChatActivity } from '../ui/ChatActivity';
import { ChatConnectionCard } from '../features/integrations/ChatConnectionCard';
import { chatConnectionIntent, type ConnectionIntent } from '../features/integrations/chatConnectionIntent';
import { LocalFile, platform } from '../platform/ports';
import { isAudioFile, isImageFile, isTextFile, pickChatAttachment, type ChatAttachmentSource } from '../platform/chatAttachments';
import { recordingSession, stopRecorder, releaseRecorder } from '../platform/recordingSession';
import { composerTextLayout, UnifiedInputBar } from '../ui/UnifiedInputBar';
import { ChatAttachmentPanel } from '../ui/ChatAttachmentPanel';
import {
  Button,
  Card,
  ErrorNotice,
  Loading,
} from '../ui/components';
import { ResultText } from '../ui/ResultText';
import { AutomaticMemoryNotice } from '../features/memory/AutomaticMemory';
import { ChatModeMotion, useChatReducedMotion } from '../ui/ChatMotion';
import { ChatVoiceOverlay } from '../ui/ChatVoiceOverlay';
import { ChatVoiceRecovery } from '../ui/ChatVoiceRecovery';
import { ChatDeleteConfirmation, ChatMessageActions, ChatTextSelection, type MessageAction, type MessageAnchor } from '../ui/ChatMessageActions';
import { ChatReplyMemory } from '../ui/ChatReplyMemory';
import { ChatReplyFailure } from '../ui/ChatReplyFailure';
import { SlackSearchSheet } from '../features/integrations/SlackConnection';
import { slackSearchQuery } from '../features/integrations/slackModel';
import { MessageLongPress } from '../ui/MessageLongPress';
import { ConversationShareSheet } from '../features/conversation-share/ConversationShareSheet';
import { shareEligible, snapshotShareCandidates, validateShareSelection, type ShareCandidate } from '../features/conversation-share/model';
import { chatAppearance as appearance } from '../ui/ChatAppearance';
import { styles as s } from '../ui/theme';
import { AssistantOrb, Icon } from '../ui/visuals';
import { ModeNotice } from './Main';
export { ConversationsScreen } from '../features/conversations/ConversationsScreen';
import { createMessageHistory, mergeMessageHistory } from './messageHistory';
import { ChatMessageList } from './ChatMessageList';
import { createChatStreamController, type ChatProgress, type ChatStreamController } from './chatStreamController';
import { voiceFailure, type VoiceFailure } from './chatVoiceRecovery';
import { PhoneAlarmCard } from '../features/phone-alarms/PhoneAlarmCard';
import { directAlarmProposal } from '../features/phone-alarms/alarmProposal';
import { phoneAlarms } from '../platform/phoneAlarms';
import { phoneCalendar } from '../platform/phoneCalendar';
import { CalendarCard, CalendarFeedbackCard, calendarPreferenceKey, calendarReceipt, preferredCalendar, type CalendarFeedback } from '../features/phone-calendar/CalendarCard';
import { calendarRequest, type CalendarRequest } from '../features/phone-calendar/calendarRequest';
import { ChatLocationRequest, useChatLocation } from '../features/location/LocationProvider';
import { ChatInteractionCard } from '../features/location/ChatInteractionCard';
import type { ChatInteraction } from '../features/location/chatInteraction';
import { captureClientContext } from '../features/location/model';
import { detectDeviceAction, openDeviceSettings, permissionLabels, settingsLabels, supportsDeviceSettings, supportsPermissionInspection,
  type DeviceAction, type PermissionFinding, type PermissionReport } from '../features/app-permissions/inspection';
import { createPermissionSession, performDeviceAction } from '../features/app-permissions/session';
import { PermissionReportCard } from '../features/app-permissions/PermissionReportCard';
import { createRecentContextIndex } from '../features/conversation-continuation/recentContext';
import { useContinuation } from '../features/conversation-continuation/useContinuation';
import { ContinuationCard } from '../features/conversation-continuation/ContinuationCard';
import type { ContinuationCandidate } from '../features/conversation-continuation/model';
import { ChatVaultCaptureCard } from '../features/private-vault/ChatVaultCaptureCard';
import { detectPrivateRecord } from '../features/private-vault/chatCapture';
import { vaultOwner, type VaultRecord } from '../domain/privateVault';

type Attachment = { file: LocalFile; upload?: Upload; transcript?: string; imageText?: string; prepareOnSend?: boolean };
type VoiceSendIntent = { draft: string; file: LocalFile | null; context: object | null; isVisible: () => boolean };
type VoiceInput = { key: string; file: LocalFile; upload?: Upload; text?: string; sendIntent?: VoiceSendIntent };
type HoldRecording = { held: boolean; cancelled: boolean; started: boolean; ended: boolean; lease: object; startY?: number; sendIntent?: VoiceSendIntent };
type VoiceRequest = { cancel: () => void; release: () => void };
type EditContext = { message: Message; previousDraft: string; previousAttachment: Attachment | null;
  removedUploadIds?: string[]; retry?: () => Promise<void> | void; retryDraft?: string; retryAttachment?: Attachment | null; discardRetry?: () => void };
export const quoteMessageText = (source: Message, text: string) =>
  `引用消息（${source.created_at}）：\n${source.content.split('\n').map(line => `> ${line}`).join('\n')}\n\n${text}`;
const afterMessageDate = (date: string) => {
  const parts = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(date);
  if (parts) {
    const next = Number((parts[2] ?? '').padEnd(9, '0')) + 1;
    if (next < 1_000_000_000) return `${parts[1]}.${String(next).padStart(9, '0')}${parts[3]}`;
  }
  const milliseconds = Date.parse(date);
  return new Date((Number.isFinite(milliseconds) ? milliseconds : Date.now()) + 1).toISOString();
};
type ChatSnapshot = {
  alarmFeedback?: { text: string; error?: boolean };
  interaction?: ChatInteraction;
  permissionApprovalNeeded?: boolean;
  localDeviceAction?: { action: DeviceAction; replyId: string };
  continuationDismissed: boolean;
  continuationTarget: { id: string; title: string } | null;
  id?: string;
  reasoningEffort: ReasoningEffort;
  draft: string;
  attachment: Attachment | null;
  voice: VoiceInput | null;
  voicePhase: string;
  voiceError: string | null;
  voiceFailure: VoiceFailure | null;
  voiceBusy: boolean;
  messages: Message[];
  messageVersion: number;
  sending: boolean;
  sendError: string | null;
  editing: EditContext | null;
  quoting: Message | null;
};

/** Only the navigation entry owns this memory; no hidden screen stays mounted. */
export function createChatEntryState(
  conversationId?: string,
  prompt?: string,
  scope?: RetainedRouteScope,
  initialInput?: InitialChatInput,
) {
  let snapshot: ChatSnapshot = {
    continuationDismissed: false,
    continuationTarget: null,
    id: conversationId,
    reasoningEffort: 'off',
    draft: initialInput?.text ?? prompt ?? '',
    attachment: initialInput?.attachment ? { file: initialInput.attachment, prepareOnSend: true } : null,
    voice: null,
    voicePhase: '',
    voiceError: null,
    voiceFailure: null,
    voiceBusy: false,
    messages: [],
    messageVersion: 0,
    sending: false,
    sendError: null,
    editing: null,
    quoting: null,
  };
  const listeners = new Set<() => void>();
  const history = createMessageHistory();
  const continuationIndex = createRecentContextIndex();
  const permissionSession = createPermissionSession();
  const streams = new Map<string, ChatStreamController>();
  const disposeStreams = () => { streams.forEach(stream => stream.dispose()); streams.clear(); };
  scope?.onDispose(history.dispose);
  scope?.onDispose(continuationIndex.clear);
  scope?.onDispose(permissionSession.clear);
  scope?.onDispose(disposeStreams);
  return {
    scope,
    history,
    continuationIndex,
    permissionSession,
    composerVoiceMode: initialInput?.voiceMode ?? false,
    hiddenHistoryIds: new Set<string>(),
    voiceRequest: null as VoiceRequest | null,
    deletedVoiceUploads: new Set<string>(),
    streams,
    disposeStreams,
    takeInitialInput: () => {
      const input = initialInput;
      initialInput = undefined;
      return input;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (change: (previous: ChatSnapshot) => ChatSnapshot) => {
      if (scope && !scope.isRetained()) return;
      snapshot = change(snapshot);
      listeners.forEach(listener => listener());
    },
  };
}
type ChatEntryState = ReturnType<typeof createChatEntryState>;

const canPrepareOnSend = (selected: Attachment) =>
  isImageFile(selected.file) || (selected.prepareOnSend === true && isTextFile(selected.file));
const isReadableAttachment = (selected: Attachment | null) => !selected || Boolean(selected.upload &&
  (isTextFile(selected.file) || selected.transcript || (isImageFile(selected.file) && selected.imageText)));

export function ChatScreen({
  conversationId,
  prompt,
  onConversationCreated,
  navigationActions,
  entryState,
}: {
  conversationId?: string;
  prompt?: string;
  onConversationCreated?: (id: string) => void;
  navigationActions?: React.ReactNode;
  entryState?: ChatEntryState;
}) {
  const { api, invalidate, formatDate, user, preferences, navigate, revision } = useApp();
  const reviewVoiceTranscript = preferences?.reviewVoiceTranscript === true;
  const location = useChatLocation();
  const { width: windowWidth, height: windowHeight, fontScale } = useWindowDimensions();
  const reducedMotion = useChatReducedMotion();
  const [availableHeight, setAvailableHeight] = useState(windowHeight);
  const [composerHeight, setComposerHeight] = useState(68);
  const localState = useRef<{ api: typeof api; value: ChatEntryState } | null>(null);
  if (!localState.current || localState.current.api !== api) {
    localState.current = { api, value: createChatEntryState(conversationId, prompt) };
  }
  const state = entryState ?? localState.current.value;
  const { id, reasoningEffort, messages, messageVersion, draft, attachment, voice, voicePhase, voiceError, voiceFailure: pendingVoiceFailure, voiceBusy, sending, editing, quoting, sendError, continuationDismissed, continuationTarget, interaction, permissionApprovalNeeded, localDeviceAction, alarmFeedback } =
    useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const [continuationPauseVersion, setContinuationPauseVersion] = useState(0);
  const setDraft = useCallback((next: React.SetStateAction<string>) => { setContinuationPauseVersion(value=>value+1);state.update(old => ({
    ...old,
    draft: typeof next === 'function' ? next(old.draft) : next,
  })); }, [state]);
  const setAttachment = (next: React.SetStateAction<Attachment | null>) => state.update(old => ({
    ...old,
    attachment: typeof next === 'function' ? next(old.attachment) : next,
  }));
  const setVoice = (next: VoiceInput | null) => state.update(old => ({ ...old, voice: next }));
  const setVoicePhase = (next: string) => state.update(old => ({ ...old, voicePhase: next }));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [voiceMode, setLocalVoiceMode] = useState(state.composerVoiceMode);
  const setVoiceMode = (next: boolean) => {
    state.composerVoiceMode = next;
    setLocalVoiceMode(next);
  };
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  useEffect(() => { setAttachmentMenu(false); }, [api, state]);
  useEffect(() => {
    if (!attachmentMenu) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { setAttachmentMenu(false); return true; });
    return () => back.remove();
  }, [attachmentMenu]);
  const [holdActive, setHoldActive] = useState(false);
  const [holdCancelled, setHoldCancelled] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const recorderLease = useRef<object | null>(null);
  // These dependencies intentionally create a new permission/gesture owner per chat scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const holdOwner = useMemo(() => ({ active: true, gesture: null as HoldRecording | null }), [api, state]);
  const mounted = useRef(true);
  const voiceOwner = useRef({ api, state });
  voiceOwner.current = { api, state };
  const attachmentAbort = useRef<AbortController | null>(null);
  const [attachmentPhase, setAttachmentPhase] = useState('');
  const recordingRef = useRef(false);
  const composerScroll = useRef<ScrollView>(null);
  const composerTop = useRef(0);
  const inputFocused = useRef(false);
  const inputRef = useRef<TextInput>(null);
  const focusAfterModeChange = useRef(false);
  useEffect(() => {
    // Wait until display:none is removed before focusing the native EditText.
    if (!voiceMode && focusAfterModeChange.current) {
      focusAfterModeChange.current = false;
      inputRef.current?.focus();
    }
  }, [voiceMode]);
  const toggleInputMode = () => {
    setAttachmentMenu(false);
    if (voiceMode) {
      focusAfterModeChange.current = true;
      setVoiceMode(false);
    } else {
      focusAfterModeChange.current = false;
      inputRef.current?.blur();
      inputFocused.current = false;
      Keyboard.dismiss();
      setVoiceMode(true);
    }
  };
  const [nativeFontScale, setNativeFontScale] = useState<number | null>(null);
  // Native callbacks from a previous account/chat must keep their original owner fence.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inputScaleOwner = useMemo(() => ({ active: true, running: false, pending: false }), [api, state]);
  const currentInputScaleOwner = useRef(inputScaleOwner);
  currentInputScaleOwner.current = inputScaleOwner;
  const refreshInputFontScale = useCallback(() => {
    if (!inputScaleOwner.active || currentInputScaleOwner.current !== inputScaleOwner ||
      !platform.getSystemFontScale) return;
    inputScaleOwner.pending = true;
    if (inputScaleOwner.running) return;
    inputScaleOwner.running = true;
    void (async () => {
      do {
        inputScaleOwner.pending = false;
        const value = await platform.getSystemFontScale().catch(() => null);
        if (!inputScaleOwner.active || currentInputScaleOwner.current !== inputScaleOwner) return;
        const scale = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
        setNativeFontScale(previous => previous === scale ? previous : scale);
      } while (inputScaleOwner.pending);
    })().finally(() => { inputScaleOwner.running = false; });
  }, [inputScaleOwner]);
  useEffect(() => {
    inputScaleOwner.active = true;
    return () => { inputScaleOwner.active = false; };
  }, [inputScaleOwner]);
  useEffect(() => {
    refreshInputFontScale();
  }, [refreshInputFontScale, windowHeight, availableHeight, fontScale]);
  // Rotation and keyboard reflow can move a field that already has focus.
  const revealFocusedInput = () => {
    if (inputFocused.current) {
      composerScroll.current?.scrollTo({
        y: composerTop.current,
        animated: false,
      });
    }
  };
  // A newly created thread already has its messages locally. Updating its route
  // identity must not trigger a history request that could overwrite a later reply.
  const initialConversationId = useRef(id);
  const history = useSyncExternalStore(state.history.subscribe,
    state.history.getSnapshot, state.history.getSnapshot);
  const canApplyHistory = useCallback(() => state.scope ? state.scope.isRetained() :
    mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state, [api, state]);
  const applyHistory = useCallback((items: Message[]) => state.update(old => ({
    ...old, messages: mergeMessageHistory(items.filter(message => !state.hiddenHistoryIds.has(message.id)), old.messages),
  })), [state]);
  const refreshHistory = useCallback(() => state.history.refresh(api, initialConversationId.current, applyHistory, canApplyHistory),
    [state, api, initialConversationId, applyHistory, canApplyHistory]);
  const loadOlder = useCallback(() => state.history.older(api, id, applyHistory, canApplyHistory),
    [state, api, id, applyHistory, canApplyHistory]);
  const restartHistory = useCallback(() => {
    state.history.viewport.anchor = null;
    state.history.viewport.pendingAppendAnchor = null;
    return state.history.restart(api, state.getSnapshot().id, applyHistory, canApplyHistory);
  }, [api, state, applyHistory, canApplyHistory]);
  const capabilities = useResource(() => api.capabilities(), [api]);
  const fileAction = useAction();
  const fileActionRef = useRef(fileAction);
  fileActionRef.current = fileAction;
  const shareOwner = useMemo(() => ({ api, state, userId: user?.id,
    serverUrl: preferences?.serverUrl, instanceId: preferences?.instance?.id }),
    [api, state, user?.id, preferences?.serverUrl, preferences?.instance?.id]);
  const currentShareOwner = useRef(shareOwner);
  currentShareOwner.current = shareOwner;
  const [slackSearch, setSlackSearch] = useState<{ owner: typeof shareOwner; query: string } | null>(null);
  useEffect(() => { setSlackSearch(null); }, [shareOwner]);
  const [vaultCapture, setVaultCapture] = useState<{
    key: string; owner: typeof shareOwner; scope: string; record: VaultRecord; transcribed: boolean;
  } | null>(null);
  const [vaultReceipt, setVaultReceipt] = useState<{ owner: typeof shareOwner; alias: string } | null>(null);
  const activeVaultCapture = vaultCapture?.owner === shareOwner ? vaultCapture : null;
  type CalendarFlow = { key: string; owner: typeof shareOwner; request: CalendarRequest; index: number;
    preferenceKey?: string; tryingDefault?: boolean; error?: string };
  const [calendarFlow, setCalendarFlow] = useState<CalendarFlow | null>(null);
  const calendarRef = useRef<CalendarFlow | null>(null);
  const [calendarFeedback, setCalendarFeedback] = useState<{ owner: typeof shareOwner; feedback: CalendarFeedback } | null>(null);
  const activeCalendar = calendarFlow?.owner === shareOwner ? calendarFlow : null;
  const showCalendar = (flow: CalendarFlow | null) => { calendarRef.current = flow; setCalendarFlow(flow); };
  useEffect(() => {
    setVaultCapture(null);
    setVaultReceipt(null);
  }, [shareOwner]);
  const [conversationSharing, setConversationSharing] = useState<{
    key: string; owner: typeof shareOwner; candidates: readonly ShareCandidate[]; initialSelectedId: string; hasOlder: boolean; conversationId?: string;
  } | null>(null);
  const pendingLocation = useRef<{
    entry: ChatEntryState;
    matches: (current: ChatSnapshot) => boolean;
  } | null>(null);
  const [locationPreview, setLocationPreview] = useState<{entry: ChatEntryState; message: Message} | null>(null);
  const previewMessage = locationPreview?.entry === state ? locationPreview.message : null;
  const visibleMessages = useMemo(() => previewMessage ? [...messages, previewMessage] : messages, [messages, previewMessage]);
  useEffect(() => () => {
    if (pendingLocation.current?.entry === state) {
      pendingLocation.current = null;
      location.session?.dismiss();
    }
  }, [state, location.session]);
  useEffect(() => {
    const pending = pendingLocation.current;
    if (pending?.entry === state && !pending.matches(state.getSnapshot())) {
      pendingLocation.current = null;
      setLocationPreview(null);
      location.session?.dismiss();
    }
  }, [state, location.session, draft, attachment, editing, quoting, id]);
  useEffect(() => () => {
    if (currentShareOwner.current !== shareOwner) state.disposeStreams();
  }, [shareOwner, state]);
  const shareMessage = useCallback((message: Message) => {
    // A previously rendered row must keep its original owner's action fence.
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained()) || recordingRef.current || recordingSession.active ||
      fileActionRef.current.busy || deletingRef.current) return;
    const snapshot = state.getSnapshot();
    if (snapshot.voice || snapshot.voiceBusy) return;
    const latest = snapshot.messages.find(item => item.id === message.id && shareEligible(item, snapshot.id));
    if (!latest) return;
    const candidates = snapshotShareCandidates(snapshot.messages, snapshot.id);
    Keyboard.dismiss();
    setConversationSharing({ key: newRequestId(), owner: shareOwner, candidates, initialSelectedId: latest.id,
      conversationId: snapshot.id,
      hasOlder: state.history.getSnapshot().nextOffset !== null });
  }, [api, state, shareOwner]);
  const retryMessage = useCallback((key: string) => {
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      state.getSnapshot().sending || (state.scope && !state.scope.isRetained())) return;
    return state.streams.get(key)?.retry();
  }, [api, state, shareOwner]);
  const [messageMenu, setMessageMenu] = useState<{ message: Message; anchor: MessageAnchor; owner: typeof shareOwner } | null>(null);
  const [selection, setSelection] = useState<{ text: string; owner: typeof shareOwner } | null>(null);
  const [replyMemory, setReplyMemory] = useState<{ text: string; owner: typeof shareOwner } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ message: Message; owner: typeof shareOwner } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [connectionFlow, setConnectionFlow] = useState<{
    owner: typeof shareOwner;
    draft: string;
    intent: ConnectionIntent;
    key: string;
  } | null>(null);
  const activeConnectionFlow = connectionFlow?.owner === shareOwner
    && !attachment && !editing && !quoting && draft === connectionFlow.draft
    ? connectionFlow : null;
  useEffect(() => {
    if (connectionFlow && !activeConnectionFlow) setConnectionFlow(null);
  }, [connectionFlow, activeConnectionFlow]);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deletionAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    deletingRef.current = false;
    setDeleting(false); setDeleteError(null); setMessageMenu(null); setSelection(null); setReplyMemory(null); setDeleteTarget(null); setConversationSharing(null);
    return () => { deletionAbort.current?.abort(); };
  }, [shareOwner]);
  const actionOwnerCurrent = (owner: typeof shareOwner) => mounted.current && currentShareOwner.current === owner &&
    voiceOwner.current.api === owner.api && voiceOwner.current.state === owner.state &&
    (!state.scope || state.scope.isRetained());
  const deviceWorkCurrent = useCallback(() => currentShareOwner.current === shareOwner &&
    (state.scope ? state.scope.isRetained() : mounted.current && voiceOwner.current.state === state), [shareOwner, state]);
  const reviewDeviceApp = useCallback(async (finding: PermissionFinding, source: PermissionReport) => {
    if (!deviceWorkCurrent() || !mounted.current || state.getSnapshot().sending) return;
    state.permissionSession.select(finding, source);
    return openDeviceSettings('selected_app', finding.packageName);
  }, [deviceWorkCurrent, state]);
  const refreshDeviceReport = useCallback(async (messageId: string, report: PermissionReport, finding?: PermissionFinding) => {
    if (!deviceWorkCurrent() || !mounted.current || state.getSnapshot().sending) return false;
    const selected = finding ? (report.findings.find(item => item.packageName === finding.packageName) ?? finding)
      : report.scope === 'selected_app' ? report.findings[0] : undefined;
    if (selected) state.permissionSession.select(selected, report);
    state.update(old => ({ ...old, sending: true }));
    const result = await state.permissionSession.check({ inspection: 'permissions', mode: 'refresh',
      scope: selected ? 'selected_app' : 'visible_apps', permission: selected ? undefined : report.permission });
    if (!deviceWorkCurrent()) return false;
    if (result) state.permissionSession.remember(result);
    state.update(old => ({ ...old, sending: false,
      messages: result ? old.messages.map(item => item.id === messageId ? { ...item, app_permission_report: result } : item) : old.messages,
      messageVersion: old.messageVersion + (result ? 1 : 0) }));
    return Boolean(result);
  }, [deviceWorkCurrent, state]);
  const respondToLocalDeviceAction = async (replyId: string, approved: boolean) => {
    const pending = state.getSnapshot().localDeviceAction;
    if (!actionOwnerCurrent(shareOwner) || pending?.replyId !== replyId) return;
    const status = pending.action.kind === 'app_permission_inspection' ? '正在检查本机应用权限…' : '正在处理手机操作…';
    state.update(old => ({ ...old, localDeviceAction: undefined, messages: old.messages.map(message => message.id === replyId
      ? { ...message, stream_status: approved ? status : undefined } : message) }));
    const result = approved ? await performDeviceAction(state.permissionSession, pending.action) : undefined;
    if (!deviceWorkCurrent()) return;
    if (result?.report) state.permissionSession.remember(result.report);
    let content = '已取消这次手机操作。';
    if (result) {
      if (result.report) content = '';
      else if (result.settings === 'requested' && pending.action.kind === 'system_settings') content = pending.action.destination === 'privacy'
        ? '已打开隐私设置。可在系统的隐私中心查看敏感权限访问记录。'
        : '已发起打开对应的系统设置。修改完成后可以返回复查。';
      else if (result.settings === 'system_settings') content = '已打开系统设置首页，可用设置搜索找到对应入口。';
      else content = pending.action.kind === 'system_settings' ? '暂时无法打开这个设置，请在系统设置中搜索对应入口。'
        : '暂时无法读取这台手机的应用权限，请重试或在系统设置中查看。';
    }
    state.update(old => ({ ...old, sending: false, messages: old.messages.map(message => message.id === replyId
      ? { ...message, stream_status: undefined, content, app_permission_report: result?.report } : message),
      messageVersion: old.messageVersion + 1 }));
  };
  const respondToInspection = (cardId: string, approved: boolean) => {
    if (!actionOwnerCurrent(shareOwner)) return;
    const stream = Array.from(state.streams.values()).find(item => item.getSnapshot().interaction?.id === cardId);
    stream?.respondToPermissionInspection(cardId, approved);
  };
  const deviceConfirmation = localDeviceAction?.action ?? (permissionApprovalNeeded &&
    (interaction?.kind === 'app_permission_inspection' || interaction?.kind === 'system_settings') ? interaction : undefined);
  const deviceAppName = state.permissionSession.selected()?.finding.name;
  const respondToDeviceAction = (approved: boolean) => {
    if (localDeviceAction) void respondToLocalDeviceAction(localDeviceAction.replyId, approved);
    else if (interaction) respondToInspection(interaction.id, approved);
  };
  const calendarCurrent = (flow: CalendarFlow) => calendarRef.current === flow && actionOwnerCurrent(flow.owner);
  const finishCalendar = (flow: CalendarFlow, feedback?: CalendarFeedback) => {
    if (!calendarCurrent(flow)) return;
    if (feedback) setCalendarFeedback({ owner: flow.owner, feedback });
    const index = flow.index + 1;
    showCalendar(index < flow.request.drafts.length ? { ...flow, index, error: undefined } : null);
  };
  const draftToolsBusy = () => Boolean(state.getSnapshot().voice) ||
    recordingRef.current || Boolean(recordingSession.active) || fileActionRef.current.busy || deletingRef.current;
  const mutationBlocked = () => state.getSnapshot().sending || draftToolsBusy();
  const editDraftBlocked = () => {
    if (draftToolsBusy() || captureBusy || continuationRequest.current || previewMessage || activeVaultCapture || activeCalendar) return true;
    if (!state.getSnapshot().sending) return false;
    // An in-flight replacement still owns the edit rollback and draft restore.
    // Ordinary replies do not own the composer after the initial send.
    for (const stream of state.streams.values()) {
      if (!stream.intent.replace_message_id) continue;
      const phase = stream.getSnapshot().phase;
      if (phase !== 'failed' && phase !== 'complete') return true;
    }
    return false;
  };
  const continuationRequest = useRef<AbortController | null>(null);
  const [openingContinuation, setOpeningContinuation] = useState(false);
  const [continuationError, setContinuationError] = useState('');
  useEffect(() => {
    setOpeningContinuation(false);setContinuationError('');
    return () => { continuationRequest.current?.abort();continuationRequest.current=null; };
  }, [shareOwner]);
  const continuation = useContinuation({api,index:state.continuationIndex,owner:state,
    userId:user?.id,server:preferences?.serverUrl,instance:preferences?.instance?.id,revision,draft,
    enabled:preferences?.continuationSuggestions!==false&&!id&&!messages.length&&!continuationDismissed&&!sending&&!editing&&!quoting&&!recording&&!voice&&!voiceBusy });
  const dismissContinuation = () => {
    if(!actionOwnerCurrent(shareOwner))return;
    continuationRequest.current?.abort();continuationRequest.current=null;
    setOpeningContinuation(false);setContinuationError('');
    state.update(old=>({...old,continuationDismissed:true}));
  };
  const resumeContinuation = async (candidate: ContinuationCandidate) => {
    const before=state.getSnapshot();
    if(!actionOwnerCurrent(shareOwner)||mutationBlocked()||continuationRequest.current||before.id||before.messages.length||before.continuationDismissed||before.draft!==draft)return;
    const controller=new AbortController();continuationRequest.current=controller;
    setOpeningContinuation(true);setContinuationError('');
    const current=()=>actionOwnerCurrent(shareOwner)&&continuationRequest.current===controller&&!controller.signal.aborted;
    try {
      const page=await api.request<Awaited<ReturnType<typeof api.messages>>>(`/conversations/${encodeURIComponent(candidate.conversation.id)}/messages?limit=40&offset=0`,'GET',undefined,controller.signal);
      if(!current()||mutationBlocked()||state.getSnapshot().id||state.getSnapshot().messages.length)return;
      if(!Array.isArray(page.items)||page.items.some(message=>message.conversation_id!==candidate.conversation.id||typeof message.content!=='string'||typeof message.id!=='string'||!['user','assistant'].includes(message.role)))throw new Error('这段对话的信息不一致，请从历史记录中重新打开。');
      initialConversationId.current=candidate.conversation.id;
      state.history.adoptLatest(api,page);
      state.history.viewport.anchor=null;state.history.viewport.pendingAppendAnchor=null;
      state.history.viewport.heights.clear();state.history.viewport.followTail=true;
      state.update(old=>({...old,id:candidate.conversation.id,messages:page.items,messageVersion:old.messageVersion+1,
        continuationDismissed:true,continuationTarget:{id:candidate.conversation.id,title:candidate.conversation.title},sendError:null}));
      state.scope?.updateRoute(route=>route.name==='chat'?{...route,conversationId:candidate.conversation.id,prompt:undefined}:route);
    }catch(error){if(current())setContinuationError(errorMessage(error));}
    finally{if(continuationRequest.current===controller){continuationRequest.current=null;if(actionOwnerCurrent(shareOwner))setOpeningContinuation(false);}}
  };
  const returnToNewConversation = () => {
    const before=state.getSnapshot();
    if(!actionOwnerCurrent(shareOwner)||mutationBlocked()||continuationRequest.current||!before.continuationTarget||before.id!==before.continuationTarget.id)return;
    initialConversationId.current=undefined;state.history.adoptLatest(api,{items:[]});
    state.history.viewport.anchor=null;state.history.viewport.pendingAppendAnchor=null;state.history.viewport.heights.clear();
    state.update(old=>({...old,id:undefined,messages:[],messageVersion:old.messageVersion+1,continuationTarget:null,continuationDismissed:true,sendError:null}));
    state.scope?.updateRoute(route=>route.name==='chat'?{...route,conversationId:undefined,prompt:undefined}:route);
  };
  const liveSentMessage = (messageId: string) => state.getSnapshot().messages.find(message =>
    message.id === messageId && message.role === 'user' && (!message.delivery || message.delivery === 'sent'));
  const showMessageMenu = useCallback((message: Message, anchor: MessageAnchor) => {
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained()) || recordingRef.current || recordingSession.active) return;
    const latest = state.getSnapshot().messages.find(item => item.id === message.id &&
      (!item.delivery || item.delivery === 'sent') && !item.stream_status &&
      (item.role === 'user' || Boolean(item.content.trim())));
    if (!latest) return;
    Keyboard.dismiss();
    setMessageMenu({ message: latest, anchor, owner: shareOwner });
  }, [api, state, shareOwner]);
  const cancelEditing = () => {
    if (!actionOwnerCurrent(shareOwner) || editDraftBlocked()) return;
    const current = state.getSnapshot().editing;
    if (!current) return;
    // A failed immutable request is retired only when the user cancels it.
    current.discardRetry?.();
    state.update(old => ({ ...old, editing: null, draft: current.previousDraft,
      attachment: current.previousAttachment, sendError: null }));
  };
  const performMessageAction = (name: MessageAction) => {
    const selected = messageMenu;
    if (!selected || !actionOwnerCurrent(selected.owner)) return;
    const message = state.getSnapshot().messages.find(item => item.id === selected.message.id &&
      (!item.delivery || item.delivery === 'sent') && !item.stream_status);
    if (!message || (['edit', 'delete'].includes(name) && message.role !== 'user') ||
      (name === 'edit' ? editDraftBlocked() :
        ['quote', 'branch', 'delete', 'memory', 'todos'].includes(name) && mutationBlocked())) return;
    setMessageMenu(null);
    if (name === 'copy') return fileActionRef.current.run(() => platform.copyText(message.content));
    if (name === 'share') return shareMessage(message);
    if (name === 'select') { setSelection({ text: message.content, owner: selected.owner }); return; }
    if (name === 'memory') { setReplyMemory({ text: message.content, owner: selected.owner }); return; }
    if (name === 'todos') { navigate({ name: 'todoSources', conversationId: message.conversation_id }); return; }
    if (name === 'delete') { setDeleteError(null); setDeleteTarget({ message, owner: selected.owner }); return; }
    if (name === 'branch') { navigate({ name: 'chat', prompt: message.content }); return; }
    state.getSnapshot().editing?.discardRetry?.();
    if (name === 'edit') {
      state.update(old => ({ ...old, editing: { message,
        previousDraft: old.editing?.previousDraft ?? old.draft,
        previousAttachment: old.editing?.previousAttachment ?? old.attachment },
        quoting: null, draft: message.content, attachment: null, sendError: null }));
    } else {
      state.update(old => ({ ...old, quoting: message, editing: null,
        draft: old.editing ? old.editing.previousDraft : old.draft,
        attachment: old.editing ? old.editing.previousAttachment : old.attachment, sendError: null }));
    }
    focusAfterModeChange.current = true;
    setVoiceMode(false);
    inputRef.current?.focus();
  };
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target || !actionOwnerCurrent(target.owner) || mutationBlocked()) return;
    const message = liveSentMessage(target.message.id);
    const conversation = state.getSnapshot().id;
    if (!message || !conversation) return;
    deletingRef.current = true; setDeleting(true); setDeleteError(null);
    const controller = new AbortController(); deletionAbort.current = controller;
    try {
      const result = await api.deleteMessage(conversation, message.id, controller.signal);
      if (!actionOwnerCurrent(target.owner)) return;
      result.removed_message_ids.forEach(messageId => state.hiddenHistoryIds.add(messageId));
      const removed = new Set(result.removed_message_ids);
      state.history.viewport.heights.forEach((value, key) => { if (removed.has(value.message.id)) state.history.viewport.heights.delete(key); });
      if (state.getSnapshot().editing && removed.has(state.getSnapshot().editing!.message.id)) state.getSnapshot().editing?.discardRetry?.();
      state.update(old => ({ ...old, messages: old.messages.filter(item => !removed.has(item.id)),
        messageVersion: old.messageVersion + 1,
        ...(old.editing && removed.has(old.editing.message.id) ? { editing: null,
          draft: old.editing.previousDraft, attachment: old.editing.previousAttachment } : {}),
        ...(old.quoting && removed.has(old.quoting.id) ? { quoting: null } : {}) }));
      setDeleteTarget(null); invalidate(); void restartHistory();
    } catch (error) {
      if (actionOwnerCurrent(target.owner)) setDeleteError(errorMessage(error));
    } finally {
      if (deletionAbort.current === controller) deletionAbort.current = null;
      if (actionOwnerCurrent(target.owner)) { deletingRef.current = false; setDeleting(false); }
    }
  };
  const latestAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'assistant') return messages[index].id;
    }
    return undefined;
  }, [messages]);
  const renderMessage = useCallback(({ item }: { item: Message }) => item === previewMessage
    ? <View><View style={chat.userBubble}><Text style={chat.userText}>{item.content}</Text></View>
      <Text style={chat.unsent}>等待出发地</Text>
      <ChatLocationRequest session={location.session} api={api} countdown />
    </View>
    : <ChatMessage message={item} observeMemory={item.id === latestAssistantId} formatDate={formatDate} share={shareMessage} retry={retryMessage} menu={showMessageMenu}
      reviewDeviceApp={reviewDeviceApp} refreshDeviceReport={refreshDeviceReport} />,
    [formatDate, shareMessage, retryMessage, showMessageMenu, latestAssistantId, previewMessage, location.session, api, reviewDeviceApp, refreshDeviceReport]);
  const attachmentReady = isReadableAttachment(attachment);
  useEffect(() => {
    void state.history.ensure(api, initialConversationId.current, applyHistory, canApplyHistory);
    // History belongs to this entry; draft/recording updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, initialConversationId, state]);
  useEffect(() => {
    mounted.current = true;
    holdOwner.active = true;
    recordingRef.current = false;
    setRecording(false); setHoldActive(false); setHoldCancelled(false); setCaptureBusy(false);
    return () => {
      mounted.current = false;
      holdOwner.active = false;
      if (holdOwner.gesture) {
        holdOwner.gesture.held = false;
        holdOwner.gesture.cancelled = true;
        if (recordingRef.current) holdOwner.gesture.ended = true;
      }
      attachmentAbort.current?.abort();
      // An authorized conversion belongs to the retained route, not this mount.
      if (!state.scope?.isRetained()) { state.voiceRequest?.cancel(); state.disposeStreams(); }
      state.history.dispose();
      if (recordingRef.current) {
        const lease = recorderLease.current;
        stopRecorder(lease).finally(() => releaseRecorder(lease)).catch(() => {});
      }
    };
  }, [api, state, holdOwner]);
  useEffect(() => {
    if (!recording) {
      return;
    }
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const insertVoiceText = (text: string) => {
    const previous = state.getSnapshot().draft;
    const separator = previous && !/\s$/.test(previous) ? '\n' : '';
    if (previous.length + separator.length + text.length > 20000) {
      throw new Error('文字已识别，请先缩短输入框中的内容，再点“填入文字”。');
    }
    state.update(old => ({ ...old, draft: `${previous}${separator}${text}`,
      voice: null, voicePhase: '', voiceError: null, voiceFailure: null, voiceBusy: false }));
  };
  const makeVoiceSendIntent = (): VoiceSendIntent => ({
    draft: state.getSnapshot().draft,
    file: state.getSnapshot().attachment?.file ?? null,
    context: state.getSnapshot().editing ?? state.getSnapshot().quoting,
    // A retained ASR may finish in History, but a detached view cannot send.
    isVisible: () => holdOwner.active && mounted.current && currentShareOwner.current === shareOwner &&
      voiceOwner.current.api === api && voiceOwner.current.state === state,
  });
  const matchesVoiceIntent = (intent: VoiceSendIntent) => {
    const latest = state.getSnapshot();
    return intent.isVisible() && latest.draft === intent.draft &&
      (latest.attachment?.file ?? null) === intent.file &&
      (latest.editing ?? latest.quoting) === intent.context;
  };
  const prepareAttachment = async (selected: Attachment | null, signal: AbortSignal,
    isCurrent: () => boolean, phase: (text: string) => void) => {
    if (!selected || isReadableAttachment(selected)) return;
    if (!isTextFile(selected.file) && !isImageFile(selected.file))
      throw new Error('这份附件还不能读取，请先完成转写或移除附件。');
    const sameSelection = () => isCurrent() && state.getSnapshot().attachment?.file === selected.file;
    let prepared = state.getSnapshot().attachment;
    if (!sameSelection() || !prepared) return;
    if (!prepared.upload) {
      phase(isImageFile(selected.file) ? '正在发送图片…' : '正在上传资料…');
      // Some Android document providers omit image MIME. The server still
      // validates the bytes; normalize the known suffix before transport.
      const transportFile = isImageFile(selected.file) && !/^image\/(jpeg|png)$/i.test(selected.file.mime_type)
        ? { ...selected.file, mime_type: /\.png$/i.test(selected.file.name) ? 'image/png' : 'image/jpeg' } : selected.file;
      const preparedFile = isImageFile(selected.file) && platform.prepareChatImage
        ? await platform.prepareChatImage(transportFile) : transportFile;
      if (!sameSelection() || signal.aborted) return;
      const upload = await api.upload(preparedFile, signal);
      if (!sameSelection()) { api.deleteUpload(upload.id).catch(() => {}); return; }
      prepared = { ...prepared, upload };
      setAttachment(old => old?.file === selected.file ? { ...old, upload } : old);
    }
    if (isImageFile(selected.file) && !prepared.imageText) {
      phase('正在理解图片…');
      const result = await api.analyzeImage(prepared.upload!.id, signal);
      if (!sameSelection()) return;
      const text = result.text.trim();
      if (!text) throw new Error('图片理解未返回内容，请重试或更换图片。');
      setAttachment(old => old?.file === selected.file ? { ...old, imageText: text } : old);
    }
  };
  const deleteUnreferencedVoiceUpload = (uploadId: string) => {
    const retained = state.scope
      ? state.scope.isRetained()
      : mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state;
    if (retained && state.getSnapshot().voice?.upload?.id === uploadId) return;
    if (state.deletedVoiceUploads.has(uploadId)) return;
    state.deletedVoiceUploads.add(uploadId);
    api.deleteUpload(uploadId).catch(() => {});
  };
  const discardVoice = (input: VoiceInput) => {
    if (!mounted.current || voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
        state.getSnapshot().voice?.key !== input.key) return;
    const upload = state.getSnapshot().voice?.upload;
    state.voiceRequest?.cancel();
    state.update(old => ({ ...old, voice: null, voicePhase: '', voiceError: null, voiceFailure: null, voiceBusy: false }));
    if (upload) deleteUnreferencedVoiceUpload(upload.id);
    fileAction.setError(null);
  };
  const convertVoice = async (input: VoiceInput) => {
    const existing = state.getSnapshot();
    if (existing.voiceBusy || (existing.voice && existing.voice.key !== input.key) ||
      (state.scope && !state.scope.isRetained())) return;
    state.voiceRequest?.release();
    const controller = new AbortController();
    let active = true;
    let detach = () => {};
    const release = () => {
      active = false;
      detach();
      if (state.voiceRequest === operation) state.voiceRequest = null;
    };
    const operation: VoiceRequest = {
      release,
      cancel: () => {
        if (!active) return;
        release();
        controller.abort();
        const pending = state.getSnapshot().voice;
        if (pending?.key === input.key) {
          state.update(old => ({ ...old, voice: null, voicePhase: '', voiceError: null, voiceFailure: null, voiceBusy: false }));
          if (pending.upload) deleteUnreferencedVoiceUpload(pending.upload.id);
        }
      },
    };
    state.voiceRequest = operation;
    const current = () => active && state.voiceRequest === operation &&
      state.getSnapshot().voice?.key === input.key &&
      (state.scope ? state.scope.isRetained() :
        mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state);
    let upload = input.upload;
    let recognized = input.text;
    state.update(old => ({ ...old, voice: input, voiceError: null, voiceFailure: null, voiceBusy: true }));
    detach = state.scope?.onDispose(operation.cancel) ?? (() => {});
    fileAction.setError(null);
    if (!current()) return;
    try {
      if (!recognized && !upload) {
        setVoicePhase('正在识别语音…');
        upload = await api.upload(input.file, controller.signal);
        if (!current()) {
          deleteUnreferencedVoiceUpload(upload.id);
          return;
        }
        setVoice({ ...input, upload });
      }
      if (!recognized) {
        setVoicePhase('正在转成文字…');
        const transcript = await api.transcribe(upload!.id, controller.signal);
        if (!current()) {
          deleteUnreferencedVoiceUpload(upload!.id);
          return;
        }
        recognized = transcript.text.trim();
      }
      if (!recognized) {
        throw new Error('未听清语音，请重新录制。');
      }
      const intent = input.sendIntent;
      if (intent && matchesVoiceIntent(intent)) {
        await prepareAttachment(state.getSnapshot().attachment, controller.signal, current, setVoicePhase);
        if (!current()) return;
      }
      const automatic = Boolean(intent && matchesVoiceIntent(intent));
      const previous = state.getSnapshot().draft;
      const separator = previous && !/\s$/.test(previous) ? '\n' : '';
      const expectedDraft = `${previous}${separator}${recognized}`;
      insertVoiceText(recognized);
      release();
      // Recognition is an input step; raw recording IDs never enter chat intent.
      if (upload) deleteUnreferencedVoiceUpload(upload.id);
      if (automatic) {
        const submitted = submitPrepared({ draft: expectedDraft, file: intent!.file });
        if (!submitted && intent!.isVisible()) {
          setVoiceMode(false);
          state.update(old => ({ ...old, voiceError: '语音已识别并保留，请先处理上一条消息后再发送。' }));
        }
        // The reply belongs to the chat entry. Release the recording UI as
        // soon as transcription hands off the message, even while it streams.
        if (submitted) void submitted.catch(reportVoiceFailure);
      } else if (intent && intent.isVisible()) {
        setVoiceMode(false);
        state.update(old => ({ ...old, voiceError: '输入内容已变化，识别文字已保留，请确认后发送。' }));
      }
    } catch (error) {
      if (current()) {
        setVoice({ ...input, upload, text: recognized });
        setVoicePhase(
          recognized
            ? '语音已识别，文字和附件已保留，可重试发送。'
            : '转写未完成，录音已保留，可重试或重新录制。',
        );
        const failure = recognized ? { kind: 'other' as const, message: errorMessage(error) } : voiceFailure(error);
        state.update(old => ({ ...old, voiceError: failure.message, voiceFailure: failure }));
        if (input.sendIntent && input.sendIntent.isVisible()) setVoiceMode(false);
        // The retained voice card owns this failure and its explicit retry.
        // Do not also emit a clipped generic file-action error or resubmit POST.
      }
    } finally {
      if (current()) state.update(old => ({ ...old, voiceBusy: false }));
    }
  };
  const finishRecording = async (sendIntent?: VoiceSendIntent) => {
    if (holdOwner.gesture?.started) {
      holdOwner.gesture.held = false; holdOwner.gesture.ended = true;
      setHoldActive(false);
    }
    const lease = recorderLease.current;
    let file: LocalFile | null;
    try {
      file = await stopRecorder(lease);
    } finally {
      // Native adapters release their recorder even if finalizing a short clip fails.
      releaseRecorder(lease);
      recordingRef.current = false;
      if (mounted.current) setRecording(false);
    }
    if (file && mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state) {
      if (!sendIntent) setVoiceMode(false);
      await convertVoice({ key: newRequestId(), file, sendIntent });
    }
  };
  const reportVoiceFailure = (failure: unknown) => {
    if (holdOwner.active && mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state)
      state.update(old => ({ ...old, voiceError: errorMessage(failure) }));
  };
  const endHold = async (gesture: HoldRecording) => {
    if (!gesture.started || gesture.ended) return;
    gesture.ended = true; gesture.held = false;
    try {
      if (holdOwner.active && mounted.current) setHoldActive(false);
      if (gesture.cancelled || !holdOwner.active || !mounted.current ||
          voiceOwner.current.api !== api || voiceOwner.current.state !== state) {
        try {
          await stopRecorder(gesture.lease);
        } finally {
          releaseRecorder(gesture.lease);
          recordingRef.current = false;
          if (holdOwner.active && mounted.current) setRecording(false);
        }
      } else {
        await finishRecording(gesture.sendIntent);
      }
    } finally {
      if (holdOwner.active && mounted.current) setCaptureBusy(false);
    }
  };
  const beginHold = (pageY?: number) => {
    if (calendarRef.current?.owner === shareOwner) return;
    if (recordingSession.active || !holdOwner.active || recordingRef.current || (holdOwner.gesture && !holdOwner.gesture.ended) ||
        currentShareOwner.current !== shareOwner || fileActionRef.current.busy || deletingRef.current ||
        (state.scope && !state.scope.isRetained()) ||
        state.getSnapshot().sending || state.getSnapshot().voice || awaitingInitialConversation()) return;
    setAttachmentMenu(false);
    const lease = {}; recordingSession.active = lease; recorderLease.current = lease;
    const gesture: HoldRecording = { held: true, cancelled: false, started: false, ended: false, lease, startY: pageY,
      sendIntent: reviewVoiceTranscript ? undefined : makeVoiceSendIntent() };
    holdOwner.gesture = gesture;
    setHoldActive(true); setHoldCancelled(false); setCaptureBusy(true);
    state.update(old => ({ ...old, voiceError: null, voiceFailure: null }));
    void (async () => {
      try {
        await platform.startRecording();
        gesture.started = true;
        // A permission dialog may resolve after release or after this route leaves.
        if (!holdOwner.active || !mounted.current || voiceOwner.current.api !== api || voiceOwner.current.state !== state)
          gesture.cancelled = true;
        if (holdOwner.active && mounted.current) {
          recordingRef.current = true; setSeconds(0); setRecording(true);
        }
        if (!gesture.held || gesture.cancelled) await endHold(gesture);
      } catch (failure) {
        gesture.ended = true;
        if (holdOwner.active && mounted.current) {
          setHoldActive(false);
          if (!gesture.started) { setRecording(false); recordingRef.current = false; }
          setCaptureBusy(false);
        }
        if (!gesture.started) releaseRecorder(lease);
        reportVoiceFailure(failure);
      }
    })();
  };
  const releaseHold = (cancel = false) => {
    const gesture = holdOwner.gesture;
    if (!gesture || gesture.ended) return;
    gesture.held = false; gesture.cancelled = gesture.cancelled || cancel || !gesture.started;
    setHoldActive(false);
    if (gesture.started) void endHold(gesture).catch(reportVoiceFailure);
  };
  const activateHold = () => {
    if (!mounted.current || !holdOwner.active || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained())) return;
    const gesture = holdOwner.gesture;
    if (gesture?.held && !gesture.ended) releaseHold();
    else beginHold();
  };
  useEffect(() => {
    const subscription = AppState?.addEventListener('change', next => {
      if (next !== 'active') releaseHold(true);
    });
    return () => subscription?.remove();
    // The listener is bound to the recording owner; gesture state lives in its ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdOwner]);
  useEffect(() => {
    if (!recording || seconds < 115) {
      return;
    }
    const gesture = holdOwner.gesture;
    fileAction.run(() => gesture?.started && !gesture.ended ? endHold(gesture) : finishRecording());
    // Recording is deliberately bounded; native adapter has its own hard limit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, seconds]);
  const chooseInputFile = (source: ChatAttachmentSource) => {
    setAttachmentMenu(false);
    fileAction.run(async ({ isCurrent }) => {
      const file = await pickChatAttachment(source);
      if (file && isCurrent()) setAttachment({ file });
    });
  };
  const awaitingInitialConversation = () => !state.getSnapshot().id &&
    Array.from(state.streams.values()).some(stream => stream.intent.conversation_id === null &&
      stream.getSnapshot().phase === 'failed' && !stream.getSnapshot().conversationId);
  const submitPrepared = (automatic?: { draft: string; file: LocalFile | null }, preparedContext?: ChatClientContext, preparedRequestId?: string, skipConnectionCard = false): Promise<void> | void => {
    const before = state.getSnapshot();
    const selected = before.attachment;
    const entered = before.draft.trim() || (selected && isImageFile(selected.file) ? '请描述这张图片的内容。' : '');
    const text = before.quoting ? quoteMessageText(before.quoting, entered) : entered;
    const ready = isReadableAttachment(selected);
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained()) ||
      !entered || before.sending || deletingRef.current || continuationRequest.current || awaitingInitialConversation() ||
      recordingRef.current || recordingSession.active || (!automatic && fileActionRef.current.busy) || before.voice || !ready ||
      (automatic && (before.draft !== automatic.draft || (selected?.file ?? null) !== automatic.file))) return;
    if (Array.from(text).length > 20000) {
      fileActionRef.current.setError('引用后的消息超过 20,000 字，请缩短追问或取消引用后再发送。');
      return;
    }
    if (activeVaultCapture || calendarRef.current?.owner === shareOwner) return;
    const canInspect = Platform.OS === 'android' && !selected && !before.editing && !before.quoting;
    const permissionToolSupported = canInspect && capabilities.value?.app_permission_tool === true && supportsPermissionInspection();
    const deviceSettingsSupported = permissionToolSupported && capabilities.value?.device_settings_tools === true && supportsDeviceSettings();
    const previousQuestion = before.messages.filter(item => item.role === 'user').at(-1);
    const priorCheck = state.permissionSession.hasRecentCheck();
    const selectedDeviceApp = state.permissionSession.selected();
    const continuing = Boolean(priorCheck || (previousQuestion && detectDeviceAction(previousQuestion.content)?.kind === 'app_permission_inspection'));
    const deviceAction = canInspect ? detectDeviceAction(entered, continuing, Boolean(selectedDeviceApp)) : undefined;
    if (deviceAction && (deviceAction.kind === 'app_permission_inspection' || !deviceSettingsSupported)) {
      const key = newRequestId();
      const now = new Date().toISOString();
      const question: Message = { id: `${key}:user`, conversation_id: before.id ?? '', role: 'user',
        content: entered, created_at: now, delivery: 'local' };
      const reply: Message = { id: `${key}:assistant`, conversation_id: question.conversation_id, role: 'assistant',
        content: '', created_at: afterMessageDate(now), delivery: 'local', stream_status: '等待确认手机操作…' };
      state.history.viewport.anchor = null;
      state.history.viewport.followTail = true;
      state.update(old => ({ ...old, draft: '', sending: true, sendError: null, voiceError: null, alarmFeedback: undefined,
        localDeviceAction: { action: deviceAction, replyId: reply.id },
        continuationDismissed: true, continuationTarget: null, messages: [...old.messages, question, reply],
        messageVersion: old.messageVersion + 1 }));
      Keyboard.dismiss();
      return Promise.resolve();
    }
    if (user && !skipConnectionCard && !preparedContext && !selected && !before.editing && !before.quoting) {
      const intent = chatConnectionIntent(entered);
      if (intent) {
        if (!activeConnectionFlow) setConnectionFlow({ owner: shareOwner, draft: before.draft, intent, key: newRequestId() });
        setVoiceMode(false);
        Keyboard.dismiss();
        return Promise.resolve();
      }
    }
    const slack = user && !selected && !before.editing && !before.quoting ? slackSearchQuery(entered) : null;
    if (slack !== null) {
      setSlackSearch({ owner: shareOwner, query: slack });
      state.update(old => ({ ...old, draft: '', voiceError: null }));
      setVoiceMode(false);
      Keyboard.dismiss();
      return Promise.resolve();
    }
    const privateRecord = user && !selected && !before.editing && !before.quoting
      ? detectPrivateRecord(entered, user.name ?? '') : null;
    if (user && privateRecord) {
      setVaultReceipt(null);
      setVaultCapture({ key: newRequestId(), owner: shareOwner,
        scope: vaultOwner(api.baseUrl, preferences?.instance?.id, user.id),
        record: privateRecord, transcribed: Boolean(automatic) });
      state.update(old => ({ ...old, draft: '', voiceError: null }));
      setVoiceMode(false);
      Keyboard.dismiss();
      return Promise.resolve();
    }
    const alarm = phoneAlarms.supportsDirectSystemAlarm && !selected && !before.editing && !before.quoting
      ? directAlarmProposal(entered, new Date().toISOString()) : null;
    if (alarm) {
      state.update(old => ({ ...old, sending: true, alarmFeedback: undefined }));
      return phoneAlarms.setNextSystemAlarm(alarm.date, alarm.time, alarm.title)
        .then(() => state.update(old => ({ ...old, sending: false, draft: old.draft === before.draft ? '' : old.draft,
          alarmFeedback: { text: `已交给系统闹钟 · ${alarm.date} ${alarm.time}` } })))
        .catch(error => state.update(old => ({ ...old, sending: false,
          alarmFeedback: { text: errorMessage(error), error: true } })));
    }
    const calendar = phoneCalendar.supported && !selected && !before.editing && !before.quoting && !preparedContext
      ? calendarRequest(entered, before.messages, new Date()) : null;
    if (calendar) {
      const preferenceKey = user?.id && api.baseUrl ? calendarPreferenceKey(api.baseUrl, preferences?.instance?.id, user.id) : undefined;
      const flow: CalendarFlow = { key: newRequestId(), owner: shareOwner, request: calendar, index: 0,
        preferenceKey, tryingDefault: calendar.automatic && Boolean(preferenceKey) };
      setCalendarFeedback(null);
      showCalendar(flow);
      state.update(old => ({ ...old, draft: '', voiceError: null, alarmFeedback: undefined,
        continuationDismissed: true, continuationTarget: null }));
      setVoiceMode(false);
      Keyboard.dismiss();
      return (async () => {
        if (!flow.tryingDefault) return;
        try {
          if (await phoneCalendar.hasAccess() && calendarCurrent(flow)) {
            const target = await preferredCalendar(preferenceKey, await phoneCalendar.calendars());
            if (target && calendarCurrent(flow)) {
              const saved = await phoneCalendar.add(target.id, calendar.drafts[0]);
              finishCalendar(flow, calendarReceipt(calendar.drafts[0], target, saved.id));
              return;
            }
          }
          if (calendarCurrent(flow)) showCalendar({ ...flow, tryingDefault: false });
        } catch (error) {
          if (calendarCurrent(flow)) showCalendar({ ...flow, tryingDefault: false, error: errorMessage(error) });
        }
      })();
    }
    if (calendarFeedback?.owner === shareOwner) setCalendarFeedback(null);
    if (before.editing?.retry && before.draft === before.editing.retryDraft && selected === before.editing.retryAttachment) return before.editing.retry();
    const context = deviceAction ? captureClientContext(null, user?.timezone)
      : preparedContext ?? location.capture(entered, false, user?.timezone, before.messages.slice(-6));
    if (!context) {
      if (pendingLocation.current) return;
      const requestId = newRequestId();
      const pending = {
        entry: state,
        matches: (latest: ChatSnapshot) => latest.draft === before.draft && latest.attachment === selected &&
          latest.editing === before.editing && latest.quoting === before.quoting && latest.id === before.id,
      };
      pendingLocation.current = pending;
      setLocationPreview({entry: state, message: {id: `${requestId}:user`, role: 'user',
        conversation_id: before.id ?? '', content: text, created_at: new Date().toISOString()}});
      setVoiceMode(false);
      Keyboard.dismiss();
      return location.request('chat', entered, before.messages.slice(-6)).then(choice => {
        if (pendingLocation.current !== pending) return;
        pendingLocation.current = null;
        setLocationPreview(null);
        if (choice.kind === 'cancel' || !mounted.current || currentShareOwner.current !== shareOwner ||
          !pending.matches(state.getSnapshot())) return;
        // The picker is an input step. Only now create an immutable new intent;
        // future retry/reconnect uses that controller's original context.
        return submitPrepared(automatic, captureClientContext(choice.kind === 'selected' ? choice.location : null, user?.timezone), requestId);
      });
    }
    before.editing?.discardRetry?.();
    const edit = before.editing;
    const targetIndex = edit ? before.messages.findIndex(message => message.id === edit.message.id) : -1;
    if (edit && (targetIndex < 0 || !before.id)) return;
    // Adjacent rows are not necessarily a pair when another device sends at
    // the same time. Only the server's removed_message_ids link a reply.
    const originalTurn = edit ? [before.messages[targetIndex]] : [];
    const originalIds = new Set(originalTurn.map(message => message.id));
    const requestId = preparedRequestId ?? newRequestId();
    const userKey = `${requestId}:user`;
    const assistantKey = `${requestId}:assistant`;
    const uploadIds = selected?.upload && ready ? [selected.upload.id]
      : edit ? (edit.message.attachments ?? []).filter(file => !file.unavailable && !edit.removedUploadIds?.includes(file.upload_id)).map(file => file.upload_id) : [];
    const now = Date.now();
    const userMessage: Message = {
      id: edit?.message.id ?? userKey, client_key: userKey, conversation_id: before.id ?? '', role: 'user',
      content: text, created_at: edit?.message.created_at ?? new Date(now).toISOString(), delivery: 'sending',
      attachments: selected?.upload && uploadIds.length ? [{
        upload_id: selected.upload.id, name: selected.upload.name,
        mime_type: selected.upload.mime_type, size: selected.upload.size, unavailable: false,
      }] : (edit?.message.attachments ?? []).filter(file => uploadIds.includes(file.upload_id)),
    };
    const assistantMessage: Message = {
      id: assistantKey, client_key: assistantKey, conversation_id: before.id ?? '', role: 'assistant',
      content: '', created_at: edit ? afterMessageDate(edit.message.created_at) : new Date(now + 1).toISOString(), stream_status: '发送中…',
    };
    const canApply = () => currentShareOwner.current === shareOwner &&
      (state.scope ? state.scope.isRetained() :
        mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state);
    const setTurn = (items: Message[], turn: Message[]) => {
      if (!edit) return [...items, ...turn];
      const at = items.findIndex(message => message.client_key === userKey || message.id === edit.message.id);
      const filtered = items.filter(message => !originalIds.has(message.id) && message.client_key !== userKey && message.client_key !== assistantKey);
      filtered.splice(Math.max(0, Math.min(at >= 0 ? at : targetIndex, filtered.length)), 0, ...turn);
      return filtered;
    };
    const retryEdit = () => {
      // The visible owner fences the button/send callback. The operation itself
      // belongs to the retained entry and remains retryable after History.
      if (!canApply() || state.getSnapshot().sending) return;
      const latest = state.getSnapshot();
      if (latest.editing?.retry !== retryEdit || latest.draft !== before.draft || latest.attachment !== selected) return;
      originalTurn.filter(message => message.role === 'assistant').forEach(message => state.hiddenHistoryIds.add(message.id));
      state.update(old => ({ ...old, editing: null, draft: '', attachment: null, sendError: null,
        sending: true, messages: setTurn(old.messages, [userMessage, assistantMessage]), messageVersion: old.messageVersion + 1 }));
      return operation.retry();
    };
    const applyProgress = (progress: ChatProgress) => {
      if (!canApply()) return;
      const conversationChanged = Boolean(progress.conversationId &&
        progress.conversationId !== state.getSnapshot().id);
      state.update(old => {
        if (edit) for (const removedId of progress.removedMessageIds ?? []) {
          originalIds.add(removedId);
          if (removedId !== edit.message.id) state.hiddenHistoryIds.add(removedId);
        }
        if (edit && progress.phase === 'failed') {
          originalIds.forEach(removedId => state.hiddenHistoryIds.delete(removedId));
          return { ...old, messages: mergeMessageHistory(before.messages.filter(message => originalIds.has(message.id)),
            old.messages.filter(message => !originalIds.has(message.id) && message.client_key !== userKey && message.client_key !== assistantKey)), sending: false, interaction: undefined,
            draft: old.draft || before.draft, attachment: old.attachment ?? selected,
            editing: { ...edit, retry: retryEdit, retryDraft: before.draft, retryAttachment: selected,
              discardRetry: () => { operation.dispose(); state.streams.delete(userKey); } },
            messageVersion: old.messageVersion + 1,
            sendError: `修改未完成，原消息和回复已保留。${progress.error ?? ''}` };
        }
        const next = old.messages.filter(message => !edit || !originalIds.has(message.id) ||
          message.client_key === userKey || message.client_key === assistantKey).map(message => {
          if (message.client_key === userKey) {
            const canonical = progress.userMessage;
            const delivery = canonical || progress.phase === 'complete' ? 'sent' as const :
              progress.phase === 'failed' ? 'failed' as const : 'sending' as const;
            const error = delivery === 'failed' ? progress.error && !before.id && !progress.conversationId
              ? `${progress.error}\n请先重试这条消息，再继续发送新消息。` : progress.error : undefined;
            if (message.delivery === delivery && message.stream_error === error &&
              (!canonical || (message.id === canonical.id && message.content === canonical.content &&
                message.attachments === canonical.attachments))) return message;
            return { ...message, ...(canonical ?? {}), client_key: userKey,
              delivery, stream_error: delivery === 'failed' ? error : undefined,
              attachments: canonical ? canonical.attachments : message.attachments };
          }
          if (message.client_key === assistantKey) {
            const failure = progress.error ?? '回复中断，请稍后重试。';
            const error = progress.phase === 'failed'
              ? !before.id && !progress.conversationId
                ? `${failure}\n请先重试这条消息，再继续发送新消息。` : failure
              : undefined;
            if (!progress.response && message.content === progress.content &&
              message.stream_status === progress.status && message.stream_error === error &&
              message.stream_activity === progress.activities && message.app_permission_report === progress.permissionReport &&
              (!progress.assistantId || message.id === progress.assistantId) &&
              (!progress.assistantCreatedAt || message.created_at === progress.assistantCreatedAt) &&
              (!progress.conversationId || message.conversation_id === progress.conversationId)) return message;
            return {
            ...message, ...(progress.response?.message ?? {}),
            id: progress.assistantId ?? message.id, client_key: assistantKey,
            created_at: progress.assistantCreatedAt ?? message.created_at,
            conversation_id: progress.conversationId ?? message.conversation_id,
            content: progress.content, stream_status: progress.status,
            stream_activity: progress.activities,
            app_permission_report: progress.permissionReport,
            stream_error: error,
          };
          }
          return message;
        });
        // The backend reuses the question ID, so remove old IDs before keeping
        // this operation's canonical revised question and answer.
        const removed = new Set(progress.response?.removed_message_ids ?? []);
        const confirmed = removed.size ? next.filter(message => !removed.has(message.id) ||
          message.client_key === userKey || message.client_key === assistantKey) : next;
        const reconciled = confirmed.length !== old.messages.length || confirmed.some((message, index) => message.id !== old.messages[index]?.id);
        const localIds = reconciled ? new Set(confirmed.filter(message => message.client_key).map(message => message.id)) : null;
        const seen = new Set<string>();
        return { ...old, id: progress.conversationId ?? old.id,
          // Preserve the submitted turn's order while removing any server row
          // that a history refresh returned before the accepted event arrived.
          messages: edit && progress.phase === 'complete' ? mergeMessageHistory([], confirmed) : reconciled ? confirmed.filter(message => {
            if (!message.client_key && localIds?.has(message.id)) return false;
            if (seen.has(message.id)) return false;
            seen.add(message.id);
            return true;
          }) : confirmed,
          sending: progress.phase !== 'complete' && progress.phase !== 'failed', interaction: progress.interaction,
          permissionApprovalNeeded: progress.permissionApprovalNeeded,
          sendError: progress.error ?? null };
      });
      if (conversationChanged && progress.conversationId) state.scope?.updateRoute(route => route.name === 'chat'
        ? { ...route, conversationId: progress.conversationId, prompt: undefined } : route);
    };
    const operation: ChatStreamController = createChatStreamController({ api,
      intent: { message: text, conversation_id: before.id ?? null,
        client_request_id: requestId, upload_ids: uploadIds, remember: false,
        client_context: context,
        action_confirmation_supported: true,
        ...(permissionToolSupported ? { app_permission_tool_supported: true as const } : {}),
        ...(deviceSettingsSupported ? { device_settings_supported: true as const,
          device_inspection_context: { has_report: priorCheck, has_selected_app: Boolean(selectedDeviceApp) } } : {}),
        ...(location.session ? { interaction_mode: preparedContext ? 'location_decided' as const : 'enabled' as const,
          personal_details_supported: true as const, didi_order_confirmation_supported: true as const } : {}),
        reasoning_effort: before.reasoningEffort,
        ...(edit ? { replace_message_id: edit.message.id } : {}) },
      isCurrent: () => canApply() && state.streams.get(userKey) === operation,
      permissionSession: state.permissionSession,
      onChange: applyProgress,
      onComplete: result => {
        if (!canApply()) return;
        for (const messageId of result.removed_message_ids ?? []) {
          if (messageId !== result.user_message?.id && messageId !== result.message.id) state.hiddenHistoryIds.add(messageId);
        }
        if (edit) {
          const removed = new Set(result.removed_message_ids ?? []);
          state.history.viewport.heights.forEach((value, key) => { if (removed.has(value.message.id)) state.history.viewport.heights.delete(key); });
          state.update(old => ({ ...old, editing: null,
            draft: old.draft || edit.previousDraft, attachment: old.attachment ?? edit.previousAttachment }));
          void restartHistory();
        }
        if (mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state)
          onConversationCreated?.(result.conversation_id);
        invalidate();
        state.streams.delete(userKey);
      },
    });
    state.streams.set(userKey, operation);
    if (edit) originalTurn.filter(message => message.role === 'assistant').forEach(message => state.hiddenHistoryIds.add(message.id));
    // Publish before the first identity probe or HTTP request can yield.
    if (!edit) { state.history.viewport.anchor = null; state.history.viewport.followTail = true; }
    state.update(old => ({ ...old, draft: '', attachment: null, sending: true, sendError: null, voiceError: null, alarmFeedback: undefined,
      continuationDismissed: true, continuationTarget: null,
      editing: null, quoting: null,
      messages: setTurn(old.messages, [userMessage, assistantMessage]),
      messageVersion: old.messageVersion + 1 }));
    return operation.start();
  };
  const send = () => {
    const before = state.getSnapshot();
    const pending = pendingLocation.current;
    if (pending?.entry === state) {
      if (location.session?.getSnapshot().dialog === 'chat' && pending.matches(before)) {
        location.session.skip();
      }
      return;
    }
    if (!before.attachment || isReadableAttachment(before.attachment)) return submitPrepared();
    if (!canPrepareOnSend(before.attachment) || before.voice || before.sending || recordingRef.current || recordingSession.active) return;
    let submitted: Promise<void> | void;
    return fileAction.run(async ({ isCurrent }) => {
      const controller = new AbortController();
      attachmentAbort.current = controller;
      try {
        await prepareAttachment(before.attachment, controller.signal, isCurrent, text => {
          if (isCurrent()) setAttachmentPhase(text);
        });
        if (!isCurrent()) return;
        // Keep the attachment lock scoped to preparation, not the AI reply.
        submitted = submitPrepared({ draft: before.draft, file: before.attachment!.file });
      } finally {
        if (attachmentAbort.current === controller) attachmentAbort.current = null;
        if (isCurrent()) setAttachmentPhase('');
      }
    }).then(() => submitted);
  };
  useEffect(() => {
    const input = state.takeInitialInput();
    if (!input) return;
    state.scope?.updateRoute(route => route.name === 'chat' ? { ...route, initialInput: undefined } : route);
    if (input.recording) {
      if (reviewVoiceTranscript) setVoiceMode(false);
      void convertVoice({ key: newRequestId(), file: input.recording,
        sendIntent: reviewVoiceTranscript ? undefined : makeVoiceSendIntent() });
    } else {
      void send();
    }
    // Only the entry may consume the explicit send from Today, including on remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  const choosingLocation = location.choosingForChat && pendingLocation.current?.entry === state &&
    pendingLocation.current.matches(state.getSnapshot());
  // Keep one scaled line visible even when the keyboard reduces the viewport.
  const { expandedText, inputStyle } = composerTextLayout(
    draft, voiceMode, Boolean(attachment), windowWidth, availableHeight, nativeFontScale ?? fontScale,
  );
  const composerToolsDisabled = recording || captureBusy || fileAction.busy || Boolean(voice) || sending || deleting ||
    openingContinuation || Boolean(activeVaultCapture || activeCalendar);
  const sendDisabled =
    (!draft.trim() && !Boolean(attachment && isImageFile(attachment.file))) ||
    awaitingInitialConversation() ||
    sending || deleting || openingContinuation || Boolean(activeVaultCapture || activeCalendar) ||
    recording || (captureBusy && !choosingLocation) ||
    Boolean(voice) ||
    (fileAction.busy && !choosingLocation) ||
    (!attachmentReady && !Boolean(attachment && canPrepareOnSend(attachment)));
  const supportMaxHeight = Math.max(64, Math.min(130, availableHeight * 0.28));
  const messageHeader = useMemo(() => (<View key="history-header" testID="chat-history-header" collapsable={false}>
        <ErrorNotice message={history.error} retry={refreshHistory} />
        {history.nextOffset !== null && <Button variant="ghost" disabled={history.loading}
          onPress={loadOlder}>{history.loading ? '正在加载…' : '加载更早消息'}</Button>}
        <ErrorNotice
          message={capabilities.error}
          retry={capabilities.refresh}
        />
        {history.loading && !messages.length && conversationId && (
          <Loading label="正在找回这段对话…" />
        )}
        {messages.length === 0 && !history.loading && (
          <View style={chat.welcome}>
            <View style={chat.welcomeOrb}><AssistantOrb size={62} /></View>
            <Text style={chat.welcomeTitle}>今天想聊点什么？</Text>
            <Text style={chat.welcomeBody}>
              一个问题，一个想法，都可以。
            </Text>
            <View style={chat.suggestions}>
              {[
                '帮我安排一下明天',
                '帮我写一封简短回复',
              ].map(value => (
                <Pressable
                  accessibilityRole="button"
                  key={value}
                  onPress={() => setDraft(value)}
                  style={chat.suggestion}
                >
                  <Text style={chat.suggestionText}>{value}</Text>
                  <Icon name="arrowUp" size={15} color={appearance.accent} />
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {capabilities.value && messages.length === 0 && (
          <View style={s.topGap}>
            <ModeNotice runtime={capabilities.value.runtime} />
          </View>
        )}
        </View>),
    [history.error, history.nextOffset, history.loading, refreshHistory, loadOlder,
      capabilities.error, capabilities.refresh, capabilities.value, messages.length, conversationId, setDraft]);
  const messageFooter = useMemo(() => <View style={chat.messageFooter}>
    {interaction?.kind === 'didi_order' && <ChatInteractionCard
      key={`${interaction.run_id}:${interaction.id}`} card={interaction} api={api} session={location.session} />}
  </View>, [interaction, api, location.session]);
  return (
    <View
      style={[s.fill, chat.chatRoot]}
      onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}
    >
      <ChatMessageList messages={visibleMessages} viewport={state.history.viewport}
        hasOlder={history.nextOffset !== null}
        latestVersion={messageVersion + (previewMessage ? 0.5 : 0)} renderItem={renderMessage}
        header={messageHeader} footer={messageFooter}
        style={chat.messagePane} contentContainerStyle={chat.messages} />
      <ScrollView
        ref={composerScroll}
        testID="chat-composer-scroll"
        style={chat.composerViewport}
        contentContainerStyle={chat.composerArea}
        removeClippedSubviews={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!recording && !holdActive}
        nestedScrollEnabled
        bounces={false}
        onLayout={event => {
          const height = event?.nativeEvent?.layout?.height;
          if (typeof height === 'number' && Number.isFinite(height) && height > 0) setComposerHeight(previous => previous === height ? previous : height);
          revealFocusedInput();
        }}
      >
        {continuationTarget&&!recording&&<View style={chat.contextStrip} testID="continuation-selected-context">
          <View style={s.fill}><Text style={chat.contextLabel}>接着「{continuationTarget.title}」聊</Text><Text style={chat.contextExcerpt}>当前输入和附件仍保留，尚未发送。</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel="回到新对话并保留输入" disabled={openingContinuation||sending||recording||Boolean(voice)||fileAction.busy||deleting}
            onPress={returnToNewConversation} style={{minHeight:44,justifyContent:'center'}}><Text style={{fontSize:11,color:appearance.accent}}>回到新对话 ↗</Text></Pressable>
        </View>}
        {continuation&&!recording&&<ContinuationCard key={continuation.conversation.id+':'+draft}
          candidate={continuation} pauseVersion={continuationPauseVersion}
          blocked={openingContinuation||captureBusy||fileAction.busy||Boolean(voice)||deleting||attachmentMenu||Boolean(messageMenu)||Boolean(conversationSharing)}
          error={continuationError} onDismiss={dismissContinuation} onResume={()=>{void resumeContinuation(continuation);}}/>}
        {activeConnectionFlow && !recording && <ChatConnectionCard
          key={activeConnectionFlow.key}
          api={api}
          message={activeConnectionFlow.draft}
          intent={activeConnectionFlow.intent}
          onClose={completed => {
            if (!actionOwnerCurrent(activeConnectionFlow.owner)) return;
            if (completed) state.update(old => old.draft === activeConnectionFlow.draft
              ? { ...old, draft: '', voiceError: null } : old);
            setConnectionFlow(null);
          }}
          onContinue={() => {
            const current = state.getSnapshot();
            if (!actionOwnerCurrent(activeConnectionFlow.owner) || current.draft !== activeConnectionFlow.draft
              || current.attachment || current.editing || current.quoting || current.sending) return;
            setConnectionFlow(null);
            void submitPrepared({ draft: current.draft, file: null }, undefined, undefined, true);
          }}
        />}
        {!recording && (fileAction.error || (!voice && voiceError) || attachment || (editing && sendError)) && (
          <ScrollView
            testID="chat-composer-support"
            style={[chat.composerSupport, { maxHeight: supportMaxHeight }]}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            bounces={false}
          >
            <ErrorNotice message={(!voice ? voiceError : null) ?? fileAction.error} />
            {editing && <ErrorNotice message={sendError} />}
            {editing?.retry && draft === editing.retryDraft && attachment === editing.retryAttachment && <Button variant="ghost"
              onPress={() => { if (actionOwnerCurrent(shareOwner) && !mutationBlocked()) return submitPrepared(); }}>重试修改</Button>}
            {attachmentPhase ? <Text style={chat.attachmentHint}>{attachmentPhase}</Text> : null}
            {attachment && !attachment.upload && (
              <Text style={[s.small, { fontSize: 10, marginBottom: 6 }]}>
                附件最多 25 MB。录音会自动转成文字。
              </Text>
            )}
            {attachment && (
              <Card style={chat.attachmentCard}>
                <View style={[s.between, { gap: 8 }]}>
                  {isImageFile(attachment.file) ? <Image source={{ uri: attachment.file.uri }}
                    accessibilityLabel="所选图片预览" style={{ width: 38, height: 38, borderRadius: 10 }} /> : <View style={chat.fileIcon}>
                    <Icon
                      name={isAudioFile(attachment.file) ? 'mic' : 'file'}
                      size={20}
                      color={appearance.accent}
                    />
                  </View>}
                  <View style={s.fill}>
                    <Text style={[s.body, { fontSize: 12 }]} numberOfLines={1}>
                      {attachment.file.name}
                    </Text>
                    <Text style={[s.small, { fontSize: 10 }]}>
                      {attachment.file.size
                        ? Math.ceil(attachment.file.size / 1024) + ' KB · '
                        : ''}
                      {attachment.upload
                        ? '已保存到服务'
                        : '仅保存在本机，尚未上传'}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="移除附件"
                    onPress={() => setAttachment(null)}
                    style={chat.removeButton}
                  >
                    <Icon name="close" size={18} color={appearance.secondary} />
                  </Pressable>
                </View>
                {!attachment.upload && !isImageFile(attachment.file) ? (
                  <Button
                    variant="ghost"
                    loading={fileAction.busy}
                    onPress={() =>
                      fileAction.run(async ({ isCurrent }) => {
                        const controller = new AbortController();
                        attachmentAbort.current = controller;
                        try {
                          const upload = await api.upload(attachment.file, controller.signal);
                          if (!isCurrent()) return;
                          setAttachment(old =>
                            old && old.file.uri === attachment.file.uri
                              ? { ...old, upload }
                              : old,
                          );
                        } finally {
                          if (attachmentAbort.current === controller) attachmentAbort.current = null;
                        }
                      })
                    }
                  >
                    上传附件　↑
                  </Button>
                ) : isAudioFile(attachment.file) && !attachment.transcript ? (
                  <Button
                    variant="ghost"
                    loading={fileAction.busy}
                    onPress={() =>
                      fileAction.run(async ({ isCurrent }) => {
                        const controller = new AbortController();
                        attachmentAbort.current = controller;
                        try {
                          const transcript = await api.transcribe(
                            attachment.upload!.id, controller.signal,
                          );
                          if (!isCurrent()) return;
                          setAttachment(old =>
                            old && old.file.uri === attachment.file.uri
                              ? { ...old, transcript: transcript.text }
                              : old,
                          );
                          if (!draftRef.current.trim()) {
                            setDraft('请整理这段录音的主要内容。');
                          }
                        } finally {
                          if (attachmentAbort.current === controller) attachmentAbort.current = null;
                        }
                      })
                    }
                  >
                    转成文字　↗
                  </Button>
                ) : null}
                {attachment.upload &&
                  !isTextFile(attachment.file) &&
                  !isImageFile(attachment.file) &&
                  !attachment.transcript &&
                  !isAudioFile(attachment.file) && (
                    <Text
                      style={[s.small, { color: appearance.secondary, marginTop: 6 }]}
                    >
                      已真实保存。暂不能解析 PDF、PPT 等此类资料，不会将其作为已读资料。
                    </Text>
                  )}
                {attachment.transcript && (
                  <Text style={[s.small, { marginTop: 8 }]} numberOfLines={3}>
                    转写：{attachment.transcript}
                  </Text>
                )}
                {attachment.upload &&
                  (isTextFile(attachment.file) || attachment.transcript || attachment.imageText) && (
                    <Text style={[s.small, { marginTop: 6 }]}>
                      发送文字时，会一起提供这份资料的可读内容。
                    </Text>
                  )}
              </Card>
            )}
            {!attachmentReady && (
              <Text style={chat.attachmentHint}>
                {!attachment?.upload
                  ? attachment && isImageFile(attachment.file)
                    ? '发送时会自动上传并理解图片，也可以按住说出你的问题。'
                    : attachment?.prepareOnSend ? '发送时会自动上传这份资料。' : '请先上传或移除附件，再发送消息。'
                  : attachment && isImageFile(attachment.file)
                  ? '发送时会先理解图片；若失败会保留图片和文字，便于重试。'
                  : isAudioFile(attachment.file)
                  ? '录音需完成转写后发送；也可以移除附件继续文字聊天。'
                  : '该格式已保存但暂不能解析，请移除附件后继续文字聊天。'}
              </Text>
            )}
          </ScrollView>
        )}
        {!recording && (editing || quoting) && <View style={chat.contextStrip} testID={editing ? 'chat-edit-context' : 'chat-quote-context'}>
          <View style={s.fill}>
            <Text style={chat.contextLabel}>{editing ? '修改消息' : '追问这条消息'}</Text>
            {editing && sending && <Text style={chat.contextExcerpt}>当前回复结束后可以提交修改。</Text>}
            <Text numberOfLines={1} style={chat.contextExcerpt}>{(editing?.message ?? quoting)?.content}</Text>
            {editing && !attachment && (editing.message.attachments ?? []).filter(file => !editing.removedUploadIds?.includes(file.upload_id)).map(file =>
              <View key={file.upload_id} style={chat.originalAttachment}>
                <Icon name="file" size={14} color={appearance.secondary} />
                <Text numberOfLines={1} style={[chat.contextExcerpt, s.fill]}>{file.name}{file.unavailable ? '（不可用）' : ' · 会保留'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`移除原附件：${file.name}`} style={chat.removeButton}
                  disabled={editDraftBlocked()}
                  onPress={() => {
                    if (!actionOwnerCurrent(shareOwner) || editDraftBlocked()) return;
                    const current = state.getSnapshot().editing;
                    if (!current || current.message.id !== editing.message.id) return;
                    current.discardRetry?.();
                    state.update(old => ({ ...old, editing: old.editing ? { ...old.editing,
                      removedUploadIds: [...(old.editing.removedUploadIds ?? []), file.upload_id],
                      retry: undefined, retryDraft: undefined, retryAttachment: undefined, discardRetry: undefined } : null }));
                  }}><Icon name="close" size={14} color={appearance.secondary} /></Pressable>
              </View>)}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={editing ? '取消修改消息' : '取消引用消息'}
            disabled={editing ? editDraftBlocked() : captureBusy || mutationBlocked()}
            style={chat.removeButton} onPress={() => {
              if (editing) cancelEditing();
              else if (actionOwnerCurrent(shareOwner) && !mutationBlocked()) state.update(old => ({ ...old, quoting: null }));
            }}><Icon name="close" size={18} color={appearance.secondary} /></Pressable>
        </View>}
        <View
          style={{ flexShrink: 0 }}
          testID="chat-composer-content"
          onLayout={event => {
            composerTop.current = event.nativeEvent.layout.y;
            revealFocusedInput();
          }}
        >
          {!recording && !activeCalendar && calendarFeedback?.owner === shareOwner && <CalendarFeedbackCard
            key={calendarFeedback.feedback.kind === 'saved' ? calendarFeedback.feedback.eventId : 'editor'}
            feedback={calendarFeedback.feedback} onClose={() => setCalendarFeedback(null)} />}
          {!recording && activeCalendar && (activeCalendar.tryingDefault
            ? <Text accessibilityLiveRegion="polite">正在添加到手机日历…</Text>
            : <CalendarCard key={`${activeCalendar.key}:${activeCalendar.index}`}
              initial={activeCalendar.request.drafts[activeCalendar.index]} index={activeCalendar.index}
              total={activeCalendar.request.drafts.length} wantsReminder={activeCalendar.request.needsReminderTime}
              preferenceKey={activeCalendar.preferenceKey} autoError={activeCalendar.error}
              isCurrent={() => calendarCurrent(activeCalendar)}
              onDone={feedback => finishCalendar(activeCalendar, feedback)} onCancel={() => finishCalendar(activeCalendar)} />)}
          {!recording && voice && <ChatVoiceRecovery phase={voicePhase} failure={pendingVoiceFailure ?? undefined}
            transcript={voice.text} busy={voiceBusy} blocked={fileAction.busy || sending || deleting}
            retryLabel={voice.sendIntent ? voice.text ? '重试发送' : '重试识别并发送' : voice.text ? '填入文字' : '重试转写'}
            onRetry={() => fileAction.run(() => convertVoice({ ...voice,
              sendIntent: voice.sendIntent ? makeVoiceSendIntent() : undefined }))}
            onCancel={() => discardVoice(voice)}
            onInsertText={voice.sendIntent && voice.text ? () => fileAction.run(() => convertVoice({ ...voice, sendIntent: undefined })) : undefined} />}
          {!recording && alarmFeedback && <View>
            {alarmFeedback.error ? <ErrorNotice message={alarmFeedback.text} /> : <Text>{alarmFeedback.text}</Text>}
            <Button variant="secondary" onPress={() => fileAction.run(async () => { await phoneAlarms.openSystemClock(); })}>打开系统闹钟</Button>
          </View>}
          {!recording && activeVaultCapture && <ChatVaultCaptureCard
            key={activeVaultCapture.key}
            scope={activeVaultCapture.scope}
            proposal={activeVaultCapture.record}
            transcribed={activeVaultCapture.transcribed}
            isCurrent={() => actionOwnerCurrent(activeVaultCapture.owner)}
            onClose={() => setVaultCapture(current => current?.key === activeVaultCapture.key ? null : current)}
            onSaved={alias => {
              if (!actionOwnerCurrent(activeVaultCapture.owner)) return;
              setVaultReceipt({ owner: activeVaultCapture.owner, alias });
              setVaultCapture(null);
            }} />}
          {!recording && vaultReceipt?.owner === shareOwner && <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Text accessibilityLiveRegion="polite">已加密保存 · {vaultReceipt.alias}</Text>
            <Button variant="ghost" onPress={() => {
              if (actionOwnerCurrent(vaultReceipt.owner)) navigate({ name: 'privateVault' });
            }}>查看私密资料</Button>
          </View>}
          {!recording && !previewMessage && deviceConfirmation && <Card>
            <View style={{ gap: 8 }}>
              {deviceConfirmation.kind === 'system_settings' ? <>
                <Text style={{ fontWeight: '700' }}>{deviceConfirmation.destination === 'selected_app' && deviceAppName
                  ? `打开「${deviceAppName}」的应用详情？` : `打开${settingsLabels[deviceConfirmation.destination]}？`}</Text>
                <Text>{deviceConfirmation.destination === 'privacy' ? '可在系统隐私中心查看访问记录。' : '设置由你在系统页面操作。'}</Text>
                <Button onPress={() => respondToDeviceAction(true)}>打开系统设置</Button>
              </> : <>
                <Text style={{ fontWeight: '700' }}>{deviceConfirmation.scope === 'selected_app' ? `重新检查「${deviceAppName ?? '所选 App'}」？`
                  : deviceConfirmation.permission ? `检查哪些 App 有「${permissionLabels[deviceConfirmation.permission]}」权限？` : '检查这台手机的应用权限？'}</Text>
                <Text>应用名单与权限详情留在手机。</Text>
                <Button onPress={() => respondToDeviceAction(true)}>开始本机检查</Button>
              </>}
              <Button variant="secondary" onPress={() => respondToDeviceAction(false)}>取消操作</Button>
            </View>
          </Card>}
          {!recording && !previewMessage && (interaction && interaction.kind !== 'didi_order' && interaction.kind !== 'app_permission_inspection' && interaction.kind !== 'system_settings'
            ? <ChatInteractionCard key={`${interaction.run_id}:${interaction.id}`} card={interaction} api={api} session={location.session} />
            : <ChatLocationRequest session={location.session} api={api} />)}
          <View style={recording && chat.recordingSecondaryHidden} testID="chat-composer-secondary">
            {navigationActions}
            <ChatReasoningSelector owner={state} value={reasoningEffort}
              disabled={recording || captureBusy || fileAction.busy || Boolean(voice) || deleting}
              onChange={value => {
                if (mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state &&
                  currentShareOwner.current === shareOwner && (!state.scope || state.scope.isRetained()))
                  state.update(old => ({ ...old, reasoningEffort: value }));
              }} />
          </View>
          <ChatModeMotion mode={voiceMode ? 'voice' : 'text'} reducedMotion={reducedMotion}>
            <UnifiedInputBar voiceMode={voiceMode} value={previewMessage ? '' : draft} onChangeText={setDraft}
              expandedText={!previewMessage && expandedText}
              reviewVoiceTranscript={reviewVoiceTranscript}
              finishRecordingLabel={reviewVoiceTranscript ? '结束录音并转成文字' : undefined}
              onToggleMode={toggleInputMode} onCamera={() => chooseInputFile('camera')}
              onAttach={() => {
                if (!attachmentMenu) Keyboard.dismiss();
                setAttachmentMenu(open => !open);
              }} attachmentsExpanded={attachmentMenu} animatedVoiceCue reducedMotion={reducedMotion !== false}
              onSend={() => { setAttachmentMenu(false); return send(); }}
              sendDisabled={sendDisabled} sending={sending} hasPayload={Boolean(attachment) || Boolean(previewMessage)}
              toolsDisabled={composerToolsDisabled}
              modeDisabled={recording || captureBusy || fileAction.busy || Boolean(voice) || deleting || openingContinuation || Boolean(activeVaultCapture || activeCalendar)}
              holding={holdActive} cancelled={holdCancelled} recording={recording} voiceBusy={voiceBusy}
              compactRecording={recording}
              onAccessibleRecord={activateHold} holdTestID="chat-hold-to-talk"
              sendLabel={choosingLocation ? '不带位置发送' : editing ? '提交修改' : '发送消息'} inputRef={inputRef}
              inputStyle={inputStyle}
              inputProps={{ accessibilityLabel: '给助手的消息', scrollEnabled: true,
                maxLength: 20000, placeholder: '发消息…', editable: !deleting && !previewMessage && !activeVaultCapture && !activeCalendar,
                onContentSizeChange: refreshInputFontScale,
                onFocus: () => { setAttachmentMenu(false); inputFocused.current = true; setContinuationPauseVersion(value=>value+1); refreshInputFontScale(); revealFocusedInput(); },
                onBlur: () => { inputFocused.current = false; },
              }}
              holdHandlers={{
                onStartShouldSetResponder: () => !fileAction.busy && !sending && !voice && !deleting,
                onResponderGrant: event => beginHold(event?.nativeEvent?.pageY),
                onResponderRelease: () => releaseHold(),
                onResponderTerminationRequest: () => true,
                onResponderTerminate: () => releaseHold(true),
                onResponderMove: event => {
                  const gesture = holdOwner.gesture;
                  if (!gesture?.held || gesture.startY === undefined) return;
                  gesture.cancelled = gesture.startY - event.nativeEvent.pageY > 44;
                  setHoldCancelled(gesture.cancelled);
                },
                onTouchCancel: () => releaseHold(true),
              }} />
          </ChatModeMotion>
          {attachmentMenu && !recording && <ChatAttachmentPanel disabled={composerToolsDisabled}
            onCamera={() => chooseInputFile('camera')} onImage={() => chooseInputFile('image')}
            onFile={() => chooseInputFile('file')} onRecent={recentId => chooseInputFile({ recentId })} />}
        </View>
      </ScrollView>
      {messageMenu?.owner === shareOwner && <ChatMessageActions anchor={messageMenu.anchor}
        role={messageMenu.message.role}
        timestamp={formatDate(messageMenu.message.created_at)} hasText={Boolean(messageMenu.message.content)}
        blocked={mutationBlocked()} editBlocked={editDraftBlocked()}
        onAction={performMessageAction} onClose={() => setMessageMenu(null)} />}
      {selection?.owner === shareOwner && <ChatTextSelection text={selection.text} onClose={() => setSelection(null)} />}
      {slackSearch?.owner === shareOwner && <SlackSearchSheet query={slackSearch.query} onClose={() => setSlackSearch(null)} />}
      {conversationSharing?.owner === shareOwner && <ConversationShareSheet
        key={conversationSharing.key}
        candidates={conversationSharing.candidates} initialSelectedId={conversationSharing.initialSelectedId}
        hasOlder={conversationSharing.hasOlder} formatDate={formatDate}
        isCurrent={() => actionOwnerCurrent(conversationSharing.owner)}
        validateSelection={ids => {
          const live = state.getSnapshot();
          return live.id !== conversationSharing.conversationId ? '对话已变化，请退出分享后重新选择。' :
            validateShareSelection(conversationSharing.candidates, ids, live.messages, live.id);
        }}
        onClose={() => { if (actionOwnerCurrent(conversationSharing.owner)) setConversationSharing(null); }} />}
      {replyMemory?.owner === shareOwner && <ChatReplyMemory content={replyMemory.text} onClose={() => setReplyMemory(null)} />}
      {deleteTarget?.owner === shareOwner && <ChatDeleteConfirmation text={deleteTarget.message.content}
        busy={deleting} error={deleteError} onDelete={confirmDelete}
        onClose={() => { if (!deletingRef.current) setDeleteTarget(null); }} />}
      {recording && <ChatVoiceOverlay seconds={seconds} cancelled={holdActive && holdCancelled} holding={holdActive}
        reviewVoiceTranscript={reviewVoiceTranscript}
        composerHeight={composerHeight} availableHeight={availableHeight}
        fontScale={nativeFontScale ?? fontScale} reducedMotion={reducedMotion} />}
    </View>
  );
}

const ChatMessage = memo(function ChatMessage({
  message,
  observeMemory,
  formatDate,
  share,
  retry,
  menu,
  reviewDeviceApp,
  refreshDeviceReport,
}: {
  message: Message;
  observeMemory: boolean;
  formatDate: (value: string) => string;
  share: (message: Message) => unknown;
  retry: (key: string) => unknown;
  menu: (message: Message, anchor: MessageAnchor) => void;
  reviewDeviceApp: (finding: PermissionFinding, source: PermissionReport) => ReturnType<typeof openDeviceSettings>;
  refreshDeviceReport: (messageId: string, report: PermissionReport, finding?: PermissionFinding) => Promise<boolean>;
}) {
  const bubbleRef = useRef<View>(null);
  const permissionReport = message.app_permission_report;
  const localOnly = message.delivery === 'local';
  const openMenu = (event?: { nativeEvent?: { pageX?: number; pageY?: number } }) => {
    if (message.delivery && message.delivery !== 'sent') return;
    const fallback = { x: event?.nativeEvent?.pageX ?? 20, y: event?.nativeEvent?.pageY ?? 100, width: 200, height: 50 };
    if (bubbleRef.current?.measureInWindow) bubbleRef.current.measureInWindow((x, y, width, height) =>
      menu(message, width > 0 && height > 0 ? { x, y, width, height } : fallback));
    else menu(message, fallback);
  };
  return message.role === 'user' ? (
    <View>
    <Pressable
      ref={bubbleRef}
      testID={`chat-message-${message.client_key ?? message.id}`}
      collapsable={false}
      style={chat.userBubble}
      delayLongPress={420}
      onLongPress={localOnly ? undefined : openMenu}
      accessibilityLabel={`你的消息：${message.content}`}
      accessibilityHint={localOnly ? undefined : '长按打开消息操作'}
      accessibilityActions={localOnly ? undefined : [{ name: 'longpress', label: '消息操作' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'longpress') openMenu(); }}
    >
      <Text style={chat.userText}>
        {message.content}
      </Text>
      {message.delivery === 'sending' && <Text style={chat.userMeta}>发送中…</Text>}
      {(message.attachments ?? []).map(file => (
        <Text key={file.upload_id} selectable style={chat.userMeta}>
          附件：{file.name}
          {file.unavailable ? '（已删除或不可用）' : ''}
        </Text>
      ))}
    </Pressable>
    {message.delivery === 'failed' && <Text style={chat.unsent}>待重试</Text>}
    {(!message.delivery || message.delivery === 'sent') && <PhoneAlarmCard text={message.content} />}
    </View>
  ) : (
    <Pressable
      ref={bubbleRef}
      testID={`chat-message-${message.client_key ?? message.id}`}
      collapsable={false}
      style={chat.assistantMessage}
      delayLongPress={420}
      onLongPress={localOnly ? undefined : openMenu}
      accessibilityHint={localOnly ? undefined : '长按打开回复操作，选择文字请使用菜单中的选择文字'}
      accessibilityActions={localOnly ? undefined : [{ name: 'longpress', label: '回复操作' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'longpress') openMenu(); }}
    >
      <View style={chat.answer}>
        {message.model_mode === 'local' && <Text style={chat.timestamp}>本地生成</Text>}
        {message.content ? <MessageLongPress.Provider value={openMenu}><ResultText content={message.content} textStyle={chat.answerText} /></MessageLongPress.Provider> : null}
        {permissionReport && <PermissionReportCard report={permissionReport} review={reviewDeviceApp}
          recheck={finding => refreshDeviceReport(message.id, permissionReport, finding)} />}
        {!message.stream_status && !message.stream_error && message.model_mode === 'llm' && <AutomaticMemoryNotice replyId={message.id} active={observeMemory && Date.now() - Date.parse(message.created_at) < 120000} />}
        {message.stream_error && <ChatReplyFailure message={message.stream_error} hasContent={!!message.content.trim()}
          onRetry={() => retry((message.client_key ?? message.id).replace(/:assistant$/, ':user'))} />}
        {(!message.stream_error || !!message.stream_activity?.length) && <ChatActivity key={message.client_key ?? message.id}
          items={message.stream_activity} status={message.stream_status} />}
        {!!message.content && !localOnly && <View style={chat.answerFooter}>
          <Text style={chat.timestamp}>{formatDate(message.created_at)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="分享这条回复"
            style={chat.shareButton}
            onPress={() => share(message)}
          >
            <Text style={chat.shareText}>分享</Text>
            <Icon name="arrowRight" size={14} color={appearance.secondary} />
          </Pressable>
        </View>}
      </View>
    </Pressable>
  );
});

const chat = StyleSheet.create({
  contextStrip: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: appearance.tint,
    borderLeftWidth: 3, borderLeftColor: appearance.accent, paddingVertical: 10, paddingLeft: 12, paddingRight: 8, marginBottom: 8, borderRadius: 12 },
  contextLabel: { fontSize: 12, color: appearance.accent, fontWeight: '500', marginBottom: 3 },
  contextExcerpt: { fontSize: 12, color: appearance.secondary, lineHeight: 19 },
  originalAttachment: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  chatRoot: { minHeight: 0, backgroundColor: 'transparent' },
  messagePane: { flex: 1, minHeight: 0 },
  messages: { paddingHorizontal: 20, paddingTop: 20, flexGrow: 1 },
  messageFooter: { paddingBottom: 24 },
  welcome: { alignItems: 'flex-start', paddingTop: 24, paddingBottom: 18 },
  welcomeOrb: { marginBottom: 20 },
  welcomeTitle: {
    fontSize: 26,
    lineHeight: 37,
    fontWeight: '500',
    color: appearance.ink,
  },
  welcomeBody: {
    fontSize: 14,
    lineHeight: 24,
    color: appearance.secondary,
    marginTop: 9,
    textAlign: 'left',
  },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 24, width: '100%' },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: 'rgba(255,255,255,0.82)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
    minHeight: 44,
    paddingVertical: 5,
    paddingHorizontal: 15,
  },
  suggestionText: { color: appearance.ink, fontSize: 12, lineHeight: 20 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '75%',
    backgroundColor: appearance.accent,
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 18,
    borderBottomRightRadius: 6,
    marginTop: 24,
  },
  userText: { color: appearance.onAccent, fontSize: 15, lineHeight: 26 },
  unsent: { alignSelf: 'flex-end', marginTop: 6, marginRight: 4, color: appearance.secondary, fontSize: 11, lineHeight: 18 },
  answerText: { color: appearance.ink, fontSize: 15, lineHeight: 28 },
  assistantMessage: { marginTop: 24 },
  answer: { paddingRight: 12 },
  answerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  timestamp: { fontSize: 10, lineHeight: 17, color: appearance.secondary },
  shareButton: {
    minWidth: 50,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  shareText: { fontSize: 11, lineHeight: 18, color: appearance.secondary },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 20,
    marginBottom: 8,
  },
  composerArea: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: 'transparent',
    flexShrink: 0,
  },
  composerViewport: { flexGrow: 0, flexShrink: 1, minHeight: 0, zIndex: 3 },
  recordingSecondaryHidden: { display: 'none' },
  composerSupport: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
    marginBottom: 6,
  },
  attachmentHint: {
    fontSize: 10,
    lineHeight: 17,
    color: appearance.secondary,
    textAlign: 'center',
    paddingBottom: 6,
  },
  composer: {
    flexShrink: 0,
    backgroundColor: appearance.surface,
    borderWidth: 1,
    borderColor: appearance.line,
    borderRadius: 25,
    paddingHorizontal: 3,
    paddingVertical: 3,
    shadowColor: appearance.ink,
    shadowOpacity: 0.07,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 4 },
    elevation: 0,
  },
  composerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
  },
  inputTools: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  toolButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end' },
  hiddenInput: { display: 'none' },
  holdButton: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
  holdPressed: { backgroundColor: appearance.tint },
  holdText: { fontSize: 16, color: appearance.ink, fontWeight: '500' },
  userMeta: { fontSize: 12, lineHeight: 18, color: appearance.onAccent },
  sendButton: {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appearance.accent,
  },
  sendDisabled: { backgroundColor: appearance.keyboard },
  recordingCancelled: { backgroundColor: appearance.cancellation },
  cancelText: { color: appearance.ink },
  recordingTool: { backgroundColor: appearance.cancellation },
  stopSymbol: {
    width: 13,
    height: 13,
    borderRadius: 3,
    backgroundColor: appearance.cancellationText,
  },
  attachmentCard: { padding: 12, borderRadius: 20, marginBottom: 10 },
  fileIcon: {
    width: 34,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appearance.tint,
  },
  removeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

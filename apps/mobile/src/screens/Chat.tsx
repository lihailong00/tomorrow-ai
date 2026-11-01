import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Text } from '../ui/Text';
import { errorMessage, newRequestId } from '../api/client';
import { useAction, useApp, useResource } from '../app/context';
import type { RetainedRouteScope } from '../app/navigation';
import type { Message, Upload } from '../domain/types';
import { LocalFile, platform } from '../platform/ports';
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Loading,
} from '../ui/components';
import { ResultText } from '../ui/ResultText';
import { ChatModeMotion, useChatReducedMotion } from '../ui/ChatMotion';
import { ChatVoiceOverlay } from '../ui/ChatVoiceOverlay';
import { ChatDeleteConfirmation, ChatMessageActions, ChatTextSelection, type MessageAction, type MessageAnchor } from '../ui/ChatMessageActions';
import { chatAppearance as appearance } from '../ui/ChatAppearance';
import { colors as historyColors, styles as s } from '../ui/theme';
import { Icon } from '../ui/visuals';
import { ModeNotice, usePagedList } from './Main';
import { createMessageHistory, mergeMessageHistory } from './messageHistory';
import { ChatMessageList } from './ChatMessageList';
import { createChatStreamController, type ChatProgress, type ChatStreamController } from './chatStreamController';

type Attachment = { file: LocalFile; upload?: Upload; transcript?: string; imageText?: string };
type VoiceSendIntent = { draft: string; file: LocalFile | null; context: object | null; isVisible: () => boolean };
type VoiceInput = { key: string; file: LocalFile; upload?: Upload; text?: string; sendIntent?: VoiceSendIntent };
type HoldRecording = { held: boolean; cancelled: boolean; started: boolean; ended: boolean; lease: object; startY?: number; sendIntent: VoiceSendIntent };
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
const INPUT_LINE_ALLOWANCE = 23;
// The microphone is process-wide, including permission requests from an old route.
let activeRecorder: object | null = null;
const recorderStops = new WeakMap<object, Promise<LocalFile | null>>();
function stopRecorder(lease: object | null): Promise<LocalFile | null> {
  if (!lease) return platform.stopRecording();
  let pending = recorderStops.get(lease);
  if (!pending) {
    pending = platform.stopRecording().catch(failure => { recorderStops.delete(lease); throw failure; });
    recorderStops.set(lease, pending);
  }
  return pending;
}
const releaseRecorder = (lease: object | null) => { if (lease && activeRecorder === lease) activeRecorder = null; };
type ChatSnapshot = {
  id?: string;
  draft: string;
  attachment: Attachment | null;
  voice: VoiceInput | null;
  voicePhase: string;
  voiceError: string | null;
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
) {
  let snapshot: ChatSnapshot = {
    id: conversationId,
    draft: prompt ?? '',
    attachment: null,
    voice: null,
    voicePhase: '',
    voiceError: null,
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
  const streams = new Map<string, ChatStreamController>();
  const disposeStreams = () => { streams.forEach(stream => stream.dispose()); streams.clear(); };
  scope?.onDispose(history.dispose);
  scope?.onDispose(disposeStreams);
  return {
    scope,
    history,
    hiddenHistoryIds: new Set<string>(),
    voiceRequest: null as VoiceRequest | null,
    streams,
    disposeStreams,
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

const isTextFile = (file: LocalFile) =>
  /\.(txt|md|csv|tsv|json|log|docx|xlsx)$/i.test(file.name);
const isAudioFile = (file: LocalFile) => file.mime_type.startsWith('audio/');
const isImageFile = (file: LocalFile) => /^(image\/(jpeg|png))$/i.test(file.mime_type) || /\.(jpe?g|png)$/i.test(file.name);
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
  const { api, invalidate, formatDate, user, preferences, navigate } = useApp();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const reducedMotion = useChatReducedMotion();
  const [availableHeight, setAvailableHeight] = useState(windowHeight);
  const [composerHeight, setComposerHeight] = useState(68);
  const localState = useRef<{ api: typeof api; value: ChatEntryState } | null>(null);
  if (!localState.current || localState.current.api !== api) {
    localState.current = { api, value: createChatEntryState(conversationId, prompt) };
  }
  const state = entryState ?? localState.current.value;
  const { id, messages, messageVersion, draft, attachment, voice, voicePhase, voiceError, voiceBusy, sending, editing, quoting, sendError } =
    useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const setDraft = useCallback((next: React.SetStateAction<string>) => state.update(old => ({
    ...old,
    draft: typeof next === 'function' ? next(old.draft) : next,
  })), [state]);
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
  const [voiceMode, setVoiceMode] = useState(false);
  const [holdActive, setHoldActive] = useState(false);
  const [holdCancelled, setHoldCancelled] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const recorderLease = useRef<object | null>(null);
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
  const initialConversationId = useRef(id).current;
  const history = useSyncExternalStore(state.history.subscribe,
    state.history.getSnapshot, state.history.getSnapshot);
  const canApplyHistory = useCallback(() => state.scope ? state.scope.isRetained() :
    mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state, [api, state]);
  const applyHistory = useCallback((items: Message[]) => state.update(old => ({
    ...old, messages: mergeMessageHistory(items.filter(message => !state.hiddenHistoryIds.has(message.id)), old.messages),
  })), [state]);
  const refreshHistory = useCallback(() => state.history.refresh(api, initialConversationId, applyHistory, canApplyHistory),
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
  useEffect(() => () => {
    if (currentShareOwner.current !== shareOwner) state.disposeStreams();
  }, [shareOwner, state]);
  const shareMessage = useCallback((content: string) => {
    // A previously rendered row must keep its original owner's action fence.
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state) return;
    return fileActionRef.current.run(() => platform.share(content));
  }, [api, state, shareOwner]);
  const retryMessage = useCallback((key: string) => {
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      state.getSnapshot().sending || (state.scope && !state.scope.isRetained())) return;
    return state.streams.get(key)?.retry();
  }, [api, state, shareOwner]);
  const [messageMenu, setMessageMenu] = useState<{ message: Message; anchor: MessageAnchor; owner: typeof shareOwner } | null>(null);
  const [selection, setSelection] = useState<{ text: string; owner: typeof shareOwner } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ message: Message; owner: typeof shareOwner } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  const deletionAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    deletingRef.current = false;
    setDeleting(false); setDeleteError(null); setMessageMenu(null); setSelection(null); setDeleteTarget(null);
    return () => { deletionAbort.current?.abort(); };
  }, [shareOwner]);
  const actionOwnerCurrent = (owner: typeof shareOwner) => mounted.current && currentShareOwner.current === owner &&
    voiceOwner.current.api === owner.api && voiceOwner.current.state === owner.state &&
    (!state.scope || state.scope.isRetained());
  const mutationBlocked = () => state.getSnapshot().sending || Boolean(state.getSnapshot().voice) ||
    recordingRef.current || Boolean(activeRecorder) || fileActionRef.current.busy || deletingRef.current;
  const liveSentMessage = (messageId: string) => state.getSnapshot().messages.find(message =>
    message.id === messageId && message.role === 'user' && (!message.delivery || message.delivery === 'sent'));
  const showMessageMenu = useCallback((message: Message, anchor: MessageAnchor) => {
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained()) || recordingRef.current || activeRecorder) return;
    const latest = state.getSnapshot().messages.find(item => item.id === message.id && item.role === 'user' &&
      (!item.delivery || item.delivery === 'sent'));
    if (!latest) return;
    Keyboard.dismiss();
    setMessageMenu({ message: latest, anchor, owner: shareOwner });
  }, [api, state, shareOwner]);
  const cancelEditing = () => {
    if (!actionOwnerCurrent(shareOwner) || mutationBlocked()) return;
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
    const message = liveSentMessage(selected.message.id);
    if (!message || (['edit', 'quote', 'branch', 'delete'].includes(name) && mutationBlocked())) return;
    setMessageMenu(null);
    if (name === 'copy') return fileActionRef.current.run(() => platform.copyText(message.content));
    if (name === 'share') return fileActionRef.current.run(() => platform.share(message.content));
    if (name === 'select') { setSelection({ text: message.content, owner: selected.owner }); return; }
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
  const renderMessage = useCallback(({ item }: { item: Message }) =>
    <ChatMessage message={item} formatDate={formatDate} share={shareMessage} retry={retryMessage} menu={showMessageMenu} />,
    [formatDate, shareMessage, retryMessage, showMessageMenu]);
  const attachmentReady = isReadableAttachment(attachment);
  useEffect(() => {
    void state.history.ensure(api, initialConversationId, applyHistory, canApplyHistory);
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
      voice: null, voicePhase: '', voiceError: null, voiceBusy: false }));
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
    api.deleteUpload(uploadId).catch(() => {});
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
          state.update(old => ({ ...old, voice: null, voicePhase: '', voiceError: null, voiceBusy: false }));
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
    state.update(old => ({ ...old, voice: input, voiceError: null, voiceBusy: true }));
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
        await submitted;
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
        state.update(old => ({ ...old, voiceError: errorMessage(error) }));
        if (input.sendIntent && input.sendIntent.isVisible()) setVoiceMode(false);
        throw error;
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
    if (activeRecorder || !holdOwner.active || recordingRef.current || (holdOwner.gesture && !holdOwner.gesture.ended) ||
        currentShareOwner.current !== shareOwner || fileActionRef.current.busy ||
        state.getSnapshot().sending || state.getSnapshot().voice || awaitingInitialConversation()) return;
    const lease = {}; activeRecorder = lease; recorderLease.current = lease;
    const gesture: HoldRecording = { held: true, cancelled: false, started: false, ended: false, lease, startY: pageY,
      sendIntent: makeVoiceSendIntent() };
    holdOwner.gesture = gesture;
    setHoldActive(true); setHoldCancelled(false); setCaptureBusy(true);
    state.update(old => ({ ...old, voiceError: null }));
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
  const awaitingInitialConversation = () => !state.getSnapshot().id &&
    Array.from(state.streams.values()).some(stream => stream.intent.conversation_id === null &&
      stream.getSnapshot().phase === 'failed' && !stream.getSnapshot().conversationId);
  const submitPrepared = (automatic?: { draft: string; file: LocalFile | null }) => {
    const before = state.getSnapshot();
    const selected = before.attachment;
    const entered = before.draft.trim() || (selected && isImageFile(selected.file) ? '请描述这张图片的内容。' : '');
    const text = before.quoting ? quoteMessageText(before.quoting, entered) : entered;
    const ready = isReadableAttachment(selected);
    if (!mounted.current || currentShareOwner.current !== shareOwner ||
      voiceOwner.current.api !== api || voiceOwner.current.state !== state ||
      (state.scope && !state.scope.isRetained()) ||
      !entered || before.sending || deletingRef.current || awaitingInitialConversation() ||
      recordingRef.current || activeRecorder || (!automatic && fileActionRef.current.busy) || before.voice || !ready ||
      (automatic && (before.draft !== automatic.draft || (selected?.file ?? null) !== automatic.file))) return;
    if (Array.from(text).length > 20000) {
      fileActionRef.current.setError('引用后的消息超过 20,000 字，请缩短追问或取消引用后再发送。');
      return;
    }
    if (before.editing?.retry && before.draft === before.editing.retryDraft && selected === before.editing.retryAttachment) return before.editing.retry();
    before.editing?.discardRetry?.();
    const edit = before.editing;
    const targetIndex = edit ? before.messages.findIndex(message => message.id === edit.message.id) : -1;
    if (edit && (targetIndex < 0 || !before.id)) return;
    // Adjacent rows are not necessarily a pair when another device sends at
    // the same time. Only the server's removed_message_ids link a reply.
    const originalTurn = edit ? [before.messages[targetIndex]] : [];
    const originalIds = new Set(originalTurn.map(message => message.id));
    const requestId = newRequestId();
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
            old.messages.filter(message => !originalIds.has(message.id) && message.client_key !== userKey && message.client_key !== assistantKey)), sending: false,
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
            const error = progress.error && !before.id && !progress.conversationId
              ? `${progress.error}\n请先重试这条消息，再继续发送新消息。`
              : progress.error;
            const delivery = progress.phase === 'failed' ? 'failed' as const :
              canonical || progress.phase === 'complete' ? 'sent' as const : 'sending' as const;
            if (message.delivery === delivery && message.stream_error === error &&
              (!canonical || (message.id === canonical.id && message.content === canonical.content &&
                message.attachments === canonical.attachments))) return message;
            return { ...message, ...(canonical ?? {}), client_key: userKey,
              delivery, stream_error: error,
              attachments: canonical ? canonical.attachments : message.attachments };
          }
          if (message.client_key === assistantKey) {
            const error = progress.phase === 'failed' ? '回复中断，收到的内容已保留。' : undefined;
            if (!progress.response && message.content === progress.content &&
              message.stream_status === progress.status && message.stream_error === error &&
              (!progress.assistantId || message.id === progress.assistantId) &&
              (!progress.assistantCreatedAt || message.created_at === progress.assistantCreatedAt) &&
              (!progress.conversationId || message.conversation_id === progress.conversationId)) return message;
            return {
            ...message, ...(progress.response?.message ?? {}),
            id: progress.assistantId ?? message.id, client_key: assistantKey,
            created_at: progress.assistantCreatedAt ?? message.created_at,
            conversation_id: progress.conversationId ?? message.conversation_id,
            content: progress.content, stream_status: progress.status,
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
          sending: progress.phase !== 'complete' && progress.phase !== 'failed',
          sendError: progress.error ?? null };
      });
      if (conversationChanged && progress.conversationId) state.scope?.updateRoute(route => route.name === 'chat'
        ? { ...route, conversationId: progress.conversationId, prompt: undefined } : route);
    };
    const operation: ChatStreamController = createChatStreamController({ api,
      intent: { message: text, conversation_id: before.id ?? null,
        client_request_id: requestId, upload_ids: uploadIds, remember: false,
        ...(edit ? { replace_message_id: edit.message.id } : {}) },
      isCurrent: () => canApply() && state.streams.get(userKey) === operation,
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
    state.update(old => ({ ...old, draft: '', attachment: null, sending: true, sendError: null, voiceError: null,
      editing: null, quoting: null,
      messages: setTurn(old.messages, [userMessage, assistantMessage]),
      messageVersion: old.messageVersion + 1 }));
    return operation.start();
  };
  const send = () => {
    const before = state.getSnapshot();
    if (!before.attachment || isReadableAttachment(before.attachment)) return submitPrepared();
    if (!isImageFile(before.attachment.file) || before.voice || before.sending || recordingRef.current || activeRecorder) return;
    return fileAction.run(async ({ isCurrent }) => {
      const controller = new AbortController();
      attachmentAbort.current = controller;
      try {
        await prepareAttachment(before.attachment, controller.signal, isCurrent, text => {
          if (isCurrent()) setAttachmentPhase(text);
        });
        if (!isCurrent()) return;
        return submitPrepared({ draft: before.draft, file: before.attachment!.file });
      } finally {
        if (attachmentAbort.current === controller) attachmentAbort.current = null;
        if (isCurrent()) setAttachmentPhase('');
      }
    });
  };
  const sendDisabled =
    (!draft.trim() && !Boolean(attachment && isImageFile(attachment.file))) ||
    awaitingInitialConversation() ||
    sending || deleting ||
    recording || captureBusy ||
    Boolean(voice) ||
    fileAction.busy ||
    (!attachmentReady && !Boolean(attachment && isImageFile(attachment.file)));
  const supportMaxHeight = Math.max(64, Math.min(130, availableHeight * 0.28));
  // Keep one scaled line visible even when the keyboard reduces the viewport.
  // Live Android font changes can precede DeviceInfo's next host-resume event.
  // Read the actual scale for layout while leaving glyph metrics to EditText.
  const inputMinHeight = Math.max(
    chat.input.minHeight,
    Math.ceil(
      INPUT_LINE_ALLOWANCE * (nativeFontScale ?? fontScale) +
        chat.input.paddingTop +
        chat.input.paddingBottom,
    ),
  );
  const inputMaxHeight = Math.max(
    inputMinHeight,
    Math.min(110, availableHeight * 0.22),
  );
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
  const messageFooter = useMemo(() => (
    <View style={chat.messageFooter}>
      {id && messages.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="从这段对话发现待办"
          disabled={sending}
          style={[chat.todoDiscovery, sending && s.disabled]}
          onPress={() => navigate({ name: 'todoSources', conversationId: id })}
        >
          <Icon name="tasks" size={15} color={appearance.secondary} />
          <Text style={chat.todoDiscoveryText}>从这段对话发现待办</Text>
          <Icon name="chevronRight" size={14} color={appearance.secondary} />
        </Pressable>
      )}
    </View>
  ), [id, messages.length, navigate, sending]);
  return (
    <View
      style={[s.fill, chat.chatRoot]}
      onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}
    >
      <ChatMessageList messages={messages} viewport={state.history.viewport}
        hasOlder={history.nextOffset !== null}
        latestVersion={messageVersion} renderItem={renderMessage}
        header={messageHeader} footer={messageFooter}
        style={chat.messagePane} contentContainerStyle={chat.messages} />
      <ScrollView
        ref={composerScroll}
        testID="chat-composer-scroll"
        style={chat.composerViewport}
        contentContainerStyle={chat.composerArea}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        bounces={false}
        onLayout={event => {
          const height = event?.nativeEvent?.layout?.height;
          if (typeof height === 'number' && Number.isFinite(height) && height > 0) setComposerHeight(previous => previous === height ? previous : height);
          revealFocusedInput();
        }}
      >
        {(fileAction.error || voiceError || attachment || voice || (editing && sendError)) && (
          <ScrollView
            style={[chat.composerSupport, { maxHeight: supportMaxHeight }]}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            bounces={false}
          >
            <ErrorNotice message={voiceError ?? fileAction.error} />
            {editing && <ErrorNotice message={sendError} />}
            {editing?.retry && draft === editing.retryDraft && attachment === editing.retryAttachment && <Button variant="ghost"
              onPress={() => { if (actionOwnerCurrent(shareOwner) && !mutationBlocked()) return submitPrepared(); }}>重试修改</Button>}
            {attachmentPhase ? <Text style={chat.attachmentHint}>{attachmentPhase}</Text> : null}
            {attachment && !attachment.upload && (
              <Text style={[s.small, { fontSize: 10, marginBottom: 6 }]}>
                附件最多 25 MB。录音会自动转成文字。
              </Text>
            )}
            {voice && (
              <Card style={chat.attachmentCard}>
                <View style={[s.row, { gap: 10 }]}>
                  {voiceBusy ? (
                    <ActivityIndicator color={appearance.accent} />
                  ) : (
                    <Icon name="mic" size={20} color={appearance.accent} />
                  )}
                  <Text style={[s.body, s.fill, { fontSize: 12 }]}>
                    {voicePhase}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="取消语音转写"
                    onPress={() => {
                      if (!mounted.current || voiceOwner.current.api !== api ||
                        voiceOwner.current.state !== state ||
                        state.getSnapshot().voice?.key !== voice.key) return;
                      state.voiceRequest?.cancel();
                      state.update(old => ({ ...old, voice: null, voicePhase: '', voiceError: null, voiceBusy: false }));
                      fileAction.setError(null);
                    }}
                    style={chat.removeButton}
                  >
                    <Icon name="close" size={18} color={appearance.secondary} />
                  </Pressable>
                </View>
                {voice.text && <Text style={[s.small, { marginTop: 6 }]} numberOfLines={3}>已识别：{voice.text}</Text>}
                {!voiceBusy && !fileAction.busy && (
                  <Button
                    variant="ghost"
                    onPress={() => fileAction.run(() => convertVoice({ ...voice,
                      sendIntent: voice.sendIntent ? makeVoiceSendIntent() : undefined }))}
                  >
                    {voice.sendIntent ? voice.text ? '重试发送' : '重试识别并发送' : voice.text ? '填入文字' : '重试转写'}
                  </Button>
                )}
                {!voiceBusy && !fileAction.busy && voice.sendIntent && voice.text && <Button variant="ghost" onPress={() => fileAction.run(async () => {
                  state.voiceRequest?.release();
                  insertVoiceText(voice.text!);
                  if (voice.upload) deleteUnreferencedVoiceUpload(voice.upload.id);
                  setVoiceMode(false);
                })}>填入文字</Button>}
              </Card>
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
                  ? attachment && isImageFile(attachment.file) ? '发送时会自动上传并理解图片，也可以按住说出你的问题。' : '请先上传或移除附件，再发送消息。'
                  : attachment && isImageFile(attachment.file)
                  ? '发送时会先理解图片；若失败会保留图片和文字，便于重试。'
                  : isAudioFile(attachment.file)
                  ? '录音需完成转写后发送；也可以移除附件继续文字聊天。'
                  : '该格式已保存但暂不能解析，请移除附件后继续文字聊天。'}
              </Text>
            )}
          </ScrollView>
        )}
        {(editing || quoting) && <View style={chat.contextStrip} testID={editing ? 'chat-edit-context' : 'chat-quote-context'}>
          <View style={s.fill}>
            <Text style={chat.contextLabel}>{editing ? '修改消息' : '追问这条消息'}</Text>
            <Text numberOfLines={1} style={chat.contextExcerpt}>{(editing?.message ?? quoting)?.content}</Text>
            {editing && !attachment && (editing.message.attachments ?? []).filter(file => !editing.removedUploadIds?.includes(file.upload_id)).map(file =>
              <View key={file.upload_id} style={chat.originalAttachment}>
                <Icon name="file" size={14} color={appearance.secondary} />
                <Text numberOfLines={1} style={[chat.contextExcerpt, s.fill]}>{file.name}{file.unavailable ? '（不可用）' : ' · 会保留'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`移除原附件：${file.name}`} style={chat.removeButton}
                  disabled={sending || recording || captureBusy || Boolean(voice) || fileAction.busy || deleting}
                  onPress={() => {
                    if (!actionOwnerCurrent(shareOwner) || mutationBlocked()) return;
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
            disabled={sending || recording || captureBusy || Boolean(voice) || fileAction.busy || deleting}
            style={chat.removeButton} onPress={() => {
              if (editing) cancelEditing();
              else if (actionOwnerCurrent(shareOwner) && !mutationBlocked()) state.update(old => ({ ...old, quoting: null }));
            }}><Icon name="close" size={18} color={appearance.secondary} /></Pressable>
        </View>}
        <View
          style={chat.composer}
          testID="chat-composer-content"
          onLayout={event => {
            composerTop.current = event.nativeEvent.layout.y;
            revealFocusedInput();
          }}
        >
          <ChatModeMotion mode={voiceMode ? 'voice' : 'text'} reducedMotion={reducedMotion}>
          <View style={chat.composerRow}>
          {navigationActions}
          <Pressable accessibilityRole="button" accessibilityLabel={voiceMode ? '切换文字输入' : '切换语音输入'}
            disabled={recording || captureBusy || fileAction.busy || Boolean(voice)}
            style={chat.toolButton} onPress={toggleInputMode}>
            <Icon name={voiceMode ? 'keyboard' : 'mic'} size={23} color={appearance.secondary} />
          </Pressable>
          <TextInput
            ref={inputRef}
            accessibilityElementsHidden={voiceMode}
            importantForAccessibility={voiceMode ? 'no-hide-descendants' : 'auto'}
            accessibilityLabel="给助手的消息"
            multiline
            scrollEnabled
            maxLength={20000}
            placeholder={
              recording
                ? '正在录音，结束后继续输入…'
                : '发消息…'
            }
            placeholderTextColor={appearance.secondary}
            value={draft}
            onChangeText={setDraft}
            onContentSizeChange={refreshInputFontScale}
            onFocus={() => {
              inputFocused.current = true;
              refreshInputFontScale();
              revealFocusedInput();
            }}
            onBlur={() => {
              inputFocused.current = false;
            }}
            editable={!deleting}
            style={[
              chat.input,
              { minHeight: inputMinHeight, maxHeight: inputMaxHeight },
              voiceMode && chat.hiddenInput,
            ]}
          />
          {voiceMode && <View testID="chat-hold-to-talk" accessible={false}
            style={[chat.holdButton, holdActive && chat.holdPressed, holdActive && holdCancelled && chat.recordingCancelled]}
            onStartShouldSetResponder={() => !fileAction.busy && !sending && !voice && !deleting}
            onResponderGrant={event => beginHold(event?.nativeEvent?.pageY)}
            onResponderRelease={() => releaseHold()}
            onResponderTerminationRequest={() => true}
            onResponderTerminate={() => releaseHold(true)}
            onResponderMove={event => {
              const gesture = holdOwner.gesture;
              if (!gesture?.held || gesture.startY === undefined) return;
              gesture.cancelled = gesture.startY - event.nativeEvent.pageY > 44;
              setHoldCancelled(gesture.cancelled);
            }}
            onTouchCancel={() => releaseHold(true)}>
            <Text style={[chat.holdText, holdActive && holdCancelled && chat.cancelText]}>{holdActive ? holdCancelled ? '松开取消' : '松开发送' : '按住说话'}</Text>
          </View>}
          <View style={chat.composerActions}>
            <View style={chat.inputTools}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="选择附件"
                style={[
                  chat.toolButton,
                  (fileAction.busy || recording || sending) &&
                    s.disabled,
                ]}
                disabled={fileAction.busy || recording || captureBusy || sending || deleting}
                onPress={() =>
                  fileAction.run(async ({ isCurrent }) => {
                    const file = await platform.pickDocument();
                    if (file && isCurrent()) {
                      setAttachment({ file });
                    }
                  })
                }
              >
                <Icon name="plus" size={23} color={appearance.secondary} />
              </Pressable>
              {voiceMode && <Pressable
                accessibilityRole="button"
                accessibilityLabel={recording ? '结束录音' : '开始录音'}
                style={[
                  chat.toolButton,
                  recording && chat.recordingTool,
                  (fileAction.busy || sending) && s.disabled,
                ]}
                disabled={fileAction.busy || sending || Boolean(voice) || captureBusy || deleting}
                onPress={() =>
                  fileAction.run(async ({ isCurrent }) => {
                    if (recording) {
                      await finishRecording();
                    } else {
                      if (activeRecorder) throw new Error('上一段录音尚未结束，请稍后重试。');
                      const lease = {}; activeRecorder = lease; recorderLease.current = lease;
                      try {
                        await platform.startRecording();
                        if (!isCurrent()) {
                          await stopRecorder(lease); releaseRecorder(lease);
                          return;
                        }
                        recordingRef.current = true;
                        setSeconds(0); setRecording(true);
                      } catch (failure) {
                        releaseRecorder(lease); throw failure;
                      }
                    }
                  })
                }
              >
                {recording ? (
                  <View style={chat.stopSymbol} />
                ) : (
                  <Icon name="mic" size={21} color={appearance.secondary} />
                )}
              </Pressable>}
            </View>
            {!voiceMode && <Pressable
              accessibilityRole="button"
              accessibilityLabel={editing ? '提交修改' : '发送消息'}
              disabled={sendDisabled}
              onPress={send}
              style={[chat.sendButton, sendDisabled && chat.sendDisabled]}
            >
              {sending ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Icon
                  name="arrowUp"
                  size={23}
                  color={sendDisabled ? appearance.secondary : appearance.onAccent}
                />
              )}
            </Pressable>}
          </View>
          </View>
          </ChatModeMotion>
        </View>
      </ScrollView>
      {messageMenu?.owner === shareOwner && <ChatMessageActions anchor={messageMenu.anchor}
        timestamp={formatDate(messageMenu.message.created_at)} hasText={Boolean(messageMenu.message.content)}
        blocked={mutationBlocked()} onAction={performMessageAction} onClose={() => setMessageMenu(null)} />}
      {selection?.owner === shareOwner && <ChatTextSelection text={selection.text} onClose={() => setSelection(null)} />}
      {deleteTarget?.owner === shareOwner && <ChatDeleteConfirmation text={deleteTarget.message.content}
        busy={deleting} error={deleteError} onDelete={confirmDelete}
        onClose={() => { if (!deletingRef.current) setDeleteTarget(null); }} />}
      {recording && <ChatVoiceOverlay seconds={seconds} cancelled={holdActive && holdCancelled} holding={holdActive}
        bottom={composerHeight} availableHeight={availableHeight - composerHeight - 8}
        fontScale={nativeFontScale ?? fontScale} reducedMotion={reducedMotion} />}
    </View>
  );
}

const ChatMessage = memo(function ChatMessage({
  message,
  formatDate,
  share,
  retry,
  menu,
}: {
  message: Message;
  formatDate: (value: string) => string;
  share: (content: string) => unknown;
  retry: (key: string) => unknown;
  menu: (message: Message, anchor: MessageAnchor) => void;
}) {
  const bubbleRef = useRef<View>(null);
  const openMenu = (event?: { nativeEvent?: { pageX?: number; pageY?: number } }) => {
    if (message.delivery && message.delivery !== 'sent') return;
    const fallback = { x: event?.nativeEvent?.pageX ?? 20, y: event?.nativeEvent?.pageY ?? 100, width: 200, height: 50 };
    if (bubbleRef.current?.measureInWindow) bubbleRef.current.measureInWindow((x, y, width, height) =>
      menu(message, width > 0 && height > 0 ? { x, y, width, height } : fallback));
    else menu(message, fallback);
  };
  return message.role === 'user' ? (
    <Pressable
      ref={bubbleRef}
      testID={`chat-message-${message.client_key ?? message.id}`}
      collapsable={false}
      style={chat.userBubble}
      delayLongPress={420}
      onLongPress={openMenu}
      accessibilityLabel={`你的消息：${message.content}`}
      accessibilityHint="长按打开消息操作"
      accessibilityActions={[{ name: 'longpress', label: '消息操作' }]}
      onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'longpress') openMenu(); }}
    >
      <Text style={chat.userText}>
        {message.content}
      </Text>
      {message.delivery === 'sending' && <Text style={chat.userMeta}>发送中…</Text>}
      {message.delivery === 'failed' && <View>
        <Text style={chat.userMeta}>{message.stream_error ?? '发送未完成，已保留这条消息。'}</Text>
        <Button variant="secondary" onPress={() => retry(message.client_key ?? message.id)}>重试</Button>
      </View>}
      {(message.attachments ?? []).map(file => (
        <Text key={file.upload_id} selectable style={chat.userMeta}>
          附件：{file.name}
          {file.unavailable ? '（已删除或不可用）' : ''}
        </Text>
      ))}
    </Pressable>
  ) : (
    <View
      testID={`chat-message-${message.client_key ?? message.id}`}
      collapsable={false}
      style={chat.assistantMessage}
    >
      <View style={chat.answer}>
        {message.model_mode === 'local' && <Text style={chat.timestamp}>本地生成</Text>}
        {message.content ? <ResultText content={message.content} textStyle={chat.answerText} /> : null}
        {message.stream_status ? <View style={chat.thinking}>
          <ActivityIndicator color={appearance.accent} size="small" />
          <Text style={s.small}>{message.stream_status}</Text>
        </View> : null}
        {message.stream_error && <Text style={s.small}>{message.stream_error}</Text>}
        {!!message.content && <View style={chat.answerFooter}>
          <Text style={chat.timestamp}>{formatDate(message.created_at)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="分享这条回复"
            style={chat.shareButton}
            onPress={() => share(message.content)}
          >
            <Text style={chat.shareText}>分享</Text>
            <Icon name="arrowRight" size={14} color={appearance.secondary} />
          </Pressable>
        </View>}
      </View>
    </View>
  );
});

export function ConversationsScreen() {
  const { api, navigate, formatDate } = useApp();
  const data = usePagedList(offset => api.conversations({ offset, limit: 50 }), [api]);
  return (
    <ScrollView
      refreshControl={
        <RefreshControl
          refreshing={data.loading && data.items.length > 0}
          onRefresh={data.refresh}
        />
      }
      contentContainerStyle={s.content}
    >
      <View style={chat.conversationsHeading}>
        <View>
          <Text style={chat.conversationsTitle}>对话记录</Text>
          <Text style={chat.conversationsSubtitle}>
            接着上次的想法，继续聊。
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="开启新对话"
          style={chat.newConversation}
          onPress={() => navigate({ name: 'chat' })}
        >
          <Icon name="plus" size={21} color={historyColors.accent} />
        </Pressable>
      </View>
      <ErrorNotice message={data.error} retry={data.refresh} />
      {data.loading && !data.items.length && <Loading />}
      {data.items.length ? (
          <View style={chat.conversationList}>
            {data.items.map(item => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'继续对话：' + item.title}
                key={item.id}
                style={chat.conversationRow}
                onPress={() =>
                  navigate({ name: 'chat', conversationId: item.id })
                }
              >
                <View style={s.fill}>
                  <Text style={chat.conversationName} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text style={chat.conversationDate}>
                    {formatDate(item.updated_at)}
                  </Text>
                </View>
                <Icon name="chevronRight" size={18} color={historyColors.secondary} />
              </Pressable>
            ))}
          </View>
        ) : !data.loading && !data.error ? (
          <Empty
            symbol="✧"
            title="还没有对话记录"
            body="聊过的内容会保存在你的账号里。"
          />
        ) : null}
      {data.hasMore && <Button variant="ghost" disabled={data.loading} onPress={data.loadMore}>{data.loading ? '正在加载…' : '加载更多对话'}</Button>}
    </ScrollView>
  );
}

const chat = StyleSheet.create({
  contextStrip: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#eef0f9',
    borderLeftWidth: 3, borderLeftColor: '#5665be', paddingVertical: 10, paddingLeft: 12, paddingRight: 8, marginBottom: 8, borderRadius: 12 },
  contextLabel: { fontSize: 12, color: '#5665be', fontWeight: '500', marginBottom: 3 },
  contextExcerpt: { fontSize: 12, color: appearance.secondary, lineHeight: 19 },
  originalAttachment: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  chatRoot: { minHeight: 0, backgroundColor: appearance.background },
  messagePane: { flex: 1, minHeight: 0 },
  messages: { paddingHorizontal: 20, paddingTop: 20, flexGrow: 1 },
  messageFooter: { paddingBottom: 24 },
  todoDiscovery: {
    minHeight: 44,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  todoDiscoveryText: { fontSize: 12, color: appearance.secondary },
  welcome: { alignItems: 'flex-start', paddingTop: 40, paddingBottom: 18 },
  welcomeTitle: {
    fontSize: 21,
    lineHeight: 30,
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
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 20, width: '100%' },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: appearance.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: appearance.line,
    minHeight: 44,
    paddingVertical: 5,
    paddingHorizontal: 12,
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
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: appearance.background,
    flexShrink: 0,
  },
  composerViewport: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
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
  input: {
    flex: 1,
    fontSize: 16,
    // A fixed lineHeight leaves a stale Android CustomLineHeightSpan after a
    // live fontScale change. Native font metrics keep complete glyphs visible.
    includeFontPadding: true,
    minHeight: 44,
    maxHeight: 145,
    paddingHorizontal: 4,
    paddingTop: 9,
    paddingBottom: 9,
    color: appearance.ink,
    textAlignVertical: 'top',
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
  conversationsHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 8,
    marginBottom: 24,
  },
  conversationsTitle: {
    fontSize: 25,
    lineHeight: 35,
    color: historyColors.ink,
    fontWeight: '500',
  },
  conversationsSubtitle: {
    fontSize: 12,
    lineHeight: 20,
    color: historyColors.secondary,
    marginTop: 6,
  },
  newConversation: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: historyColors.blueLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationList: {
    backgroundColor: historyColors.surface,
    borderRadius: 23,
    overflow: 'hidden',
  },
  conversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 18,
    minHeight: 86,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: historyColors.line,
  },
  conversationName: {
    fontSize: 14,
    lineHeight: 23,
    color: historyColors.ink,
    fontWeight: '500',
  },
  conversationDate: {
    fontSize: 11,
    lineHeight: 18,
    color: historyColors.secondary,
    marginTop: 5,
  },
});

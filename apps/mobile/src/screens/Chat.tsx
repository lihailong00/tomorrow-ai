import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
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
  Pill,
} from '../ui/components';
import { ResultText } from '../ui/ResultText';
import { colors, styles as s } from '../ui/theme';
import { AssistantOrb, Icon } from '../ui/visuals';
import { ModeNotice, usePagedList } from './Main';
import { createMessageHistory, mergeMessageHistory } from './messageHistory';

type Attachment = { file: LocalFile; upload?: Upload; transcript?: string };
type VoiceInput = { key: string; file: LocalFile; upload?: Upload; text?: string };
type VoiceRequest = { cancel: () => void; release: () => void };
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
  };
  const listeners = new Set<() => void>();
  const history = createMessageHistory();
  scope?.onDispose(history.dispose);
  return {
    scope,
    history,
    voiceRequest: null as VoiceRequest | null,
    request: { key: '', id: newRequestId() },
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
  const { api, invalidate, formatDate } = useApp();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const [availableHeight, setAvailableHeight] = useState(windowHeight);
  const localState = useRef<{ api: typeof api; value: ChatEntryState } | null>(null);
  if (!localState.current || localState.current.api !== api) {
    localState.current = { api, value: createChatEntryState(conversationId, prompt) };
  }
  const state = entryState ?? localState.current.value;
  const { id, messages, draft, attachment, voice, voicePhase, voiceError, voiceBusy, sending, sendError } =
    useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const setDraft = (next: React.SetStateAction<string>) => state.update(old => ({
    ...old,
    draft: typeof next === 'function' ? next(old.draft) : next,
  }));
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
  const mounted = useRef(true);
  const voiceOwner = useRef({ api, state });
  voiceOwner.current = { api, state };
  const attachmentAbort = useRef<AbortController | null>(null);
  const recordingRef = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const scrollToLatest = useRef(!state.history.getSnapshot().initialized);
  const restoreViewport = useRef(state.history.getSnapshot().initialized);
  const composerScroll = useRef<ScrollView>(null);
  const composerTop = useRef(0);
  const inputFocused = useRef(false);
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
  const canApplyHistory = () => state.scope ? state.scope.isRetained() :
    mounted.current && voiceOwner.current.api === api && voiceOwner.current.state === state;
  const applyHistory = (items: Message[]) => state.update(old => ({
    ...old, messages: mergeMessageHistory(items, old.messages),
  }));
  const refreshHistory = () => state.history.refresh(api, initialConversationId, applyHistory, canApplyHistory);
  const loadOlder = () => state.history.older(api, id, items => {
    scrollToLatest.current = false;
    applyHistory(items);
  }, canApplyHistory);
  const capabilities = useResource(() => api.capabilities(), [api]);
  const sendAction = useAction();
  const fileAction = useAction();
  const attachmentReady =
    !attachment ||
    Boolean(
      attachment.upload &&
        (isTextFile(attachment.file) || attachment.transcript),
    );
  useEffect(() => {
    void state.history.ensure(api, initialConversationId, applyHistory, canApplyHistory);
    // History belongs to this entry; draft/recording updates must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, initialConversationId, state]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attachmentAbort.current?.abort();
      // An authorized conversion belongs to the retained route, not this mount.
      if (!state.scope?.isRetained()) state.voiceRequest?.cancel();
      state.history.dispose();
      if (recordingRef.current) {
        platform.stopRecording().catch(() => {});
      }
    };
  }, [api, state]);
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
      if (input.text) {
        insertVoiceText(input.text);
        if (upload) {
          deleteUnreferencedVoiceUpload(upload.id);
        }
        release();
        return;
      }
      if (!upload) {
        setVoicePhase('正在识别语音…');
        upload = await api.upload(input.file, controller.signal);
        if (!current()) {
          deleteUnreferencedVoiceUpload(upload.id);
          return;
        }
        setVoice({ ...input, upload });
      }
      setVoicePhase('正在转成文字…');
      const transcript = await api.transcribe(upload.id, controller.signal);
      if (!current()) {
        deleteUnreferencedVoiceUpload(upload.id);
        return;
      }
      const text = transcript.text.trim();
      if (!text) {
        throw new Error('未听清语音，请重新录制。');
      }
      recognized = text;
      insertVoiceText(text);
      // Chat dictation is plain editable text; do not attach its audio to chat.
      deleteUnreferencedVoiceUpload(upload.id);
      release();
    } catch (error) {
      if (current()) {
        setVoice({ ...input, upload, text: recognized });
        setVoicePhase(
          recognized
            ? '文字已识别，请整理输入框后再填入。'
            : '转写未完成，录音已保留，可重试或重新录制。',
        );
        state.update(old => ({ ...old, voiceError: errorMessage(error) }));
        throw error;
      }
    } finally {
      if (current()) state.update(old => ({ ...old, voiceBusy: false }));
    }
  };
  const finishRecording = async () => {
    const file = await platform.stopRecording();
    recordingRef.current = false;
    setRecording(false);
    if (file && mounted.current) {
      await convertVoice({ key: newRequestId(), file });
    }
  };
  useEffect(() => {
    if (!recording || seconds < 115) {
      return;
    }
    fileAction.run(finishRecording);
    // Recording is deliberately bounded; native adapter has its own hard limit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, seconds]);
  const send = () =>
    sendAction.run(async ({ isCurrent }) => {
      const before = state.getSnapshot();
      const text = before.draft.trim();
      const selected = before.attachment;
      const ready = !selected || Boolean(selected.upload &&
        (isTextFile(selected.file) || selected.transcript));
      if (!text || before.sending || recording || fileAction.busy || voice || !ready) {
        return;
      }
      const uploadIds =
        selected?.upload &&
        (isTextFile(selected.file) || selected.transcript)
          ? [selected.upload.id]
          : [];
      const key = JSON.stringify({ text, id: before.id, uploadIds });
      if (state.request.key !== key) {
        state.request = { key, id: newRequestId() };
      }
      const requestId = state.request.id;
      // A retained entry can complete while its screen is unmounted. Popped,
      // reset, or previous-owner entries can never publish their result.
      const canApply = () => state.scope
        ? state.scope.isRetained()
        : isCurrent();
      state.update(old => ({ ...old, sending: true, sendError: null }));
      try {
        const result = await api.chat(text, before.id, requestId, uploadIds);
        if (!canApply()) return;
        scrollToLatest.current = true;
        const userMessage: Message = result.user_message ?? {
          id: requestId,
          conversation_id: result.conversation_id,
          role: 'user',
          content: text,
          attachments:
            selected?.upload && uploadIds.length
              ? [{
                  upload_id: selected.upload.id,
                  name: selected.upload.name,
                  mime_type: selected.upload.mime_type,
                  size: selected.upload.size,
                  unavailable: false,
                }]
              : [],
          created_at: new Date().toISOString(),
        };
        state.update(old => ({
          ...old,
          id: result.conversation_id,
          messages: mergeMessageHistory(old.messages, [userMessage, result.message]),
          messageVersion: old.messageVersion + 1,
          draft: old.draft === before.draft ? '' : old.draft,
          attachment: old.attachment === before.attachment ? null : old.attachment,
          sending: false,
        }));
        state.scope?.updateRoute(current => current.name === 'chat'
          ? { ...current, conversationId: result.conversation_id, prompt: undefined }
          : current);
        if (isCurrent()) onConversationCreated?.(result.conversation_id);
        state.request = { key: '', id: newRequestId() };
        invalidate();
      } catch (failure) {
        if (canApply()) {
          state.update(old => ({ ...old, sendError: errorMessage(failure) }));
        }
      } finally {
        if (canApply()) state.update(old => ({ ...old, sending: false }));
      }
    });
  const sendDisabled =
    !draft.trim() ||
    sending ||
    recording ||
    Boolean(voice) ||
    fileAction.busy ||
    !attachmentReady;
  const supportMaxHeight = Math.max(64, Math.min(130, availableHeight * 0.28));
  // Keep one scaled line visible even when the keyboard reduces the viewport.
  // Font scaling stays native; only the input's layout allowance changes.
  const inputMinHeight = Math.max(
    chat.input.minHeight,
    Math.ceil(
      chat.input.lineHeight * fontScale +
        chat.input.paddingTop +
        chat.input.paddingBottom,
    ),
  );
  const inputMaxHeight = Math.max(
    inputMinHeight,
    Math.min(110, availableHeight * 0.22),
  );
  return (
    <View
      style={[s.fill, chat.chatRoot]}
      onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}
    >
      <ScrollView
        ref={scroll}
        style={chat.messagePane}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={chat.messages}
        // Child 0 is always the header. Native anchoring follows the same message
        // View through every layout pass, including text and keyboard reflow.
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        onScroll={event => { state.history.viewport.y = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          const viewport = state.history.viewport;
          if (messages.length > 0 && restoreViewport.current) {
            scroll.current?.scrollTo({ y: viewport.y, animated: false });
            restoreViewport.current = false;
          } else if (messages.length > 0 && scrollToLatest.current) {
            scroll.current?.scrollToEnd({ animated: true });
            scrollToLatest.current = false;
          }
        }}
      >
        <View key="history-header" testID="chat-history-header" collapsable={false}>
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
            <View style={chat.welcomeOrb}>
              <AssistantOrb size={76} />
            </View>
            <Text style={chat.welcomeTitle}>有什么想聊的？</Text>
            <Text style={chat.welcomeBody}>
              一个问题、一个想法，都可以从这里开始。
            </Text>
            <View style={chat.suggestions}>
              {[
                '帮我梳理今天的重点',
                '把一个目标拆成小步骤',
                '结合我的记忆给点建议',
              ].map(value => (
                <Pressable
                  accessibilityRole="button"
                  key={value}
                  onPress={() => setDraft(value)}
                  style={chat.suggestion}
                >
                  <Text style={chat.suggestionText}>{value}</Text>
                  <Icon name="arrowUp" size={14} color={colors.secondary} />
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
        </View>
        {messages.map(message =>
          message.role === 'user' ? (
            <View key={message.id} testID={`chat-message-${message.id}`} collapsable={false} style={chat.userBubble}>
              <Text selectable style={[s.body, { color: colors.ink }]}>
                {message.content}
              </Text>
              {(message.attachments ?? []).map(file => (
                <Text key={file.upload_id} selectable style={s.small}>
                  附件：{file.name}
                  {file.unavailable ? '（已删除或不可用）' : ''}
                </Text>
              ))}
            </View>
          ) : (
            <View key={message.id} testID={`chat-message-${message.id}`} collapsable={false} style={chat.assistantMessage}>
              <View style={chat.messageIdentity}>
                <AssistantOrb size={22} />
                <Text style={chat.assistantName}>妥啦</Text>
                {message.model_mode === 'local' && (
                  <Pill tone="neutral">本地生成</Pill>
                )}
              </View>
              <View style={chat.answer}>
                <ResultText content={message.content} />
                <View style={chat.answerFooter}>
                  <Text style={chat.timestamp}>
                    {formatDate(message.created_at)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="分享这条回复"
                    style={chat.shareButton}
                    onPress={() =>
                      fileAction.run(() => platform.share(message.content))
                    }
                  >
                    <Text style={chat.shareText}>分享</Text>
                    <Icon
                      name="arrowRight"
                      size={14}
                      color={colors.secondary}
                    />
                  </Pressable>
                </View>
              </View>
            </View>
          ),
        )}
        {sending && (
          <View style={chat.thinking}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={s.small}>正在整理思路…</Text>
          </View>
        )}
        <ErrorNotice message={sendError} />
      </ScrollView>
      <ScrollView
        ref={composerScroll}
        testID="chat-composer-scroll"
        style={chat.composerViewport}
        contentContainerStyle={chat.composerArea}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        bounces={false}
        onLayout={revealFocusedInput}
      >
        {(fileAction.error || voiceError || attachment || recording || voice) && (
          <ScrollView
            style={[chat.composerSupport, { maxHeight: supportMaxHeight }]}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            bounces={false}
          >
            <ErrorNotice message={voiceError ?? fileAction.error} />
            {attachment && !attachment.upload && (
              <Text style={[s.small, { fontSize: 10, marginBottom: 6 }]}>
                附件最多 25 MB。录音会自动转成文字。
              </Text>
            )}
            {recording && (
              <View style={chat.recordingPanel}>
                <View style={chat.recordingInfo}>
                  <View style={chat.recordingDot} />
                  <View>
                    <Text style={chat.recordingLabel}>
                      正在录音 ·{' '}
                      {String(Math.floor(seconds / 60)).padStart(2, '0')}:
                      {String(seconds % 60).padStart(2, '0')}
                    </Text>
                    <Text style={chat.recordingHint}>
                      结束后自动转成文字，确认后再发送 · 最长 120 秒
                    </Text>
                  </View>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="结束录音"
                  disabled={fileAction.busy}
                  style={chat.stopButton}
                  onPress={() => fileAction.run(finishRecording)}
                >
                  {fileAction.busy ? (
                    <ActivityIndicator size="small" color={colors.danger} />
                  ) : (
                    <Text style={chat.stopText}>结束</Text>
                  )}
                </Pressable>
              </View>
            )}
            {voice && (
              <Card style={chat.attachmentCard}>
                <View style={[s.row, { gap: 10 }]}>
                  {voiceBusy ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Icon name="mic" size={20} color={colors.accent} />
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
                    <Icon name="close" size={18} color={colors.secondary} />
                  </Pressable>
                </View>
                {!voiceBusy && !fileAction.busy && (
                  <Button
                    variant="ghost"
                    onPress={() => fileAction.run(() => convertVoice(voice))}
                  >
                    {voice.text ? '填入文字' : '重试转写'}
                  </Button>
                )}
              </Card>
            )}
            {attachment && (
              <Card style={chat.attachmentCard}>
                <View style={[s.between, { gap: 8 }]}>
                  <View style={chat.fileIcon}>
                    <Icon
                      name={isAudioFile(attachment.file) ? 'mic' : 'file'}
                      size={20}
                      color={colors.accent}
                    />
                  </View>
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
                    <Icon name="close" size={18} color={colors.secondary} />
                  </Pressable>
                </View>
                {!attachment.upload ? (
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
                  !attachment.transcript &&
                  !isAudioFile(attachment.file) && (
                    <Text
                      style={[s.small, { color: colors.amber, marginTop: 6 }]}
                    >
                      已真实保存。暂不能解析 PDF、PPT
                      或图片，不会将其作为已读资料。
                    </Text>
                  )}
                {attachment.transcript && (
                  <Text style={[s.small, { marginTop: 8 }]} numberOfLines={3}>
                    转写：{attachment.transcript}
                  </Text>
                )}
                {attachment.upload &&
                  (isTextFile(attachment.file) || attachment.transcript) && (
                    <Text style={[s.small, { marginTop: 6 }]}>
                      发送文字时，会一起提供这份资料的可读内容。
                    </Text>
                  )}
              </Card>
            )}
            {!attachmentReady && (
              <Text style={chat.attachmentHint}>
                {!attachment?.upload
                  ? '请先上传或移除附件，再发送消息。'
                  : isAudioFile(attachment.file)
                  ? '录音需完成转写后发送；也可以移除附件继续文字聊天。'
                  : '该格式已保存但暂不能解析，请移除附件后继续文字聊天。'}
              </Text>
            )}
          </ScrollView>
        )}
        <View
          style={chat.composer}
          testID="chat-composer-content"
          onLayout={event => {
            composerTop.current = event.nativeEvent.layout.y;
            revealFocusedInput();
          }}
        >
          <TextInput
            accessibilityLabel="给助手的消息"
            multiline
            scrollEnabled
            maxLength={20000}
            placeholder={
              recording
                ? '正在录音，结束后继续输入…'
                : '发消息，或说说你的想法…'
            }
            placeholderTextColor={colors.muted}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => {
              inputFocused.current = true;
              revealFocusedInput();
            }}
            onBlur={() => {
              inputFocused.current = false;
            }}
            editable={!sending}
            style={[
              chat.input,
              { minHeight: inputMinHeight, maxHeight: inputMaxHeight },
            ]}
          />
          <View style={chat.composerActions}>
            <View style={chat.inputTools}>
              {navigationActions}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="选择附件"
                style={[
                  chat.toolButton,
                  (fileAction.busy || recording || sending) &&
                    s.disabled,
                ]}
                disabled={fileAction.busy || recording || sending}
                onPress={() =>
                  fileAction.run(async ({ isCurrent }) => {
                    const file = await platform.pickDocument();
                    if (file && isCurrent()) {
                      setAttachment({ file });
                    }
                  })
                }
              >
                <Icon name="plus" size={23} color={colors.secondary} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={recording ? '结束录音' : '开始录音'}
                style={[
                  chat.toolButton,
                  recording && chat.recordingTool,
                  (fileAction.busy || sending) && s.disabled,
                ]}
                disabled={fileAction.busy || sending || Boolean(voice)}
                onPress={() =>
                  fileAction.run(async ({ isCurrent }) => {
                    if (recording) {
                      await finishRecording();
                    } else {
                      await platform.startRecording();
                      if (!isCurrent()) {
                        await platform.stopRecording().catch(() => {});
                        return;
                      }
                      recordingRef.current = true;
                      setSeconds(0);
                      setRecording(true);
                    }
                  })
                }
              >
                {recording ? (
                  <View style={chat.stopSymbol} />
                ) : (
                  <Icon name="mic" size={21} color={colors.secondary} />
                )}
              </Pressable>
              {!navigationActions && (
                <Text numberOfLines={1} style={chat.memoryHint}>
                  记忆由你主动添加
                </Text>
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送消息"
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
                  color={sendDisabled ? colors.secondary : '#FFFFFF'}
                />
              )}
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

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
          <Icon name="plus" size={21} color={colors.accent} />
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
                <Icon name="chevronRight" size={18} color={colors.secondary} />
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
  chatRoot: { minHeight: 0 },
  messagePane: { flex: 1, minHeight: 0 },
  messages: { paddingHorizontal: 24, paddingBottom: 24, flexGrow: 1 },
  welcome: { alignItems: 'center', paddingTop: 27, paddingBottom: 12 },
  welcomeOrb: { marginBottom: 19 },
  welcomeTitle: {
    fontSize: 23,
    lineHeight: 33,
    fontWeight: '500',
    color: colors.ink,
  },
  welcomeBody: {
    fontSize: 12,
    lineHeight: 21,
    color: colors.secondary,
    marginTop: 9,
    textAlign: 'center',
  },
  suggestions: { alignItems: 'center', gap: 9, marginTop: 23, width: '100%' },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    backgroundColor: colors.surface,
    borderRadius: 24,
    minHeight: 44,
    paddingVertical: 11,
    paddingHorizontal: 17,
  },
  suggestionText: { color: colors.text, fontSize: 12, lineHeight: 20 },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '90%',
    backgroundColor: colors.blueLight,
    paddingHorizontal: 17,
    paddingVertical: 13,
    borderRadius: 21,
    borderBottomRightRadius: 7,
    marginTop: 20,
  },
  assistantMessage: { marginTop: 25 },
  messageIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 13,
  },
  assistantName: { fontSize: 12, color: colors.ink, fontWeight: '500' },
  answer: { paddingLeft: 1 },
  answerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 3,
  },
  timestamp: { fontSize: 10, lineHeight: 17, color: colors.secondary },
  shareButton: {
    minWidth: 50,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  shareText: { fontSize: 11, lineHeight: 18, color: colors.secondary },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 20,
    marginBottom: 8,
  },
  composerArea: {
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 12,
    backgroundColor: colors.background,
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
    color: colors.secondary,
    textAlign: 'center',
    paddingBottom: 6,
  },
  composer: {
    flexShrink: 0,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: '#EDF0F6',
    borderRadius: 28,
    paddingHorizontal: 9,
    paddingTop: 4,
    shadowColor: '#5671AA',
    shadowOpacity: 0.07,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  input: {
    fontSize: 14,
    lineHeight: 23,
    minHeight: 51,
    maxHeight: 145,
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 10,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  composerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 7,
  },
  inputTools: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  toolButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memoryHint: {
    fontSize: 10,
    lineHeight: 17,
    color: colors.secondary,
    flex: 1,
    marginLeft: 4,
  },
  sendButton: {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendDisabled: { backgroundColor: '#EEF1F7' },
  recordingPanel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: colors.dangerLight,
    marginBottom: 10,
  },
  recordingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    flex: 1,
  },
  recordingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.danger,
  },
  recordingLabel: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.danger,
    fontWeight: '500',
  },
  recordingHint: { fontSize: 10, lineHeight: 17, color: colors.danger },
  stopButton: {
    minWidth: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  stopText: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.danger,
    fontWeight: '600',
  },
  recordingTool: { backgroundColor: colors.dangerLight },
  stopSymbol: {
    width: 13,
    height: 13,
    borderRadius: 3,
    backgroundColor: colors.danger,
  },
  attachmentCard: { padding: 12, borderRadius: 20, marginBottom: 10 },
  fileIcon: {
    width: 34,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blueLight,
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
    color: colors.ink,
    fontWeight: '500',
  },
  conversationsSubtitle: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.secondary,
    marginTop: 6,
  },
  newConversation: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.blueLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationList: {
    backgroundColor: colors.surface,
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
    borderColor: colors.line,
  },
  conversationName: {
    fontSize: 14,
    lineHeight: 23,
    color: colors.ink,
    fontWeight: '500',
  },
  conversationDate: {
    fontSize: 11,
    lineHeight: 18,
    color: colors.secondary,
    marginTop: 5,
  },
});

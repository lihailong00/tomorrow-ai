import React, { useEffect, useRef, useState } from 'react';
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
import { newRequestId } from '../api/client';
import { useAction, useApp, useResource } from '../app/context';
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
import { ModeNotice } from './Main';

type Attachment = { file: LocalFile; upload?: Upload; transcript?: string };
type VoiceInput = { file: LocalFile; upload?: Upload; text?: string };
const isTextFile = (file: LocalFile) =>
  /\.(txt|md|csv|tsv|json|log|docx|xlsx)$/i.test(file.name);
const isAudioFile = (file: LocalFile) => file.mime_type.startsWith('audio/');

export function ChatScreen({
  conversationId,
  prompt,
}: {
  conversationId?: string;
  prompt?: string;
}) {
  const { api, invalidate, formatDate } = useApp();
  const { height: windowHeight } = useWindowDimensions();
  const [availableHeight, setAvailableHeight] = useState(windowHeight);
  const [id, setId] = useState(conversationId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState(prompt ?? '');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [voice, setVoice] = useState<VoiceInput | null>(null);
  const [voicePhase, setVoicePhase] = useState('');
  const voiceGeneration = useRef(0);
  const mounted = useRef(true);
  const voiceAbort = useRef<AbortController | null>(null);
  const recordingRef = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const request = useRef({ key: '', id: newRequestId() });
  const history = useResource(
    () =>
      conversationId
        ? api.messages(conversationId)
        : Promise.resolve({ items: [] as Message[] }),
    [api, conversationId],
  );
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
    if (history.value) {
      setMessages(history.value.items);
    }
  }, [history.value]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      voiceGeneration.current += 1;
      voiceAbort.current?.abort();
      if (recordingRef.current) {
        platform.stopRecording().catch(() => {});
      }
    };
  }, []);
  useEffect(() => {
    if (!recording) {
      return;
    }
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const insertVoiceText = (text: string) => {
    if (draftRef.current.length + text.length + 1 > 20000) {
      throw new Error('文字已识别，请先缩短输入框中的内容，再点“填入文字”。');
    }
    setDraft(previous =>
      previous ? `${previous}${/\s$/.test(previous) ? '' : '\n'}${text}` : text,
    );
    setVoice(null);
    setVoicePhase('');
  };
  const convertVoice = async (input: VoiceInput) => {
    const generation = ++voiceGeneration.current;
    const current = () =>
      mounted.current && voiceGeneration.current === generation;
    const controller = new AbortController();
    voiceAbort.current = controller;
    let upload = input.upload;
    let recognized = input.text;
    setVoice(input);
    try {
      if (input.text) {
        insertVoiceText(input.text);
        if (upload) {
          api.deleteUpload(upload.id).catch(() => {});
        }
        return;
      }
      if (!upload) {
        setVoicePhase('正在识别语音…');
        upload = await api.upload(input.file, controller.signal);
        if (!current()) {
          api.deleteUpload(upload.id).catch(() => {});
          return;
        }
        setVoice({ ...input, upload });
      }
      setVoicePhase('正在转成文字…');
      const transcript = await api.transcribe(upload.id, controller.signal);
      if (!current()) {
        api.deleteUpload(upload.id).catch(() => {});
        return;
      }
      const text = transcript.text.trim();
      if (!text) {
        throw new Error('未听清语音，请重新录制。');
      }
      recognized = text;
      insertVoiceText(text);
      // Chat dictation is plain editable text; do not attach its audio to chat.
      api.deleteUpload(upload.id).catch(() => {});
    } catch (error) {
      if (current()) {
        setVoice({ ...input, upload, text: recognized });
        setVoicePhase(
          recognized
            ? '文字已识别，请整理输入框后再填入。'
            : '转写未完成，录音已保留，可重试或重新录制。',
        );
        throw error;
      }
    } finally {
      if (voiceAbort.current === controller) {
        voiceAbort.current = null;
      }
    }
  };
  const finishRecording = async () => {
    const file = await platform.stopRecording();
    recordingRef.current = false;
    setRecording(false);
    if (file && mounted.current) {
      await convertVoice({ file });
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
    sendAction.run(async () => {
      const text = draft.trim();
      if (!text || recording || fileAction.busy || voice || !attachmentReady) {
        return;
      }
      const uploadIds =
        attachment?.upload &&
        (isTextFile(attachment.file) || attachment.transcript)
          ? [attachment.upload.id]
          : [];
      const key = JSON.stringify({ text, id, uploadIds });
      if (request.current.key !== key) {
        request.current = { key, id: newRequestId() };
      }
      const result = await api.chat(text, id, request.current.id, uploadIds);
      setMessages(old => [
        ...old,
        {
          id: request.current.id,
          conversation_id: result.conversation_id,
          role: 'user',
          content:
            text +
            (uploadIds.length ? '\n\n附件：' + attachment?.file.name : ''),
          created_at: new Date().toISOString(),
        },
        result.message,
      ]);
      setId(result.conversation_id);
      setDraft('');
      setAttachment(null);
      request.current = { key: '', id: newRequestId() };
      invalidate();
    });
  const sendDisabled =
    !draft.trim() ||
    sendAction.busy ||
    recording ||
    Boolean(voice) ||
    fileAction.busy ||
    !attachmentReady;
  const supportMaxHeight = Math.max(64, Math.min(130, availableHeight * 0.28));
  const inputMaxHeight = Math.max(51, Math.min(110, availableHeight * 0.22));
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
        onContentSizeChange={() =>
          messages.length > 0 && scroll.current?.scrollToEnd({ animated: true })
        }
      >
        <ErrorNotice message={history.error} retry={history.refresh} />
        <ErrorNotice
          message={capabilities.error}
          retry={capabilities.refresh}
        />
        {history.loading && conversationId && (
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
        {messages.map(message =>
          message.role === 'user' ? (
            <View key={message.id} style={chat.userBubble}>
              <Text selectable style={[s.body, { color: colors.ink }]}>
                {message.content}
              </Text>
            </View>
          ) : (
            <View key={message.id} style={chat.assistantMessage}>
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
        {sendAction.busy && (
          <View style={chat.thinking}>
            <ActivityIndicator color={colors.accent} size="small" />
            <Text style={s.small}>正在整理思路…</Text>
          </View>
        )}
        <ErrorNotice message={sendAction.error} />
      </ScrollView>
      <View style={chat.composerArea}>
        {(fileAction.error || attachment || recording || voice) && (
          <ScrollView
            style={[chat.composerSupport, { maxHeight: supportMaxHeight }]}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
            bounces={false}
          >
            <ErrorNotice message={fileAction.error} />
            {attachment && !attachment.upload && (
              <Text style={[s.small, { fontSize: 10, marginBottom: 6 }]}>
                附件最多 20 MB。录音会自动转成文字。
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
                  {fileAction.busy ? (
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
                      voiceGeneration.current += 1;
                      voiceAbort.current?.abort();
                      const upload = voice.upload;
                      setVoice(null);
                      setVoicePhase('');
                      fileAction.setError(null);
                      if (upload) {
                        api.deleteUpload(upload.id).catch(() => {});
                      }
                    }}
                    style={chat.removeButton}
                  >
                    <Icon name="close" size={18} color={colors.secondary} />
                  </Pressable>
                </View>
                {!fileAction.busy && (
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
                      fileAction.run(async () => {
                        const upload = await api.upload(attachment.file);
                        setAttachment(old =>
                          old && old.file.uri === attachment.file.uri
                            ? { ...old, upload }
                            : old,
                        );
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
                      fileAction.run(async () => {
                        const transcript = await api.transcribe(
                          attachment.upload!.id,
                        );
                        setAttachment(old =>
                          old ? { ...old, transcript: transcript.text } : old,
                        );
                        if (!draft.trim()) {
                          setDraft('请整理这段录音的主要内容。');
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
        <View style={chat.composer}>
          <TextInput
            accessibilityLabel="给助手的消息"
            multiline
            maxLength={20000}
            placeholder={
              recording
                ? '正在录音，结束后继续输入…'
                : '发消息，或说说你的想法…'
            }
            placeholderTextColor={colors.muted}
            value={draft}
            onChangeText={setDraft}
            editable={!sendAction.busy}
            style={[chat.input, { maxHeight: inputMaxHeight }]}
          />
          <View style={chat.composerActions}>
            <View style={chat.inputTools}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="选择附件"
                style={[
                  chat.toolButton,
                  (fileAction.busy || recording || sendAction.busy) &&
                    s.disabled,
                ]}
                disabled={fileAction.busy || recording || sendAction.busy}
                onPress={() =>
                  fileAction.run(async () => {
                    const file = await platform.pickDocument();
                    if (file) {
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
                  (fileAction.busy || sendAction.busy) && s.disabled,
                ]}
                disabled={fileAction.busy || sendAction.busy || Boolean(voice)}
                onPress={() =>
                  fileAction.run(async () => {
                    if (recording) {
                      await finishRecording();
                    } else {
                      await platform.startRecording();
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
              <Text numberOfLines={1} style={chat.memoryHint}>
                记忆由你主动添加
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="发送消息"
              disabled={sendDisabled}
              onPress={send}
              style={[chat.sendButton, sendDisabled && chat.sendDisabled]}
            >
              {sendAction.busy ? (
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
      </View>
    </View>
  );
}

export function ConversationsScreen() {
  const { api, navigate, formatDate } = useApp();
  const data = useResource(() => api.conversations(), [api]);
  return (
    <ScrollView
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(data.value)}
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
      {data.loading && !data.value && <Loading />}
      {data.value &&
        (data.value.items.length ? (
          <View style={chat.conversationList}>
            {data.value.items.map(item => (
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
        ) : (
          <Empty
            symbol="✧"
            title="还没有对话记录"
            body="聊过的内容会保存在你的账号里。"
          />
        ))}
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
    flexShrink: 1,
    minHeight: 0,
  },
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

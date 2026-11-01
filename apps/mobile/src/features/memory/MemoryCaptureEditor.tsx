import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useAction, useApp } from '../../app/context';
import { newRequestId } from '../../api/client';
import type { Memory } from '../../domain/types';
import {
  UnifiedInputBar,
  UnifiedAttachmentMenu,
} from '../../ui/UnifiedInputBar';
import { ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { AssistantOrb, Icon } from '../../ui/visuals';
import { chatAppearance as colors } from '../../ui/ChatAppearance';
import { suggestedMemoryKind } from './memoryModel';
import { useMemoryCapture } from './useMemoryCapture';

interface MemoryCaptureEditorProps {
  memory?: Memory;
  onSaved: (memory: Memory) => void;
  onBusyChange?: (busy: boolean) => void;
  onDeleted?: () => void;
  embedded?: boolean;
}

export function MemoryCaptureEditor(props: MemoryCaptureEditorProps) {
  const { api } = useApp();
  const scopeKey = useMemo(() => newRequestId(), [api, props.memory?.id]);
  return <MemoryCaptureBody key={scopeKey} {...props} />;
}

function MemoryCaptureBody({
  memory,
  onSaved,
  onBusyChange,
  onDeleted,
  embedded = false,
}: MemoryCaptureEditorProps) {
  const { api, invalidate } = useApp();
  const [content, setContent] = useState(memory?.content ?? '');
  const [voiceMode, setVoiceMode] = useState(!memory);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [saved, setSaved] = useState<Memory | null>(null);
  const [notice, setNotice] = useState('');
  const requestId = useRef(newRequestId());
  const record = useRef(memory);
  const beforeSave = useRef<Memory | undefined>(memory);
  const existing = record.current;
  const inputRef = useRef<TextInput>(null);
  const focusInput = useRef(false);
  const action = useAction();
  const capture = useMemoryCapture(content, setContent);
  const busy = action.busy || capture.busy;
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!voiceMode && focusInput.current) {
      focusInput.current = false;
      inputRef.current?.focus();
    }
  }, [voiceMode]);
  const textMode = () => {
    focusInput.current = true;
    setVoiceMode(false);
    if (!voiceMode) inputRef.current?.focus();
  };
  const toggleMode = () => {
    if (busy) return;
    if (voiceMode) textMode();
    else {
      inputRef.current?.blur();
      Keyboard.dismiss();
      setVoiceMode(true);
    }
  };
  const save = () => {
    if (busy || !content.trim()) return;
    action.run(async ({ isCurrent }) => {
      const text = content.trim();
      const target = record.current;
      const result = await api.saveMemory(
        {
          content: text,
          title: [...text].slice(0, 40).join(''),
          kind: target?.kind ?? suggestedMemoryKind(text),
          ...(target
            ? { version: target.version }
            : { source: '用户主动添加', client_request_id: requestId.current }),
        },
        target?.id,
      );
      if (!isCurrent()) return;
      beforeSave.current = target;
      record.current = result;
      Keyboard.dismiss();
      invalidate();
      setSaved(result);
      setNotice('');
    });
  };
  const undo = () => {
    if (!saved || action.busy) return;
    action.run(async ({ isCurrent }) => {
      const previous = beforeSave.current;
      const restored = previous
        ? await api.saveMemory(
            {
              title: previous.title,
              content: previous.content,
              kind: previous.kind,
              version: saved.version,
            },
            previous.id,
          )
        : undefined;
      if (!previous) await api.deleteMemory(saved.id);
      if (!isCurrent()) return;
      record.current = restored;
      if (!previous) requestId.current = newRequestId();
      if (previous) setContent(previous.content);
      invalidate();
      setSaved(null);
      setNotice(previous ? '已恢复原来的记忆。' : '已撤销，还没有记住这件事。');
    });
  };
  return (
    <View style={[m.container, embedded && m.embedded]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={m.scroll}
        contentContainerStyle={m.content}
      >
        {saved ? (
          <>
            <View style={m.success} accessibilityLiveRegion="polite">
              <AssistantOrb size={68} />
              <Text style={m.title}>记住了</Text>
              <Text style={m.subtitle}>
                以后遇到相关的事，我会把这一点放在心上。
              </Text>
            </View>
            <View style={m.card}>
              <View style={m.row}>
                <Icon name="check" size={16} color={colors.accent} />
                <Text style={[m.note, m.flex]}>我记下的是</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="修改记忆"
                  disabled={busy}
                  onPress={() => {
                    setContent(saved.content);
                    setSaved(null);
                  }}
                  style={m.editButton}
                >
                  <Text style={m.editText}>修改</Text>
                </Pressable>
              </View>
              <Text style={m.preview}>{saved.content}</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="完成记忆保存"
              disabled={busy}
              onPress={() => onSaved(saved)}
              style={m.done}
            >
              <Text style={m.doneText}>完成</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="撤销这次保存"
              disabled={busy}
              onPress={undo}
              style={m.secondary}
            >
              <Text style={m.note}>撤销这次保存</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={m.heading}>
              <View style={m.row}>
                <Icon name="memory" size={15} color={colors.secondary} />
                <Text style={m.note}>更懂你一点</Text>
              </View>
              <Text style={m.title}>
                {existing ? '有什么想改的？' : '想让我记住什么？'}
              </Text>
              <Text style={m.subtitle}>说一句就好，我帮你记下来。</Text>
            </View>
            <View style={m.card}>
              {capture.recording || capture.phase ? (
                <View style={m.placeholder}>
                  {capture.recording ? (
                    <Icon
                      name="mic"
                      size={32}
                      color={
                        capture.cancelled
                          ? colors.cancellationText
                          : colors.accent
                      }
                    />
                  ) : (
                    <ActivityIndicator color={colors.accent} />
                  )}
                  <Text style={m.captureText}>
                    {capture.recording
                      ? capture.cancelled
                        ? '松开取消'
                        : '松开，转成文字'
                      : capture.phase}
                  </Text>
                  {capture.recording && (
                    <Text style={m.note}>
                      {`${Math.floor(capture.seconds / 60)}`.padStart(2, '0')}:
                      {`${capture.seconds % 60}`.padStart(2, '0')} · 上滑取消
                    </Text>
                  )}
                </View>
              ) : content.trim() ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="修改准备记住的文字"
                  onPress={textMode}
                  style={m.previewTarget}
                >
                  <Text style={m.preview}>{content}</Text>
                </Pressable>
              ) : (
                <View style={m.placeholder}>
                  <Text style={m.note}>比如，你可以这样说</Text>
                  <Text style={m.example}>
                    我上午更专注，{'\n'}重要的事情尽量放在午饭前。
                  </Text>
                </View>
              )}
              <View style={m.cardFoot}>
                <Icon name="sparkles" size={14} color={colors.secondary} />
                <Text style={[m.note, m.flex]}>
                  {content.trim() ? '点文字可以修改' : '不用分类，也不用起名字'}
                </Text>
                {!!content.trim() && !capture.busy && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={existing ? '保存修改' : '记住这件事'}
                    disabled={busy}
                    onPress={save}
                    style={m.confirm}
                  >
                    {action.busy ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <>
                        <Text style={m.confirmText}>
                          {existing ? '更新' : '记住'}
                        </Text>
                        <Icon
                          name="arrowRight"
                          size={15}
                          color={colors.onAccent}
                        />
                      </>
                    )}
                  </Pressable>
                )}
              </View>
            </View>
            {!!notice && (
              <Text accessibilityLiveRegion="polite" style={m.notice}>
                {notice}
              </Text>
            )}
            {!!capture.error && (
              <ErrorNotice
                message={capture.error}
                retry={busy ? undefined : capture.retry}
              />
            )}
            {!!capture.phase && !capture.recording && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消识别"
                onPress={capture.cancel}
                style={m.secondary}
              >
                <Text style={m.note}>取消识别</Text>
              </Pressable>
            )}
          </>
        )}
        <ErrorNotice message={action.error} />
        {action.error?.includes('刷新') && (
          <Text style={m.notice}>
            输入已保留；请返回刷新后，按最新版本修改。
          </Text>
        )}
        {!saved && existing && onDeleted && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="删除这条记忆"
            disabled={busy}
            style={m.secondary}
            onPress={() =>
              Alert.alert(
                '忘记这件事？',
                '之后不再用于新的回答，原始会话会保留。',
                [
                  { text: '保留', style: 'cancel' },
                  {
                    text: '忘记',
                    style: 'destructive',
                    onPress: () =>
                      action.run(async ({ isCurrent }) => {
                        await api.deleteMemory(existing.id);
                        if (isCurrent()) {
                          invalidate();
                          onDeleted();
                        }
                      }),
                  },
                ],
              )
            }
          >
            <Text style={m.note}>忘记这件事</Text>
          </Pressable>
        )}
      </ScrollView>
      {!saved && (
        <View style={m.inputArea}>
          <UnifiedInputBar
            voiceMode={voiceMode}
            value={content}
            onChangeText={setContent}
            onToggleMode={toggleMode}
            onCamera={() => {
              void capture.choose('camera');
            }}
            onAttach={() => setAttachmentMenu(true)}
            onSend={save}
            sendDisabled={busy || !content.trim()}
            toolsDisabled={busy}
            sending={action.busy}
            holding={capture.recording}
            recording={capture.recording}
            cancelled={capture.cancelled}
            voiceBusy={Boolean(capture.phase)}
            voiceLabel={
              capture.recording
                ? capture.cancelled
                  ? '松开取消'
                  : '松开转文字'
                : capture.phase
                ? '识别中…'
                : '按住说话'
            }
            onAccessibleRecord={() => {
              if (!action.busy) capture.toggle();
            }}
            holdTestID="memory-hold-to-talk"
            voiceHint="按住说话，松开转成文字，确认后再记住；向上滑动取消。也可以双击开始、再双击结束。"
            finishRecordingLabel="结束录音并转成文字"
            sendLabel={existing ? '保存修改' : '记住这件事'}
            inputRef={inputRef}
            inputProps={{
              accessibilityLabel: '你希望我记住什么',
              maxLength: 10000,
              placeholder: '想让我记住…',
              editable: !busy,
              onSubmitEditing: save,
              blurOnSubmit: false,
            }}
            holdHandlers={{
              onStartShouldSetResponder: () => !busy,
              onResponderGrant: event => {
                if (!action.busy) capture.begin(event.nativeEvent.pageY);
              },
              onResponderMove: event => capture.move(event.nativeEvent.pageY),
              onResponderRelease: () => capture.release(),
              onResponderTerminate: () => capture.release(true),
              onResponderTerminationRequest: () => true,
              onTouchCancel: () => capture.release(true),
            }}
          />
        </View>
      )}
      <UnifiedAttachmentMenu
        visible={attachmentMenu}
        onClose={() => setAttachmentMenu(false)}
        onImage={() => {
          void capture.choose('image');
        }}
        onFile={() => {
          void capture.choose('file');
        }}
      />
    </View>
  );
}

const m = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  embedded: { flex: undefined, flexShrink: 1 },
  scroll: { flexShrink: 1, flexGrow: 0 },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 22 },
  heading: { marginBottom: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: {
    fontSize: 27,
    lineHeight: 39,
    fontWeight: '500',
    color: colors.ink,
    marginTop: 11,
    marginBottom: 8,
  },
  subtitle: { fontSize: 14, lineHeight: 25, color: colors.secondary },
  card: {
    padding: 18,
    borderRadius: 23,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  placeholder: {
    minHeight: 159,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  note: { color: colors.secondary, fontSize: 11, lineHeight: 20 },
  example: {
    color: colors.secondary,
    fontSize: 17,
    lineHeight: 31,
    textAlign: 'center',
  },
  previewTarget: { minHeight: 150 },
  preview: { color: colors.ink, fontSize: 16, lineHeight: 29 },
  cardFoot: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
  },
  flex: { flex: 1, minWidth: 0 },
  confirm: {
    minHeight: 44,
    borderRadius: 23,
    paddingHorizontal: 17,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    backgroundColor: colors.accent,
  },
  confirmText: { color: colors.onAccent, fontSize: 13, fontWeight: '500' },
  inputArea: { marginTop: 'auto', padding: 10, paddingTop: 0 },
  captureText: { fontSize: 16, lineHeight: 27, color: colors.accent },
  success: { alignItems: 'center', paddingVertical: 22, gap: 4 },
  done: {
    marginTop: 24,
    minHeight: 53,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneText: { color: colors.onAccent, fontSize: 16, fontWeight: '500' },
  secondary: {
    minHeight: 44,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 5,
  },
  notice: {
    fontSize: 12,
    lineHeight: 22,
    color: colors.secondary,
    paddingVertical: 8,
  },
  editButton: { minHeight: 44, paddingHorizontal: 7, justifyContent: 'center' },
  editText: { fontSize: 13, color: colors.accent },
});

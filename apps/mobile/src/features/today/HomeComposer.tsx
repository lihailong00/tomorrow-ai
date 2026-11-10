import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { errorMessage } from '../../api/client';
import { useAction, useApp, type InitialChatInput } from '../../app/context';
import { isAudioFile, isImageFile, isTextFile, pickChatAttachment, type ChatAttachmentSource } from '../../platform/chatAttachments';
import { platform, type LocalFile } from '../../platform/ports';
import { recordingSession, releaseRecorder, stopRecorder } from '../../platform/recordingSession';
import { chatAppearance } from '../../ui/ChatAppearance';
import { ChatAttachmentPanel } from '../../ui/ChatAttachmentPanel';
import { ChatModeMotion, useChatReducedMotion } from '../../ui/ChatMotion';
import { ChatVoiceOverlay } from '../../ui/ChatVoiceOverlay';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { composerTextLayout, UnifiedInputBar, type InputHoldHandlers } from '../../ui/UnifiedInputBar';
import { Icon } from '../../ui/visuals';

type Hold = {
  startY?: number;
  startX?: number;
  phase: 'waiting' | 'starting' | 'recording' | 'finishing';
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export type HomeComposerDraft = { text: string; file: LocalFile | null; voiceMode: boolean };

export function HomeComposer({ savedDraft }: { savedDraft: HomeComposerDraft }) {
  const { navigate, preferences } = useApp();
  const reviewTranscript = preferences?.reviewVoiceTranscript === true;
  const [draft, setDraft] = useState(savedDraft.text);
  const [file, setFile] = useState(savedDraft.file);
  const [voiceMode, setVoiceMode] = useState(savedDraft.voiceMode);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [status, setStatus] = useState<'idle' | 'starting' | 'recording' | 'finishing'>('idle');
  const [cancelled, setCancelled] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(76);
  const input = useRef<TextInput>(null);
  const focusAfterModeChange = useRef(false);
  const hold = useRef<Hold | null>(null);
  const handedOff = useRef(false);
  const mounted = useRef(true);
  const { width, height: windowHeight, fontScale } = useWindowDimensions();
  const reducedMotion = useChatReducedMotion();
  const picker = useAction();
  const busy = status !== 'idle' || picker.busy;

  const enterChat = useCallback((initialInput: InitialChatInput) => {
    if (handedOff.current) return;
    handedOff.current = true;
    savedDraft.text = '';
    savedDraft.file = null;
    Keyboard.dismiss();
    navigate({ name: 'chat', initialInput });
  }, [navigate, savedDraft]);

  const reset = useCallback((gesture: Hold) => {
    if (gesture.timer !== undefined) clearTimeout(gesture.timer);
    releaseRecorder(gesture);
    if (hold.current !== gesture) return;
    hold.current = null;
    if (mounted.current) setStatus('idle');
  }, []);

  const finish = useCallback(async (gesture: Hold) => {
    if (gesture.phase !== 'recording') return;
    gesture.phase = 'finishing';
    if (gesture.timer !== undefined) clearTimeout(gesture.timer);
    if (mounted.current) setStatus('finishing');
    try {
      const file = await stopRecorder(gesture);
      if (!mounted.current || gesture.cancelled) return;
      if (!file) {
        setError('这次没有录到声音，请再按住说话。');
        return;
      }
      releaseRecorder(gesture);
      enterChat({
        text: savedDraft.text, attachment: savedDraft.file ?? undefined, recording: file, voiceMode: true,
      });
    } catch (failure) {
      if (mounted.current && !gesture.cancelled) setError(errorMessage(failure));
    } finally {
      reset(gesture);
    }
  }, [enterChat, reset, savedDraft]);

  const cancelHold = useCallback(() => {
    const gesture = hold.current;
    if (!gesture) return;
    gesture.cancelled = true;
    if (gesture.phase === 'waiting') reset(gesture);
    else if (gesture.phase === 'recording') void finish(gesture);
  }, [finish, reset]);

  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', next => {
      if (next !== 'active') cancelHold();
    });
    return () => {
      mounted.current = false;
      listener.remove();
      cancelHold();
    };
  }, [cancelHold]);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setSeconds(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (!attachmentMenu) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { setAttachmentMenu(false); return true; });
    return () => back.remove();
  }, [attachmentMenu]);

  useEffect(() => {
    if (!voiceMode && focusAfterModeChange.current) {
      focusAfterModeChange.current = false;
      input.current?.focus();
    }
  }, [voiceMode]);

  const audio = Boolean(file && isAudioFile(file));
  const image = Boolean(file && isImageFile(file));
  const toggleInputMode = () => {
    if (busy || audio || hold.current || handedOff.current) return;
    setAttachmentMenu(false);
    focusAfterModeChange.current = voiceMode;
    if (!voiceMode) {
      input.current?.blur();
      Keyboard.dismiss();
    }
    savedDraft.voiceMode = !voiceMode;
    setVoiceMode(!voiceMode);
  };

  const chooseFile = (source: ChatAttachmentSource) => {
    if (busy || hold.current || handedOff.current) return;
    setAttachmentMenu(false);
    setError('');
    Keyboard.dismiss();
    return picker.run(async ({ isCurrent }) => {
      const chosen = await pickChatAttachment(source);
      if (!chosen || !isCurrent()) return;
      if (chosen.size !== undefined && chosen.size > 25 * 1024 * 1024)
        throw new Error('附件最多 25 MB，请选择更小的文件。');
      if (!isImageFile(chosen) && !isTextFile(chosen) && !isAudioFile(chosen))
        throw new Error('聊天暂时无法读取这种文件，请选择 JPG、PNG、文本、Word、Excel 或录音。');
      savedDraft.file = chosen;
      setFile(chosen);
      if (isAudioFile(chosen)) {
        savedDraft.voiceMode = false;
        setVoiceMode(false);
      }
    });
  };

  const canRecord = () => !busy && !audio && !hold.current && !handedOff.current;
  const start = async (gesture: Hold) => {
    if (recordingSession.active) {
      reset(gesture);
      setError('麦克风正在使用，请稍后再试。');
      return;
    }
    recordingSession.active = gesture;
    gesture.phase = 'starting';
    setError('');
    setCancelled(false);
    setStatus('starting');
    setAttachmentMenu(false);
    Keyboard.dismiss();
    try {
      await platform.startRecording();
      gesture.phase = 'recording';
      if (!mounted.current || gesture.cancelled) {
        await finish(gesture);
        return;
      }
      setSeconds(0);
      setStatus('recording');
      gesture.timer = setTimeout(() => { void finish(gesture); }, 115_000);
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
      reset(gesture);
    }
  };

  const holdHandlers: InputHoldHandlers = {
    onStartShouldSetResponder: canRecord,
    onResponderGrant: ({ nativeEvent }) => {
      if (!canRecord()) return;
      const gesture: Hold = {
        phase: 'waiting', cancelled: false, startX: nativeEvent.pageX, startY: nativeEvent.pageY,
      };
      hold.current = gesture;
      gesture.timer = setTimeout(() => { void start(gesture); }, 160);
    },
    onResponderMove: ({ nativeEvent }) => {
      const gesture = hold.current;
      if (gesture?.startY === undefined || gesture.startX === undefined) return;
      if (gesture.phase === 'waiting') {
        if (Math.hypot(nativeEvent.pageY - gesture.startY, nativeEvent.pageX - gesture.startX) > 12) reset(gesture);
        return;
      }
      if (gesture.phase === 'finishing') return;
      gesture.cancelled = gesture.startY - nativeEvent.pageY > 44;
      setCancelled(gesture.cancelled);
    },
    onResponderRelease: () => {
      const gesture = hold.current;
      if (!gesture) return;
      if (gesture.phase === 'waiting') {
        reset(gesture);
      } else if (gesture.phase === 'starting') {
        // Do not send a clip that started after permission or touch release.
        gesture.cancelled = true;
      } else {
        void finish(gesture);
      }
    },
    onResponderTerminationRequest: () => true,
    onResponderTerminate: cancelHold,
    onTouchCancel: cancelHold,
  };

  const submit = () => {
    const text = savedDraft.text.trim();
    if ((!text && !image && !audio) || busy || hold.current || handedOff.current) return;
    enterChat(audio && file ? { text, recording: file } : { text, attachment: file ?? undefined });
  };
  const recording = status === 'recording';
  const visibleError = picker.error ?? error;
  const { expandedText, inputStyle } = composerTextLayout(draft, voiceMode, Boolean(file), width, windowHeight, fontScale);

  return (
    <View style={styles.dock} onLayout={event => setHeight(event.nativeEvent.layout.height)}>
      {visibleError ? <Text accessibilityLiveRegion="polite" style={styles.error}>{visibleError}</Text> : null}
      {file && !recording && (
        <View style={styles.attachment}>
          {image ? <Image source={{ uri: file.uri }} accessibilityLabel="所选图片预览" style={styles.thumbnail} />
            : <Icon name={audio ? 'mic' : 'file'} color={colors.accent} size={22} />}
          <View style={styles.fileInfo}>
            <Text style={styles.fileName} numberOfLines={1}>{file.name}</Text>
            <Text style={styles.fileHint}>
              {audio ? '发送后转成文字' : !draft.trim() && !image ? '写一句你想问的，再发送' : '发送后处理'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="移除附件" style={styles.remove}
            disabled={busy} onPress={() => {
              savedDraft.file = null;
              setFile(null);
              picker.setError(null);
            }}>
            <Icon name="close" size={18} color={colors.secondary} />
          </Pressable>
        </View>
      )}
      <ChatModeMotion mode={voiceMode ? 'voice' : 'text'} reducedMotion={reducedMotion}>
        <UnifiedInputBar voiceMode={voiceMode} value={draft}
          onChangeText={text => { savedDraft.text = text; setDraft(text); }}
          expandedText={expandedText} inputStyle={inputStyle} inputRef={input}
          inputProps={{ accessibilityLabel: '首页消息', placeholder: '发消息…', maxLength: 20000,
            scrollEnabled: true, editable: status === 'idle', onFocus: () => setAttachmentMenu(false) }}
          onToggleMode={toggleInputMode} onCamera={() => chooseFile('camera')}
          onAttach={() => {
            if (!attachmentMenu) Keyboard.dismiss();
            setAttachmentMenu(open => !open);
          }}
          attachmentsExpanded={attachmentMenu} animatedVoiceCue reducedMotion={reducedMotion !== false}
          onSend={submit} hasPayload={Boolean(file)} sendDisabled={busy || (!draft.trim() && !image && !audio)}
          toolsDisabled={busy} modeDisabled={busy || audio} holdTestID="home-hold-to-talk" holdHandlers={holdHandlers}
          compactRecording={recording} holding={recording} cancelled={cancelled}
          voiceBusy={status === 'starting' || status === 'finishing'}
          voiceLabel={status === 'starting' ? '正在打开麦克风…' : status === 'finishing' ? '正在处理录音…' : undefined}
          reviewVoiceTranscript={reviewTranscript} finishRecordingLabel={reviewTranscript ? '结束录音并转成文字' : undefined}
          onAccessibleRecord={() => {
            if (hold.current) void finish(hold.current);
            else if (canRecord()) {
              const gesture: Hold = { phase: 'waiting', cancelled: false };
              hold.current = gesture;
              void start(gesture);
            }
          }}
        />
      </ChatModeMotion>
      {attachmentMenu && !recording && <ChatAttachmentPanel disabled={busy}
        onCamera={() => chooseFile('camera')} onImage={() => chooseFile('image')}
        onFile={() => chooseFile('file')} onRecent={recentId => chooseFile({ recentId })} />}
      {recording && (
        <ChatVoiceOverlay seconds={seconds} cancelled={cancelled} holding
          composerHeight={height} availableHeight={windowHeight} fontScale={fontScale}
          reducedMotion={reducedMotion} reviewVoiceTranscript={reviewTranscript} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 5 },
  attachment: {
    flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 18, paddingLeft: 12,
    paddingVertical: 4, marginBottom: 8, backgroundColor: chatAppearance.surface,
  },
  thumbnail: { width: 38, height: 38, borderRadius: 10 },
  fileInfo: { flex: 1 },
  fileName: { color: colors.ink, fontSize: 13 },
  fileHint: { color: colors.secondary, fontSize: 11 },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  error: { color: colors.danger, paddingBottom: 6 },
});

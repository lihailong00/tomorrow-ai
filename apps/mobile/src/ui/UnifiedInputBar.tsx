import React, { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewProps,
} from 'react-native';
import { Text } from './Text';
import { Icon } from './visuals';
import { chatAppearance as colors } from './ChatAppearance';

const INPUT_VERTICAL_PADDING = 9;

export function composerTextLayout(
  draft: string, voiceMode: boolean, hasAttachment: boolean, width: number, height: number, fontScale: number,
) {
  const longDraft = !voiceMode && (draft.trim().length >= 24 || draft.includes('\n'));
  const minHeight = Math.max(44, Math.ceil(23 * fontScale + 2 * INPUT_VERTICAL_PADDING));
  return {
    expandedText: longDraft || (!voiceMode && width < 380 && (Boolean(draft.trim()) || hasAttachment)),
    inputStyle: {
      minHeight,
      maxHeight: Math.max(minHeight, longDraft ? Math.min(144, height * 0.32) : Math.min(110, height * 0.22)),
    },
  };
}

export type InputHoldHandlers = Pick<
  ViewProps,
  | 'onStartShouldSetResponder'
  | 'onResponderGrant'
  | 'onResponderMove'
  | 'onResponderRelease'
  | 'onResponderTerminate'
  | 'onResponderTerminationRequest'
  | 'onTouchCancel'
>;

export interface UnifiedInputBarProps {
  reviewVoiceTranscript?: boolean;
  expandedText?: boolean;
  voiceMode: boolean;
  value: string;
  onChangeText: (text: string) => void;
  onToggleMode: () => void;
  onCamera: () => void;
  onAttach: () => void;
  attachmentsExpanded?: boolean;
  animatedVoiceCue?: boolean;
  reducedMotion?: boolean;
  onSend: () => void;
  sendDisabled?: boolean;
  toolsDisabled?: boolean;
  modeDisabled?: boolean;
  sending?: boolean;
  hasPayload?: boolean;
  holding?: boolean;
  cancelled?: boolean;
  recording?: boolean;
  compactRecording?: boolean;
  voiceBusy?: boolean;
  voiceLabel?: string;
  voiceHint?: string;
  finishRecordingLabel?: string;
  holdHandlers?: InputHoldHandlers;
  onAccessibleRecord?: () => void;
  holdTestID?: string;
  sendLabel?: string;
  inputRef?: React.Ref<TextInput>;
  inputProps?: Omit<TextInputProps, 'value' | 'onChangeText' | 'style' | 'ref'>;
  inputStyle?: StyleProp<TextStyle>;
}

/** One input layout for chat and capture forms; owners keep their send semantics. */
export function UnifiedInputBar({
  reviewVoiceTranscript = false,
  expandedText = false,
  voiceMode,
  value,
  onChangeText,
  onToggleMode,
  onCamera,
  onAttach,
  attachmentsExpanded,
  animatedVoiceCue = false,
  reducedMotion = false,
  onSend,
  sendDisabled,
  toolsDisabled,
  modeDisabled = toolsDisabled,
  sending,
  hasPayload,
  holding,
  cancelled,
  compactRecording = false,
  voiceBusy,
  voiceLabel,
  voiceHint,
  finishRecordingLabel = '结束录音并发送',
  holdHandlers,
  onAccessibleRecord,
  holdTestID,
  sendLabel = '发送消息',
  inputRef,
  inputProps,
  inputStyle,
}: UnifiedInputBarProps) {
  const showSend =
    !voiceMode && (Boolean(value.trim()) || hasPayload || sending);
  const holdLabel = voiceLabel ??
    (holding ? cancelled ? '松开取消' : reviewVoiceTranscript ? '松开转文字' : '松开发送' : voiceBusy ? '识别中…' : '按住说话');
  const expanded = expandedText && !voiceMode;
  // Mount fresh tool views when recording ends; leave the EditText and the
  // press-and-hold responder mounted throughout layout and mode changes.
  const recordingSurface = voiceMode && compactRecording && holding;
  const camera = !recordingSurface && (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="拍照"
      disabled={toolsDisabled}
      onPress={onCamera}
      style={[c.tool, toolsDisabled && c.disabled]}
    >
      <Icon name="camera" size={25} color={colors.secondary} />
    </Pressable>
  );
  return (
    <View style={[c.bar, expanded && c.expandedBar, recordingSurface && c.recordingBar]} testID="unified-input-bar">
      {!expanded && camera}
      <TextInput
        key="composer-text"
        {...inputProps}
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        multiline
        accessibilityElementsHidden={voiceMode}
        importantForAccessibility={voiceMode ? 'no-hide-descendants' : 'auto'}
        placeholderTextColor={colors.secondary}
        style={[c.input, inputStyle, expanded && c.expandedInput, voiceMode && c.hidden]}
      />
      {voiceMode && (
        <View
          key="composer-hold"
          {...holdHandlers}
          testID={holdTestID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={holdLabel}
          accessibilityHint={
            holding && cancelled ? '再次激活取消这段录音。' :
            voiceHint ??
            (holding ? (reviewVoiceTranscript ? '再次激活结束录音并转成文字；也可以上滑取消。' : '再次激活结束录音并发送；也可以上滑取消。') :
            `按住说话，${reviewVoiceTranscript ? '松开转文字' : '松开发送'}；向上滑动取消。也可以双击开始、再双击结束。`)
          }
          accessibilityState={{
            disabled: (!holding && toolsDisabled) || voiceBusy,
          }}
          accessibilityActions={[
            { name: 'activate', label: holding ? cancelled ? '取消这段录音' : finishRecordingLabel : '开始录音' },
          ]}
          onAccessibilityTap={onAccessibleRecord}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === 'activate')
              onAccessibleRecord?.();
          }}
          style={[
            c.hold,
            holding && c.holding,
            recordingSurface && c.recordingHold,
            holding && cancelled && c.cancelled,
            recordingSurface && holding && cancelled && c.recordingCancelled,
          ]}
        >
          <Text style={[c.holdText, recordingSurface && c.recordingText, holding && cancelled && c.cancelText]}>
            {holdLabel}
          </Text>
        </View>
      )}
      {!recordingSurface && <View key="composer-tools" collapsable={false}
        style={[c.toolbar, expanded && c.expandedToolbar]} testID="unified-input-tools">
        {expanded && camera}
        {expanded && <View style={c.toolbarSpace} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={voiceMode ? '切换文字输入' : '切换语音输入'}
          disabled={modeDisabled}
          onPress={onToggleMode}
          style={[c.tool, modeDisabled && c.disabled]}
        >
          <View style={c.modeCircle}>
            {animatedVoiceCue && !voiceMode ? <VoiceCue reducedMotion={reducedMotion} /> : <Icon
              name={voiceMode ? 'keyboard' : 'mic'}
              size={18}
              color={colors.accent}
            />}
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={attachmentsExpanded ? '收起附件' : '选择附件'}
          accessibilityState={attachmentsExpanded === undefined ? undefined : { expanded: attachmentsExpanded }}
          disabled={toolsDisabled}
          onPress={onAttach}
          style={[c.tool, toolsDisabled && c.disabled]}
        >
          <Icon name={attachmentsExpanded ? 'close' : 'plus'} size={25} color={colors.secondary} />
        </Pressable>
        {showSend && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sendLabel}
            disabled={sendDisabled}
            onPress={onSend}
            style={[c.send, sendDisabled && c.sendDisabled]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={colors.onAccent} />
            ) : (
              <Icon
                name="arrowUp"
                size={23}
                color={sendDisabled ? colors.secondary : colors.onAccent}
              />
            )}
          </Pressable>
        )}
      </View>}
    </View>
  );
}

function VoiceCue({ reducedMotion }: { reducedMotion: boolean }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reducedMotion) return;
    const beat = () => [1.28, 1].map(toValue => Animated.timing(pulse, { toValue, duration: 260, useNativeDriver: true }));
    const cue = Animated.sequence([...beat(), ...beat()]);
    cue.start();
    return () => { cue.stop(); pulse.setValue(1); };
  }, [pulse, reducedMotion]);
  return <Animated.View accessible={false} style={[c.voiceCue, { transform: [{ scaleY: pulse }] }]}>
    {[4, 7, 10, 14, 10, 7, 4].map((height, index) => <View key={index} style={[c.voiceCueBar, { height }]} />)}
  </Animated.View>;
}

export function UnifiedAttachmentMenu({
  visible,
  onClose,
  onImage,
  onFile,
}: {
  visible: boolean;
  onClose: () => void;
  onImage: () => void;
  onFile: () => void;
}) {
  if (!visible) return null;
  const choose = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={c.shade}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="关闭附件选择"
        />
        <View style={c.sheet} accessibilityViewIsModal>
          <Text style={c.sheetTitle}>添加内容</Text>
          <View style={c.choices}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择图片"
              style={c.choice}
              onPress={() => choose(onImage)}
            >
              <Icon name="image" size={25} color={colors.accent} />
              <Text>图片</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="选择文件"
              style={c.choice}
              onPress={() => choose(onFile)}
            >
              <Icon name="file" size={25} color={colors.accent} />
              <Text>文件</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const c = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: '#FFFFFF',
    borderRadius: 30,
    padding: 5,
    minHeight: 64,
    shadowColor: '#61739A',
    shadowOpacity: 0.10,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  tool: {
    width: 44,
    height: 52,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
  },
  expandedBar: { flexDirection: 'column', alignItems: 'stretch', borderRadius: 24, paddingHorizontal: 8 },
  expandedInput: { flex: 0, flexShrink: 0, width: '100%', paddingHorizontal: 10 },
  toolbar: { flexDirection: 'row', alignItems: 'flex-end', flexShrink: 0 },
  expandedToolbar: { alignSelf: 'stretch' },
  toolbarSpace: { flex: 1 },
  recordingBar: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 5,
    shadowOpacity: 0,
    elevation: 0,
  },
  recordingHold: {
    minHeight: 54,
    borderRadius: 27,
    paddingHorizontal: 12,
    backgroundColor: colors.voiceHold,
  },
  recordingText: { color: colors.voiceHoldText },
  recordingCancelled: { backgroundColor: colors.voiceCancelledHold },
  modeCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.tint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voiceCue: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  voiceCueBar: { width: 2, borderRadius: 1, backgroundColor: colors.accent },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    maxHeight: 145,
    fontSize: 16,
    includeFontPadding: true,
    paddingHorizontal: 4,
    paddingVertical: INPUT_VERTICAL_PADDING,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  hidden: { display: 'none' },
  hold: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
  },
  holdText: {
    fontSize: 17,
    color: colors.ink,
    fontWeight: '500',
    textAlign: 'center',
    alignSelf: 'stretch',
    flexShrink: 1,
  },
  holding: { backgroundColor: colors.tint },
  cancelled: { backgroundColor: colors.cancellation },
  cancelText: { color: colors.cancellationText },
  disabled: { opacity: 0.45 },
  send: {
    width: 44,
    height: 44,
    margin: 4,
    borderRadius: 22,
    flexShrink: 0,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: colors.keyboard },
  shade: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#30384938' },
  sheet: {
    padding: 22,
    paddingBottom: 32,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
  },
  sheetTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '500',
    marginBottom: 15,
  },
  choices: { flexDirection: 'row', gap: 12 },
  choice: {
    flex: 1,
    flexDirection: 'row',
    gap: 9,
    minHeight: 80,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: colors.tint,
  },
});

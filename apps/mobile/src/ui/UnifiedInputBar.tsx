import React from 'react';
import {
  ActivityIndicator,
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

type HoldHandlers = Pick<
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
  voiceMode: boolean;
  value: string;
  onChangeText: (text: string) => void;
  onToggleMode: () => void;
  onCamera: () => void;
  onAttach: () => void;
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
  holdHandlers?: HoldHandlers;
  onAccessibleRecord?: () => void;
  holdTestID?: string;
  sendLabel?: string;
  inputRef?: React.Ref<TextInput>;
  inputProps?: Omit<TextInputProps, 'value' | 'onChangeText' | 'style' | 'ref'>;
  inputStyle?: StyleProp<TextStyle>;
}

/** One input layout for chat and capture forms; owners keep their send semantics. */
export function UnifiedInputBar({
  voiceMode,
  value,
  onChangeText,
  onToggleMode,
  onCamera,
  onAttach,
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
    (holding ? cancelled ? '松开取消' : '松开发送' : voiceBusy ? '识别中…' : '按住说话');
  return (
    <View style={[c.bar, compactRecording && c.recordingBar]} testID="unified-input-bar">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="拍照"
        disabled={toolsDisabled}
        onPress={onCamera}
        style={[c.tool, toolsDisabled && c.disabled, compactRecording && c.hidden]}
      >
        <Icon name="camera" size={25} color={colors.secondary} />
      </Pressable>
      <TextInput
        {...inputProps}
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        multiline
        accessibilityElementsHidden={voiceMode}
        importantForAccessibility={voiceMode ? 'no-hide-descendants' : 'auto'}
        placeholderTextColor={colors.secondary}
        style={[c.input, inputStyle, voiceMode && c.hidden]}
      />
      {voiceMode && (
        <View
          {...holdHandlers}
          testID={holdTestID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={holdLabel}
          accessibilityHint={
            holding && cancelled ? '再次激活取消这段录音。' :
            voiceHint ??
            (holding ? '再次激活结束录音并发送；也可以上滑取消。' :
            '按住说话，松开发送；向上滑动取消。也可以双击开始、再双击结束。')
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
            compactRecording && c.recordingHold,
            holding && cancelled && c.cancelled,
            compactRecording && holding && cancelled && c.recordingCancelled,
          ]}
        >
          <Text style={[c.holdText, compactRecording && c.recordingText, holding && cancelled && c.cancelText]}>
            {holdLabel}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={voiceMode ? '切换文字输入' : '切换语音输入'}
        disabled={modeDisabled}
        onPress={onToggleMode}
        style={[c.tool, modeDisabled && c.disabled, compactRecording && c.hidden]}
      >
        <View style={c.modeCircle}>
          <Icon
            name={voiceMode ? 'keyboard' : 'mic'}
            size={18}
            color={colors.accent}
          />
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="选择附件"
        disabled={toolsDisabled}
        onPress={onAttach}
        style={[c.tool, toolsDisabled && c.disabled, compactRecording && c.hidden]}
      >
        <Icon name="plus" size={25} color={colors.secondary} />
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
    </View>
  );
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
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    maxHeight: 145,
    fontSize: 16,
    includeFontPadding: true,
    paddingHorizontal: 4,
    paddingVertical: 9,
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

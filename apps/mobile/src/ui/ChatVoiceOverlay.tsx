import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Circle, Stop } from 'react-native-svg';
import { Text } from './Text';
import { Icon } from './visuals';
import { chatAppearance as appearance } from './ChatAppearance';
import { ChatRecordingMotion } from './ChatMotion';

/** Visual feedback only. The caller mounts this after the native recorder starts. */
export function ChatVoiceOverlay({ seconds, cancelled, holding, bottom, availableHeight, fontScale, reducedMotion }: {
  seconds: number;
  cancelled: boolean;
  holding: boolean;
  bottom: number;
  availableHeight: number;
  fontScale: number;
  reducedMotion: boolean | null;
}) {
  const id = useId().replace(/:/g, '');
  const height = Math.min(230, Math.max(0, availableHeight));
  if (height < Math.max(70, Math.ceil(26 * fontScale) + 14)) return null;
  const compact = height < 170 || fontScale > 1.5;
  const cancelling = holding && cancelled;
  const tint = cancelling ? appearance.cancellation : appearance.tint;
  const foreground = cancelling ? appearance.cancellationText : appearance.ink;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <View testID="chat-voice-overlay" pointerEvents="none" accessible={false}
    importantForAccessibility="no-hide-descendants"
    style={[styles.anchor, { bottom, height }]}>
    <ChatRecordingMotion reducedMotion={reducedMotion}>
      <View style={[styles.panel, { height }]}>
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs><LinearGradient id={`${id}-glow`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={tint} stopOpacity="0" />
            <Stop offset="0.54" stopColor={tint} stopOpacity="0.96" />
            <Stop offset="1" stopColor={appearance.surface} />
          </LinearGradient></Defs>
          <Rect width="100%" height="100%" fill={`url(#${id}-glow)`} />
        </Svg>
        {!compact && <View style={styles.orb}>
          <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="62" height="62">
            <Defs><RadialGradient id={`${id}-orb`} cx="32%" cy="26%" rx="78%" ry="78%">
              <Stop offset="0" stopColor={appearance.surface} />
              <Stop offset="0.48" stopColor={tint} />
              <Stop offset="1" stopColor={cancelling ? appearance.cancellationText : appearance.accent} stopOpacity="0.5" />
            </RadialGradient></Defs>
            <Circle cx="31" cy="31" r="31" fill={`url(#${id}-orb)`} />
          </Svg>
          <Icon name={cancelling ? 'close' : 'mic'} size={26} color={cancelling ? foreground : appearance.accent} />
        </View>}
        <Text testID="chat-voice-overlay-title" style={[styles.title, { color: foreground }]}>
          {cancelling ? '松开取消' : '正在聆听'} · {clock}
        </Text>
        {height >= (fontScale > 1.5 ? 140 : 100) && <Text style={[styles.hint, { color: cancelling ? foreground : appearance.secondary }]}>
          {cancelling ? '这段录音不会发送' : holding ? '松开转文字，上滑取消' : '点击结束转文字'}
        </Text>}
      </View>
    </ChatRecordingMotion>
  </View>;
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: 0, right: 0, zIndex: 2, overflow: 'hidden' },
  panel: { justifyContent: 'flex-end', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 14 },
  orb: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', marginBottom: 9 },
  title: { fontSize: 15, lineHeight: 26, fontWeight: '500', textAlign: 'center' },
  hint: { fontSize: 12, lineHeight: 21, textAlign: 'center', marginTop: 3 },
});

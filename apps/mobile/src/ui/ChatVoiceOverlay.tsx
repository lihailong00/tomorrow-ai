import React, { useEffect, useId, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text } from './Text';
import { chatAppearance as appearance } from './ChatAppearance';
import { ChatRecordingMotion } from './ChatMotion';
import { platform } from '../platform/ports';

const SILENCE = Array<number>(29).fill(0);

/** Read the real recorder only while mounted; a slow bridge never builds a queue. */
function useRecordingLevels(enabled: boolean) {
  const [levels, setLevels] = useState(SILENCE);
  useEffect(() => {
    if (!enabled || !platform.hasRecordingLevel) return;
    let active = true;
    let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      let level = 0;
      try { level = await platform.recordingLevel(); } catch { /* A meter failure cannot interrupt recording. */ }
      if (active) {
        const sample = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        setLevels(previous => sample === 0 && previous.every(value => value === 0)
          ? previous : [...previous.slice(1), sample]);
      }
      pending = false;
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 150);
    return () => { active = false; clearInterval(timer); };
  }, [enabled]);
  return levels;
}

/** Visual feedback only. The caller mounts this after the native recorder starts. */
export function ChatVoiceOverlay({ seconds, cancelled, holding, composerHeight, availableHeight, fontScale, reducedMotion, reviewVoiceTranscript }: {
  reviewVoiceTranscript?: boolean;
  seconds: number;
  cancelled: boolean;
  holding: boolean;
  composerHeight: number;
  availableHeight: number;
  fontScale: number;
  reducedMotion: boolean | null;
}) {
  const id = useId().replace(/:/g, '');
  const viewport = Number.isFinite(availableHeight) ? Math.max(0, availableHeight) : 0;
  const levels = useRecordingLevels(viewport > 0);
  const footer = Number.isFinite(composerHeight) ? Math.max(0, Math.min(viewport, composerHeight)) : 0;
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  const fade = Math.min(36, Math.max(0, viewport - footer));
  const room = Math.max(0, viewport - footer - fade);
  const stacked = scale > 2;
  const headingHeight = Math.ceil(26 * scale) * (stacked ? 2 : 1);
  const showHeading = room >= headingHeight + 8;
  // Leave room for a wrapped hint at large system font sizes instead of
  // hiding the gesture instruction on otherwise spacious screens.
  const hintHeight = Math.ceil(20 * scale) * (scale > 1.5 ? 2 : 1);
  const showHint = showHeading && room >= headingHeight + hintHeight + 16;
  const showLevels = showHeading && room >= headingHeight + (showHint ? hintHeight + 6 : 0) + 42;
  const feedbackHeight = showHeading ? headingHeight + 8 + (showHint ? hintHeight + 6 : 0) + (showLevels ? 34 : 0) : 0;
  const height = Math.min(viewport, footer + fade + feedbackHeight);
  if (height <= 0) return null;
  const cancelling = holding && cancelled;
  const tint = cancelling ? appearance.cancellation : appearance.voiceTint;
  const surface = cancelling ? appearance.cancellation : appearance.voiceSurface;
  const foreground = cancelling ? appearance.cancellationText : appearance.ink;
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <View testID="chat-voice-overlay" pointerEvents="none" accessible={false}
    importantForAccessibility="no-hide-descendants"
    style={[styles.anchor, { height }]}>
    {/* The opaque lower surface never moves or fades with the feedback. */}
    <Svg testID="chat-voice-backdrop" pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs><LinearGradient id={`${id}-glow`} x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={tint} stopOpacity="0" />
        <Stop offset={Math.min(1, fade / height)} stopColor={tint} stopOpacity="1" />
        <Stop offset="1" stopColor={surface} stopOpacity="1" />
      </LinearGradient></Defs>
      <Rect width="100%" height="100%" fill={`url(#${id}-glow)`} />
    </Svg>
    {showHeading && <View style={[styles.feedback, { bottom: footer }]} testID="chat-voice-feedback">
      <ChatRecordingMotion reducedMotion={reducedMotion}>
        <View style={styles.panel}>
          <View style={[styles.heading, { minHeight: headingHeight }, stacked && styles.stacked]}>
            <Text testID="chat-voice-overlay-title" style={[styles.title, { color: foreground }]}>
              {cancelling ? '松开取消' : '正在聆听'}
            </Text>
            <Text testID="chat-voice-clock" style={[styles.clock, { color: cancelling ? foreground : appearance.secondary }]}>{clock}</Text>
          </View>
          {showLevels && <View testID="chat-voice-levels" style={styles.levels}>
            {levels.map((level, index) => <View key={index} testID={`chat-voice-level-${index}`}
              style={[styles.level, { height: 4 + 22 * Math.pow(level, 0.45),
                backgroundColor: cancelling ? appearance.cancellationText : appearance.accent,
                opacity: 0.4 + 0.6 * Math.sin((index + 1) / (levels.length + 1) * Math.PI) }]} />)}
          </View>}
          {showHint && <Text testID="chat-voice-hint" style={[styles.hint, { color: cancelling ? foreground : appearance.secondary }]}>
            {cancelling ? '这段录音不会发送' : holding ? (reviewVoiceTranscript ? '松开转文字，上滑取消' : '松开发送，上滑取消') : '点击结束转文字'}
          </Text>}
        </View>
      </ChatRecordingMotion>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 2, overflow: 'hidden' },
  feedback: { position: 'absolute', left: 0, right: 0 },
  panel: { paddingHorizontal: 24, paddingBottom: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  stacked: { flexDirection: 'column', alignItems: 'stretch', gap: 0 },
  title: { fontSize: 15, lineHeight: 26, fontWeight: '500', flexShrink: 1 },
  clock: { fontSize: 12, lineHeight: 22, fontVariant: ['tabular-nums'], textAlign: 'right' },
  levels: { flexDirection: 'row', alignItems: 'center', alignSelf: 'center', gap: 3, height: 26, marginTop: 8 },
  level: { width: 3, borderRadius: 2 },
  hint: { fontSize: 12, lineHeight: 20, textAlign: 'center', marginTop: 6 },
});

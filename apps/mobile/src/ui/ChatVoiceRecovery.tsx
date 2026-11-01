import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Button } from './components';
import { Icon } from './visuals';
import { chatAppearance as appearance } from './ChatAppearance';
import { voiceRetryTime, type VoiceFailure } from '../screens/chatVoiceRecovery';

export function ChatVoiceRecovery({ phase, failure, transcript, busy, blocked, retryLabel, onRetry, onCancel, onInsertText }: {
  phase: string; failure?: VoiceFailure; transcript?: string; busy: boolean; blocked: boolean;
  retryLabel: string; onRetry: () => void; onCancel: () => void;
  onInsertText?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const retryAt = failure?.retryAt;
  useEffect(() => {
    setNow(Date.now());
    if (!retryAt || retryAt <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2147483647, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);
  const waiting = Boolean(retryAt && retryAt > now);
  return <View style={styles.card} testID="chat-voice-recovery">
    <View style={styles.row}>
      {busy ? <ActivityIndicator color={appearance.accent} /> : <Icon name="mic" size={18} color={appearance.accent} />}
      <Text style={styles.message} accessibilityLiveRegion="polite" numberOfLines={3}>
        {failure?.message ?? phase}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="取消语音转写" onPress={onCancel} style={styles.remove}>
        <Icon name="close" size={18} color={appearance.secondary} />
      </Pressable>
    </View>
    {failure && <Text style={styles.hint} numberOfLines={2}>录音和草稿已保留；也可关闭卡片，继续文字输入。</Text>}
    {retryAt && <Text style={styles.hint} testID="chat-voice-retry-time">
      {failure?.kind === 'quota' ? '预计额度恢复：' : '建议重试时间：'}{voiceRetryTime(retryAt)}（本机时间）
    </Text>}
    {waiting && failure?.kind === 'quota' && <Text style={styles.hint}>管理员调整额度后，可提前重新检查。</Text>}
    {transcript && <Text style={styles.hint} numberOfLines={2}>已识别：{transcript}</Text>}
    {!busy && <Button variant="secondary" disabled={blocked} onPress={() => {
      if (blocked) return;
      onRetry();
    }}>{waiting && failure?.kind === 'quota' ? '重新检查额度' : retryLabel}</Button>}
    {!busy && onInsertText && <Button variant="ghost" disabled={blocked} onPress={() => {
      if (!blocked) onInsertText();
    }}>填入文字</Button>}
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 10, marginBottom: 8, borderRadius: 16, backgroundColor: appearance.surface,
    borderWidth: 1, borderColor: appearance.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  message: { flex: 1, flexShrink: 1, fontSize: 12, lineHeight: 19, color: appearance.ink },
  hint: { fontSize: 11, lineHeight: 18, color: appearance.secondary, marginTop: 4 },
  remove: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});

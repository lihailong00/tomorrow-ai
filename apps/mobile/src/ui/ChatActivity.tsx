import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import type { ChatActivity as Activity } from '../screens/chatActivity';
import { Text } from './Text';
import { chatAppearance as colors } from './ChatAppearance';
import { Icon } from './visuals';

export function ChatActivity({ items = [], status }: { items?: readonly Activity[]; status?: string }) {
  const [expanded, setExpanded] = useState(false);
  const latest = items[items.length - 1];
  if (!status && !latest) return null;
  return <View style={css.root} testID="chat-activity">
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? '收起执行记录' : '展开执行记录'}
      accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={css.heading}>
      {status ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="history" size={16} color={colors.accent} />}
      <View style={css.copy}>
        <Text style={css.title}>{status || '查看执行记录'}</Text>
        {latest?.detail ? <Text style={css.detail} numberOfLines={2}>{latest.label} · {latest.detail}</Text> : null}
      </View>
      <Icon name={expanded ? 'arrowUp' : 'chevronDown'} size={14} color={colors.secondary} />
    </Pressable>
    {expanded && <View style={css.history}>
      {!items.length && <Text style={css.detail}>等待执行信息…</Text>}
      {items.map(item => <View key={item.id} style={css.step}>
        <Text style={[css.marker, item.state === 'failed' && css.failed]}>
          {item.state === 'running' ? '进行中' : item.state === 'complete' ? '已完成' : item.state === 'failed' ? '未成功' : '已中断'}
        </Text>
        <View style={css.copy}><Text style={css.title}>{item.label}</Text>
          {!!item.detail && <Text style={css.detail} numberOfLines={3}>{item.detail}</Text>}</View>
      </View>)}
      {items.length === 24 && <Text style={css.detail}>显示最近 24 步</Text>}
    </View>}
  </View>;
}
const css = StyleSheet.create({
  root: { marginTop: 14, marginBottom: 8 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingVertical: 6 },
  copy: { flex: 1, minWidth: 0 },
  title: { fontSize: 12, lineHeight: 20, color: colors.secondary },
  detail: { fontSize: 11, lineHeight: 18, color: colors.secondary, marginTop: 3 },
  history: { backgroundColor: 'rgba(255,255,255,0.62)', borderRadius: 18, padding: 14, marginTop: 6, gap: 14 },
  step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  marker: { fontSize: 10, lineHeight: 20, color: colors.accent, minWidth: 36 },
  failed: { color: colors.cancellationText },
});

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './visuals';
import { chatAppearance as colors } from './ChatAppearance';

export function replyFailureCopy(message: string, hasContent: boolean) {
  const reason = message.replace(/\n?请先重试这条消息，再继续发送新消息。/g, '').trim();
  const busy = /service_unavailable|service is too busy|(?:模型|服务).*繁忙|\b503\b/i.test(message);
  const network = /网络|连接.*(?:中断|失败)|断网|timeout|超时/i.test(message);
  const generic = /回复中断|回复未完整|模型调用失败|Agent.*未完成/i.test(message);
  return {
    title: busy ? '模型暂时繁忙' : network ? '连接暂时中断' : hasContent ? '回复暂时中断' : '这次回复没有完成',
    detail: busy ? '稍后重试，就能继续这条消息。' : network ? '请检查网络后重试。' : generic
      ? '稍后重试，我们会继续处理这条消息。' : reason.slice(0, 240) || '请稍后重试。',
    retained: hasContent ? '已生成的内容已保留' : '你的消息已保留',
    gate: message.includes('请先重试这条消息') ? '请先重试这条消息，再继续发送新消息。' : undefined,
  };
}

/** A reply failure belongs beside the assistant, never inside the user's bubble. */
export function ChatReplyFailure({ message, hasContent, onRetry }: {
  message: string; hasContent: boolean; onRetry: () => unknown;
}) {
  const copy = replyFailureCopy(message, hasContent);
  return <View testID="chat-reply-failure" style={css.card} accessibilityLiveRegion="polite">
    <View style={css.row}>
      <View style={css.symbol}><Icon name="clock" size={16} color={colors.accent} /></View>
      <View style={css.copy}>
        <Text style={css.title}>{copy.title}</Text>
        <Text style={css.detail}>{copy.detail}</Text>
        {copy.gate && <Text style={css.detail}>{copy.gate}</Text>}
      </View>
    </View>
    <View style={css.footer}>
      <Text style={css.retained}>{copy.retained}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重试回复"
        onPress={onRetry} style={({ pressed }) => [css.retry, pressed && css.pressed]}>
        <Icon name="history" size={15} color={colors.accent} />
        <Text style={css.retryText}>重试</Text>
      </Pressable>
    </View>
  </View>;
}

const css = StyleSheet.create({
  card: { marginTop: 8, padding: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, maxWidth: '100%' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  symbol: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.tint },
  copy: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontSize: 14, lineHeight: 22, fontWeight: '500' },
  detail: { marginTop: 3, color: colors.secondary, fontSize: 12, lineHeight: 20 },
  footer: { marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  retained: { color: colors.secondary, fontSize: 11, lineHeight: 18, flexShrink: 1, minWidth: 0 },
  retry: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 22, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: colors.tint },
  retryText: { color: colors.accent, fontSize: 13, lineHeight: 22, fontWeight: '500', flexShrink: 1 },
  pressed: { opacity: 0.65 },
});

import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { ReasoningEffort } from '../domain/types';
import { chatAppearance as colors } from './ChatAppearance';
import { Text } from './Text';
import { Icon } from './visuals';

const choices: { value: ReasoningEffort; label: string; short: string; hint: string }[] = [
  { value: 'off', label: '关闭思考', short: '关闭', hint: '默认 · 快速、直接回答' },
  { value: 'low', label: '轻度思考', short: '轻度', hint: '适合简单分析' },
  { value: 'high', label: '深度思考', short: '深度', hint: '适合多步分析和方案比较' },
  { value: 'max', label: '最强思考', short: '最强', hint: '适合复杂推理，等待通常更久' },
];

/** The owner retains the choice with its conversation, never as a global default. */
export function ChatReasoningSelector({ value, onChange, disabled, owner }: {
  value: ReasoningEffort; onChange: (value: ReasoningEffort) => void; disabled?: boolean; owner?: object;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [owner]);
  const selected = choices.find(choice => choice.value === value) ?? choices[0];
  return <View style={css.toolbar}>
    <Pressable accessibilityRole="button" accessibilityLabel={`思考：${selected.short}`}
      accessibilityHint="选择下一次发送的思考强度" accessibilityState={{ expanded: open, disabled: Boolean(disabled) }}
      disabled={disabled} onPress={() => setOpen(true)} style={[css.trigger, disabled && css.disabled]}>
      <Text style={css.triggerText}>思考：{selected.short}</Text>
      <Icon name="chevronDown" size={14} color={colors.secondary} />
    </Pressable>
    {open && <Modal transparent visible animationType="slide" onRequestClose={() => setOpen(false)}>
      <View style={css.layer}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭思考设置" onPress={() => setOpen(false)} style={StyleSheet.absoluteFill} />
        <View style={css.sheet} accessibilityViewIsModal testID="chat-reasoning-sheet">
          <View style={css.header}>
            <Text style={css.title}>思考强度</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="完成思考设置" onPress={() => setOpen(false)} style={css.close}>
              <Icon name="close" size={20} color={colors.secondary} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
            {choices.map(choice => <Pressable key={choice.value} accessibilityRole="radio"
              accessibilityLabel={choice.label} accessibilityHint={choice.hint}
              accessibilityState={{ checked: value === choice.value, disabled: Boolean(disabled) }} disabled={disabled}
              onPress={() => { if (!disabled) onChange(choice.value); setOpen(false); }}
              style={[css.option, value === choice.value && css.selected]}>
              <View style={css.copy}><Text style={css.label}>{choice.label}</Text><Text style={css.hint}>{choice.hint}</Text></View>
              {value === choice.value && <Icon name="check" size={20} color={colors.accent} />}
            </Pressable>)}
            <Text style={css.footer}>仅用于当前会话的后续消息，正在生成的回复保持原档位。</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>}
  </View>;
}

const css = StyleSheet.create({
  toolbar: { alignItems: 'flex-start', paddingBottom: 9 },
  trigger: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.95)', borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.72)', paddingHorizontal: 13 },
  triggerText: { color: colors.secondary, fontSize: 13, fontWeight: '500', flexShrink: 1 },
  disabled: { opacity: 0.5 },
  layer: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(30,38,60,0.2)' },
  sheet: { maxHeight: '85%', backgroundColor: colors.surface, borderTopLeftRadius: 25, borderTopRightRadius: 25,
    padding: 20, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 19, fontWeight: '600', color: colors.ink },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: 72, padding: 14, borderRadius: 16, marginBottom: 5 },
  selected: { backgroundColor: colors.tint },
  copy: { flex: 1, paddingRight: 10 },
  label: { fontSize: 16, color: colors.ink, fontWeight: '500' },
  hint: { fontSize: 13, color: colors.secondary, marginTop: 5 },
  footer: { fontSize: 12, color: colors.secondary, lineHeight: 19, padding: 12 },
});

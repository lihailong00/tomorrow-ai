import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { Memory } from '../../domain/types';
import { useAction, useApp } from '../../app/context';
import { Text } from '../../ui/Text';
import { ErrorNotice } from '../../ui/components';
import {
  confirmedWeightContent,
  getMemoryConfirmation,
} from './memoryPresentation';

export function MemoryConfirmationCard({
  memory,
  onSaved,
  onBusyChange,
}: {
  memory: Memory;
  onSaved: (memory: Memory) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { api, invalidate } = useApp();
  const action = useAction();
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState('');
  const review = getMemoryConfirmation(memory);
  useEffect(() => {
    onBusyChange?.(action.busy);
    return () => onBusyChange?.(false);
  }, [action.busy, onBusyChange]);
  if (!review) return null;
  const save = (kilograms: number) => {
    const content = confirmedWeightContent(review, kilograms);
    if (!content || action.busy) return;
    action.run(async ({ isCurrent }) => {
      const saved = await api.saveMemory(
        { content, kind: memory.kind, version: memory.version },
        memory.id,
      );
      if (!isCurrent()) return;
      invalidate();
      onSaved(saved);
    });
  };
  const valid =
    /^\d+(?:\.\d+)?$/.test(value.trim()) &&
    Number(value) > 0 &&
    Number(value) <= 1000;
  return (
    <View style={s.card} testID="memory-number-confirmation">
      <Text style={s.title}>
        {review.options.length
          ? `你目前的体重是 ${review.options[0]} 公斤吗？`
          : '你的体重是多少？'}
      </Text>
      <Text style={s.note}>
        这处数字可能听错了，确认后再记住；确认前不会用于回答。
      </Text>
      {review.options
        .filter(n => Number.isFinite(n) && n > 0 && n <= 1000)
        .map(n => (
          <Pressable
            key={n}
            accessibilityRole="button"
            accessibilityLabel={`是 ${n} 公斤`}
            disabled={action.busy}
            onPress={() => save(n)}
            style={[s.choice, action.busy && s.disabled]}
          >
            <Text style={s.choiceText}>是 {n} 公斤</Text>
          </Pressable>
        ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="都不对，自己填写"
        disabled={action.busy}
        onPress={() => setCustom(v => !v)}
        style={s.other}
      >
        <Text style={s.link}>都不对，自己填写</Text>
      </Pressable>
      {custom && (
        <View style={s.custom}>
          <TextInput
            accessibilityLabel="体重（公斤）"
            placeholder="请输入体重（公斤）"
            keyboardType="decimal-pad"
            value={value}
            onChangeText={setValue}
            editable={!action.busy}
            maxLength={8}
            style={s.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="确认体重"
            disabled={!valid || action.busy}
            onPress={() => save(Number(value))}
            style={[s.choice, (!valid || action.busy) && s.disabled]}
          >
            <Text style={s.choiceText}>确认体重</Text>
          </Pressable>
        </View>
      )}
      {action.busy && (
        <ActivityIndicator
          color="#5665BE"
          accessibilityLabel="正在保存确认结果"
        />
      )}
      <ErrorNotice message={action.error} />
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#F1F2FF',
    borderRadius: 18,
    padding: 18,
    gap: 10,
    marginBottom: 16,
  },
  title: { color: '#303849', fontSize: 18, lineHeight: 28, fontWeight: '500' },
  note: { color: '#707B91', fontSize: 13, lineHeight: 22 },
  choice: {
    minHeight: 48,
    borderRadius: 14,
    backgroundColor: '#5665BE',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  choiceText: { color: '#FFFFFF', fontSize: 15 },
  other: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  link: { color: '#5665BE', fontSize: 14 },
  disabled: { opacity: 0.45 },
  custom: { gap: 10 },
  input: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    color: '#303849',
    paddingHorizontal: 14,
  },
});

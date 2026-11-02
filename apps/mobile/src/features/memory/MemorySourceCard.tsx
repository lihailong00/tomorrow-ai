import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Memory } from '../../domain/types';
import { useApp } from '../../app/context';
import { Text } from '../../ui/Text';
import { memorySource } from './memoryPresentation';

export function MemorySourceCard({ memory }: { memory: Memory }) {
  const { formatDate, navigate } = useApp();
  const [expanded, setExpanded] = useState(false);
  const source = memorySource(memory.source);
  return (
    <View style={s.card}>
      <Text style={s.note}>从哪里记住的</Text>
      <Text style={s.text}>{`${source.label}${
        source.date ? ` · ${formatDate(source.date)}` : ''
      }`}</Text>
      {source.quote && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? '收起原话' : '查看原话'}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded(v => !v)}
            style={s.linkTarget}
          >
            <Text style={s.link}>{expanded ? '收起原话' : '查看原话'}</Text>
          </Pressable>
          {expanded && (
            <Text selectable style={s.text}>
              {source.quote}
            </Text>
          )}
        </>
      )}
      {source.conversationId && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看原对话"
          onPress={() =>
            navigate({ name: 'chat', conversationId: source.conversationId })
          }
          style={s.linkTarget}
        >
          <Text style={s.link}>查看原对话</Text>
        </Pressable>
      )}
      <Text style={s.note}>{`更新于 ${formatDate(memory.updated_at)}`}</Text>
    </View>
  );
}
const s = StyleSheet.create({
  card: { backgroundColor: '#F7F8FC', borderRadius: 14, padding: 14, gap: 7 },
  note: { color: '#707B91', fontSize: 11, lineHeight: 18 },
  text: { color: '#303849', fontSize: 13, lineHeight: 22 },
  linkTarget: { minHeight: 44, justifyContent: 'center' },
  link: { color: '#5665BE', fontSize: 13 },
});

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Text } from './Text';
import { Icon } from './visuals';

export type MessageAnchor = { x: number; y: number; width: number; height: number };
export type MessageAction = 'copy' | 'edit' | 'quote' | 'select' | 'share' | 'branch' | 'delete' | 'memory' | 'todos';
export function messageMenuPosition(anchor: MessageAnchor, width: number, height: number, expanded: boolean, menuHeight?: number) {
  const cardWidth = Math.min(276, Math.max(160, width - 32));
  const cardHeight = Math.min(menuHeight ?? (expanded ? 408 : 300), Math.max(100, height - 48));
  const below = anchor.y + anchor.height + 10;
  return { width: cardWidth, maxHeight: height - 48,
    left: Math.max(16, Math.min(width - cardWidth - 16, anchor.x + anchor.width - cardWidth)),
    top: Math.max(24, Math.min(height - cardHeight - 24, below + cardHeight <= height - 24 ? below : anchor.y - cardHeight - 10)) };
}

/** A native anchored menu; selection uses Android/iOS' actual selectable Text. */
export function ChatMessageActions({ anchor, timestamp, hasText, blocked, role = 'user', onAction, onClose }: {
  anchor: MessageAnchor; timestamp: string; hasText: boolean; blocked: boolean;
  role?: 'user' | 'assistant';
  onAction: (action: MessageAction) => void; onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number>();
  const assistant = role === 'assistant';
  const action = (name: MessageAction, label: string, icon: Parameters<typeof Icon>[0]['name'], compact = false) => {
    const disabled = (blocked && ['edit', 'quote', 'branch', 'delete', 'memory', 'todos'].includes(name)) || (!hasText && name !== 'delete');
    return <Pressable key={name} accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
      onPress={() => onAction(name)} style={[compact ? css.topAction : css.row, disabled && css.disabled]}>
      <Icon name={icon} size={compact ? 21 : 19} color={name === 'delete' ? '#c84c63' : '#5665be'} />
      <Text style={[css.label, compact && css.compactLabel, name === 'delete' && css.danger]}>{label}</Text>
    </Pressable>;
  };
  return <Modal transparent visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <View style={css.layer}>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭消息菜单" onPress={onClose} style={StyleSheet.absoluteFill} />
      <View testID="chat-message-menu" accessibilityViewIsModal
        onLayout={event => { const next = event.nativeEvent.layout.height; if (next > 0 && next !== measuredHeight) setMeasuredHeight(next); }}
        style={[css.menu, messageMenuPosition(anchor, width, height, expanded, measuredHeight ?? (assistant ? 460 : undefined))]}>
        <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
          <Text style={css.timestamp}>{timestamp}</Text>
          <View style={css.top}>{action('copy', '复制', 'copy', true)}{assistant ? action('share', '分享', 'share', true) : action('edit', '修改', 'edit', true)}{action('quote', '追问', 'quote', true)}</View>
          <View style={css.divider} />
          {action('select', '选择文字', 'select')}
          {assistant ? <>
            {action('memory', '保存到记忆', 'memory')}
            {action('todos', '从对话发现待办', 'tasks')}
            <View style={css.divider} />
            {action('branch', '在新对话中继续', 'compose')}
          </> : <>
            {action('share', '分享', 'share')}
            <Pressable accessibilityRole="button" accessibilityLabel="更多消息操作" accessibilityState={{ expanded }}
              onPress={() => { setMeasuredHeight(undefined); setExpanded(!expanded); }} style={css.row}>
              <Icon name="more" size={19} color="#5665be" /><Text style={css.label}>更多</Text>
              <View style={css.spacer} /><View style={expanded ? css.moreExpanded : undefined}><Icon name="chevronDown" size={16} color="#8a90a3" /></View>
            </Pressable>
            {expanded && <><View style={css.divider} />{action('branch', '创建新对话', 'plus')}{action('delete', '删除', 'delete')}</>}
          </>}
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

export function ChatTextSelection({ text, onClose }: { text: string; onClose: () => void }) {
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={css.sheetLayer}><View style={css.sheet} accessibilityViewIsModal>
      <View style={css.heading}><Text style={css.title}>选择文字</Text><Pressable accessibilityRole="button" accessibilityLabel="完成文字选择" onPress={onClose} style={css.done}><Text style={css.doneText}>完成</Text></Pressable></View>
      <ScrollView style={css.selectionScroll}><Text selectable testID="chat-selectable-message" style={css.selectionText}>{text}</Text></ScrollView>
    </View></View>
  </Modal>;
}

export function ChatDeleteConfirmation({ text, busy, error, onDelete, onClose }: {
  text: string; busy: boolean; error: string | null; onDelete: () => void; onClose: () => void;
}) {
  return <Modal transparent visible animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={css.sheetLayer}><View style={css.sheet} accessibilityViewIsModal>
      <Text style={css.title}>删除这条消息？</Text>
      <Text style={css.caption}>这条消息和对应回复会一起删除。</Text>
      <Text numberOfLines={4} style={css.preview}>{text}</Text>
      {error ? <Text accessibilityRole="alert" style={css.danger}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="确认删除消息" disabled={busy} onPress={onDelete} style={css.confirm}>
        <Text style={css.danger}>{busy ? '正在删除…' : '删除'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="取消删除消息" disabled={busy} onPress={onClose} style={css.confirm}><Text style={css.label}>取消</Text></Pressable>
    </View></View>
  </Modal>;
}

const css = StyleSheet.create({
  layer: { flex: 1, backgroundColor: 'rgba(24,31,55,0.13)' },
  menu: { position: 'absolute', backgroundColor: '#fff', borderRadius: 19, paddingVertical: 12, borderWidth: 1, borderColor: '#e2e6ef',
    shadowColor: '#1c2548', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 12 },
  timestamp: { color: '#606b80', fontSize: 12, paddingHorizontal: 17, paddingTop: 1, paddingBottom: 5 },
  top: { flexDirection: 'row', paddingHorizontal: 9, paddingTop: 5, paddingBottom: 12 },
  topAction: { flex: 1, minHeight: 69, alignItems: 'center', justifyContent: 'center', gap: 5 },
  row: { minHeight: 53, paddingHorizontal: 20, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 13 },
  label: { fontSize: 15, color: '#303849' }, compactLabel: { fontSize: 15 },
  danger: { color: '#c84c63' }, disabled: { opacity: 0.35 },
  moreExpanded: { transform: [{ rotate: '180deg' }] },
  divider: { height: 1, marginHorizontal: 18, backgroundColor: '#f0f1f6' }, spacer: { flex: 1 },
  sheetLayer: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(24,31,55,0.20)' },
  sheet: { backgroundColor: '#f7f8fc', padding: 20, paddingBottom: 32, borderTopLeftRadius: 26, borderTopRightRadius: 26, maxHeight: '75%' },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '600', color: '#292f42' }, done: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  doneText: { color: '#5665be', fontSize: 14 }, selectionScroll: { flexGrow: 0 }, selectionText: { fontSize: 16, lineHeight: 28, color: '#292f42' },
  caption: { fontSize: 13, lineHeight: 23, color: '#8a90a3', marginTop: 12 },
  preview: { color: '#41485d', fontSize: 14, lineHeight: 24, backgroundColor: '#fff', padding: 14, borderRadius: 16, marginTop: 14, marginBottom: 10 },
  confirm: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
});

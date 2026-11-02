import React, {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { Alert, Pressable, StyleSheet } from 'react-native';
import type { createChatEntryState } from '../../screens/Chat';
import { Icon } from '../../ui/visuals';
import { colors } from '../../ui/theme';
import { useConversationPins } from './useConversationPins';

type Entry = ReturnType<typeof createChatEntryState>;

export function CurrentConversationPin({ entryState }: { entryState?: Entry }) {
  return entryState ? <PinButton entry={entryState} /> : null;
}

function PinButton({ entry }: { entry: Entry }) {
  const pins = useConversationPins();
  // Streaming text updates do not rerender the app header on every token.
  const reference = useCallback(() => {
    const state = entry.getSnapshot();
    return (state.id ?? '') + ':' + Boolean(state.messages.length);
  }, [entry]);
  useSyncExternalStore(entry.subscribe, reference, reference);
  const current = entry.getSnapshot();
  const id = current.id;
  const owner = useRef(pins.key);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  owner.current = pins.key;
  const pinned = pins.items.find(item => item.id === id);
  if (!id || (!current.messages.length && !pinned)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={pinned ? '取消置顶当前对话' : '置顶当前对话'}
      accessibilityState={{
        selected: Boolean(pinned),
        disabled: !pins.enabled,
      }}
      disabled={!pins.enabled}
      style={[css.button, pinned && css.selected]}
      onPress={() => {
        const requestOwner = pins.key;
        const snapshot = entry.getSnapshot();
        const first = snapshot.messages.find(
          message => message.role === 'user',
        );
        const item = pinned ?? {
          id,
          title:
            first?.content.replace(/\s+/g, ' ').trim().slice(0, 500) ||
            '对话记录',
          updated_at:
            snapshot.messages.at(-1)?.created_at || new Date().toISOString(),
        };
        void pins.owner.toggle(item).catch(() => {
          if (active.current && owner.current === requestOwner)
            Alert.alert('未能保存置顶', '请在对话记录中重试。');
        });
      }}
    >
      <Icon
        name={pinned ? 'pinOff' : 'pin'}
        size={20}
        color={pinned ? colors.action : colors.ink}
      />
    </Pressable>
  );
}

const css = StyleSheet.create({
  button: {
    width: 44,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: colors.blueLight },
});

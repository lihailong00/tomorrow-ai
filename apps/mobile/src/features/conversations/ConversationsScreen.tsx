import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutAnimation,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { useApp } from '../../app/context';
import type { Conversation } from '../../domain/types';
import { usePagedList } from '../../screens/Main';
import { Text } from '../../ui/Text';
import { Button, Empty, ErrorNotice, Loading } from '../../ui/components';
import { Icon } from '../../ui/visuals';
import { colors, styles as s } from '../../ui/theme';
import { useChatReducedMotion } from '../../ui/ChatMotion';
import { conversationSections, type PinUndo } from './pins';
import { useConversationPins } from './useConversationPins';

type Anchor = { x: number; y: number; width: number; height: number };
type Menu = { item: Conversation; anchor: Anchor; owner: string | null };

export function ConversationPinMenu({
  item,
  anchor,
  pinned,
  busy,
  onPin,
  onOpen,
  onClose,
}: {
  item: Conversation;
  anchor: Anchor;
  pinned: boolean;
  busy: boolean;
  onPin: () => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const reducedMotion = useChatReducedMotion();
  const [measuredHeight, setMeasuredHeight] = useState(205);
  const menuWidth = Math.min(244, Math.max(160, width - 32));
  const top = Math.max(
    24,
    Math.min(
      height - Math.min(measuredHeight, height - 48) - 24,
      anchor.y + anchor.height + 6 + measuredHeight < height - 24
        ? anchor.y + anchor.height + 6
        : anchor.y - measuredHeight - 6,
    ),
  );
  return (
    <Modal
      transparent
      visible
      animationType={reducedMotion === false ? 'fade' : 'none'}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={css.scrim}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="关闭对话菜单"
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          testID="conversation-pin-menu"
          style={[
            css.menu,
            {
              width: menuWidth,
              maxHeight: Math.max(100, height - 48),
              top,
              left: Math.max(
                16,
                Math.min(
                  width - menuWidth - 16,
                  anchor.x + anchor.width - menuWidth,
                ),
              ),
            },
          ]}
          onLayout={event => {
            if (event.nativeEvent.layout.height > 0)
              setMeasuredHeight(event.nativeEvent.layout.height);
          }}
        >
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled">
            <Text style={css.menuTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pinned ? '取消置顶对话' : '置顶对话'}
              disabled={busy}
              onPress={onPin}
              style={[css.menuAction, busy && css.disabled]}
            >
              <Icon
                name={pinned ? 'pinOff' : 'pin'}
                color={colors.action}
                size={19}
              />
              <Text style={css.pinAction}>
                {pinned ? '取消置顶' : '置顶对话'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="继续这段对话"
              onPress={onOpen}
              style={css.menuAction}
            >
              <Icon name="history" size={19} />
              <Text style={css.menuActionText}>继续对话</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消对话操作"
              onPress={onClose}
              style={css.cancel}
            >
              <Text style={css.menuCaption}>取消</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ConversationRow({
  item,
  pinned,
  formatDate,
  onOpen,
  onMenu,
}: {
  item: Conversation;
  pinned: boolean;
  formatDate: (date: string) => string;
  onOpen: () => void;
  onMenu: (
    item: Conversation,
    event: GestureResponderEvent,
    row: View | null,
  ) => void;
}) {
  const row = useRef<View>(null);
  return (
    <View
      ref={row}
      style={[css.row, pinned && css.pinnedRow]}
      testID={'conversation-row-' + item.id}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={'继续对话：' + item.title}
        accessibilityHint="长按可管理置顶"
        delayLongPress={480}
        onLongPress={event => onMenu(item, event, row.current)}
        onPress={onOpen}
        style={css.open}
      >
        <Text style={css.name} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={css.metadata}>
          <Text style={css.date}>{formatDate(item.updated_at)}</Text>
          {pinned && (
            <View style={css.pinMark}>
              <Icon name="pin" size={11} color={colors.action} />
              <Text style={css.pinLabel}>已置顶</Text>
            </View>
          )}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={'管理对话：' + item.title}
        onPress={event => onMenu(item, event, row.current)}
        style={css.more}
      >
        <Icon name="more" size={18} color={colors.secondary} />
      </Pressable>
    </View>
  );
}

export function ConversationsScreen() {
  const { api, user, preferences, navigate, formatDate } = useApp();
  const data = usePagedList(
    offset => api.conversations({ offset, limit: 50 }),
    [api, user?.id, preferences?.serverUrl, preferences?.instance?.id],
  );
  const pins = useConversationPins();
  const reducedMotion = useChatReducedMotion();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [retained, setRetained] = useState<{
    owner: string | null;
    items: Conversation[];
  }>({ owner: pins.key, items: [] });
  const [toast, setToast] = useState<{
    owner: string | null;
    message: string;
    undo: PinUndo;
  } | null>(null);
  const active = useRef({ mounted: true, owner: pins.key });
  active.current.owner = pins.key;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRequest = useRef(0);
  useEffect(() => {
    active.current.mounted = true;
    return () => {
      active.current.mounted = false;
      menuRequest.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    menuRequest.current++;
    setMenu(null);
    setToast(null);
    if (timer.current) clearTimeout(timer.current);
  }, [pins.key]);
  const sections = useMemo(
    () =>
      conversationSections(
        data.items,
        pins.items,
        retained.owner === pins.key ? retained.items : [],
      ),
    [data.items, pins.items, pins.key, retained],
  );
  const animate = () => {
    if (reducedMotion === false)
      LayoutAnimation.configureNext({
        duration: 240,
        update: { type: LayoutAnimation.Types.easeInEaseOut },
        create: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
        delete: {
          type: LayoutAnimation.Types.easeInEaseOut,
          property: LayoutAnimation.Properties.opacity,
        },
      });
  };
  const openMenu = (
    item: Conversation,
    event: GestureResponderEvent,
    row: View | null,
  ) => {
    const request = ++menuRequest.current;
    const owner = pins.key;
    const anchor = {
      x: event.nativeEvent.pageX ?? 20,
      y: event.nativeEvent.pageY ?? 100,
      width: 0,
      height: 0,
    };
    setMenu({ item, owner, anchor });
    row?.measureInWindow?.((x, y, width, height) => {
      if (
        active.current.mounted &&
        active.current.owner === owner &&
        menuRequest.current === request
      )
        setMenu({ item, owner, anchor: { x, y, width, height } });
    });
  };
  const closeMenu = () => {
    menuRequest.current++;
    setMenu(null);
  };
  const toggle = async (item: Conversation) => {
    if (!pins.enabled) return;
    const owner = pins.key;
    closeMenu();
    // A pin from an older page stays visible when unpinned, without fetching every page.
    setRetained(old => ({
      owner,
      items: [
        ...(old.owner === owner ? old.items : []).filter(
          row => row.id !== item.id,
        ),
        item,
      ],
    }));
    animate();
    try {
      const undo = await pins.owner.toggle(item);
      if (!active.current.mounted || active.current.owner !== owner) return;
      if (timer.current) clearTimeout(timer.current);
      setToast({
        owner,
        undo,
        message:
          undo.index < 0 ? '已置顶，下次更快找到' : '已取消置顶，回到时间顺序',
      });
      timer.current = setTimeout(() => setToast(null), 5500);
    } catch {
      /* The shared store renders an explicit save failure and rolls back. */
    }
  };
  const undo = async () => {
    if (!toast || toast.owner !== pins.key || !pins.enabled) return;
    const owner = pins.key;
    animate();
    try {
      await pins.owner.undo(toast.undo);
      if (active.current.mounted && active.current.owner === owner) {
        setToast(null);
        if (timer.current) clearTimeout(timer.current);
      }
    } catch {
      /* Preserve undo for a user-initiated retry. */
    }
  };
  const renderSection = (
    title: string,
    items: Conversation[],
    pinned: boolean,
  ) =>
    !items.length ? null : (
      <View
        style={css.section}
        testID={pinned ? 'pinned-conversations' : 'recent-conversations'}
      >
        <View style={css.sectionHeading}>
          {pinned && <Icon name="pin" size={13} color={colors.action} />}
          <Text style={css.sectionLabel}>{title}</Text>
          <Text style={css.count}>{items.length}</Text>
        </View>
        <View style={[css.list, pinned && css.pinnedList]}>
          {items.map(item => (
            <ConversationRow
              key={item.id}
              item={item}
              pinned={pinned}
              formatDate={formatDate}
              onOpen={() => navigate({ name: 'chat', conversationId: item.id })}
              onMenu={openMenu}
            />
          ))}
        </View>
      </View>
    );
  const visibleMenu = menu?.owner === pins.key ? menu : null;
  return (
    <View style={s.fill}>
      <ScrollView
        contentContainerStyle={[
          s.content,
          { paddingBottom: toast?.owner === pins.key ? 106 : 28 },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={data.loading && data.items.length > 0}
            onRefresh={data.refresh}
          />
        }
      >
        <View style={css.heading}>
          <View style={s.fill}>
            <Text style={css.title}>对话记录</Text>
            <Text style={css.subtitle}>接着上次的想法，继续聊。</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="开启新对话"
            style={css.newConversation}
            onPress={() => navigate({ name: 'chat' })}
          >
            <Icon name="plus" size={21} color={colors.accent} />
          </Pressable>
        </View>
        <ErrorNotice message={data.error} retry={data.refresh} />
        <ErrorNotice
          message={pins.error}
          retry={
            !pins.ready && !pins.loading
              ? () => {
                  void pins.owner.load();
                }
              : undefined
          }
        />
        {data.loading && !data.items.length && !pins.items.length && (
          <Loading />
        )}
        {renderSection('置顶', sections.pinned, true)}
        {renderSection('最近', sections.recent, false)}
        {!sections.pinned.length &&
          !sections.recent.length &&
          !data.loading &&
          !data.error && (
            <Empty
              symbol="✧"
              title="还没有对话记录"
              body="聊过的内容会保存在你的账号里。"
            />
          )}
        {data.hasMore && (
          <Button
            variant="ghost"
            disabled={data.loading}
            onPress={data.loadMore}
          >
            {data.loading ? '正在加载…' : '加载更多对话'}
          </Button>
        )}
        {(sections.pinned.length > 0 || sections.recent.length > 0) && (
          <Text style={css.hint}>长按对话，或点击 ··· 管理置顶</Text>
        )}
      </ScrollView>
      {visibleMenu && (
        <ConversationPinMenu
          item={visibleMenu.item}
          anchor={visibleMenu.anchor}
          pinned={pins.items.some(item => item.id === visibleMenu.item.id)}
          busy={!pins.enabled}
          onPin={() => {
            void toggle(visibleMenu.item);
          }}
          onClose={closeMenu}
          onOpen={() => {
            closeMenu();
            navigate({ name: 'chat', conversationId: visibleMenu.item.id });
          }}
        />
      )}
      {toast?.owner === pins.key && (
        <View
          accessibilityRole="alert"
          style={css.toast}
          testID="conversation-pin-toast"
        >
          <Icon name="check" size={16} color="#D0DEFE" />
          <Text style={css.toastText}>{toast.message}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="撤销置顶操作"
            disabled={!pins.enabled}
            onPress={() => {
              void undo();
            }}
            style={css.undo}
          >
            <Text style={css.undoText}>撤销</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const css = StyleSheet.create({
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    marginBottom: 24,
  },
  title: { fontSize: 25, lineHeight: 35, fontWeight: '500', color: colors.ink },
  subtitle: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.secondary,
    marginTop: 6,
  },
  newConversation: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.blueLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginBottom: 19 },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 9,
    marginBottom: 9,
  },
  sectionLabel: {
    fontSize: 12,
    lineHeight: 19,
    fontWeight: '500',
    color: colors.secondary,
  },
  count: { fontSize: 11, color: colors.muted },
  list: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    overflow: 'hidden',
  },
  pinnedList: { borderWidth: 1, borderColor: '#DFE7F7' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#EDF0F5',
    minHeight: 86,
  },
  pinnedRow: { backgroundColor: '#FBFCFF' },
  open: { flex: 1, minWidth: 0, paddingLeft: 17, paddingVertical: 15 },
  name: { fontSize: 14, lineHeight: 23, color: colors.ink, fontWeight: '500' },
  metadata: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 7,
    marginTop: 6,
  },
  date: { fontSize: 11, lineHeight: 18, color: colors.secondary },
  pinMark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pinLabel: { fontSize: 11, color: colors.action },
  more: {
    width: 44,
    minHeight: 48,
    marginHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  hint: {
    fontSize: 11,
    lineHeight: 19,
    textAlign: 'center',
    color: colors.secondary,
    marginTop: 4,
  },
  scrim: { flex: 1, backgroundColor: 'rgba(48,56,73,0.10)' },
  menu: {
    position: 'absolute',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 19,
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#303849',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
  },
  menuTitle: {
    fontSize: 12,
    lineHeight: 20,
    color: colors.secondary,
    paddingHorizontal: 17,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  menuAction: {
    minHeight: 51,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 17,
    paddingVertical: 13,
  },
  pinAction: {
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '500',
    color: colors.action,
    flexShrink: 1,
  },
  menuActionText: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.ink,
    flexShrink: 1,
  },
  cancel: {
    minHeight: 49,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 5,
    borderTopColor: '#F5F7FA',
    paddingVertical: 9,
  },
  menuCaption: { fontSize: 13, color: colors.secondary },
  disabled: { opacity: 0.4 },
  toast: {
    position: 'absolute',
    bottom: 16,
    left: 20,
    right: 20,
    paddingLeft: 15,
    paddingRight: 7,
    minHeight: 56,
    backgroundColor: '#303C53',
    borderRadius: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    elevation: 8,
  },
  toastText: {
    fontSize: 12,
    lineHeight: 20,
    color: '#FFFFFF',
    flex: 1,
    paddingVertical: 10,
  },
  undo: {
    minWidth: 48,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  undoText: { fontSize: 12, color: '#CFDDFF' },
});

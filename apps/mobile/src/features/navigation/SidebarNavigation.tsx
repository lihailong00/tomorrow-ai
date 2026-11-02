import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp, type MainTab, type Route } from '../../app/context';
import type { Conversation } from '../../domain/types';
import { errorMessage } from '../../api/client';
import { Text } from '../../ui/Text';
import { AssistantOrb, Icon } from '../../ui/visuals';
import { useChatReducedMotion } from '../../ui/ChatMotion';
import { useConversationPins } from '../conversations/useConversationPins';
import {
  searchSidebar,
  sidebarActiveId,
  sidebarGroups,
  sidebarTools,
  sidebarUtilities,
  type SidebarDestination,
  type SidebarItem,
} from './sidebarModel';

type SidebarProps = {
  visible: boolean;
  route: Route;
  tab: MainTab;
  onClose: () => void;
  onSelect: (destination: SidebarDestination) => void;
};
export function SidebarNavigation(props: SidebarProps) {
  const { api, user, preferences } = useApp();
  return (
    <SidebarPanel
      key={`${api.baseUrl}:${preferences.instance?.id ?? ''}:${user?.id ?? ''}`}
      {...props}
    />
  );
}
function SidebarPanel({
  visible,
  route,
  tab,
  onClose,
  onSelect,
}: SidebarProps) {
  const { api, user, preferences } = useApp();
  const { width, height, fontScale } = useWindowDimensions();
  const drawerWidth = Math.min(340, Math.max(240, width - 52));
  const reduced = useChatReducedMotion();
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [present, setPresent] = useState(visible);
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const [unread, setUnread] = useState(false);
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [recentError, setRecentError] = useState('');
  const [searching, setSearching] = useState(false);
  const sequence = useRef(0);
  const recentRequest = useRef(0);
  const active = useRef(false);
  const scroll = useRef<ScrollView>(null);
  const lastScroll = useRef(0);
  const pins = useConversationPins();
  const term = query.trim();
  const activeId = sidebarActiveId(route, tab);
  useEffect(() => {
    if (visible && sidebarTools.some(item => item.id === activeId)) setMore(true);
  }, [visible, activeId]);
  const searchResults = useMemo(() => searchSidebar(query), [query]);
  const conversationResults = useMemo(() => {
    const found = new Map<string, Conversation>();
    [...pins.items, ...recent].forEach(item => {
      if (item.title.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
        found.set(item.id, item);
    });
    return term ? [...found.values()].slice(0, 30) : [];
  }, [pins.items, recent, term]);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    const generation = ++sequence.current;
    progress.stopAnimation();
    if (visible) setPresent(true);
    if (reduced !== false) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setPresent(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 260 : 190,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (
        finished &&
        active.current &&
        sequence.current === generation &&
        !visible
      )
        setPresent(false);
    });
    return () => {
      animation.stop();
      progress.stopAnimation();
    };
  }, [visible, progress, reduced]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let current = true;
    void api
      .request<{ items: { read: boolean }[] }>(
        '/notifications?read=false&limit=1&offset=0',
        'GET',
        undefined,
        controller.signal,
      )
      .then(result => {
        if (current)
          setUnread(
            Array.isArray(result?.items) &&
              result.items.some(item => item.read === false),
          );
      })
      .catch(() => {
        if (current) setUnread(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, visible]);
  useEffect(() => {
    const generation = ++recentRequest.current;
    if (!visible || !term) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    let current = true;
    setSearching(true);
    setRecentError('');
    const timer = setTimeout(() => {
      void api
        .request<{ items: Conversation[] }>(
          '/conversations?offset=0&limit=50',
          'GET',
          undefined,
          controller.signal,
        )
        .then(result => {
          if (!Array.isArray(result?.items))
            throw new Error('暂时无法读取最近对话。');
          if (current && recentRequest.current === generation)
            setRecent(
              result.items
                .filter(
                  item =>
                    item &&
                    typeof item.id === 'string' &&
                    typeof item.title === 'string',
                )
                .slice(0, 50),
            );
        })
        .catch(failure => {
          if (current && recentRequest.current === generation) {
            setRecent([]);
            setRecentError(errorMessage(failure));
          }
        })
        .finally(() => {
          if (current && recentRequest.current === generation)
            setSearching(false);
        });
    }, 280);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, visible, term]);

  const choose = (destination: SidebarDestination) => {
    if (!visible || !active.current) return;
    Keyboard.dismiss();
    setQuery('');
    setRecent([]);
    setRecentError('');
    onSelect(destination);
    onClose();
  };
  const utility = (id: string) =>
    sidebarUtilities.find(item => item.id === id)!;
  const close = () => {
    Keyboard.dismiss();
    onClose();
  };
  const renderRow = (item: SidebarItem) => (
    <Pressable
      key={item.id}
      testID={'sidebar-row-' + item.id}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityState={{ selected: activeId === item.id }}
      onPress={() => choose(item.destination)}
      style={({ pressed }) => [
        v.row,
        activeId === item.id && v.selected,
        pressed && v.pressed,
      ]}
    >
      <Icon
        name={item.icon}
        size={19}
        color={activeId === item.id ? '#5277B9' : '#7C8798'}
      />
      <Text
        numberOfLines={1}
        style={[v.rowText, activeId === item.id && v.selectedText]}
      >
        {item.label}
      </Text>
    </Pressable>
  );
  const service =
    preferences.instance?.deployment_mode === 'official'
      ? '官方服务'
      : preferences.instance?.deployment_mode === 'self_hosted'
      ? '自建服务'
      : '服务待验证';
  if (!present || !user) return null;
  return (
    <Modal
      visible={present}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View
        style={v.overlay}
        testID="sidebar-overlay"
        pointerEvents={visible ? 'auto' : 'none'}
      >
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: progress }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭侧边栏"
            onPress={close}
            style={v.scrim}
          />
        </Animated.View>
        <Animated.View
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={[
            v.drawer,
            {
              width: drawerWidth,
              transform: [
                {
                  translateX: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-drawerWidth, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <SafeAreaView edges={['top', 'bottom']} style={v.safe}>
            <View
              style={[v.header, height < 500 && v.compactHeader]}
              testID="sidebar-fixed-header"
            >
              <View style={v.brand}>
                <AssistantOrb size={32} />
                <View style={v.brandCopy}>
                  <Text style={v.name}>妥啦</Text>
                  {height > 500 && fontScale < 1.6 ? (
                    <Text style={v.tagline}>陪你理清每一天</Text>
                  ) : null}
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    unread ? '消息通知，有未读消息' : '消息通知'
                  }
                  onPress={() => choose(utility('notifications').destination)}
                  style={v.headerButton}
                >
                  <Icon name="bell" size={18} color="#7C8798" />
                  {unread ? <View style={v.unread} /> : null}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="收起侧边栏"
                  onPress={close}
                  style={v.headerButton}
                >
                  <Icon name="panelLeft" size={19} color="#7C8798" />
                </Pressable>
              </View>
              <View style={v.search}>
                <Icon name="search" size={16} color="#8790A1" />
                <TextInput
                  accessibilityLabel="搜索功能或对话"
                  placeholder="搜索功能或对话"
                  placeholderTextColor="#8A93A2"
                  value={query}
                  onChangeText={value => {
                    setQuery(value);
                    scroll.current?.scrollTo({ y: 0, animated: false });
                  }}
                  autoCorrect={false}
                  autoCapitalize="none"
                  maxLength={100}
                  style={v.searchInput}
                />
                {query ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="清空侧栏搜索"
                    onPress={() => setQuery('')}
                    style={v.clear}
                  >
                    <Icon name="close" size={15} color="#8790A1" />
                  </Pressable>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新对话"
                onPress={() =>
                  choose({ kind: 'route', route: { name: 'chat' } })
                }
                style={v.newChat}
              >
                <Icon name="compose" size={19} color="#4569AC" />
                <Text style={v.newChatText}>新对话</Text>
                <Text style={v.newPlus}>＋</Text>
              </Pressable>
            </View>
            <ScrollView
              ref={scroll}
              testID="sidebar-scroll-content"
              style={v.scroll}
              contentContainerStyle={v.scrollBody}
              keyboardShouldPersistTaps="handled"
              onScroll={event => {
                lastScroll.current = event.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={64}
              onLayout={() => {
                if (lastScroll.current > 0)
                  scroll.current?.scrollTo({
                    y: lastScroll.current,
                    animated: false,
                  });
              }}
            >
              {term ? (
                <>
                  <Text style={v.groupTitle}>功能</Text>
                  {searchResults.map(renderRow)}
                  {!searchResults.length ? (
                    <Text style={v.caption}>没有匹配的功能</Text>
                  ) : null}
                  <Text style={[v.groupTitle, v.searchGroup]}>
                    置顶与最近对话
                  </Text>
                  {conversationResults.map(item => (
                    <Pressable
                      key={item.id}
                      accessibilityRole="button"
                      accessibilityLabel={'打开对话：' + item.title}
                      onPress={() =>
                        choose({
                          kind: 'route',
                          route: { name: 'chat', conversationId: item.id },
                        })
                      }
                      style={v.row}
                    >
                      <Icon
                        name={
                          pins.items.some(pin => pin.id === item.id)
                            ? 'pin'
                            : 'history'
                        }
                        size={17}
                        color="#7C8798"
                      />
                      <Text numberOfLines={1} style={v.rowText}>
                        {item.title}
                      </Text>
                    </Pressable>
                  ))}
                  {searching ? (
                    <Text accessibilityLiveRegion="polite" style={v.caption}>
                      正在查找最近的对话…
                    </Text>
                  ) : recentError ? (
                    <Text style={v.caption}>
                      最近对话暂不可用，仍可使用上方功能搜索。
                    </Text>
                  ) : !conversationResults.length ? (
                    <Text style={v.caption}>最近 50 条对话中没有匹配项</Text>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="查看全部对话记录"
                    onPress={() =>
                      choose({
                        kind: 'route',
                        route: { name: 'conversations' },
                      })
                    }
                    style={v.row}
                  >
                    <Text style={v.link}>查看全部对话记录 →</Text>
                  </Pressable>
                </>
              ) : (
                sidebarGroups.map((group, index) => (
                  <View
                    key={group.title}
                    style={index > 0 ? v.groupGap : undefined}
                  >
                    <Text style={v.groupTitle}>{group.title}</Text>
                    {group.items.map(renderRow)}
                    {index === sidebarGroups.length - 1 ? (
                      <>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="更多工具"
                          accessibilityState={{ expanded: more }}
                          onPress={() => setMore(value => !value)}
                          style={v.row}
                        >
                          <Icon name="more" size={19} color="#7C8798" />
                          <Text style={v.rowText}>更多工具</Text>
                          <Icon
                            name={more ? 'chevronDown' : 'chevronRight'}
                            size={16}
                            color="#929BAD"
                          />
                        </Pressable>
                        {more ? (
                          <View style={v.toolIndent}>
                            {sidebarTools.map(renderRow)}
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                ))
              )}
            </ScrollView>
            <View style={v.footer} testID="sidebar-fixed-footer">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'服务连接：' + service}
                onPress={() => choose(utility('server').destination)}
                style={v.service}
              >
                <Icon name="shield" size={16} color="#7188B3" />
                <Text numberOfLines={1} style={v.serviceText}>
                  {service}
                  <Text style={v.serviceHint}>
                    {preferences.connectionError
                      ? ' · 需检查连接'
                      : ' · 个人空间'}
                  </Text>
                </Text>
                <Icon name="chevronRight" size={14} color="#8294B5" />
              </Pressable>
              <View style={v.footerRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="我的账户"
                  onPress={() =>
                    choose({
                      kind: 'route',
                      route: { name: 'settings', section: 'account' },
                    })
                  }
                  style={v.account}
                >
                  <View style={v.avatar}>
                    <Text style={v.avatarText}>
                      {(user.name || '我').slice(0, 1)}
                    </Text>
                  </View>
                  <View style={v.accountCopy}>
                    <Text numberOfLines={1} style={v.accountName}>
                      {user.name || '我的账户'}
                    </Text>
                    {fontScale < 1.6 ? (
                      <Text style={v.accountHint}>个人空间</Text>
                    ) : null}
                  </View>
                </Pressable>
                {[utility('settings'), utility('help')].map(item => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    onPress={() => choose(item.destination)}
                    style={v.footerAction}
                  >
                    <Icon name={item.icon} size={18} color="#7C8798" />
                    <Text style={v.footerActionLabel}>
                      {item.id === 'help' ? '帮助' : item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const v = StyleSheet.create({
  overlay: { flex: 1 },
  scrim: { flex: 1, backgroundColor: 'rgba(38,52,72,0.28)' },
  drawer: {
    height: '100%',
    backgroundColor: '#FCFCFE',
    borderTopRightRadius: 28,
    borderBottomRightRadius: 28,
    overflow: 'hidden',
    elevation: 10,
    shadowColor: '#283C4E',
    shadowOffset: { width: 8, height: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 22,
  },
  safe: { flex: 1 },
  header: {
    paddingTop: 20,
    paddingHorizontal: 20,
    paddingBottom: 15,
    backgroundColor: '#F6F8FF',
  },
  compactHeader: { paddingTop: 4, paddingBottom: 8 },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginBottom: 17,
  },
  brandCopy: { flex: 1, minWidth: 0 },
  name: { color: '#293343', fontSize: 20, fontWeight: '500', letterSpacing: 1 },
  tagline: { color: '#707B8D', fontSize: 11, marginTop: 2 },
  headerButton: {
    width: 34,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unread: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#7193CE',
    top: 9,
    right: 6,
  },
  search: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#E9EDF5',
    borderRadius: 12,
    paddingHorizontal: 11,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    minHeight: 42,
    paddingVertical: 8,
    paddingHorizontal: 0,
    fontSize: 14,
    color: '#293343',
  },
  clear: {
    minWidth: 26,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 13,
    paddingVertical: 12,
    minHeight: 44,
    backgroundColor: '#E4ECFC',
    borderRadius: 13,
    marginTop: 12,
  },
  newChatText: { flex: 1, color: '#4569AC', fontSize: 14, fontWeight: '500' },
  newPlus: { color: '#8093B4', fontSize: 15 },
  scroll: { flex: 1 },
  scrollBody: { paddingHorizontal: 15, paddingTop: 9, paddingBottom: 24 },
  groupGap: { marginTop: 23 },
  groupTitle: {
    color: '#858F9E',
    fontSize: 11,
    letterSpacing: 0.4,
    paddingHorizontal: 13,
    paddingTop: 6,
    paddingBottom: 8,
  },
  searchGroup: { marginTop: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 11,
    gap: 12,
  },
  rowText: { flex: 1, minWidth: 0, color: '#596579', fontSize: 14 },
  selected: { backgroundColor: '#E8EEFB' },
  selectedText: { color: '#365B9C', fontWeight: '500' },
  pressed: { opacity: 0.65 },
  toolIndent: { paddingLeft: 7 },
  caption: {
    color: '#707B8D',
    fontSize: 12,
    lineHeight: 20,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  link: { color: '#4A71C0', fontSize: 13 },
  footer: {
    paddingHorizontal: 19,
    paddingTop: 11,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: '#E9ECF2',
    backgroundColor: '#FCFCFE',
  },
  service: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
    paddingHorizontal: 11,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: '#F1F4FB',
    marginBottom: 9,
  },
  serviceText: { flex: 1, minWidth: 0, color: '#596579', fontSize: 12 },
  serviceHint: { color: '#8D96A5' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  account: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 44,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#F3E5DE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#9C7A65', fontSize: 13 },
  accountCopy: { flex: 1, minWidth: 0 },
  accountName: { color: '#4D586B', fontSize: 13, fontWeight: '500' },
  accountHint: { color: '#9299A6', fontSize: 10, marginTop: 1 },
  footerAction: {
    minWidth: 40,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  footerActionLabel: { color: '#7C8798', fontSize: 10 },
});

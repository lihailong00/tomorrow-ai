import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { newRequestId } from '../../api/client';
import { MemoryCaptureEditor } from './MemoryCaptureEditor';
import { useAction, useApp } from '../../app/context';
import type { Memory } from '../../domain/types';
import { ErrorNotice, Loading } from '../../ui/components';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import {
  memoryEffect,
  memoryReviewPrompt,
  memoryTryPrompt,
} from './memoryModel';
import { useMemoryCollection } from './useMemoryCollection';
import { AutomaticMemorySettings } from './AutomaticMemory';
import { MemoryConfirmationCard } from './MemoryConfirmationCard';
import { MemorySourceCard } from './MemorySourceCard';
import {
  getMemoryConfirmation,
  memoryCategories,
  memoryCategory,
  memoryGroup,
  memoryGroups,
  memorySource,
  type MemoryGroup,
} from './memoryPresentation';

const appearance = {
  ink: '#252E43',
  muted: '#59667D',
  accent: '#435CB5',
  paper: '#FFFFFF',
  soft: '#EDF0FB',
  background: '#F5F6FA',
  line: '#E4E9F3',
  danger: '#A13851',
};

const primaryGroups = Object.entries(memoryGroups) as [MemoryGroup, string][];
const rowSymbols = {
  preference: { icon: 'memory', background: '#EEEDFD', color: '#6256A8' },
  goal: { icon: 'flag', background: '#F9EFDF', color: '#915D30' },
  fact: { icon: 'person', background: '#E7F2EE', color: '#3F7161' },
  pending: { icon: 'clock', background: '#F0F2F8', color: appearance.muted },
} as const;
type HomeFilter = 'all' | 'pending' | MemoryGroup;

type Pane =
  | { kind: 'all' }
  | { kind: 'settings' }
  | { kind: 'detail'; memory: Memory }
  | { kind: 'edit'; memory?: Memory; entry: string }
  | null;

function MemoryDivider() {
  return <View style={m.divider} />;
}

function matchesQuery(memory: Memory, query: string) {
  return `${memory.title}\n${memory.content}\n${memorySource(memory.source).label}\n${memoryGroups[memoryGroup(memory.kind)]}`
    .toLocaleLowerCase()
    .includes(query);
}

function MemoryAction({
  label,
  onPress,
  secondary = false,
  busy = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy || disabled}
      onPress={onPress}
      style={({ pressed }) => [
        m.action,
        secondary && m.actionSecondary,
        (busy || disabled) && m.disabled,
        pressed && m.pressed,
      ]}
    >
      {busy && (
        <ActivityIndicator
          size="small"
          color={secondary ? appearance.accent : appearance.paper}
        />
      )}
      <Text style={[m.actionText, secondary && m.actionSecondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function MemoryRow({
  memory,
  onPress,
  inLibrary = false,
}: {
  memory: Memory;
  onPress: () => void;
  inLibrary?: boolean;
}) {
  const { formatDate } = useApp();
  const pending = getMemoryConfirmation(memory);
  const group = memoryGroup(memory.kind);
  const symbol = rowSymbols[pending ? 'pending' : group];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看记忆：${
        pending ? '体重待确认' : memory.title || memory.content
      }`}
      onPress={onPress}
      style={({ pressed }) => [
        m.memoryRow,
        pressed && m.pressed,
      ]}
    >
      {inLibrary && (
        <View style={[m.rowSymbol, { backgroundColor: symbol.background }]}>
          <Icon name={symbol.icon} size={18} color={symbol.color} />
        </View>
      )}
      <View style={m.flex}>
        <Text style={m.rowContent} numberOfLines={2}>
          {pending ? '体重待确认' : memory.content}
        </Text>
        <Text style={m.rowSource} numberOfLines={1}>
          {pending ? '待确认' : inLibrary ? memoryGroups[group] : memoryCategory(memory)}
          {' · '}
          {inLibrary ? formatDate(memory.updated_at) : `${memorySource(memory.source).label} · ${formatDate(memory.updated_at)}`}
        </Text>
      </View>
      <Icon name="chevronRight" size={15} color={appearance.muted} />
    </Pressable>
  );
}

function MemoryEntry(props: {
  memory?: Memory;
  onSaved: (memory: Memory) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  return <MemoryCaptureEditor {...props} embedded />;
}

export function MemoryHome() {
  const { api, revision, invalidate, navigate } = useApp();
  const data = useMemoryCollection(api, revision);
  const { saved, pending } = useMemo(() => {
    const saved: Memory[] = [];
    const pending: Memory[] = [];
    const recent = [...data.items].sort((a, b) =>
      Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    for (const item of recent) {
      (getMemoryConfirmation(item) ? pending : saved).push(item);
    }
    return { saved, pending };
  }, [data.items]);
  const [filter, setFilter] = useState<HomeFilter>('all');
  const [pane, setPane] = useState<Pane>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [category, setCategory] = useState('全部');
  const [editBusy, setEditBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleted, setDeleted] = useState<{
    memory: Memory;
    requestId: string;
  } | null>(null);
  const action = useAction();
  const busy = editBusy || action.busy;
  const searchQuery = query.trim().toLocaleLowerCase();
  const library = useMemo(
    () => (filter === 'pending' ? pending : saved).filter(item =>
      (filter === 'all' || filter === 'pending' || memoryGroup(item.kind) === filter) &&
      (!searchQuery || matchesQuery(item, searchQuery)),
    ),
    [filter, pending, saved, searchQuery],
  );
  const visible = useMemo(
    () => data.items.filter(item =>
      (category === '全部' || (category === '待确认'
        ? !!getMemoryConfirmation(item) : memoryCategory(item) === category)) &&
      (!searchQuery || matchesQuery(item, searchQuery)),
    ),
    [category, data.items, searchQuery],
  );
  useEffect(() => {
    if (!menuOpen) return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      setMenuOpen(false);
      return true;
    });
    return () => listener.remove();
  }, [menuOpen]);
  const openDetail = (memory: Memory) => {
    Keyboard.dismiss();
    action.setError(null);
    setPane({ kind: 'detail', memory });
  };
  const openAll = () => {
    action.setError(null);
    setMenuOpen(false);
    setCategory('全部');
    setPane({ kind: 'all' });
  };
  const openEditor = (memory?: Memory) => {
    Keyboard.dismiss();
    action.setError(null);
    setPane({ kind: 'edit', memory, entry: newRequestId() });
  };
  const close = () => {
    if (!busy) {
      setPane(null);
      action.setError(null);
    }
  };
  const forget = (memory: Memory) => {
    const entry = paneRef.current;
    Alert.alert(
      '忘记这件事？',
      '之后的回答不再参考这条记忆，原始对话会保留。',
      [
        { text: '保留', style: 'cancel' },
        {
          text: '忘记',
          style: 'destructive',
          onPress: () => {
            if (paneRef.current !== entry) return;
            action.run(async ({ isCurrent }) => {
              await api.deleteMemory(memory.id);
              if (!isCurrent()) return;
              data.updateLocal(null, memory.id);
              setDeleted({ memory, requestId: newRequestId() });
              setNotice('已忘记，之后的回答不再参考这件事。');
              setPane(null);
              invalidate();
            });
          },
        },
      ],
    );
  };
  const restore = () => {
    if (!deleted) return;
    const entry = deleted;
    action.run(async ({ isCurrent }) => {
      const memory = await api.saveMemory({
        title: entry.memory.title,
        content: entry.memory.content,
        kind: entry.memory.kind,
        source: entry.memory.source,
        client_request_id: entry.requestId,
      });
      if (!isCurrent()) return;
      data.updateLocal(memory);
      setDeleted(null);
      setNotice('这条记忆已恢复。');
      invalidate();
    });
  };
  return (
    <>
      <View style={m.home}>
        <View style={m.heading}>
          <View style={m.flex}>
            <Text accessibilityRole="header" style={m.title}>记忆</Text>
            <Text style={m.subtitle}>把想留住的事记下来。</Text>
          </View>
          <View style={m.headingActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="添加一条记忆"
              onPress={() => openEditor()} style={({ pressed }) => [m.add, pressed && m.pressed]}>
              <Icon name="plus" size={16} color={appearance.accent} />
              <Text style={m.addText}>新增</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="更多记忆操作"
              accessibilityState={{ expanded: menuOpen }}
              onPress={() => { Keyboard.dismiss(); setMenuOpen(true); }}
              style={({ pressed }) => [m.iconButton, pressed && m.pressed]}>
              <Icon name="more" size={22} color={appearance.muted} />
            </Pressable>
          </View>
        </View>
        <FlatList
          testID="memory-understand-home"
          data={library}
          keyExtractor={memory => memory.id}
          renderItem={({ item }) => (
            <MemoryRow memory={item} onPress={() => openDetail(item)} inLibrary />
          )}
          ItemSeparatorComponent={MemoryDivider}
          contentContainerStyle={m.page}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          refreshControl={
            <RefreshControl refreshing={data.loading && data.items.length > 0}
              onRefresh={data.refresh} tintColor={appearance.accent} />
          }
          ListHeaderComponent={
            <>
              <View style={m.search}>
                <Icon name="search" size={17} color={appearance.muted} />
                <TextInput accessibilityLabel="搜索记忆" placeholder="搜索记忆"
                  placeholderTextColor={appearance.muted} autoCorrect={false}
                  returnKeyType="search" value={query} onChangeText={setQuery} style={m.searchInput} />
                {!!query && (
                  <Pressable accessibilityRole="button" accessibilityLabel="清空搜索"
                    onPress={() => setQuery('')} style={m.iconButton}>
                    <Icon name="close" size={16} color={appearance.muted} />
                  </Pressable>
                )}
              </View>
              <View style={m.homeFilters}>
                {([['all', '全部'], ...primaryGroups, ...(pending.length || filter === 'pending'
                  ? [['pending', '待确认']] : [])] as [HomeFilter, string][]).map(([id, label]) => (
                  <Pressable key={id} accessibilityRole="button"
                    accessibilityLabel={id === 'pending' ? '查看待确认的记忆' : `筛选：${label}`}
                    accessibilityState={{ selected: filter === id }} onPress={() => setFilter(id)}
                    style={({ pressed }) => [m.homeFilter, filter === id && m.homeFilterSelected, pressed && m.pressed]}>
                    <Text style={[m.homeFilterText, filter === id && m.homeFilterTextSelected]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={m.libraryHeading}>
                <Text accessibilityRole="header" style={m.sectionTitle}>
                  {searchQuery ? '搜索结果' : filter === 'pending' ? '待确认' : '最近更新'}
                </Text>
                {(data.items.length > 0 || (!data.loading && !data.error)) && (
                  <Text style={m.small} accessibilityLiveRegion="polite">
                    {library.length}{filter === 'all' && !searchQuery && data.hasMore ? '+' : ''} 条
                  </Text>
                )}
              </View>
            </>
          }
          ListEmptyComponent={
            data.loading ? <Loading /> : data.error ? null : (
              <View style={m.empty}>
                <Text style={m.emptyTitle}>
                  {searchQuery ? data.hasMore
                    ? '已加载的记忆中没有匹配项，可继续加载后查找。'
                    : '没有找到匹配的记忆。' : filter === 'pending' ? '没有待确认的记忆' :
                    saved.length ? '这个分类还没有记忆' : '先告诉我一件关于你的事'}
                </Text>
                {!searchQuery && filter === 'all' && !saved.length && !data.hasMore && (
                  <MemoryAction label="告诉我一件事" secondary onPress={() => openEditor()} />
                )}
              </View>
            )
          }
          ListFooterComponent={
            <>
              <ErrorNotice message={data.error} retry={data.refresh} />
              {data.hasMore && (
                <MemoryAction label="加载更多记忆" secondary busy={data.loading} onPress={data.loadMore} />
              )}
            </>
          }
        />
        <Pressable accessibilityRole="button" accessibilityLabel="私密资料：地址、银行卡、身份证"
          onPress={() => navigate({ name: 'privateVault' })}
          style={({ pressed }) => [m.vault, pressed && m.pressed]}>
          <Icon name="lock" size={17} color={appearance.accent} />
          <Text style={[m.vaultTitle, m.flex]}>私密资料</Text>
          <Text style={m.small}>本机加密</Text>
          <Icon name="chevronRight" size={15} color={appearance.muted} />
        </Pressable>
        {!!notice && (
          <View accessibilityLiveRegion="polite" style={m.notice}>
            <Text style={[m.noticeText, m.flex]}>{notice}</Text>
            {deleted && (
              <Pressable accessibilityRole="button" accessibilityLabel="撤销忘记"
                disabled={action.busy} onPress={restore} style={m.noticeButton}>
                <Text style={m.noticeText}>{action.busy ? '恢复中…' : '撤销'}</Text>
              </Pressable>
            )}
            <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" disabled={action.busy}
              onPress={() => { setNotice(''); setDeleted(null); action.setError(null); }} style={m.noticeButton}>
              <Icon name="close" size={16} color={appearance.paper} />
            </Pressable>
          </View>
        )}
        {!pane && <ErrorNotice message={action.error} retry={deleted ? restore : undefined} />}
        {menuOpen && (
          <View style={m.menuLayer}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭记忆菜单"
              onPress={() => setMenuOpen(false)} style={StyleSheet.absoluteFill} />
            <View style={m.menu} accessibilityViewIsModal>
              <Pressable accessibilityRole="button" accessibilityLabel="从对话里整理记忆，先列出候选供你确认"
                onPress={() => { setMenuOpen(false); navigate({ name: 'chat', prompt: memoryReviewPrompt }); }}
                style={({ pressed }) => [m.tool, pressed && m.pressed]}>
                <Icon name="sparkles" size={17} color={appearance.accent} />
                <Text style={m.toolText}>从对话整理</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="按细分类查找"
                onPress={openAll} style={({ pressed }) => [m.tool, pressed && m.pressed]}>
                <Icon name="search" size={17} color={appearance.accent} />
                <Text style={m.toolText}>按细分类查找</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="记忆设置"
                onPress={() => { setMenuOpen(false); setPane({ kind: 'settings' }); }}
                style={({ pressed }) => [m.tool, pressed && m.pressed]}>
                <Icon name="settings" size={17} color={appearance.accent} />
                <Text style={m.toolText}>记忆设置</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
      <Modal
        visible={pane !== null}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={close}
      >
        <KeyboardAvoidingView
          style={m.modal}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭记忆详情"
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          <View style={[m.sheet, pane?.kind === 'settings' && m.settingsSheet]} accessibilityViewIsModal>
            <View style={m.handle} />
            <View style={m.sheetHeading}>
              <Text style={m.sheetTitle}>
                {pane?.kind === 'all'
                  ? '搜索记忆'
                  : pane?.kind === 'settings'
                  ? '记忆设置'
                  : pane?.kind === 'edit'
                  ? pane.memory
                    ? '修改记忆'
                    : '新记忆'
                  : '记忆详情'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭"
                disabled={busy}
                onPress={close}
                style={m.close}
              >
                <Icon name="close" size={19} color={appearance.ink} />
              </Pressable>
            </View>
            {pane?.kind === 'settings' && (
              <ScrollView style={m.sheetScroll}><AutomaticMemorySettings /></ScrollView>
            )}
            {pane?.kind === 'all' && (
              <>
                <View style={m.search}>
                  <Icon name="search" size={18} color={appearance.muted} />
                  <TextInput
                    accessibilityLabel="搜索已加载的记忆"
                    placeholder="找一件记住的事"
                    placeholderTextColor={appearance.muted}
                    value={query}
                    onChangeText={setQuery}
                    style={m.searchInput}
                  />
                </View>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={m.categories}
                >
                  {[
                    '全部',
                    ...(pending.length ? ['待确认'] : []),
                    ...memoryCategories.filter(label =>
                      data.items.some(item => memoryCategory(item) === label),
                    ),
                  ].map(label => (
                    <Pressable
                      key={label}
                      accessibilityRole="button"
                      accessibilityLabel={`分类：${label}`}
                      accessibilityState={{ selected: category === label }}
                      onPress={() => setCategory(label)}
                      style={[
                        m.category,
                        category === label && m.categorySelected,
                      ]}
                    >
                      <Text style={[m.small, category === label && m.link]}>
                        {label}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <FlatList
                  testID="memory-search-results"
                  style={m.sheetScroll}
                  data={visible}
                  keyExtractor={memory => memory.id}
                  keyboardShouldPersistTaps="handled"
                  initialNumToRender={12}
                  maxToRenderPerBatch={12}
                  renderItem={({ item }) => (
                    <MemoryRow memory={item} onPress={() => openDetail(item)} />
                  )}
                  ItemSeparatorComponent={MemoryDivider}
                  ListEmptyComponent={
                    <Text style={m.listEmpty}>
                      {category === '待确认' && !query
                        ? '需要确认的信息已处理完。'
                        : query
                        ? data.hasMore
                          ? '已加载的记忆中没有匹配项，可继续加载后查找。'
                          : '还没记住这件事，可以直接告诉我。'
                        : '还没有记忆，可以先告诉我一件事。'}
                    </Text>
                  }
                  ListFooterComponent={
                    <>
                      <ErrorNotice message={data.error} retry={data.refresh} />
                      {data.hasMore && (
                        <MemoryAction
                          label={data.loading ? '正在加载…' : '加载更多记忆'}
                          secondary
                          busy={data.loading}
                          onPress={data.loadMore}
                        />
                      )}
                    </>
                  }
                />
                <Pressable accessibilityRole="button"
                  accessibilityLabel="帮我安排明天，使用真实记忆开始对话"
                  onPress={() => navigate({ name: 'chat', prompt: memoryTryPrompt })}
                  style={({ pressed }) => [m.tool, pressed && m.pressed]}>
                  <Icon name="sparkles" size={16} color={appearance.accent} />
                  <Text style={m.toolText}>用记忆帮我安排明天</Text>
                </Pressable>
              </>
            )}
            {pane?.kind === 'detail' && (
              <ScrollView
                style={m.sheetScroll}
                contentContainerStyle={m.detail}
              >
                <Text style={m.detailContent}>
                  {getMemoryConfirmation(pane.memory)
                    ? '体重待确认'
                    : pane.memory.content}
                </Text>
                <MemoryConfirmationCard
                  key={`confirmation:${pane.memory.id}:${pane.memory.version}`}
                  memory={pane.memory}
                  onBusyChange={setEditBusy}
                  onSaved={memory => {
                    data.updateLocal(memory);
                    setPane({ kind: 'detail', memory });
                    setNotice('已确认，以后按这个信息记住。');
                  }}
                />
                <View style={m.effect}>
                  <Icon name="sparkles" size={18} color={appearance.accent} />
                  <Text style={m.effectText}>
                    {getMemoryConfirmation(pane.memory)
                      ? '确认后，才会用于相关回答。'
                      : memoryEffect(pane.memory)}
                  </Text>
                </View>
                <MemorySourceCard
                  key={`source:${pane.memory.id}:${pane.memory.version}`}
                  memory={pane.memory}
                />
                <ErrorNotice message={action.error} />
                <View style={m.detailActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel="修改"
                    disabled={busy} onPress={() => openEditor(pane.memory)}
                    style={({ pressed }) => [m.detailAction, busy && m.disabled, pressed && m.pressed]}>
                    <Text style={m.toolText}>修改</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="忘记这件事"
                    disabled={busy} onPress={() => forget(pane.memory)}
                    style={({ pressed }) => [m.detailAction, m.forget, pressed && m.pressed]}>
                    {action.busy ? <ActivityIndicator size="small" color={appearance.danger} /> :
                      <Text style={m.forgetText}>忘记这条</Text>}
                  </Pressable>
                </View>
              </ScrollView>
            )}
            {pane?.kind === 'edit' && (
              <MemoryEntry
                key={pane.entry}
                memory={pane.memory}
                onBusyChange={setEditBusy}
                onSaved={memory => {
                  data.updateLocal(memory);
                  if (filter !== 'all' && filter !== 'pending') setFilter(memoryGroup(memory.kind));
                  setNotice(
                    pane.memory
                      ? '已改好，下次按新的来。'
                      : '记住了，不用再从头解释。',
                  );
                  setPane({ kind: 'detail', memory });
                }}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const m = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  home: { flex: 1, backgroundColor: 'rgba(252,252,255,0.76)' },
  page: { paddingHorizontal: 18, paddingBottom: 12 },
  heading: {
    flexDirection: 'row', gap: 8, alignItems: 'flex-start',
    paddingHorizontal: 18, paddingTop: 8, paddingBottom: 17,
  },
  headingActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  title: { fontSize: 32, fontWeight: '700', color: appearance.ink },
  subtitle: { fontSize: 13, color: appearance.muted, marginTop: 3 },
  add: {
    minHeight: 44, borderRadius: 13, paddingHorizontal: 11, paddingVertical: 8, gap: 5,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: appearance.soft,
  },
  addText: { fontSize: 13, color: appearance.accent, fontWeight: '600' },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  vault: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 46,
    paddingHorizontal: 12, paddingVertical: 8, marginHorizontal: 18, marginVertical: 8,
    borderRadius: 12, backgroundColor: '#F0F2F8',
  },
  vaultTitle: { fontSize: 14, fontWeight: '600', color: appearance.ink },
  libraryHeading: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 8, paddingBottom: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: appearance.ink },
  homeFilters: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 15 },
  homeFilter: {
    minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 12,
  },
  homeFilterSelected: { backgroundColor: appearance.soft },
  homeFilterText: { fontSize: 13, color: appearance.muted },
  homeFilterTextSelected: { fontWeight: '600', color: appearance.accent },
  memoryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, minHeight: 68 },
  rowSymbol: {
    width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
  },
  rowContent: { color: appearance.ink, fontSize: 15, lineHeight: 22, fontWeight: '600' },
  rowSource: { color: appearance.muted, fontSize: 12, lineHeight: 18, marginTop: 2 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: appearance.line },
  small: { fontSize: 12, color: appearance.muted },
  empty: { paddingVertical: 16 },
  emptyTitle: { fontSize: 15, fontWeight: '500', color: appearance.ink },
  menuLayer: { ...StyleSheet.absoluteFillObject, zIndex: 2 },
  menu: {
    position: 'absolute', top: 56, right: 18, maxWidth: '85%',
    padding: 5, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth,
    borderColor: appearance.line, backgroundColor: appearance.paper,
    elevation: 6, shadowColor: appearance.ink, shadowOpacity: 0.14,
    shadowRadius: 9, shadowOffset: { width: 0, height: 3 },
  },
  tool: { minHeight: 44, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7, paddingHorizontal: 10 },
  toolText: { fontSize: 13, color: appearance.accent, fontWeight: '600', flexShrink: 1 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 13,
    marginHorizontal: 18, marginTop: 4, paddingLeft: 12, paddingRight: 4, backgroundColor: appearance.ink,
  },
  noticeText: { fontSize: 13, color: appearance.paper },
  noticeButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  link: { fontSize: 13, color: appearance.accent },
  modal: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(30,42,82,0.38)' },
  sheet: {
    maxHeight: '88%', minHeight: 240, flexShrink: 1, paddingTop: 12, paddingHorizontal: 18, paddingBottom: 22,
    borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: appearance.paper,
  },
  settingsSheet: { minHeight: 0 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  handle: { width: 33, height: 4, borderRadius: 4, backgroundColor: '#DCE0EB', alignSelf: 'center', marginBottom: 11 },
  sheetHeading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 9 },
  sheetTitle: { fontSize: 21, fontWeight: '700', color: appearance.ink, flex: 1 },
  close: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: appearance.background,
    alignItems: 'center', justifyContent: 'center',
  },
  detail: { paddingBottom: 4, gap: 10 },
  detailContent: { fontSize: 17, fontWeight: '600', color: appearance.ink },
  effect: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 2 },
  effectText: { flex: 1, color: appearance.muted, fontSize: 13, lineHeight: 21 },
  detailActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  detailAction: {
    minHeight: 44, padding: 8, borderRadius: 12, flexGrow: 1, flexBasis: 100,
    alignItems: 'center', justifyContent: 'center', backgroundColor: appearance.soft,
  },
  forget: { backgroundColor: '#FFF1F3' },
  forgetText: { color: appearance.danger, fontSize: 13, fontWeight: '600' },
  categories: { gap: 8, paddingBottom: 12 },
  category: {
    minHeight: 44, paddingHorizontal: 14, justifyContent: 'center',
    backgroundColor: appearance.background, borderRadius: 22,
  },
  categorySelected: { backgroundColor: appearance.soft },
  action: {
    minHeight: 44, paddingHorizontal: 12, paddingVertical: 9, marginTop: 10, borderRadius: 12,
    backgroundColor: appearance.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  actionSecondary: { backgroundColor: appearance.soft },
  actionText: { color: appearance.paper, fontSize: 13, fontWeight: '600', textAlign: 'center', flexShrink: 1 },
  actionSecondaryText: { color: appearance.accent },
  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 4,
    borderRadius: 13, backgroundColor: '#F0F2F8', marginBottom: 8,
  },
  searchInput: { flex: 1, minWidth: 0, minHeight: 48, paddingRight: 8, fontSize: 16, color: appearance.ink },
  listEmpty: { fontSize: 14, lineHeight: 24, color: appearance.muted, paddingVertical: 24 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});

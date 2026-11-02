import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
  describeMemory,
  memoryReviewPrompt,
  memoryTryPrompt,
  selectMemoryHighlights,
} from './memoryModel';
import { useMemoryCollection } from './useMemoryCollection';
import { AutomaticMemorySettings } from './AutomaticMemory';
import { MemoryConfirmationCard } from './MemoryConfirmationCard';
import { MemorySourceCard } from './MemorySourceCard';
import {
  getMemoryConfirmation,
  memoryCategories,
  memoryCategory,
  memorySource,
} from './memoryPresentation';

const appearance = {
  ink: '#303849',
  muted: '#707B91',
  accent: '#5665BE',
  paper: '#FFFFFF',
  soft: '#EEF0FD',
  background: '#F7F8FC',
  line: '#E9ECF4',
  danger: '#AE465D',
};

type Pane =
  | { kind: 'all' }
  | { kind: 'detail'; memory: Memory }
  | { kind: 'edit'; memory?: Memory; entry: string }
  | null;

function MemoryDivider() {
  return <View style={m.divider} />;
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
  summary = false,
  disabled = false,
}: {
  memory: Memory;
  onPress: () => void;
  summary?: boolean;
  disabled?: boolean;
}) {
  const { formatDate } = useApp();
  const presentation = describeMemory(memory);
  const pending = getMemoryConfirmation(memory);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`查看记忆：${
        pending ? '体重待确认' : memory.title || memory.content
      }`}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [m.memoryRow, pressed && m.pressed]}
    >
      <View style={m.rowIcon}>
        <Icon name={presentation.icon} size={18} color={appearance.muted} />
      </View>
      <View style={m.flex}>
        {summary && <Text style={m.rowLabel}>{presentation.label}</Text>}
        <Text style={m.rowContent} numberOfLines={summary ? 3 : 2}>
          {pending ? '体重待确认' : memory.content}
        </Text>
        {!summary && (
          <Text style={m.rowSource} numberOfLines={1}>
            {pending ? '待确认' : memoryCategory(memory)} ·{' '}
            {memorySource(memory.source).label} ·{' '}
            {formatDate(memory.updated_at)}
          </Text>
        )}
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
  const highlights = useMemo(
    () => selectMemoryHighlights(data.items),
    [data.items],
  );
  const recent = data.items.find(
    item =>
      !getMemoryConfirmation(item) &&
      !highlights.some(highlight => highlight.id === item.id),
  );
  const pending = data.items.filter(item => getMemoryConfirmation(item));
  const [pane, setPane] = useState<Pane>(null);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [editBusy, setEditBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleted, setDeleted] = useState<{
    memory: Memory;
    requestId: string;
  } | null>(null);
  const action = useAction();
  const busy = editBusy || action.busy;
  const visible = data.items.filter(
    item =>
      (category === '全部' ||
        (category === '待确认'
          ? !!getMemoryConfirmation(item)
          : memoryCategory(item) === category)) &&
      `${item.title}\n${item.content}\n${memorySource(item.source).label}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const openDetail = (memory: Memory) => {
    action.setError(null);
    setPane({ kind: 'detail', memory });
  };
  const openAll = () => {
    action.setError(null);
    setQuery('');
    setCategory('全部');
    setPane({ kind: 'all' });
  };
  const openEditor = (memory?: Memory) => {
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
      <ScrollView
        testID="memory-understand-home"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={m.page}
        refreshControl={
          <RefreshControl
            refreshing={data.loading && data.items.length > 0}
            onRefresh={data.refresh}
            tintColor={appearance.accent}
          />
        }
      >
        <View style={m.heading}>
          <View style={m.flex}>
            <Text style={m.title}>记忆</Text>
            <Text style={m.subtitle}>不用每次从头说。</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加一条记忆"
            onPress={() => openEditor()}
            style={m.add}
          >
            <Icon name="plus" size={23} color={appearance.accent} />
          </Pressable>
        </View>
        <AutomaticMemorySettings />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="从对话里整理记忆，先列出候选供你确认"
          onPress={() => navigate({ name: 'chat', prompt: memoryReviewPrompt })}
          style={({ pressed }) => [m.discover, pressed && m.pressed]}
        >
          <Icon name="sparkles" size={17} color={appearance.accent} />
          <Text style={m.discoverText}>从对话里整理，先由你确认</Text>
          <Icon name="chevronRight" size={15} color={appearance.accent} />
        </Pressable>
        <ErrorNotice message={data.error} retry={data.refresh} />
        {pending.length > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="查看待确认的记忆"
            onPress={() => {
              openAll();
              setCategory('待确认');
            }}
            style={m.discover}
          >
            <Icon name="sparkles" size={17} color={appearance.accent} />
            <Text style={m.discoverText}>
              {pending.length} 条信息需要你确认一下
            </Text>
            <Icon name="chevronRight" size={15} color={appearance.accent} />
          </Pressable>
        )}
        {data.loading && !data.items.length ? <Loading /> : null}
        {(data.items.length > 0 || (!data.loading && !data.error)) && (
          <View style={m.summary}>
            <View style={m.summaryHeader}>
              <Icon name="memory" size={16} color={appearance.accent} />
              <Text style={m.summaryTitle}>妥啦了解的你</Text>
            </View>
            {highlights.map((memory, index) => (
              <View key={memory.id} style={index > 0 && m.divider}>
                <MemoryRow
                  memory={memory}
                  summary
                  onPress={() => openDetail(memory)}
                />
              </View>
            ))}
            {!highlights.length && (
              <View style={m.empty}>
                <Text style={m.emptyTitle}>
                  {pending.length
                    ? '有信息等待你确认'
                    : '先告诉我一件关于你的事'}
                </Text>
                <Text style={m.emptyBody}>
                  {pending.length
                    ? '先核对一下数字，确认后我再把它用于回答。'
                    : '比如你喜欢怎样的回复，或者什么时候更专注。'}
                </Text>
                <MemoryAction
                  label={pending.length ? '核对信息' : '告诉我一件事'}
                  secondary
                  onPress={() =>
                    pending.length ? openDetail(pending[0]) : openEditor()
                  }
                />
              </View>
            )}
            {!!highlights.length && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="查看全部记忆"
                onPress={openAll}
                style={m.summaryFooter}
              >
                <Text style={m.footerText}>
                  查看全部 {data.items.length}
                  {data.hasMore ? '+' : ''} 条记忆
                </Text>
                <Icon name="arrowRight" size={15} color={appearance.muted} />
              </Pressable>
            )}
          </View>
        )}
        <View style={m.sectionHeading}>
          <Text style={m.sectionTitle}>记住，然后帮上忙</Text>
          <Text style={m.small}>试试看</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="帮我安排明天，使用真实记忆开始对话"
          onPress={() => navigate({ name: 'chat', prompt: memoryTryPrompt })}
          style={({ pressed }) => [m.tryCard, pressed && m.pressed]}
        >
          <Icon name="sparkles" size={22} color={appearance.accent} />
          <View style={m.flex}>
            <Text style={m.tryTitle}>帮我安排明天</Text>
            <Text style={m.tryDescription}>看看建议如何考虑你的习惯</Text>
          </View>
          <Icon name="arrowRight" size={17} color={appearance.accent} />
        </Pressable>
        {recent && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`最近记住：${recent.title}`}
            onPress={() => openDetail(recent)}
            style={m.recent}
          >
            <Icon name="clock" size={16} color={appearance.accent} />
            <Text style={[m.small, m.flex]} numberOfLines={2}>
              最近记住：{recent.content}
            </Text>
            <Icon name="chevronRight" size={14} color={appearance.muted} />
          </Pressable>
        )}
        {!!notice && (
          <View accessibilityLiveRegion="polite" style={m.notice}>
            <Icon name="check" size={17} color={appearance.accent} />
            <Text style={[m.noticeText, m.flex]}>{notice}</Text>
            {deleted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="撤销忘记"
                disabled={action.busy}
                onPress={restore}
                style={m.noticeButton}
              >
                <Text style={m.link}>{action.busy ? '恢复中…' : '撤销'}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭提示"
                onPress={() => setNotice('')}
                style={m.noticeButton}
              >
                <Icon name="close" size={15} color={appearance.muted} />
              </Pressable>
            )}
          </View>
        )}
        {!pane && (
          <ErrorNotice
            message={action.error}
            retry={deleted ? restore : undefined}
          />
        )}
      </ScrollView>
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
          <View style={m.sheet} accessibilityViewIsModal>
            <View style={m.handle} />
            <View style={m.sheetHeading}>
              <Text style={m.sheetTitle}>
                {pane?.kind === 'all'
                  ? '记住的事'
                  : pane?.kind === 'edit'
                  ? pane.memory
                    ? '改一下记忆'
                    : '告诉我一件事'
                  : '这条记忆'}
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
                <MemoryAction
                  label="再告诉我一件事"
                  onPress={() => openEditor()}
                />
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
                      : describeMemory(pane.memory).effect}
                  </Text>
                </View>
                <MemorySourceCard
                  key={`source:${pane.memory.id}:${pane.memory.version}`}
                  memory={pane.memory}
                />
                <ErrorNotice message={action.error} />
                <MemoryAction
                  label="改一下"
                  disabled={action.busy}
                  onPress={() => openEditor(pane.memory)}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="忘记这件事"
                  disabled={action.busy}
                  onPress={() => forget(pane.memory)}
                  style={m.forget}
                >
                  {action.busy ? (
                    <ActivityIndicator size="small" color={appearance.danger} />
                  ) : (
                    <Text style={m.forgetText}>忘记这件事</Text>
                  )}
                </Pressable>
              </ScrollView>
            )}
            {pane?.kind === 'edit' && (
              <MemoryEntry
                key={pane.entry}
                memory={pane.memory}
                onBusyChange={setEditBusy}
                onSaved={memory => {
                  data.updateLocal(memory);
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
  flex: { flex: 1 },
  page: { paddingHorizontal: 22, paddingTop: 9, paddingBottom: 26 },
  heading: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
    marginBottom: 19,
  },
  title: {
    fontSize: 30,
    lineHeight: 40,
    fontWeight: '500',
    color: appearance.ink,
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 22,
    color: appearance.muted,
    marginTop: 3,
  },
  add: {
    width: 45,
    height: 45,
    borderRadius: 16,
    backgroundColor: appearance.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discover: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 12,
    borderRadius: 13,
    backgroundColor: appearance.soft,
    marginBottom: 18,
  },
  discoverText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 19,
    color: appearance.accent,
  },
  summary: {
    backgroundColor: appearance.paper,
    borderRadius: 23,
    paddingHorizontal: 18,
    paddingTop: 17,
    overflow: 'hidden',
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: 5,
  },
  summaryTitle: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
    color: appearance.accent,
  },
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingVertical: 14,
    minHeight: 63,
  },
  rowIcon: {
    alignSelf: 'flex-start',
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: appearance.background,
    marginTop: 3,
  },
  rowLabel: {
    fontSize: 11,
    lineHeight: 17,
    color: appearance.muted,
    marginBottom: 3,
  },
  rowContent: { color: appearance.ink, fontSize: 14, lineHeight: 23 },
  rowSource: {
    color: appearance.muted,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 6,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: appearance.line,
  },
  summaryFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 9,
    minHeight: 45,
    paddingHorizontal: 18,
    paddingVertical: 12,
    marginHorizontal: -18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: appearance.line,
  },
  footerText: {
    fontSize: 12,
    lineHeight: 18,
    color: appearance.muted,
    flexShrink: 1,
  },
  empty: { paddingVertical: 19 },
  emptyTitle: {
    fontSize: 16,
    lineHeight: 25,
    fontWeight: '500',
    color: appearance.ink,
  },
  emptyBody: {
    fontSize: 13,
    lineHeight: 22,
    color: appearance.muted,
    marginTop: 8,
  },
  sectionHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 9,
    marginTop: 22,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
    color: appearance.ink,
  },
  small: { fontSize: 11, lineHeight: 19, color: appearance.muted },
  tryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: appearance.soft,
    padding: 16,
    borderRadius: 17,
  },
  tryTitle: {
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '500',
    color: appearance.ink,
  },
  tryDescription: {
    fontSize: 11,
    lineHeight: 19,
    color: appearance.muted,
    marginTop: 3,
  },
  recent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 16,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    padding: 12,
    marginTop: 14,
    backgroundColor: appearance.paper,
  },
  noticeText: { fontSize: 12, lineHeight: 20, color: appearance.ink },
  noticeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  link: { fontSize: 13, color: appearance.accent },
  modal: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(48,56,73,0.28)',
  },
  sheet: {
    maxHeight: '88%',
    minHeight: 240,
    flexShrink: 1,
    paddingTop: 12,
    paddingHorizontal: 22,
    paddingBottom: 28,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    backgroundColor: appearance.paper,
  },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  handle: {
    width: 33,
    height: 4,
    borderRadius: 4,
    backgroundColor: '#DCE0EB',
    alignSelf: 'center',
    marginBottom: 17,
  },
  sheetHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 13,
    marginBottom: 15,
  },
  sheetTitle: {
    fontSize: 20,
    lineHeight: 29,
    fontWeight: '500',
    color: appearance.ink,
    flex: 1,
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: appearance.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detail: { paddingBottom: 4 },
  categories: { gap: 8, paddingBottom: 12 },
  category: {
    minHeight: 44,
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: appearance.background,
    borderRadius: 22,
  },
  categorySelected: { backgroundColor: appearance.soft },
  detailContent: { fontSize: 19, lineHeight: 31, color: appearance.ink },
  effect: {
    backgroundColor: appearance.soft,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 14,
    marginVertical: 17,
  },
  effectText: {
    flex: 1,
    color: appearance.accent,
    fontSize: 13,
    lineHeight: 22,
  },
  source: {
    backgroundColor: appearance.background,
    borderRadius: 14,
    padding: 14,
  },
  sourceLabel: {
    color: appearance.muted,
    fontSize: 11,
    lineHeight: 18,
    marginBottom: 6,
  },
  sourceText: { color: appearance.ink, fontSize: 13, lineHeight: 21 },
  sourceDate: {
    color: appearance.muted,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 7,
  },
  action: {
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 13,
    marginTop: 16,
    borderRadius: 15,
    backgroundColor: appearance.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  actionSecondary: { backgroundColor: appearance.soft },
  actionText: {
    color: appearance.paper,
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '500',
    textAlign: 'center',
    flexShrink: 1,
  },
  actionSecondaryText: { color: appearance.accent },
  forget: {
    minHeight: 48,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgetText: { color: appearance.danger, fontSize: 13, lineHeight: 22 },
  editor: { paddingBottom: 4 },
  fieldLabel: {
    color: appearance.muted,
    fontSize: 12,
    lineHeight: 20,
    marginTop: 18,
    marginBottom: 8,
  },
  input: {
    backgroundColor: appearance.background,
    borderWidth: 1,
    borderColor: appearance.line,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    lineHeight: 25,
    color: appearance.ink,
    minHeight: 130,
    maxHeight: 240,
  },
  explanation: { fontSize: 12, lineHeight: 21, color: appearance.muted },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 13,
    borderRadius: 13,
    backgroundColor: appearance.background,
    marginBottom: 8,
  },
  searchInput: { flex: 1, minHeight: 48, fontSize: 16, color: appearance.ink },
  listEmpty: {
    fontSize: 14,
    lineHeight: 24,
    color: appearance.muted,
    paddingVertical: 24,
  },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
});

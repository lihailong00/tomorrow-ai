import React, { useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';
import { useAction, useApp } from '../../app/context';
import { ApiError, newRequestId } from '../../api/client';
import { chineseDayLabel } from '../../domain/types';
import { Text } from '../../ui/Text';
import { Button, ErrorNotice, Loading, Notice } from '../../ui/components';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { createTodo, listTodos, updateTodo } from './api';
import { progressLabel, shortSourceLabel } from './model';
import { TodoEditor } from './TodoEditor';
import { useTodoList } from './useTodoList';
import type { CreateTodo, Todo, TodoScope } from './types';
import { todoStyles as s } from './ui';
import { DailyRecommendations, useDailyGrowth } from '../growth/DailyGrowth';
import { useGrowth } from '../growth/context';
import { localDateLabel } from '../growth/model';

type Group = 'suggested' | 'waiting' | 'completed';
type Row =
  | { key: string; todo: Todo }
  | { key: string; group: Group }
  | { key: string; more: 'active' | Group };
const sameInput = (left: CreateTodo, right: CreateTodo) =>
  JSON.stringify([
    left.title.trim(),
    left.description ?? '',
    left.kind ?? 'general',
    left.due_at ?? null,
    left.estimated_minutes ?? null,
  ]) ===
  JSON.stringify([
    right.title.trim(),
    right.description ?? '',
    right.kind ?? 'general',
    right.due_at ?? null,
    right.estimated_minutes ?? null,
  ]);
export function TodosScreen() {
  const { api, user, revision, navigate, invalidate, formatDate } = useApp();
  const [scope, setScope] = useState<TodoScope>('today');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [menu, setMenu] = useState<'more' | 'daily' | null>(null);
  const [capture, setCapture] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [notice, setNotice] = useState('');
  const [editorKey, setEditorKey] = useState(0);
  const captureValue = useRef(capture);
  const expandedValue = useRef(expanded);
  const editorRevision = useRef(0);
  const changeCapture = (value: string) => {
    captureValue.current = value;
    setCapture(value);
  };
  const changeExpanded = (value: boolean) => {
    expandedValue.current = value;
    setExpanded(value);
  };
  const owner = useMemo(() => ({ api, userId: user?.id }), [api, user?.id]);
  const action = useAction();
  const growth = useGrowth();
  const daily = useDailyGrowth();
  const pendingIntent = useRef<
    | {
        owner: typeof owner;
        input: Readonly<CreateTodo>;
        id: string;
      }
    | undefined
  >(undefined);
  const active = useTodoList(
    offset => listTodos(api, { filter: 'active', scope, offset }),
    [api, user?.id, scope, revision],
  );
  const suggested = useTodoList(
    offset => listTodos(api, { filter: 'suggested', scope: 'all', offset }),
    [api, user?.id, revision],
  );
  const waiting = useTodoList(
    offset =>
      scope === 'all'
        ? listTodos(api, { filter: 'waiting', scope, offset })
        : Promise.resolve({ items: [] }),
    [api, user?.id, scope, revision],
  );
  const completed = useTodoList(
    offset => listTodos(api, { filter: 'completed', scope, offset }),
    [api, user?.id, scope, revision],
  );
  const groups = { suggested, waiting, completed };
  const labels = {
    suggested: '待办建议',
    waiting: '等待后续',
    completed: '已完成',
  };
  const refresh = () => {
    active.refresh();
    suggested.refresh();
    waiting.refresh();
    completed.refresh();
    growth?.refresh();
    daily.refresh();
  };
  const rows = useMemo(() => {
    const result: Row[] = active.items.map(todo => ({
      key: 'active-' + todo.id,
      todo,
    }));
    if (active.hasMore) result.push({ key: 'more-active', more: 'active' });
    const appendGroup = (group: Group, expandedGroup: boolean) => {
      const data = groups[group];
      if (!data.items.length && !data.hasMore && !data.error) return;
      result.push({ key: 'group-' + group, group });
      if (!expandedGroup) return;
      for (const todo of data.items)
        result.push({ key: group + '-' + todo.id, todo });
      if (data.hasMore) result.push({ key: 'more-' + group, more: group });
    };
    if (scope === 'all') appendGroup('waiting', true);
    appendGroup('suggested', showSuggestions);
    appendGroup('completed', showCompleted);
    return result;
    // List hooks return a new controller each render; only row data matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scope,
    showSuggestions,
    showCompleted,
    active.items,
    active.hasMore,
    waiting.items,
    waiting.hasMore,
    waiting.error,
    suggested.items,
    suggested.hasMore,
    suggested.error,
    completed.items,
    completed.hasMore,
    completed.error,
  ]);
  const toggleDone = (todo: Todo) =>
    action.run(async guard => {
      const status = todo.status === 'completed' ? 'pending' : 'completed';
      const observation = growth?.prepareReward(todo.id) ?? null;
      setNotice('');
      try {
        await updateTodo(api, todo.id, { status, version: todo.version });
      } catch (failure) {
        if (guard.isCurrent()) {
          active.refresh();
          completed.refresh();
        }
        throw failure;
      }
      if (!guard.isCurrent()) return;
      invalidate();
      void growth?.confirmReward(observation);
    });
  const add = (
    input: CreateTodo,
    surface: 'capture' | 'expanded' = 'capture',
  ) =>
    action.run(async guard => {
      if (pendingIntent.current?.owner !== owner)
        pendingIntent.current = undefined;
      if (!pendingIntent.current) {
        if (!input.title.trim()) throw new Error('写下今天想做的一件事就好。');
        // The id and payload form one immutable intent until its result is known.
        pendingIntent.current = {
          owner,
          input: Object.freeze({ ...input }),
          id: newRequestId(),
        };
      }
      const intent = pendingIntent.current;
      const attempt = {
        capture: captureValue.current,
        editorRevision: editorRevision.current,
        input: { ...input },
      };
      setNotice('');
      try {
        await createTodo(api, {
          ...intent.input,
          client_request_id: intent.id,
        });
        if (!guard.isCurrent()) return;
        pendingIntent.current = undefined;
        const unchanged =
          sameInput(attempt.input, intent.input) &&
          captureValue.current === attempt.capture &&
          (surface === 'expanded'
            ? expandedValue.current &&
              editorRevision.current === attempt.editorRevision
            : !expandedValue.current);
        if (unchanged) {
          changeCapture('');
          if (surface === 'expanded') {
            changeExpanded(false);
            setEditorKey(value => value + 1);
          }
          setNotice('已加入事项。');
        } else {
          setNotice('原事项已确认保存；当前草稿尚未提交，请再次点击添加。');
        }
        invalidate();
      } catch (error) {
        // A definite validation rejection created nothing; corrected input is a new intent.
        if (
          guard.isCurrent() &&
          error instanceof ApiError &&
          error.status === 400 &&
          pendingIntent.current === intent
        )
          pendingIntent.current = undefined;
        throw error;
      }
    });
  return (
    <View style={s.fill}>
      <FlatList
        data={rows}
        keyExtractor={row => row.key}
        contentContainerStyle={s.page}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        refreshing={active.loading && active.items.length > 0}
        onRefresh={refresh}
        ListHeaderComponent={
          <>
            <View style={s.heading}>
              <Text style={s.title}>事项</Text>
              <Text style={[s.small, s.date]}>
                {growth?.data?.summary.today.date
                  ? localDateLabel(growth.data.summary.today.date, true)
                  : chineseDayLabel(new Date(), user?.timezone)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="更多事项功能"
                onPress={() => {
                  Keyboard.dismiss();
                  setMenu('more');
                }}
                style={s.more}
              >
                <Icon name="more" size={20} color={colors.ink} />
              </Pressable>
            </View>
            <View style={s.toolbar}>
              <View style={s.tabs}>
                {(['today', 'all'] as TodoScope[]).map(id => (
                  <Pressable
                    key={id}
                    accessibilityRole="tab"
                    accessibilityLabel={
                      id === 'today' ? '今天的事项' : '全部事项'
                    }
                    accessibilityState={{ selected: scope === id }}
                    onPress={() => setScope(id)}
                    style={[s.tab, scope === id && s.selected]}
                  >
                    <Text style={[s.tabText, scope === id && s.selectedText]}>
                      {id === 'today' ? '今天' : '全部'}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {active.items.length > 0 && (
                <Text style={s.small} accessibilityLiveRegion="polite">
                  {active.items.length}
                  {active.hasMore ? '+' : ''} 件待办
                </Text>
              )}
            </View>
            <ErrorNotice message={active.error} retry={active.refresh} />
            {active.loading && !active.items.length ? (
              <Loading />
            ) : !active.items.length &&
              !active.error &&
              (scope === 'today' || !waiting.items.length) ? (
              <View style={s.emptyState}>
                <View style={s.emptyMark}>
                  <Icon name="check" size={20} color={colors.action} />
                </View>
                <Text style={s.rowTitle}>
                  {scope === 'today' && completed.items.length
                    ? '今天的待办做完了'
                    : scope === 'today'
                    ? '今天没有待办'
                    : '还没有待办'}
                </Text>
                <Text style={s.small}>有新的安排，可以在下面记一件。</Text>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => {
          if ('group' in item) {
            const group = item.group;
            const data = groups[group];
            if (data.error && !data.items.length)
              return <ErrorNotice message={data.error} retry={data.refresh} />;
            if (group === 'waiting')
              return (
                <View>
                  <Text style={s.groupHeading}>等待后续</Text>
                  <ErrorNotice message={data.error} retry={data.refresh} />
                </View>
              );
            const count = `${data.items.length}${data.hasMore ? '+' : ''}`;
            const suggestion = group === 'suggested';
            const singleSuggestion =
              suggestion && data.items.length === 1 && !data.hasMore;
            const open = suggestion ? showSuggestions : showCompleted;
            const label = suggestion
              ? `发现 ${count} 条待办建议`
              : `已完成 ${count} 件`;
            return (
              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={
                    singleSuggestion ? undefined : { expanded: open }
                  }
                  onPress={() => {
                    if (singleSuggestion)
                      navigate({ name: 'todo', id: data.items[0].id });
                    else if (suggestion) setShowSuggestions(value => !value);
                    else setShowCompleted(value => !value);
                  }}
                  style={suggestion ? s.discovery : s.fold}
                >
                  {suggestion && (
                    <Icon name="sparkles" size={18} color={colors.action} />
                  )}
                  <Text style={suggestion ? s.discoveryText : s.small}>
                    {label}
                  </Text>
                  <Icon
                    name={
                      singleSuggestion
                        ? 'chevronRight'
                        : open
                        ? 'arrowUp'
                        : 'chevronDown'
                    }
                    size={15}
                    color={suggestion ? colors.action : colors.secondary}
                  />
                </Pressable>
                {data.error && (
                  <ErrorNotice message={data.error} retry={data.refresh} />
                )}
              </View>
            );
          }
          if ('more' in item) {
            const data = item.more === 'active' ? active : groups[item.more];
            return (
              <Button
                variant="ghost"
                loading={data.loading}
                onPress={data.loadMore}
              >
                加载更多{item.more === 'active' ? '事项' : labels[item.more]}
              </Button>
            );
          }
          const todo = item.todo;
          const done = todo.status === 'completed';
          const canToggle =
            done || todo.status === 'pending' || todo.status === 'in_progress';
          const showProgress =
            !done &&
            (todo.status !== 'pending' ||
              todo.progress_notes ||
              todo.draft ||
              todo.linked_task_id);
          return (
            <View style={[s.row, s.compactRow]}>
              {canToggle ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={
                    (done ? '恢复事项：' : '完成事项：') + todo.title
                  }
                  accessibilityState={{ checked: done, disabled: action.busy }}
                  disabled={action.busy}
                  onPress={() => {
                    void toggleDone(todo);
                  }}
                  style={s.checkAction}
                >
                  <View style={[s.checkRing, done && s.checkedRing]}>
                    {done && (
                      <Icon name="check" size={13} color={colors.action} />
                    )}
                  </View>
                </Pressable>
              ) : (
                <View style={s.checkAction}>
                  <Icon
                    name={todo.status === 'waiting' ? 'clock' : 'sparkles'}
                    size={17}
                    color={colors.secondary}
                  />
                </View>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'查看事项：' + todo.title}
                onPress={() => navigate({ name: 'todo', id: todo.id })}
                style={s.openRow}
              >
                <View style={s.rowCopy}>
                  <Text
                    style={[s.rowTitle, done && s.completedTitle]}
                    numberOfLines={2}
                  >
                    {todo.title}
                  </Text>
                  <Text style={s.small} numberOfLines={1}>
                    {shortSourceLabel(todo)}
                    {todo.due_at ? ' · ' + formatDate(todo.due_at) : ''}
                    {showProgress ? ' · ' + progressLabel(todo) : ''}
                  </Text>
                </View>
                <Icon name="chevronRight" size={15} color={colors.secondary} />
              </Pressable>
            </View>
          );
        }}
      />
      <ErrorNotice message={action.error} />
      {!!notice && <Notice>{notice}</Notice>}
      <View style={s.capture}>
        <TextInput
          accessibilityLabel="记件要做的事"
          placeholder="记一件要做的事…"
          placeholderTextColor={colors.muted}
          style={s.input}
          maxLength={200}
          value={capture}
          onChangeText={changeCapture}
          onSubmitEditing={() => {
            void add({ title: capture });
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="添加事项"
          disabled={action.busy}
          onPress={() => {
            void add({ title: capture });
          }}
          style={s.add}
        >
          <Icon name="plus" size={20} color={colors.surface} />
        </Pressable>
      </View>
      {menu !== null && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setMenu(null)}
        >
          <View style={s.scrim}>
            <Pressable
              style={s.fill}
              accessible={false}
              onPress={() => setMenu(null)}
            />
            <View style={s.sheet} accessibilityViewIsModal>
              <View style={s.sheetHeading}>
                <Text style={s.sheetTitle}>
                  {menu === 'more' ? '更多' : '每日小行动'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭事项菜单"
                  onPress={() => setMenu(null)}
                  style={s.more}
                >
                  <Icon name="close" size={18} color={colors.ink} />
                </Pressable>
              </View>
              {menu === 'more' ? (
                <>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="从资料找待办"
                    style={s.menuRow}
                    onPress={() => {
                      setMenu(null);
                      navigate({ name: 'todoSources' });
                    }}
                  >
                    <Icon name="folder" size={19} color={colors.action} />
                    <Text style={s.rowTitle}>从资料找待办</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="每日小行动"
                    style={s.menuRow}
                    onPress={() => {
                      if (daily.enabled) setMenu('daily');
                      else {
                        setMenu(null);
                        navigate({ name: 'growth' });
                      }
                    }}
                  >
                    <Icon name="growth" size={19} color={colors.action} />
                    <Text style={s.rowTitle}>每日小行动</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="助手记录与计划"
                    style={s.menuRow}
                    onPress={() => {
                      setMenu(null);
                      navigate({ name: 'assistantTasks' });
                    }}
                  >
                    <Icon name="history" size={19} color={colors.action} />
                    <Text style={s.rowTitle}>助手记录与计划</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="展开事项编辑"
                    style={s.menuRow}
                    onPress={() => {
                      setMenu(null);
                      changeExpanded(true);
                    }}
                  >
                    <Icon name="compose" size={19} color={colors.action} />
                    <Text style={s.rowTitle}>新建详细事项</Text>
                  </Pressable>
                </>
              ) : (
                <ScrollView keyboardShouldPersistTaps="handled">
                  <DailyRecommendations daily={daily} />
                  <Button
                    variant="ghost"
                    onPress={() => {
                      setMenu(null);
                      navigate({ name: 'growth' });
                    }}
                  >
                    查看成长与设置
                  </Button>
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
      )}
      <Modal
        visible={expanded}
        animationType="slide"
        onRequestClose={() => changeExpanded(false)}
      >
        <ScrollView
          contentContainerStyle={s.page}
          style={s.modal}
          keyboardShouldPersistTaps="handled"
        >
          <View style={s.heading}>
            <Text style={s.title}>记件事</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => changeExpanded(false)}
            >
              <Text style={s.link}>收起</Text>
            </Pressable>
          </View>
          <ErrorNotice message={action.error} />
          {!!notice && <Notice>{notice}</Notice>}
          <TodoEditor
            key={editorKey}
            initialTitle={capture}
            timezone={user?.timezone ?? 'Asia/Shanghai'}
            busy={action.busy}
            onEdit={() => {
              editorRevision.current++;
            }}
            onSave={input => {
              void add(input, 'expanded');
            }}
          />
        </ScrollView>
      </Modal>
    </View>
  );
}

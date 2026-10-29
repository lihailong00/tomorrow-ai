import React, { useMemo, useRef, useState } from 'react';
import {
  FlatList,
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
import { createTodo, listTodos } from './api';
import { kindIcons, nextAction, progressLabel } from './model';
import { TodoEditor } from './TodoEditor';
import { useTodoList } from './useTodoList';
import type { CreateTodo, Todo, TodoScope } from './types';
import { todoStyles as s } from './ui';

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
  const [open, setOpen] = useState<Record<Group, boolean>>({
    suggested: false,
    waiting: false,
    completed: false,
  });
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
    offset => listTodos(api, { filter: 'waiting', scope, offset }),
    [api, user?.id, scope, revision],
  );
  const completed = useTodoList(
    offset => listTodos(api, { filter: 'completed', scope, offset }),
    [api, user?.id, scope, revision],
  );
  const groups = { suggested, waiting, completed };
  const labels = {
    suggested: '新发现',
    waiting: '等待后续',
    completed: '已完成',
  };
  const refresh = () => {
    active.refresh();
    suggested.refresh();
    waiting.refresh();
    completed.refresh();
  };
  const rows = useMemo(() => {
    const result: Row[] = active.items.map(todo => ({ key: todo.id, todo }));
    if (active.hasMore) result.push({ key: 'more-active', more: 'active' });
    (['suggested', 'waiting', 'completed'] as Group[]).forEach(group => {
      result.push({ key: 'group-' + group, group });
      if (open[group]) {
        result.push(
          ...groups[group].items.map(todo => ({ key: todo.id, todo })),
        );
        if (groups[group].hasMore)
          result.push({ key: 'more-' + group, more: group });
      }
    });
    return result;
    // Hook results are recreated; only their actual list state affects rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active.items,
    active.hasMore,
    suggested.items,
    suggested.hasMore,
    waiting.items,
    waiting.hasMore,
    completed.items,
    completed.hasMore,
    open,
  ]);
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
              <Text style={s.small}>
                {chineseDayLabel(new Date(), user?.timezone)}
              </Text>
            </View>
            <View style={s.links}>
              <Pressable
                accessibilityRole="button"
                onPress={() => navigate({ name: 'todoSources' })}
              >
                <Text style={s.link}>从资料发现</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => navigate({ name: 'assistantTasks' })}
              >
                <Text style={s.small}>助手执行记录 · 自动计划</Text>
              </Pressable>
            </View>
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
            <ErrorNotice message={active.error} retry={active.refresh} />
            {active.loading && !active.items.length ? (
              <Loading />
            ) : !active.items.length && !active.error ? (
              <Text style={s.empty}>
                {scope === 'today'
                  ? '今天还没有待处理的事项。\n记下一件事，或从你确认过的资料里发现。'
                  : '还没有待处理的事项。可以先记下一件小事。'}
              </Text>
            ) : null}
          </>
        }
        renderItem={({ item }) => {
          if ('group' in item) {
            const group = item.group,
              data = groups[group];
            return (
              <View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={labels[group]}
                  accessibilityState={{ expanded: open[group] }}
                  onPress={() =>
                    setOpen(previous => ({
                      ...previous,
                      [group]: !previous[group],
                    }))
                  }
                  style={s.fold}
                >
                  <Text style={s.foldText}>
                    {labels[group]} · {data.items.length}
                    {data.hasMore ? '+' : ''}
                  </Text>
                  <Text style={s.muted}>{open[group] ? '收起' : '展开'}</Text>
                </Pressable>
                {open[group] && (
                  <>
                    <ErrorNotice message={data.error} retry={data.refresh} />
                    {data.loading && !data.items.length ? (
                      <Loading />
                    ) : !data.error && !data.items.length ? (
                      <Text style={s.small}>这里暂时没有事项。</Text>
                    ) : null}
                  </>
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
          return (
            <View style={s.row}>
              <View style={s.icon}>
                <Icon
                  name={kindIcons[todo.kind]}
                  size={19}
                  color={todo.draft ? colors.action : colors.secondary}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'查看事项：' + todo.title}
                onPress={() => navigate({ name: 'todo', id: todo.id })}
                style={s.rowContent}
              >
                <Text style={s.rowTitle} numberOfLines={2}>
                  {todo.title}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {todo.source_label || '你添加'} · {progressLabel(todo)}
                  {todo.due_at ? ' · ' + formatDate(todo.due_at) : ''}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={nextAction(todo) + '：' + todo.title}
                onPress={() => navigate({ name: 'todo', id: todo.id })}
                style={s.rowAction}
              >
                <Text style={todo.draft ? s.link : s.small}>
                  {nextAction(todo)}
                </Text>
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
          placeholder="记件要做的事…"
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
          accessibilityLabel="展开事项编辑"
          onPress={() => changeExpanded(true)}
        >
          <Text style={s.small}>更多</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="添加事项"
          disabled={action.busy}
          onPress={() => {
            void add({ title: capture });
          }}
          style={s.add}
        >
          <Icon name="plus" size={20} color={colors.action} />
        </Pressable>
      </View>
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

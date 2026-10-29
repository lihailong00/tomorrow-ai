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
import { newRequestId } from '../../api/client';
import { chineseDayLabel } from '../../domain/types';
import { Text } from '../../ui/Text';
import { Button, ErrorNotice, Loading } from '../../ui/components';
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
  const action = useAction();
  const request = useRef('');
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
  const add = (input: CreateTodo) =>
    action.run(async guard => {
      if (!input.title.trim()) throw new Error('写下今天想做的一件事就好。');
      // Keep this intent through unknown results, including edits before retry.
      if (!request.current) request.current = newRequestId();
      await createTodo(api, { ...input, client_request_id: request.current });
      if (!guard.isCurrent()) return;
      request.current = '';
      setCapture('');
      setExpanded(false);
      invalidate();
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
      <View style={s.capture}>
        <TextInput
          accessibilityLabel="记件要做的事"
          placeholder="记件要做的事…"
          placeholderTextColor={colors.muted}
          style={s.input}
          maxLength={200}
          value={capture}
          onChangeText={setCapture}
          onSubmitEditing={() => {
            void add({ title: capture });
          }}
        />
        <Pressable accessibilityRole="button" onPress={() => setExpanded(true)}>
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
        onRequestClose={() => setExpanded(false)}
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
              onPress={() => setExpanded(false)}
            >
              <Text style={s.link}>收起</Text>
            </Pressable>
          </View>
          <ErrorNotice message={action.error} />
          <TodoEditor
            initialTitle={capture}
            timezone={user?.timezone ?? 'Asia/Shanghai'}
            busy={action.busy}
            onSave={input => {
              void add(input);
            }}
          />
        </ScrollView>
      </Modal>
    </View>
  );
}

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../ui/Text';
import { useAction, useApp, useResource, type Route } from '../app/context';
import {
  chineseDayLabel,
  frequencies,
  isActiveTask,
  RuntimeInfo,
  Task,
  taskStatuses,
} from '../domain/types';
import { Button, ErrorNotice, Loading, Notice } from '../ui/components';
import { colors, styles as s } from '../ui/theme';
import { AssistantOrb, Icon } from '../ui/visuals';
import { platform } from '../platform/ports';
import { MemoryHome } from '../features/memory/MemoryHome';
import { DailyNewsCard } from '../features/news/DailyNewsCard';
import { ResultText } from '../ui/ResultText';
import { listTodos } from '../features/todos/api';
import { localDue } from '../features/todos/model';

type IconName = React.ComponentProps<typeof Icon>['name'];
const accent = colors.accent;
const secondary = colors.secondary;
const tint = { blue: '#EAF1FF', peach: '#FFF0E8', lilac: '#EEEAFE' };

// A filter or refresh starts a new generation, so late pages cannot mix lists.
export function usePagedList<T extends { id: string }>(
  load: (
    offset: number,
  ) => Promise<{ items: T[]; next_offset?: number | null }>,
  deps: React.DependencyList,
) {
  const loader = useRef(load);
  loader.current = load;
  const generation = useRef(0);
  const pending = useRef(false);
  const [items, setItems] = useState<T[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(
    async (offset: number, append: boolean, version: number) => {
      pending.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await loader.current(offset);
        if (version !== generation.current) return;
        setItems(previous => {
          const unique = new Map(
            (append ? previous : []).map(item => [item.id, item]),
          );
          page.items.forEach(item => unique.set(item.id, item));
          return [...unique.values()];
        });
        setNextOffset(page.next_offset ?? null);
      } catch (failure) {
        if (version === generation.current) {
          setError(
            failure instanceof Error ? failure.message : '读取失败，请重试',
          );
        }
      } finally {
        if (version === generation.current) {
          pending.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );
  const refresh = useCallback(() => {
    const version = ++generation.current;
    setNextOffset(null);
    request(0, false, version);
  }, [request]);
  useEffect(() => {
    setItems([]);
    refresh();
    return () => {
      generation.current += 1;
    };
    // The caller explicitly identifies the account, filter and revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  const loadMore = () => {
    if (nextOffset !== null && !pending.current) {
      request(nextOffset, true, generation.current);
    }
  };
  return {
    items,
    loading,
    error,
    refresh,
    loadMore,
    hasMore: nextOffset !== null,
  };
}

function PageHeader({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={v.pageHeader}>
      <View style={v.flex}>
        <Text style={v.pageTitle}>{title}</Text>
        <Text style={v.subtitle}>{subtitle}</Text>
      </View>
      {action && onAction && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={action}
          onPress={onAction}
          style={v.addButton}
        >
          <Icon name="plus" size={23} color={accent} />
        </Pressable>
      )}
    </View>
  );
}
function SectionTitle({
  children,
  action,
  onAction,
}: {
  children: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={v.sectionHeader}>
      <Text style={v.sectionTitle}>{children}</Text>
      {action && (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={v.sectionAction}
        >
          <Text style={v.actionText}>{action}</Text>
          <Icon name="chevronRight" size={14} color={secondary} />
        </Pressable>
      )}
    </View>
  );
}
function PageEmpty({
  icon,
  title,
  body,
  action,
  onAction,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={v.empty}>
      <View style={v.emptyIcon}>
        <Icon name={icon} size={26} color={accent} />
      </View>
      <Text style={v.emptyTitle}>{title}</Text>
      <Text style={v.emptyBody}>{body}</Text>
      {action && onAction && (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          style={v.emptyAction}
        >
          <Text style={v.primaryText}>{action}</Text>
          <Icon name="arrowRight" size={16} color={accent} />
        </Pressable>
      )}
    </View>
  );
}
export function ModeNotice({ runtime }: { runtime: RuntimeInfo }) {
  if (runtime.model_mode !== 'local' && runtime.model_mode !== 'demo') {
    return null;
  }
  return (
    <View style={v.modeNotice}>
      <View style={v.modeDot} />
      <View style={v.flex}>
        <Text style={v.modeTitle}>本地演示模式</Text>
        <Text style={v.modeDescription}>
          可整理已保存的资料。尚未连接在线 AI，也不会搜索网页或操作外部账号。
        </Text>
      </View>
    </View>
  );
}

export function TaskCard({
  task,
  compact = false,
}: {
  task: Task;
  compact?: boolean;
}) {
  const { navigate, formatDate } = useApp();
  const active = isActiveTask(task);
  const executionStatus = task.status === 'succeeded'
    ? task.kind === 'todo_prepare' ? '内容已准备' : '执行完成'
    : taskStatuses[task.status];
  const waiting =
    task.status === 'waiting_approval' || task.status === 'uncertain';
  const statusColor = waiting
    ? '#B5824C'
    : task.status === 'failed'
    ? '#B66C72'
    : active
    ? accent
    : secondary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={task.title + '，' + executionStatus}
      onPress={() => navigate({ name: 'task', id: task.id })}
      style={({ pressed }) => [v.taskCard, pressed && v.pressed]}
    >
      <View style={v.taskTop}>
        <View
          style={[
            v.taskIcon,
            {
              backgroundColor: waiting
                ? tint.peach
                : task.status === 'succeeded'
                ? tint.lilac
                : tint.blue,
            },
          ]}
        >
          <Icon
            name={
              task.status === 'succeeded'
                ? 'check'
                : waiting
                ? 'clock'
                : 'tasks'
            }
            size={19}
            color={statusColor}
          />
        </View>
        <View style={v.flex}>
          <Text style={v.itemTitle} numberOfLines={2}>
            {task.title}
          </Text>
          <View style={v.statusRow}>
            <View style={[v.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[v.statusText, { color: statusColor }]}>
              {executionStatus}
            </Text>
            <Text style={v.metadata}>{formatDate(task.created_at)}</Text>
          </View>
        </View>
        <Icon name="chevronRight" size={17} color="#9DA5B4" />
      </View>
      {!compact && (
        <Text style={v.taskSummary} numberOfLines={2}>
          {task.instruction || task.summary}
        </Text>
      )}
      {active && task.status !== 'waiting_approval' && (
        <View style={v.progressTrack}>
          <View
            style={[
              v.progressFill,
              {
                width: (Math.max(3, Math.min(100, task.progress)) + '%') as any,
              },
            ]}
          />
        </View>
      )}
      {!compact && (
        <Text style={v.taskFootnote}>
          {task.model_mode === 'local' ? '本地执行' : 'AI 助手'} ·
          查看执行过程与结果
        </Text>
      )}
    </Pressable>
  );
}

export function HomeScreen({ onTasks, pendingInputs = 0 }: { onTasks: () => void; pendingInputs?: number }) {
  const { api, user, navigate, revision, invalidate } = useApp();
  const data = useResource(() => api.today(), [api, revision]);
  const todos = useResource(() => listTodos(api, { filter: 'active', scope: 'today', offset: 0, limit: 50 }), [api, revision]);
  const action = useAction();
  const [briefOpen, setBriefOpen] = useState(false);
  const { refresh: refreshToday } = data;
  const { refresh: refreshTodos } = todos;
  const refreshHome = useCallback(() => {
    refreshToday();
    refreshTodos();
  }, [refreshToday, refreshTodos]);
  // A foreground identity check may cancel the initial read. Let all synchronous
  // guard invalidation listeners run before queuing another guarded GET.
  useEffect(() => {
    let active = true;
    const unsubscribe = platform.onForeground?.(() => {
      Promise.resolve().then(() => {
        if (active) refreshHome();
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [api, user?.id, refreshHome]);
  // Preview and totals can straddle a completion; refresh until both settle.
  const hasActiveTasks = Boolean(
    data.value && (
      (data.value.stats.active_tasks ?? 0) > 0 || data.value.tasks.some(isActiveTask)
    ),
  );
  const unreadCount = data.value
    ? data.value.stats.unread_notifications ??
      data.value.notifications.filter(item => !item.read).length
    : 0;
  useEffect(() => {
    if (!hasActiveTasks) {
      return;
    }
    const timer = setInterval(data.refresh, 8000);
    return () => clearInterval(timer);
  }, [hasActiveTasks, data.refresh]);
  const now = new Date();
  const timezone = user?.timezone ?? 'Asia/Shanghai';
  const date = chineseDayLabel(now, timezone);
  const localTime = (value?: string | null) => {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    try { return localDue(value, timezone); } catch { return ''; }
  };
  const day = localTime(now.toISOString()).slice(0, 10);
  const nextSchedule = data.value?.schedules
    .filter(item => item.enabled && Date.parse(item.next_run_at) >= now.getTime() &&
      localTime(item.next_run_at).startsWith(day + ' '))
    .sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at))[0];
  const due = (todos.value?.items ?? [])
    .filter(item => localTime(item.due_at).startsWith(day + ' '))
    .sort((a, b) => Date.parse(a.due_at!) - Date.parse(b.due_at!))[0];
  const approval = data.value?.tasks.find(task => task.status === 'waiting_approval');
  const rows: Array<{ title: string; detail: string; icon: IconName; tint: string; route: Route }> = [];
  if (nextSchedule) rows.push({
    title: nextSchedule.title, detail: localTime(nextSchedule.next_run_at).slice(11) + ' · 计划',
    icon: 'calendar', tint: tint.blue, route: { name: 'schedule', schedule: nextSchedule },
  });
  if (due) rows.push({
    title: due.title, detail: '今天到期 · 事项', icon: 'tasks', tint: '#EAF4EE', route: { name: 'todo', id: due.id },
  });
  if (approval) rows.push({
    title: approval.title, detail: '待你确认 · 助手执行', icon: 'bell', tint: tint.peach, route: { name: 'task', id: approval.id },
  });
  else if (pendingInputs > 0) rows.push({
    title: '手机分享资料', detail: `${pendingInputs} 条待你接收`, icon: 'file', tint: tint.peach, route: { name: 'integrations' },
  });
  const briefing = data.value?.briefing.trim() ?? '';
  const hasBriefing = Boolean(briefing) &&
    !(briefing.startsWith('你有 ') && briefing.includes('点击生成简报，后台会依据已保存的资料整理。'));
  const loadingToday = (data.loading && !data.value) || (todos.loading && !todos.value);
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={(data.loading && Boolean(data.value)) || (todos.loading && Boolean(todos.value))}
          onRefresh={refreshHome}
          tintColor={accent}
        />
      }
      contentContainerStyle={v.homeContent}
    >
      <View style={v.greetingRow}>
        <View style={v.flex}>
          <Text style={v.date}>{date}</Text>
          <Text style={v.greeting}>
            {user?.name ? '你好，' + user.name : '你好'}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看通知"
          onPress={() => navigate({ name: 'notifications' })}
          style={v.notificationButton}
        >
          <Icon name="bell" size={22} color={secondary} />
          {unreadCount > 0 && (
            <View accessibilityLabel="有未读通知" style={v.unreadDot} />
          )}
        </Pressable>
      </View>
      <View style={v.todayCard}>
        <View style={v.todayHeader}>
          <Text style={v.sectionTitle}>今天</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="查看简报" onPress={() => setBriefOpen(true)} style={v.refreshButton}>
            <Text style={v.primaryText}>查看简报</Text>
            <Icon name="arrowRight" size={13} color={accent} />
          </Pressable>
        </View>
        {rows.map(row => (
          <Pressable
            key={row.detail}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}，${row.detail}`}
            onPress={() => navigate(row.route)}
            style={({ pressed }) => [v.todayRow, pressed && v.pressed]}
          >
            <View style={[v.todayIcon, { backgroundColor: row.tint }]}><Icon name={row.icon} size={19} color={accent} /></View>
            <View style={v.flex}>
              <Text style={v.todayTitle} numberOfLines={2}>{row.title}</Text>
              <Text style={v.todayDetail}>{row.detail}</Text>
            </View>
            <Icon name="chevronRight" size={17} color={secondary} />
          </Pressable>
        ))}
        <ErrorNotice message={data.loading ? null : data.error} retry={refreshHome} />
        {!rows.length && !(data.error && !data.loading) && (
          loadingToday ? <Loading label="正在查看今天的安排…" /> :
            <Pressable accessibilityRole="button" onPress={onTasks} style={v.todayRow}>
              <Text style={[v.todayDetail, v.flex]}>
                {todos.error || todos.value?.next_offset != null ? '查看我的事项' : '今天暂无到期事项或待确认内容'}
              </Text>
              <Icon name="chevronRight" size={17} color={secondary} />
            </Pressable>
        )}
      </View>
      {briefOpen && (
        <Modal transparent animationType="slide" onRequestClose={() => setBriefOpen(false)}>
          <View style={hasBriefing ? v.flex : v.briefOverlay}>
          <SafeAreaView style={hasBriefing ? s.screen : v.briefSheet} edges={hasBriefing ? ['top', 'bottom'] : ['bottom']}>
            <ScrollView bounces={hasBriefing} contentContainerStyle={hasBriefing ? v.homeContent : v.briefSheetContent}>
              <View style={v.todayHeader}>
                <Text accessibilityRole="header" style={hasBriefing ? s.title : v.briefSheetTitle}>今日简报</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="关闭简报" onPress={() => setBriefOpen(false)} style={v.notificationButton}>
                  <Icon name="close" size={22} color={secondary} />
                </Pressable>
              </View>
              {hasBriefing ? (
                <>
                  <Text style={s.small}>最近一次简报</Text>
                  <ResultText content={briefing} textStyle={v.briefText} />
                </>
              ) : <Text style={s.small}>还没有生成简报。生成后可查看今天的待办和已保存资料摘要。</Text>}
              <ErrorNotice message={action.error} />
              <Button accessibilityLabel="更新今日简报" loading={action.busy} onPress={() => action.run(async ({ isCurrent }) => {
                const task = await api.briefing();
                if (!isCurrent()) return;
                setBriefOpen(false);
                invalidate();
                navigate({ name: 'task', id: task.id });
              })}>生成今天的简报</Button>
            </ScrollView>
          </SafeAreaView>
          </View>
        </Modal>
      )}
    </ScrollView>
  );
}

export function TasksScreen({ initialView = 'tasks' }: { initialView?: 'tasks' | 'schedules' } = {}) {
  const { api, navigate, revision, invalidate, formatDate } = useApp();
  const [view, setView] = useState<'tasks' | 'schedules'>(initialView);
  const [filter, setFilter] = useState('all');
  const taskData = usePagedList(
    offset => api.tasks({ status: filter, offset, limit: 50 }),
    [api, filter, revision],
  );
  const data = useResource(() => api.schedules(), [api, revision]);
  const action = useAction();
  const tasks = taskData.items;
  const refresh = () => {
    taskData.refresh();
    data.refresh();
  };
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={
            view === 'tasks'
              ? taskData.loading && tasks.length > 0
              : data.loading && Boolean(data.value)
          }
          onRefresh={refresh}
          tintColor={accent}
        />
      }
      contentContainerStyle={v.pageContent}
    >
      <PageHeader
        title={view === 'schedules' ? '定时安排' : '助手执行记录'}
        subtitle={view === 'schedules' ? '按你的时间，完成固定的整理与提醒。' : '查看妥啦准备内容的进度与结果。'}
        action={view === 'tasks' ? '新建任务' : '新建计划'}
        onAction={() =>
          navigate({ name: view === 'tasks' ? 'newTask' : 'schedule' })
        }
      />
      <View style={v.pageTabs}>
        {[
          ['tasks', '执行记录'],
          ['schedules', '自动计划'],
        ].map(([id, label]) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: view === id }}
            key={id}
            onPress={() => setView(id as typeof view)}
            style={v.pageTab}
          >
            <Text style={[v.pageTabText, view === id && v.pageTabSelected]}>
              {label}
            </Text>
            {view === id && <View style={v.tabUnderline} />}
          </Pressable>
        ))}
      </View>
      {view === 'schedules' && <DailyNewsCard />}
      {view === 'tasks' && (
        <View style={v.filters}>
          {[
            ['all', '全部'],
            ['active', '进行中'],
            ['done', '已完成'],
          ].map(([id, label]) => (
            <Pressable
              accessibilityRole="button"
              key={id}
              onPress={() => setFilter(id)}
              style={[v.filter, filter === id && v.filterSelected]}
            >
              <Text
                style={[v.filterText, filter === id && v.filterTextSelected]}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <ErrorNotice
        message={view === 'tasks' ? taskData.error : data.error}
        retry={refresh}
      />
      <ErrorNotice message={action.error} />
      {(view === 'tasks'
        ? taskData.loading && !tasks.length
        : data.loading && !data.value) && <Loading />}
      {view === 'tasks' ? (
        tasks.length ? (
          <>
            {tasks.map(task => (
              <TaskCard key={task.id} task={task} />
            ))}
            {taskData.hasMore && (
              <Button
                variant="ghost"
                disabled={taskData.loading}
                onPress={taskData.loadMore}
              >
                {taskData.loading ? '正在加载…' : '加载更多任务'}
              </Button>
            )}
          </>
        ) : !taskData.loading && !taskData.error ? (
          <PageEmpty
            icon="tasks"
            title={filter === 'all' ? '还没有任务' : '暂无这类任务'}
            body="可以从整理一份资料，或拆解一个计划开始。"
            action="创建任务"
            onAction={() => navigate({ name: 'newTask' })}
          />
        ) : null
      ) : data.value?.items.length ? (
        data.value.items.map(schedule => (
          <View key={schedule.id} style={v.scheduleCard}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={'编辑计划' + schedule.title}
              onPress={() => navigate({ name: 'schedule', schedule })}
            >
              <View style={v.scheduleTop}>
                <View style={v.scheduleIcon}>
                  <Icon name="calendar" size={20} color="#8981BD" />
                </View>
                <View style={v.flex}>
                  <Text style={v.itemTitle}>{schedule.title}</Text>
                  <Text style={v.scheduleFrequency}>
                    {frequencies[schedule.frequency]} · {schedule.time}
                  </Text>
                </View>
                <Text
                  style={[
                    v.statusText,
                    { color: schedule.enabled ? accent : secondary },
                  ]}
                >
                  {schedule.enabled ? '已开启' : '已暂停'}
                </Text>
              </View>
              <Text style={v.scheduleInstruction} numberOfLines={2}>
                {schedule.instruction}
              </Text>
              <View style={v.scheduleNext}>
                <Icon name="clock" size={13} color="#9AA3B2" />
                <Text style={v.metadata}>
                  下次：
                  {schedule.enabled
                    ? formatDate(schedule.next_run_at, schedule.timezone)
                    : '恢复后继续'}{' '}
                  · {schedule.timezone}
                </Text>
              </View>
            </Pressable>
            <View style={v.scheduleActions}>
              <Pressable
                accessibilityRole="button"
                disabled={action.busy}
                onPress={() =>
                  action.run(async () => {
                    await api.saveSchedule(
                      { enabled: !schedule.enabled },
                      schedule.id,
                    );
                    invalidate();
                  })
                }
                style={v.scheduleAction}
              >
                <Text style={v.primaryText}>
                  {schedule.enabled ? '暂停计划' : '恢复计划'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => navigate({ name: 'schedule', schedule })}
                style={v.scheduleAction}
              >
                <Text style={v.actionText}>编辑</Text>
                <Icon name="chevronRight" size={13} color={secondary} />
              </Pressable>
            </View>
          </View>
        ))
      ) : !data.loading && !data.error ? (
        <PageEmpty
          icon="calendar"
          title="设定一个自动计划"
          body="简报、回顾或固定的整理工作，设好时间后按计划执行。"
          action="创建计划"
          onAction={() => navigate({ name: 'schedule' })}
        />
      ) : null}
    </ScrollView>
  );
}

export function MemoriesScreen() {
  const { api, user, preferences } = useApp();
  return (
    <MemoryHome key={`${api.baseUrl}:${user?.id ?? ''}:${preferences?.instance?.id ?? ''}`} />
  );
}

export function CapabilitiesScreen() {
  const { api, navigate, revision } = useApp();
  const data = useResource(() => api.capabilities(), [api, revision]);
  const connections = useResource(() => api.connectors(), [api, revision]);
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const action = useAction();
  const labels = {
    available: '可用',
    not_configured: '未配置',
    coming_soon: '待开放',
  };
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(data.value)}
          onRefresh={() => {
            data.refresh();
            connections.refresh();
          }}
          tintColor={accent}
        />
      }
      contentContainerStyle={v.pageContent}
    >
      <PageHeader title="能力" subtitle="连接你的工具，让帮助更具体。" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="导入 AI 对话"
        onPress={() => navigate({ name: 'aiHistory' })}
        style={v.assistantCard}
      >
        <View style={v.flex}>
          <Text style={v.assistantTitle}>带上过去的 AI 对话</Text>
          <Text style={v.assistantDescription}>
            ChatGPT、Claude、DeepSeek · 导入、搜索与整理记忆候选
          </Text>
          <View style={v.assistantLink}>
            <Text style={v.primaryText}>导入 AI 对话</Text>
            <Icon name="arrowRight" size={15} color={accent} />
          </View>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="我的连接"
        onPress={() => navigate({ name: 'integrations' })}
        style={v.assistantCard}
      >
        <View style={v.flex}>
          <Text style={v.assistantTitle}>我的连接</Text>
          <Text style={v.assistantDescription}>
            连接个人账号 · 健康设备 · 手机通知与分享资料
          </Text>
          <View style={v.assistantLink}>
            <Text style={v.primaryText}>管理我的连接</Text>
            <Icon name="arrowRight" size={15} color={accent} />
          </View>
        </View>
      </Pressable>
      <ErrorNotice message={data.error} retry={data.refresh} />
      {data.loading && !data.value && <Loading />}
      {data.value && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="和助手聊聊"
            onPress={() => navigate({ name: 'chat' })}
            style={v.assistantCard}
          >
            <View style={v.assistantOrb}>
              <AssistantOrb size={84} />
            </View>
            <View style={v.flex}>
              <Text style={v.assistantTitle}>你的个人助手</Text>
              <Text style={v.assistantDescription}>
                {data.value.runtime.model_mode === 'local'
                  ? '本地演示模式 · 体验任务与记忆'
                  : data.value.runtime.model_name || '在线 AI 已配置'}
              </Text>
              <View style={v.assistantLink}>
                <Text style={v.primaryText}>开始对话</Text>
                <Icon name="arrowRight" size={15} color={accent} />
              </View>
            </View>
          </Pressable>
          <ModeNotice runtime={data.value.runtime} />
          <SectionTitle action="刷新" onAction={connections.refresh}>
            账号连接
          </SectionTitle>
          <Text style={v.sectionDescription}>
            仅在授权范围内读取，不会自动发送或修改内容。
          </Text>
          <ErrorNotice
            message={connections.error}
            retry={connections.refresh}
          />
          <ErrorNotice message={action.error} />
          {notice ? <Notice>{notice}</Notice> : null}
          {connections.loading && !connections.value && <Loading />}
          <View style={v.connectionGroup}>
            {connections.value?.items.map((connection, index) => (
              <View
                key={connection.id}
                style={[v.connectionItem, index > 0 && v.connectionDivider]}
              >
                <View style={v.connectionHeader}>
                  <View
                    style={[
                      v.connectionIcon,
                      {
                        backgroundColor:
                          connection.id === 'gmail'
                            ? tint.peach
                            : connection.id === 'google_calendar'
                            ? tint.blue
                            : tint.lilac,
                      },
                    ]}
                  >
                    <Icon
                      name={
                        connection.id === 'google_calendar'
                          ? 'calendar'
                          : connection.id === 'gmail'
                          ? 'attachment'
                          : 'file'
                      }
                      size={21}
                      color={
                        connection.id === 'gmail'
                          ? '#CC9A85'
                          : connection.id === 'google_calendar'
                          ? '#7599D8'
                          : '#A094CA'
                      }
                    />
                  </View>
                  <View style={v.flex}>
                    <Text style={v.itemTitle}>{connection.name}</Text>
                    <Text style={v.connectionDetail}>
                      {connection.status === 'connected'
                        ? '已连接'
                        : connection.status === 'not_connected'
                        ? '尚未授权'
                        : '服务端尚未配置'}
                    </Text>
                  </View>
                  {connection.status !== 'connected' && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={'连接' + connection.name}
                      disabled={
                        connection.status === 'not_configured' || action.busy
                      }
                      onPress={() =>
                        action.run(async () => {
                          const authorization = await api.authorizeConnector(
                            connection.id,
                          );
                          await platform.openUrl(
                            authorization.authorization_url,
                          );
                          setNotice(
                            '请在浏览器完成授权，然后回到这里点击刷新。只会申请这项连接需要的读取权限。',
                          );
                        })
                      }
                      style={[
                        v.connectButton,
                        connection.status === 'not_configured' && v.disabled,
                      ]}
                    >
                      <Text style={v.connectButtonText}>
                        {connection.status === 'not_configured'
                          ? '未配置'
                          : '连接'}
                      </Text>
                    </Pressable>
                  )}
                </View>
                <Text style={v.connectionHint}>{connection.detail}</Text>
                {connection.status === 'connected' && (
                  <>
                    <View style={v.connectedActions}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          setOpened(
                            opened === connection.id ? null : connection.id,
                          )
                        }
                        style={v.connectedAction}
                      >
                        <Text style={v.primaryText}>
                          {opened === connection.id ? '收起资料' : '查看资料'}
                        </Text>
                        <Icon name="chevronRight" size={13} color={accent} />
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          Alert.alert(
                            '断开 ' + connection.name + '？',
                            '撤销 Google 授权可能同时断开这个账号的其他 Google 连接。已保存在任务和对话中的资料需要单独处理。',
                            [
                              { text: '保留', style: 'cancel' },
                              {
                                text: '撤销并断开',
                                style: 'destructive',
                                onPress: () =>
                                  action.run(async () => {
                                    const result =
                                      await api.disconnectConnector(
                                        connection.id,
                                      );
                                    setNotice(
                                      result.revoked
                                        ? '已撤销授权并断开连接。'
                                        : '已从本服务解绑。Google 端撤销未确认，请在 Google 账号授权管理中检查。',
                                    );
                                    connections.refresh();
                                    data.refresh();
                                    setOpened(null);
                                  }),
                              },
                            ],
                          )
                        }
                        style={v.connectedAction}
                      >
                        <Text style={v.actionText}>断开连接</Text>
                      </Pressable>
                    </View>
                    {opened === connection.id && (
                      <ConnectorContents id={connection.id} />
                    )}
                  </>
                )}
              </View>
            ))}
          </View>
          <SectionTitle>助手能力</SectionTitle>
          <View style={v.capabilityGroup}>
            {data.value.items.map((capability, index) => (
              <Pressable
                key={capability.id}
                accessibilityRole="button"
                onPress={() =>
                  Alert.alert(
                    capability.name,
                    capability.description +
                      '\n\n' +
                      capability.detail +
                      (capability.status === 'not_configured'
                        ? '\n\n需要在服务端完成真实配置，当前没有授权或连接你的账号。'
                        : ''),
                    [{ text: '知道了' }],
                  )
                }
                style={[v.capabilityItem, index > 0 && v.connectionDivider]}
              >
                <View style={v.capabilityIcon}>
                  <Icon
                    name={
                      (
                        [
                          'sparkles',
                          'clock',
                          'file',
                          'tasks',
                          'memory',
                        ] as IconName[]
                      )[index % 5]
                    }
                    size={20}
                    color="#8994AE"
                  />
                </View>
                <View style={v.flex}>
                  <Text style={v.itemTitle}>{capability.name}</Text>
                  <Text style={v.capabilityDescription} numberOfLines={2}>
                    {capability.description}
                  </Text>
                </View>
                <View style={v.capabilityState}>
                  <Text
                    style={[
                      v.sourceText,
                      capability.status === 'available' && { color: accent },
                    ]}
                  >
                    {labels[capability.status]}
                  </Text>
                  <Icon name="chevronRight" size={14} color="#A5ADBB" />
                </View>
              </Pressable>
            ))}
          </View>
          <View style={v.executionNote}>
            <Icon name="clock" size={15} color="#98A1B4" />
            <View style={v.flex}>
              <Text style={v.executionTitle}>
                {data.value.runtime.scheduler_mode === 'temporal'
                  ? '持久工作流服务'
                  : '本地任务执行器'}
              </Text>
              <Text style={v.executionBody}>
                任务与计划需要后台服务持续运行。远程推送和外部服务写入尚未开放。
              </Text>
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

function ConnectorContents({ id }: { id: string }) {
  const { api, formatDate } = useApp();
  const data = useResource(() => api.connectorItems(id), [api, id]);
  const action = useAction();
  return (
    <View style={v.connectorContents}>
      <ErrorNotice message={data.error} retry={data.refresh} />
      <ErrorNotice message={action.error} />
      {data.loading && !data.value && <Loading label="正在读取已授权资料…" />}
      {data.value &&
        (data.value.items.length ? (
          data.value.items.map(item => (
            <View key={item.id} style={v.sourceItem}>
              <Text style={v.itemTitle}>{item.title}</Text>
              {item.date && (
                <Text style={v.metadata}>{formatDate(item.date)}</Text>
              )}
              <Text selectable style={v.sourcePreview}>
                {item.preview}
              </Text>
              {item.link && (
                <Button
                  variant="ghost"
                  onPress={() => action.run(() => platform.openUrl(item.link!))}
                >
                  打开原始来源
                </Button>
              )}
            </View>
          ))
        ) : (
          <Text style={v.metadata}>已连接，当前没有可显示的资料。</Text>
        ))}
      {data.value?.next_page_token && (
        <Text style={v.metadata}>
          首版显示最近一页资料，更多内容请前往原始服务查看。
        </Text>
      )}
    </View>
  );
}

const v = StyleSheet.create({
  briefOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(27,37,59,0.30)' },
  briefSheet: { maxHeight: '85%', backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26 },
  briefSheetContent: { paddingHorizontal: 22, paddingTop: 13, paddingBottom: 18, gap: 10 },
  briefSheetTitle: { fontSize: 22, fontWeight: '600', color: colors.ink },
  flex: { flex: 1 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  pageContent: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 32 },
  homeContent: { paddingHorizontal: 22, paddingTop: 4, paddingBottom: 24 },
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    marginBottom: 22,
  },
  pageTitle: {
    fontSize: 26,
    lineHeight: 36,
    fontWeight: '500',
    color: '#303849',
  },
  subtitle: { fontSize: 13, lineHeight: 21, color: secondary, marginTop: 6 },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
    color: '#424959',
  },
  sectionAction: {
    minWidth: 52,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingLeft: 12,
  },
  actionText: { fontSize: 12, lineHeight: 20, color: secondary },
  primaryText: {
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '500',
    color: accent,
  },
  greetingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 3,
    marginBottom: 20,
    gap: 12,
  },
  date: { fontSize: 12, lineHeight: 20, color: '#8B93A4', marginBottom: 9 },
  greeting: {
    fontSize: 26,
    lineHeight: 36,
    fontWeight: '500',
    color: '#303849',
  },
  notificationButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 5,
  },
  unreadDot: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: accent,
    right: 11,
    top: 9,
    borderWidth: 1,
    borderColor: 'white',
  },
  todayCard: {
    borderRadius: 24,
    paddingHorizontal: 19,
    paddingTop: 7,
    paddingBottom: 6,
    backgroundColor: 'rgba(255,255,255,0.83)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.96)',
  },
  todayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    minHeight: 47,
  },
  todayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 58,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#E5E9F1',
  },
  todayIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  todayTitle: { fontSize: 15, lineHeight: 22, color: colors.ink, fontWeight: '500' },
  todayDetail: { fontSize: 12, lineHeight: 18, color: secondary },
  refreshButton: {
    minWidth: 52,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 5,
  },
  briefText: {
    fontSize: 14,
    lineHeight: 25,
    color: '#626B7C',
    paddingBottom: 2,
  },
  sourceText: { fontSize: 10, lineHeight: 17, color: '#9BA3B2' },
  modeNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 2,
    marginTop: 17,
    marginBottom: 4,
  },
  modeDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#B2A3CC',
    marginTop: 6,
  },
  modeTitle: { fontSize: 11, lineHeight: 18, color: '#9294AD' },
  modeDescription: {
    fontSize: 10,
    lineHeight: 17,
    color: '#8792A6',
    marginTop: 2,
  },
  taskCard: {
    padding: 16,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.94)',
    borderRadius: 21,
    marginBottom: 10,
  },
  taskTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  taskIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemTitle: {
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '500',
    color: '#465064',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 3,
  },
  statusDot: { width: 4, height: 4, borderRadius: 2 },
  statusText: { fontSize: 10, lineHeight: 18, color: secondary },
  metadata: { fontSize: 10, lineHeight: 18, color: '#9AA3B3', marginLeft: 3 },
  taskSummary: {
    fontSize: 12,
    lineHeight: 21,
    color: secondary,
    marginTop: 12,
  },
  progressTrack: {
    height: 2,
    backgroundColor: '#EEF1F8',
    marginTop: 14,
    overflow: 'hidden',
    borderRadius: 2,
  },
  progressFill: { height: 2, borderRadius: 2, backgroundColor: '#AAC2F3' },
  taskFootnote: {
    fontSize: 10,
    lineHeight: 18,
    color: '#A5ACBA',
    marginTop: 9,
  },
  pageTabs: {
    flexDirection: 'row',
    gap: 26,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#DEE4EF',
    marginBottom: 17,
  },
  pageTab: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 2,
    paddingBottom: 6,
  },
  pageTabText: { fontSize: 15, color: '#A0A7B5' },
  pageTabSelected: { fontWeight: '500', color: '#526B9E' },
  tabUnderline: {
    position: 'absolute',
    width: 22,
    height: 2,
    backgroundColor: '#7F9FE2',
    borderRadius: 2,
    bottom: 0,
    alignSelf: 'center',
  },
  filters: { flexDirection: 'row', gap: 9, marginBottom: 17 },
  filter: {
    minHeight: 44,
    paddingHorizontal: 15,
    borderRadius: 14,
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.36)',
  },
  filterSelected: { backgroundColor: '#E7EDFB' },
  filterText: { fontSize: 12, lineHeight: 19, color: '#929BAD' },
  filterTextSelected: { color: '#6484C0', fontWeight: '500' },
  scheduleCard: {
    padding: 17,
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'white',
    borderRadius: 22,
    marginBottom: 12,
  },
  scheduleTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  scheduleIcon: {
    width: 38,
    height: 38,
    borderRadius: 14,
    backgroundColor: '#F0EDFA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scheduleFrequency: {
    fontSize: 12,
    lineHeight: 19,
    color: '#8C96A8',
    marginTop: 2,
  },
  scheduleInstruction: {
    fontSize: 12,
    lineHeight: 21,
    color: '#8D96A7',
    marginTop: 12,
  },
  scheduleNext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 13,
  },
  scheduleActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#E9EDF5',
    marginTop: 14,
    paddingTop: 3,
  },
  scheduleAction: {
    minWidth: 52,
    minHeight: 44,
    justifyContent: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  assistantCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.67)',
    borderWidth: 1,
    borderColor: 'white',
    padding: 13,
    gap: 13,
  },
  assistantOrb: { width: 84, height: 84 },
  assistantTitle: {
    fontSize: 17,
    lineHeight: 27,
    fontWeight: '500',
    color: '#535D72',
  },
  assistantDescription: {
    fontSize: 11,
    lineHeight: 20,
    color: '#9198AA',
    marginTop: 3,
  },
  assistantLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 9,
  },
  sectionDescription: {
    fontSize: 11,
    lineHeight: 19,
    color: '#A1A8B8',
    marginTop: -7,
    marginBottom: 14,
  },
  connectionGroup: {
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.76)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
    paddingHorizontal: 17,
  },
  connectionItem: { paddingVertical: 17 },
  connectionDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#E9EDF4',
  },
  connectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  connectionIcon: {
    width: 39,
    height: 39,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectionDetail: {
    fontSize: 10,
    lineHeight: 18,
    color: '#A1A8B8',
    marginTop: 1,
  },
  connectionHint: {
    fontSize: 11,
    lineHeight: 20,
    color: secondary,
    marginTop: 10,
  },
  connectButton: {
    minWidth: 60,
    minHeight: 44,
    backgroundColor: '#EEF2FB',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 11,
    borderRadius: 13,
  },
  connectButtonText: { fontSize: 11, fontWeight: '500', color: '#7795C9' },
  connectedActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  connectedAction: {
    minWidth: 64,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  capabilityGroup: {
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.66)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 16,
  },
  capabilityItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
  },
  capabilityIcon: { width: 30, alignItems: 'center' },
  capabilityDescription: {
    fontSize: 11,
    lineHeight: 19,
    color: secondary,
    marginTop: 3,
  },
  capabilityState: { alignItems: 'flex-end', gap: 4 },
  executionNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    paddingHorizontal: 3,
    marginTop: 24,
  },
  executionTitle: { fontSize: 11, lineHeight: 18, color: '#929CAF' },
  executionBody: {
    fontSize: 10,
    lineHeight: 18,
    color: '#A9B0BE',
    marginTop: 4,
  },
  connectorContents: {
    marginTop: 5,
    paddingTop: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#E8ECF4',
  },
  sourceItem: { paddingBottom: 14, marginBottom: 10 },
  sourcePreview: {
    fontSize: 12,
    lineHeight: 21,
    color: '#8A94A6',
    marginTop: 5,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 49,
    paddingBottom: 35,
    paddingHorizontal: 25,
  },
  emptyIcon: {
    width: 62,
    height: 62,
    borderRadius: 23,
    backgroundColor: 'rgba(234,241,255,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 19,
  },
  emptyTitle: {
    fontSize: 16,
    lineHeight: 25,
    color: '#66758F',
    fontWeight: '500',
  },
  emptyBody: {
    fontSize: 12,
    lineHeight: 22,
    color: '#A1A9B8',
    textAlign: 'center',
    marginTop: 8,
    maxWidth: 260,
  },
  emptyAction: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 14,
  },
});

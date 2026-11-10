/** UI transport fixtures. Persistence and model execution are tested in Rust separately. */
import React from 'react';
import { AccessibilityInfo, Text as NativeText, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { Button } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import { GrowthProvider } from '../src/features/growth/context';
import {
  GrowthScreen,
  GrowthWeekScreen,
} from '../src/features/growth/GrowthScreen';
import { GrowthFocusTimer } from '../src/features/growth/GrowthFocusTimer';
import type {
  GrowthJourney,
  GrowthJourneys,
  GrowthPreferences,
  GrowthSummary,
  GrowthHistory,
} from '../src/features/growth/types';
import type { Todo } from '../src/features/todos/types';

jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/platform/ports', () => ({
  platform: {
    share: jest.fn().mockResolvedValue(undefined),
    onForeground: jest.fn(() => () => {}),
  },
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
});
beforeEach(() => jest.clearAllMocks());
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
const todo = (id = 'owned-todo'): Todo => ({
  id,
  title: '读懂一次借用',
  description: '留下自己的解释',
  kind: 'learning',
  status: 'pending',
  source_kind: 'growth_journey',
  source_label: '我的成长旅程',
  created_at: '2026-11-03T00:00:00Z',
  updated_at: '2026-11-03T00:00:00Z',
  version: 1,
});
function route(): GrowthJourney {
  return {
    id: 'owned-route',
    goal: '看懂第一个 Rust 借用示例',
    kind: 'learning',
    daily_minutes: 15,
    status: 'ready',
    error: null,
    can_retry: false,
    version: 2,
    completed_steps: 0,
    skipped_steps: 0,
    steps: [0, 1, 2].map(n => ({
      id: 'step-' + n,
      title: ['读懂一次借用', '修改一次引用', '留下自己的作品'][n],
      description: '从一个小示例开始，不必一次看完所有知识。',
      criterion: '写下一句自己的解释',
      estimated_minutes: 5,
      status: n === 0 ? 'current' : 'locked',
      todo: null,
      difficulty: null,
      version: 1,
    })),
  };
}
function fixture(active: GrowthJourney | null = null) {
  const prefs: GrowthPreferences = {
    enabled: !!active,
    daily_minutes: 15,
    use_existing_todos: false,
    goals: active ? [{ kind: 'learning', title: active.goal }] : [],
    paused_today: false,
    timezone: 'Asia/Shanghai',
    version: active ? 1 : 0,
    halo: 'classic',
  };
  const summary: GrowthSummary = {
    total_xp: 0,
    level: 1,
    level_xp: 0,
    xp_per_level: 60,
    halo: 'classic',
    available_halos: ['classic'],
    today: {
      date: '2026-11-03',
      timezone: 'Asia/Shanghai',
      action_count: 0,
      xp: 0,
      paused: false,
    },
    week: {
      start_date: '2026-11-02',
      end_date: '2026-11-08',
      active_days: 0,
      days: [{ date: '2026-11-03', action_count: 0, xp: 0, paused: false }],
      communication_actions: 0,
      learning_actions: 0,
      exercise_minutes: 0,
      records: [],
    },
    milestones: [],
  };
  const state = {
    prefs,
    summary,
    journeys: { active, past: [] } as GrowthJourneys,
    history: {
      period: 'week',
      action_count: 0,
      active_days: 0,
      learning_actions: 0,
      exercise_minutes: 0,
      total_xp: 0,
      records: [],
      next_offset: null,
    } as GrowthHistory,
  };
  const override = jest.fn();
  const request = jest.fn(
    async (path: string, method = 'GET', body?: any): Promise<any> => {
      const value = override(path, method, body);
      if (value !== undefined) return value;
      if (path === '/growth/preferences') return copy(state.prefs);
      if (path === '/growth/summary') return copy(state.summary);
      if (path === '/daily-plan')
        return {
          id: null,
          local_date: '2026-11-03',
          timezone: 'Asia/Shanghai',
          status: state.prefs.enabled ? 'ready' : 'disabled',
          error: null,
          items: [],
          can_retry: false,
        };
      if (path === '/growth/journeys' && method === 'GET')
        return copy(state.journeys);
      if (path === '/growth/journeys' && method === 'POST') {
        const j = {
          ...route(),
          goal: body.goal,
          kind: body.kind,
          daily_minutes: body.daily_minutes,
          status: 'queued' as const,
          steps: [],
        };
        state.journeys.active = j;
        state.prefs = {
          ...state.prefs,
          enabled: true,
          daily_minutes: body.daily_minutes,
          goals: [{ kind: body.kind, title: body.goal }],
          version: state.prefs.version + 1,
        };
        return copy(j);
      }
      if (path.endsWith('/start')) {
        const step = state.journeys.active!.steps.find(s =>
          path.includes(s.id),
        )!;
        step.todo ??= todo();
        step.version++;
        return copy(step.todo);
      }
      if (path.includes('/steps/') && path.endsWith('/commands')) {
        const j = state.journeys.active!;
        const step = j.steps.find(s => path.includes(s.id))!;
        if (body.action === 'skip') {
          step.status = 'skipped';
          j.skipped_steps++;
          const next = j.steps.find(s => s.status === 'locked');
          if (next) next.status = 'current';
        } else {
          step.difficulty = body.action;
        }
        step.version++;
        return copy(j);
      }
      if (path.startsWith('/growth/history?'))
        return {
          ...copy(state.history),
          period: path.match(/period=([^&]+)/)![1],
        };
      throw new Error('Unmocked ' + path);
    },
  );
  return {
    api: { request, baseUrl: 'https://journey.test' },
    state,
    override,
    request,
  };
}
function context(api: unknown, id = 'owner'): AppContextValue {
  return {
    api,
    user: { id, name: '我', timezone: 'Asia/Shanghai' },
    preferences: { serverUrl: 'https://journey.test' },
    navigate: jest.fn(),
    back: jest.fn(),
    invalidate: jest.fn(),
    revision: 0,
  } as unknown as AppContextValue;
}
async function mount(
  f: ReturnType<typeof fixture>,
  page: React.ReactNode = <GrowthScreen />,
  provider = true,
) {
  let tree!: ReactTestRenderer;
  let ctx = context(f.api);
  const render = () => (
    <AppProvider value={ctx}>
      {provider ? <GrowthProvider>{page}</GrowthProvider> : page}
    </AppProvider>
  );
  await act(async () => {
    tree = create(render());
  });
  return {
    tree,
    get ctx() {
      return ctx;
    },
    async refresh() {
      ctx = { ...ctx, revision: ctx.revision + 1 };
      await act(async () => tree.update(render()));
    },
    async owner(api: unknown, id: string) {
      ctx = context(api, id);
      await act(async () => tree.update(render()));
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}
const flatten = (x: any): string =>
  typeof x === 'string' || typeof x === 'number'
    ? String(x)
    : Array.isArray(x)
    ? x.map(flatten).join('')
    : x?.props
    ? flatten(x.props.children)
    : '';
const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(NativeText)
    .map(n => flatten(n.props.children))
    .join(' ');
async function button(tree: ReactTestRenderer, label: string) {
  const n = tree.root
    .findAllByType(Button)
    .find(n => flatten(n.props.children) === label);
  expect(n).toBeDefined();
  expect(n!.props.disabled).not.toBe(true);
  await act(async () => n!.props.onPress());
}
async function press(tree: ReactTestRenderer, label: string) {
  const n = tree.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  )[0];
  expect(n).toBeDefined();
  await act(async () => n.props.onPress());
}

test('first use needs a chosen goal, time and explicit enable; entry never starts a paid generation', async () => {
  const f = fixture(),
    app = await mount(f);
  try {
    expect(texts(app.tree)).toContain('最近，想让哪件事变好一点');
    expect(f.request.mock.calls.filter(([, m]) => m === 'POST')).toHaveLength(
      0,
    );
    const start = app.tree.root
      .findAllByType(Button)
      .find(n => flatten(n.props.children) === '开始我的旅程')!;
    expect(start.props.disabled).toBe(true);
    const input = app.tree.root
      .findAllByType(TextInput)
      .find(n => n.props.accessibilityLabel === '我的成长目标')!;
    await act(async () => input.props.onChangeText('每天练习一次旅行英语'));
    await press(app.tree, '每天5分钟');
    const consent = app.tree.root.findAll(
      n =>
        n.props.accessibilityRole === 'checkbox' &&
        typeof n.props.onPress === 'function',
    )[0];
    await act(async () => consent.props.onPress());
    await button(app.tree, '开始我的旅程');
    const sent = f.request.mock.calls.find(
      ([p, m]) => p === '/growth/journeys' && m === 'POST',
    )!;
    expect(sent[2]).toMatchObject({
      goal: '每天练习一次旅行英语',
      kind: 'learning',
      daily_minutes: 5,
      preferences_version: 0,
    });
    expect(sent[2].client_request_id).toBeTruthy();
    expect(texts(app.tree)).toContain('正在把目标拆成一段小旅程');
    expect(f.state.summary.total_xp).toBe(0);
  } finally {
    await app.close();
  }
});
test('the compact overview shows one current step and starts the ordinary owned Todo', async () => {
  const f = fixture(route()),
    app = await mount(f);
  try {
    expect(
      app.tree.root.findAll(n => n.props.testID === 'growth-compact-hero')
        .length,
    ).toBeGreaterThan(0);
    expect(texts(app.tree)).toContain('读懂一次借用');
    expect(texts(app.tree)).not.toContain('修改一次引用');
    await button(app.tree, '开始这一步');
    expect(app.ctx.navigate).toHaveBeenCalledWith({
      name: 'todo',
      id: 'owned-todo',
    });
    const call = f.request.mock.calls.find(
      ([p, m]) => p.endsWith('/step-0/start') && m === 'POST',
    )!;
    expect(call[2].version).toBe(1);
    expect(f.state.summary.total_xp).toBe(0);
  } finally {
    await app.close();
  }
});
test('an existing route Todo is not shown again as a daily recommendation', async () => {
  const j = route();
  const owned = todo();
  j.steps[0].todo = owned;
  const f = fixture(j);
  f.override.mockImplementation(path =>
    path === '/daily-plan'
      ? {
          id: 'today-plan',
          local_date: '2026-11-03',
          timezone: 'Asia/Shanghai',
          status: 'ready',
          error: null,
          items: [
            {
              id: 'duplicate-ref',
              title: owned.title,
              description: owned.description,
              kind: owned.kind,
              reason: '同一条真实待办',
              estimated_minutes: 5,
              source_kind: 'growth_journey',
              source_label: '成长旅程',
              todo_id: owned.id,
              todo: owned,
              status: 'accepted',
              focus: false,
              can_replace: false,
              version: 1,
            },
          ],
          can_retry: false,
        }
      : undefined,
  );
  const app = await mount(f);
  try {
    const occurrences = app.tree.root
      .findAllByType(NativeText)
      .filter(node => flatten(node.props.children) === owned.title);
    expect(occurrences).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('AI coaching carries the real goal and completion criterion without claiming completion', async () => {
  const f = fixture(route()),
    app = await mount(f);
  try {
    await press(app.tree, 'AI 陪我做');
    const sent = (app.ctx.navigate as jest.Mock).mock.calls.at(-1)![0];
    expect(sent.name).toBe('chat');
    expect(sent.prompt).toContain('看懂第一个 Rust 借用示例');
    expect(sent.prompt).toContain('写下一句自己的解释');
    expect(sent.prompt).toContain('不要替我勾选完成');
    expect(f.state.summary.total_xp).toBe(0);
  } finally {
    await app.close();
  }
});
test('skipping advances the route without creating or completing any task', async () => {
  const f = fixture(route()),
    app = await mount(f);
  try {
    await press(app.tree, '当前成长步骤选项');
    await button(app.tree, '跳过这一步');
    expect(texts(app.tree)).toContain('修改一次引用');
    expect(f.state.journeys.active!.skipped_steps).toBe(1);
    expect(f.state.summary.total_xp).toBe(0);
    expect(f.request.mock.calls.some(([p]) => p.endsWith('/start'))).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});
test('late creation in a previous account cannot restore its goal or navigate', async () => {
  const f = fixture(),
    other = fixture(route()),
    late = deferred<GrowthJourney>();
  const app = await mount(f);
  try {
    const input = app.tree.root
      .findAllByType(TextInput)
      .find(n => n.props.accessibilityLabel === '我的成长目标')!;
    await act(async () => input.props.onChangeText('旧账号的私人目标'));
    const consent = app.tree.root.findAll(
      n =>
        n.props.accessibilityRole === 'checkbox' &&
        typeof n.props.onPress === 'function',
    )[0];
    await act(async () => consent.props.onPress());
    f.override.mockImplementation((p, m) =>
      p === '/growth/journeys' && m === 'POST' ? late.promise : undefined,
    );
    const start = app.tree.root
      .findAllByType(Button)
      .find(n => flatten(n.props.children) === '开始我的旅程')!;
    let pending!: Promise<void>;
    await act(async () => {
      pending = start.props.onPress();
    });
    await app.owner(other.api, 'other');
    await act(async () =>
      late.resolve({ ...route(), goal: '旧账号的私人目标' }),
    );
    await pending;
    expect(texts(app.tree)).not.toContain('旧账号的私人目标');
    expect(texts(app.tree)).toContain(other.state.journeys.active!.goal);
    expect(app.ctx.navigate).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
test('history filters real period totals and shares only statistics until titles are explicitly included', async () => {
  const f = fixture(route());
  f.state.history = {
    period: 'week',
    action_count: 1,
    active_days: 1,
    learning_actions: 1,
    exercise_minutes: 0,
    total_xp: 10,
    records: [
      {
        reward: {
          id: 'reward:mine',
          todo_id: 'mine',
          title: '私人练习标题',
          kind: 'learning',
          xp: 10,
          active: true,
          version: 1,
          earned_at: '2026-11-03T00:00:00Z',
          updated_at: '2026-11-03T00:00:00Z',
          local_date: '2026-11-03',
          timezone: 'Asia/Shanghai',
          minutes: null,
        },
        note: '私人笔记不应默认分享',
      },
    ],
    next_offset: null,
  };
  const app = await mount(f, <GrowthWeekScreen />);
  try {
    await press(app.tree, '查看本月成长');
    expect(
      f.request.mock.calls.some(([p]) =>
        p.includes('/growth/history?period=month'),
      ),
    ).toBe(true);
    const share = app.tree.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        flatten(n.props.children).includes('分享这段成长'),
    )[0];
    await act(async () => share.props.onPress());
    await button(app.tree, '打开系统分享');
    expect(platform.share).toHaveBeenCalled();
    const text = (platform.share as jest.Mock).mock.calls.at(-1)![0];
    expect(text).not.toContain('私人练习标题');
    expect(text).not.toContain('私人笔记');
    const choose = app.tree.root.findAll(
      n =>
        n.props.accessibilityRole === 'checkbox' &&
        typeof n.props.onPress === 'function',
    )[0];
    await act(async () => choose.props.onPress());
    await button(app.tree, '打开系统分享');
    const opted = (platform.share as jest.Mock).mock.calls.at(-1)![0];
    expect(opted).toContain('私人练习标题');
    expect(opted).not.toContain('私人笔记');
    await press(app.tree, '查看全部成长');
    expect(
      f.request.mock.calls.some(([p]) =>
        p.includes('/growth/history?period=all'),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
test('a local focus timer supports pause and expiry without writing a completion or XP', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-03T00:00:00Z'));
  const f = fixture();
  const app = await mount(
    f,
    <GrowthFocusTimer todoId="mine" minutes={1} />,
    false,
  );
  try {
    await press(app.tree, '开始专注计时');
    await act(async () => jest.advanceTimersByTime(10000));
    expect(texts(app.tree)).toContain('00:50');
    await press(app.tree, '暂停专注计时');
    await act(async () => jest.advanceTimersByTime(10000));
    expect(texts(app.tree)).toContain('00:50');
    await press(app.tree, '开始专注计时');
    await act(async () => jest.advanceTimersByTime(50000));
    expect(texts(app.tree)).toContain('00:00');
    expect(texts(app.tree)).toContain('由你按实际情况确认');
    expect(f.request).not.toHaveBeenCalled();
  } finally {
    await app.close();
    jest.useRealTimers();
  }
});

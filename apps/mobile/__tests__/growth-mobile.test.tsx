import React from 'react';
import { AccessibilityInfo, FlatList, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { Button, ErrorNotice } from '../src/ui/components';
import { GrowthEntry } from '../src/features/growth/DailyGrowth';
import {
  GrowthFeedbackBanner,
  GrowthProvider,
} from '../src/features/growth/context';
import {
  GrowthScreen,
  GrowthWeekScreen,
} from '../src/features/growth/GrowthScreen';
import { GrowthSettingsScreen } from '../src/features/growth/GrowthSettings';
import { localDateLabel } from '../src/features/growth/model';
import { TodoDetail } from '../src/features/todos/TodoDetail';
import { TodosScreen } from '../src/features/todos/TodosScreen';
import { platform } from '../src/platform/ports';
import type { Todo } from '../src/features/todos/types';
import type {
  DailyPlan,
  GrowthPreferences,
  GrowthReward,
  GrowthSummary,
} from '../src/features/growth/types';

jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/platform/ports', () => ({
  platform: { share: jest.fn(), onForeground: () => () => {} },
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(true);
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const todo = (extra: Partial<Todo> = {}): Todo => ({
  id: 'one',
  title: '用户自己的事项',
  description: '',
  kind: 'general',
  status: 'pending',
  source_kind: 'manual',
  source_label: '你添加',
  created_at: '2026-10-29T00:00:00Z',
  updated_at: '2026-10-29T00:00:00Z',
  version: 1,
  ...extra,
});
const preferences = (
  extra: Partial<GrowthPreferences> = {},
): GrowthPreferences => ({
  enabled: true,
  daily_minutes: 15,
  use_existing_todos: true,
  goals: [{ kind: 'learning', title: '用户自己选择的学习目标' }],
  paused_today: false,
  timezone: 'America/Los_Angeles',
  version: 1,
  halo: 'classic',
  ...extra,
});
function summary(rewards: GrowthReward[] = []): GrowthSummary {
  const active = rewards.filter(reward => reward.active),
    total = active.reduce((sum, reward) => sum + reward.xp, 0);
  return {
    total_xp: total,
    level: 1 + Math.floor(total / 60),
    level_xp: total % 60,
    xp_per_level: 60,
    halo: 'classic',
    available_halos: total >= 120 ? ['classic', 'sunrise'] : ['classic'],
    today: {
      date: '2026-10-30',
      timezone: 'America/Los_Angeles',
      action_count: active.length,
      xp: total,
      paused: false,
    },
    week: {
      start_date: '2026-10-26',
      end_date: '2026-11-01',
      active_days: active.length ? 1 : 0,
      days: [
        {
          date: '2026-10-30',
          action_count: active.length,
          xp: total,
          paused: false,
        },
      ],
      communication_actions: active.filter(
        reward => reward.kind === 'communication',
      ).length,
      learning_actions: active.filter(reward => reward.kind === 'learning')
        .length,
      exercise_minutes: active.reduce(
        (sum, reward) =>
          sum + (reward.kind === 'exercise' ? reward.minutes ?? 0 : 0),
        0,
      ),
      records: active,
    },
    milestones: [],
  };
}
function apiFixture(initial = todo()) {
  let saved = clone(initial),
    prefs = preferences(),
    rewards: GrowthReward[] = [],
    replied = false;
  let plan: DailyPlan = {
    id: 'owned-plan',
    local_date: '2026-10-30',
    timezone: prefs.timezone,
    status: 'ready',
    error: null,
    items: [],
    can_retry: true,
  };
  function reconcile(active: boolean, actualMinutes: number | null = null) {
    if (!prefs.enabled) return;
    const current = rewards.find(reward => reward.todo_id === saved.id);
    if (current) {
      current.active = active;
      current.version++;
      current.minutes = actualMinutes;
      return;
    }
    if (active)
      rewards.push({
        id: 'reward:' + saved.id,
        todo_id: saved.id,
        title: saved.title,
        kind: saved.kind,
        xp: 10,
        active,
        earned_at: '2026-10-30T10:00:00Z',
        updated_at: '2026-10-30T10:00:00Z',
        version: 1,
        local_date: '2026-10-30',
        timezone: prefs.timezone,
        minutes: actualMinutes,
      });
  }
  const request = jest.fn(
    async (path: string, method = 'GET', body?: any): Promise<any> => {
      if (path === '/growth/preferences') {
        if (method === 'PATCH') {
          prefs = { ...prefs, ...body, version: prefs.version + 1 };
        }
        return clone(prefs);
      }
      if (path === '/growth/summary') return clone(summary(rewards));
      if (path === '/growth/journeys') return { active: null, past: [] };
      if (path.startsWith('/growth/history?')) {
        const all = summary(rewards);
        return { period: path.match(/period=([^&]+)/)?.[1], action_count: all.week.records.length,
          active_days: all.week.active_days, learning_actions: all.week.learning_actions,
          exercise_minutes: all.week.exercise_minutes, total_xp: all.total_xp,
          records: all.week.records.map(reward => ({ reward, note: null })), next_offset: null };
      }
      if (path.startsWith('/growth/todos/'))
        return {
          reward: clone(
            rewards.find(reward => reward.todo_id === saved.id) ?? null,
          ),
          total_xp: summary(rewards).total_xp,
          level: summary(rewards).level,
        };
      if (path === '/daily-plan') return clone(plan);
      if (path === '/daily-plan/ensure') {
        plan = { ...plan, id: 'queued-plan', status: 'queued' };
        return clone(plan);
      }
      if (path.endsWith('/accept'))
        return {
          item: { ...plan.items[0], status: 'accepted' },
          todo: clone(saved),
        };
      if (path.endsWith('/skip')) {
        plan = { ...plan, items: [] };
        return clone(plan);
      }
      if (path === '/todos/' + saved.id + '/actions') {
        if (method === 'POST') {
          if (body.kind === 'replied') {
            replied = true;
            saved = {
              ...saved,
              status: 'waiting',
              draft: body.draft,
              version: saved.version + 1,
            };
            reconcile(true);
          } else if (body.kind === 'undo_replied') {
            replied = false;
            saved = {
              ...saved,
              status: saved.status === 'waiting' ? 'pending' : saved.status,
              version: saved.version + 1,
            };
            reconcile(saved.status === 'completed');
          } else {
            saved = {
              ...saved,
              status: 'completed',
              progress_notes: body.progress_notes,
              version: saved.version + 1,
            };
            reconcile(true, body.actual_minutes ?? null);
          }
          return {
            todo: clone(saved),
            actions: {
              replied,
              replied_at: replied ? '2026-10-30T10:00:00Z' : null,
            },
            reward: clone(rewards[0] ?? null),
          };
        }
        return { replied, replied_at: replied ? '2026-10-30T10:00:00Z' : null };
      }
      if (path === '/todos/' + saved.id) {
        if (method === 'PATCH') {
          saved = { ...saved, ...body, version: saved.version + 1 };
          if (body.status) reconcile(saved.status === 'completed' || replied);
        }
        return clone(saved);
      }
      if (path.startsWith('/todos?'))
        return {
          items:
            path.includes('filter=active') &&
            !['completed', 'waiting'].includes(saved.status)
              ? [clone(saved)]
              : [],
          next_offset: null,
        };
      throw new Error('Unexpected test request ' + path);
    },
  );
  return {
    api: { baseUrl: 'https://growth.test', request },
    saved: () => saved,
    rewards: () => rewards,
    prefs: () => prefs,
    setPrefs: (value: GrowthPreferences) => {
      prefs = value;
    },
    setPlan: (value: DailyPlan) => {
      plan = value;
    },
  };
}
const context = (api: unknown, userId = 'owner'): AppContextValue =>
  ({
    api,
    user: { id: userId, timezone: 'America/Los_Angeles' },
    preferences: { serverUrl: 'https://growth.test' },
    revision: 0,
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: (value: string) => value,
  } as unknown as AppContextValue);
const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(node => [node.props.children].flat().join(''))
    .join(' ');
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root
    .findAllByType(Button)
    .find(node => [node.props.children].flat().join('') === label)!;
const label = (tree: ReactTestRenderer, value: string) =>
  tree.root.findAll(node => node.props.accessibilityLabel === value)[0];
async function openDailyActions(tree: ReactTestRenderer) {
  await act(async () => label(tree, '更多事项功能').props.onPress());
  await act(async () => label(tree, '每日小行动').props.onPress());
}
async function mount(ui: React.ReactNode, api: unknown, owner = 'owner') {
  const value = context(api, owner);
  let tree!: ReactTestRenderer;
  const render = (next: AppContextValue) => (
    <AppProvider value={next}>
      <GrowthProvider>
        <GrowthFeedbackBanner />
        {ui}
      </GrowthProvider>
    </AppProvider>
  );
  await act(async () => {
    tree = create(render(value));
  });
  return {
    tree,
    value,
    update: async (next: AppContextValue) => {
      await act(async () => tree.update(render(next)));
    },
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

test('server zero remains Lv1 with no demo history and civil dates do not shift to the device timezone', async () => {
  const api = apiFixture();
  const app = await mount(
    <>
      <GrowthEntry />
      <GrowthScreen />
      <GrowthWeekScreen />
    </>,
    api.api,
  );
  expect(texts(app.tree)).toContain('成长 Lv.1');
  expect(texts(app.tree)).toContain('累计 0');
  expect(texts(app.tree)).toContain('还没有已确认的成长行动');
  expect(texts(app.tree)).not.toContain('林总');
  expect(localDateLabel('2026-10-30', true)).toBe('10月30日 · 周五');
  expect(texts(app.tree)).toContain('仅计自行填写的时长，未填的不估算');
  await app.close();
});

test('turning on growth requires a concrete selected goal or saved-todo consent and uses a versioned server write', async () => {
  const api = apiFixture();
  api.setPrefs(
    preferences({
      enabled: false,
      goals: [],
      use_existing_todos: false,
      version: 0,
    }),
  );
  const app = await mount(<GrowthSettingsScreen />, api.api);
  await act(async () => label(app.tree, '开启每日成长').props.onPress());
  await act(async () => button(app.tree, '开启并保存').props.onPress());
  expect(api.api.request.mock.calls.some(call => call[1] === 'PATCH')).toBe(
    false,
  );
  expect(texts(app.tree)).toContain('请选择一个目标');
  await act(async () => label(app.tree, '学点新知识').props.onPress());
  await act(async () =>
    label(app.tree, '学点新知识：我的目标').props.onChangeText(
      '我自己的法语学习目标',
    ),
  );
  await act(async () => button(app.tree, '开启并保存').props.onPress());
  expect(api.api.request).toHaveBeenCalledWith(
    '/growth/preferences',
    'PATCH',
    expect.objectContaining({
      version: 0,
      enabled: true,
      goals: [{ kind: 'learning', title: '我自己的法语学习目标' }],
      use_existing_todos: false,
    }),
  );
  await app.close();
});

test('suggestions use the actual accepted Todo and do not duplicate a referenced ordinary row', async () => {
  const api = apiFixture(todo({ title: '唯一的真实待办' }));
  api.setPlan({
    id: 'owned-plan',
    local_date: '2026-10-30',
    timezone: 'America/Los_Angeles',
    status: 'ready',
    error: null,
    can_retry: true,
    items: [
      {
        id: 'owned-item',
        title: '唯一的真实待办',
        description: '',
        kind: 'general',
        reason: '已有待办',
        estimated_minutes: 5,
        source_kind: 'manual',
        source_label: '你添加',
        todo_id: 'one',
        todo: api.saved(),
        status: 'suggested',
        focus: true,
        can_replace: false,
        version: 2,
      },
    ],
  });
  const app = await mount(<TodosScreen />, api.api);
  expect(app.tree.root.findAllByType(FlatList)).toHaveLength(1);
  expect(texts(app.tree).match(/唯一的真实待办/g)).toHaveLength(1);
  expect(texts(app.tree)).toContain('10月30日 · 周五');
  await openDailyActions(app.tree);
  await act(async () =>
    label(app.tree, '开始建议：唯一的真实待办').props.onPress(),
  );
  expect(api.api.request).toHaveBeenCalledWith(
    '/daily-plan/items/owned-item/accept',
    'POST',
    expect.objectContaining({
      version: 2,
      client_request_id: expect.any(String),
    }),
  );
  expect(app.value.navigate).toHaveBeenCalledWith({ name: 'todo', id: 'one' });
  expect(api.rewards()).toEqual([]);
  await app.close();
});

test('rest keeps unaccepted existing mail visible and accepted learning reachable without duplicate rows', async () => {
  const api = apiFixture(
    todo({ title: '休息时仍在的邮件', kind: 'communication' }),
  );
  api.setPrefs(preferences({ paused_today: true }));
  api.setPlan({
    id: 'rest-plan',
    local_date: '2026-10-30',
    timezone: 'America/Los_Angeles',
    status: 'paused',
    error: null,
    items: [
      {
        id: 'mail-item',
        title: api.saved().title,
        description: '',
        kind: 'communication',
        reason: '',
        estimated_minutes: 5,
        source_kind: 'manual',
        source_label: '你添加',
        todo_id: 'one',
        todo: api.saved(),
        status: 'suggested',
        focus: true,
        can_replace: false,
        version: 1,
      },
    ],
  });
  const app = await mount(<TodosScreen />, api.api);
  expect(texts(app.tree).match(/休息时仍在的邮件/g)).toHaveLength(1);
  await openDailyActions(app.tree);
  expect(texts(app.tree)).toContain('今天留点空白也可以');
  expect(
    api.api.request.mock.calls.filter(call => call[0] === '/daily-plan/ensure'),
  ).toHaveLength(0);
  await app.close();
});

test('returning on the next server-local day replaces yesterday rest plan without relying on the device date', async () => {
  const api = apiFixture();
  api.setPrefs(preferences({ paused_today: true }));
  api.setPlan({
    id: 'yesterday-rest',
    local_date: '2026-10-30',
    timezone: 'America/Los_Angeles',
    status: 'paused',
    error: null,
    items: [],
  });
  let serverDate = '2026-10-30';
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    const result = await original(path, method, body);
    return path === '/growth/summary'
      ? { ...result, today: { ...result.today, date: serverDate } }
      : result;
  });
  let foreground!: () => void;
  const spy = jest
    .spyOn(platform, 'onForeground')
    .mockImplementation(callback => {
      foreground = callback;
      return () => {};
    });
  const app = await mount(<TodosScreen />, api.api);
  await openDailyActions(app.tree);
  expect(texts(app.tree)).toContain('今天留点空白也可以');
  api.setPrefs(preferences({ paused_today: false }));
  serverDate = '2026-10-31';
  api.setPlan({
    id: 'new-server-day',
    local_date: serverDate,
    timezone: 'America/Los_Angeles',
    status: 'ready',
    error: null,
    items: [],
  });
  await act(async () => foreground());
  expect(texts(app.tree)).toContain('10月31日');
  expect(texts(app.tree)).toContain('今天没有新的推荐');
  expect(texts(app.tree)).not.toContain('今天留点空白也可以');
  expect(
    api.api.request.mock.calls.filter(call => call[0] === '/daily-plan'),
  ).toHaveLength(2);
  await app.close();
  spy.mockRestore();
});

test('an unknown daily ensure acknowledgement replays only on its server day and gets a new key after foreground rollover', async () => {
  const api = apiFixture();
  let serverDate = '2026-10-30';
  const emptyPlan = (): DailyPlan => ({
    id: null,
    local_date: serverDate,
    timezone: 'America/Los_Angeles',
    status: 'ready',
    error: null,
    can_retry: true,
    items: [],
  });
  api.setPlan(emptyPlan());
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    if (path === '/daily-plan/ensure')
      throw new ApiError('network', 'ensure结果未确认', 0);
    const result = await original(path, method, body);
    return path === '/growth/summary'
      ? { ...result, today: { ...result.today, date: serverDate } }
      : result;
  });
  let foreground!: () => void;
  const spy = jest
    .spyOn(platform, 'onForeground')
    .mockImplementation(callback => {
      foreground = callback;
      return () => {};
    });
  const app = await mount(<TodosScreen />, api.api);
  const attempts = () =>
    api.api.request.mock.calls.filter(call => call[0] === '/daily-plan/ensure');
  expect(attempts()).toHaveLength(1);
  await openDailyActions(app.tree);
  await act(async () => button(app.tree, '准备今天的建议').props.onPress());
  expect(attempts()).toHaveLength(2);
  expect(attempts()[1][2]).toEqual(attempts()[0][2]);
  serverDate = '2026-10-31';
  api.setPlan(emptyPlan());
  await act(async () => foreground());
  expect(attempts()).toHaveLength(3);
  expect(attempts()[2][2].client_request_id).not.toEqual(
    attempts()[0][2].client_request_id,
  );
  expect(texts(app.tree)).toContain('10月31日');
  await app.close();
  spy.mockRestore();
});

test('failed generation with no safe retry never exposes a second model admission button', async () => {
  const api = apiFixture();
  api.setPlan({
    id: 'uncertain-plan',
    local_date: '2026-10-30',
    timezone: 'America/Los_Angeles',
    status: 'failed',
    error: '本次准备结果还未确认',
    can_retry: false,
    items: [],
  });
  const app = await mount(<TodosScreen />, api.api);
  await openDailyActions(app.tree);
  expect(texts(app.tree)).toContain('本次准备结果还未确认');
  expect(button(app.tree, '重新准备今天的建议')).toBeUndefined();
  expect(button(app.tree, '刷新准备状态')).toBeDefined();
  expect(
    api.api.request.mock.calls.filter(call => call[0] === '/daily-plan/ensure'),
  ).toHaveLength(0);
  await app.close();
});

test('uncertain daily retry reuses its intent until a fresh failed plan explicitly permits another attempt', async () => {
  const api = apiFixture();
  api.setPlan({
    id: 'failed-plan',
    local_date: '2026-10-30',
    timezone: 'America/Los_Angeles',
    status: 'failed',
    error: '第一次准备失败',
    can_retry: true,
    items: [],
  });
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    if (path === '/daily-plan/ensure')
      throw new ApiError('network', '结果尚未确认，请刷新查看', 0);
    return original(path, method, body);
  });
  const app = await mount(<TodosScreen />, api.api);
  await openDailyActions(app.tree);
  const retry = () => button(app.tree, '重新准备今天的建议').props.onPress();
  await act(async () => retry());
  await act(async () => retry());
  const attempts = () =>
    api.api.request.mock.calls.filter(call => call[0] === '/daily-plan/ensure');
  expect(attempts()).toHaveLength(2);
  expect(attempts()[1][2]).toEqual(attempts()[0][2]);
  await act(async () =>
    app.tree.root
      .findAllByType(ErrorNotice)
      .find(node => node.props.message === '结果尚未确认，请刷新查看')!
      .props.retry(),
  );
  await act(async () => retry());
  expect(attempts()).toHaveLength(3);
  expect(attempts()[2][2].client_request_id).not.toEqual(
    attempts()[0][2].client_request_id,
  );
  await app.close();
});

test('opening share never grants growth; explicit typed reply grants one receipt and keeps the parent waiting', async () => {
  const api = apiFixture(
    todo({ kind: 'communication', draft: '用户自己的回复草稿' }),
  );
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () => button(app.tree, '分享回复').props.onPress());
  expect(platform.share).toHaveBeenCalled();
  expect(api.rewards()).toEqual([]);
  expect(
    api.api.request.mock.calls.filter(
      call => call[0].endsWith('/actions') && call[1] === 'POST',
    ),
  ).toHaveLength(0);
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  expect(api.api.request).toHaveBeenCalledWith(
    '/todos/one/actions',
    'POST',
    expect.objectContaining({
      kind: 'replied',
      version: 1,
      draft: '用户自己的回复草稿',
      client_request_id: expect.any(String),
    }),
  );
  expect(api.saved().status).toBe('waiting');
  expect(api.rewards()).toHaveLength(1);
  expect(texts(app.tree)).toContain('+10 成长');
  expect(button(app.tree, '撤销已回复记录')).toBeDefined();
  expect(
    app.tree.root
      .findAllByType(Button)
      .filter(node => node.props.children === '撤销已回复记录'),
  ).toHaveLength(1);
  await act(async () => button(app.tree, '撤销已回复记录').props.onPress());
  expect(api.saved().status).toBe('pending');
  expect(api.rewards()[0].active).toBe(false);
  await app.close();
});

test('completed communication can undo its separate reply fact without restoring the Todo or giving another reward', async () => {
  const api = apiFixture(todo({ kind: 'communication', draft: '真实回复' }));
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  const earned = clone(api.rewards()[0]);
  await act(async () => button(app.tree, '我已确认这件事结束').props.onPress());
  expect(api.saved().status).toBe('completed');
  expect(button(app.tree, '撤销已回复记录')).toBeDefined();
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  const version = api.saved().version;
  await act(async () => button(app.tree, '撤销已回复记录').props.onPress());
  expect(api.api.request).toHaveBeenCalledWith(
    '/todos/one/actions',
    'POST',
    expect.objectContaining({ kind: 'undo_replied', version }),
  );
  expect(api.saved().status).toBe('completed');
  expect(api.rewards()).toHaveLength(1);
  expect(api.rewards()[0]).toMatchObject({
    id: earned.id,
    xp: earned.xp,
    earned_at: earned.earned_at,
    active: true,
  });
  expect(button(app.tree, '撤销已回复记录')).toBeUndefined();
  expect(texts(app.tree)).toContain('已确认的事项完成记录会保留');
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  await app.close();
});

test('pending communication can undo its reply fact directly without reconfirming a reply', async () => {
  const api = apiFixture(todo({ kind: 'communication', draft: '真实回复' }));
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  await act(async () => button(app.tree, '继续处理').props.onPress());
  expect(api.saved().status).toBe('pending');
  expect(button(app.tree, '撤销已回复记录')).toBeDefined();
  await act(async () => button(app.tree, '撤销已回复记录').props.onPress());
  expect(api.saved().status).toBe('pending');
  expect(api.rewards()[0].active).toBe(false);
  expect(
    api.api.request.mock.calls
      .filter(call => call[0] === '/todos/one/actions' && call[1] === 'POST')
      .map(call => call[2].kind),
  ).toEqual(['replied', 'undo_replied']);
  expect(button(app.tree, '撤销已回复记录')).toBeUndefined();
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  await app.close();
});

test.each(['pending', 'completed'] as const)(
  'reply fact read failure has its own retry even when the communication Todo is %s',
  async status => {
    const api = apiFixture(todo({ kind: 'communication', status }));
    const original = api.api.request.getMockImplementation()!;
    let unavailable = true;
    api.api.request.mockImplementation(async (path, method, body) => {
      if (
        path === '/todos/one/actions' &&
        (!method || method === 'GET') &&
        unavailable
      )
        throw new ApiError('network', '回复记录读取失败', 0);
      return original(path, method, body);
    });
    const app = await mount(<TodoDetail id="one" />, api.api);
    const retry = app.tree.root
      .findAllByType(ErrorNotice)
      .find(node =>
        node.props.message?.startsWith('回复确认记录暂时无法读取'),
      )!;
    expect(retry).toBeDefined();
    unavailable = false;
    await act(async () => retry.props.retry());
    expect(texts(app.tree)).not.toContain('回复确认记录暂时无法读取');
    expect(api.saved().status).toBe(status);
    expect(
      api.api.request.mock.calls.filter(
        call => call[0] === '/todos/one/actions',
      ),
    ).toHaveLength(2);
    expect(api.api.request.mock.calls.some(call => call[1] === 'POST')).toBe(
      false,
    );
    await app.close();
  },
);

test('exercise records explicit optional real minutes and rejects 1000 without creating a completion action', async () => {
  const api = apiFixture(
    todo({
      kind: 'exercise',
      status: 'in_progress',
      estimated_minutes: 30,
      progress_notes: '真实笔记',
    }),
  );
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () =>
    label(app.tree, '实际运动分钟数（可选）').props.onChangeText('1000'),
  );
  await act(async () => button(app.tree, '我已完成这次运动').props.onPress());
  expect(
    api.api.request.mock.calls.some(
      call => call[0].endsWith('/actions') && call[1] === 'POST',
    ),
  ).toBe(false);
  expect(
    app.tree.root
      .findAllByType(ErrorNotice)
      .some(node => String(node.props.message).includes('1–360')),
  ).toBe(true);
  await act(async () =>
    label(app.tree, '实际运动分钟数（可选）').props.onChangeText(''),
  );
  await act(async () => button(app.tree, '我已完成这次运动').props.onPress());
  expect(api.api.request).toHaveBeenCalledWith(
    '/todos/one/actions',
    'POST',
    expect.objectContaining({
      kind: 'exercise_completed',
      actual_minutes: null,
      progress_notes: expect.stringContaining('真实笔记'),
    }),
  );
  expect(api.rewards()[0].minutes).toBeNull();
  expect(api.saved().status).toBe('completed');
  await app.close();
});

test('ordinary completion stays successful when growth service reads fail', async () => {
  const api = apiFixture();
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    if (path.startsWith('/growth/')) throw new Error('growth unavailable');
    return original(path, method, body);
  });
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () => button(app.tree, '这件事我已完成').props.onPress());
  expect(api.saved().status).toBe('completed');
  expect(texts(app.tree)).toContain('已按你的确认记录完成');
  expect(texts(app.tree)).not.toContain('+10 成长');
  await app.close();
});

test.each([404, 405])(
  'only definite unsupported typed actions use legacy CAS compatibility (%s)',
  async status => {
    const api = apiFixture(todo({ kind: 'communication' }));
    const original = api.api.request.getMockImplementation()!;
    api.api.request.mockImplementation(async (path, method, body) => {
      if (path.endsWith('/actions'))
        throw new ApiError('unsupported', 'old server', status);
      if (path.startsWith('/growth/'))
        throw new ApiError('unsupported', 'old server', 404);
      return original(path, method, body);
    });
    const app = await mount(<TodoDetail id="one" />, api.api);
    await act(async () =>
      button(app.tree, '我已实际回复 → 等待').props.onPress(),
    );
    expect(api.saved().status).toBe('waiting');
    expect(
      api.api.request.mock.calls.filter(
        call => call[0] === '/todos/one' && call[1] === 'PATCH',
      ),
    ).toHaveLength(1);
    expect(texts(app.tree)).toContain('兼容方式保存');
    expect(texts(app.tree)).not.toContain('+10 成长');
    await app.close();
  },
);

test('an uncertain typed action never falls back to a second legacy mutation', async () => {
  const api = apiFixture(todo({ kind: 'communication' }));
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    if (path.endsWith('/actions') && method === 'POST')
      throw new ApiError('network', '结果尚未确认', 0);
    return original(path, method, body);
  });
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  const first = api.api.request.mock.calls.find(
    call => call[0].endsWith('/actions') && call[1] === 'POST',
  )![2];
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  const attempts = api.api.request.mock.calls.filter(
    call => call[0].endsWith('/actions') && call[1] === 'POST',
  );
  expect(attempts[1][2]).toEqual(first);
  expect(
    api.api.request.mock.calls.some(
      call => call[0] === '/todos/one' && call[1] === 'PATCH',
    ),
  ).toBe(false);
  expect(api.rewards()).toEqual([]);
  await app.close();
});

test('growth stays lazy until a growth-aware page is actually used', async () => {
  const api = apiFixture();
  const app = await mount(<Text>普通页面</Text>, api.api);
  expect(api.api.request).not.toHaveBeenCalled();
  await app.close();
});

test('an already sent Todo mutation finishing after account switch cannot publish the old account or reward', async () => {
  let resolve!: () => void;
  const mutation = new Promise<void>(done => {
    resolve = done;
  });
  const old = apiFixture(todo({ title: '账号甲的事项' }));
  const original = old.api.request.getMockImplementation()!;
  old.api.request.mockImplementation(async (path, method, body) => {
    const result = await original(path, method, body);
    if (path === '/todos/one' && method === 'PATCH') await mutation;
    return result;
  });
  const next = apiFixture(todo({ title: '账号乙的事项' }));
  const app = await mount(<TodoDetail id="one" />, old.api);
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = button(app.tree, '这件事我已完成').props.onPress();
    await Promise.resolve();
  });
  await app.update(context(next.api, 'account-b'));
  await act(async () => {
    resolve();
    await pending;
  });
  expect(
    old.api.request.mock.calls.some(
      call => call[0] === '/todos/one' && call[1] === 'PATCH',
    ),
  ).toBe(true);
  expect(texts(app.tree)).toContain('账号乙的事项');
  expect(texts(app.tree)).not.toContain('账号甲的事项');
  expect(texts(app.tree)).not.toContain('+10 成长');
  await app.close();
});

test('a growth Todo read that never returns cannot delay an ordinary completion', async () => {
  const api = apiFixture();
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    if (path.startsWith('/growth/todos/')) return new Promise(() => {});
    return original(path, method, body);
  });
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () => button(app.tree, '这件事我已完成').props.onPress());
  expect(api.saved().status).toBe('completed');
  expect(texts(app.tree)).toContain('已按你的确认记录完成');
  expect(texts(app.tree)).not.toContain('+10 成长');
  expect(button(app.tree, '恢复为待处理').props.loading).toBeFalsy();
  await app.close();
});

test('a reply summary delayed past undo cannot restore XP or show a stale celebration', async () => {
  const api = apiFixture(todo({ kind: 'communication', draft: '真实草稿' }));
  const original = api.api.request.getMockImplementation()!;
  let resolve!: (value: GrowthSummary) => void;
  let captured: GrowthSummary | undefined;
  const delayed = new Promise<GrowthSummary>(done => {
    resolve = done;
  });
  api.api.request.mockImplementation(async (path, method, body) => {
    const result = await original(path, method, body);
    if (path === '/growth/summary' && result.total_xp > 0) {
      captured = result;
      return delayed;
    }
    return result;
  });
  const app = await mount(
    <>
      <GrowthEntry />
      <GrowthScreen />
      <TodoDetail id="one" />
    </>,
    api.api,
  );
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  expect(captured?.total_xp).toBe(10);
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  await act(async () => button(app.tree, '撤销已回复记录').props.onPress());
  expect(api.saved().status).toBe('pending');
  expect(api.rewards()[0].active).toBe(false);
  await act(async () => resolve(captured!));
  expect(texts(app.tree)).toContain('累计 0');
  expect(texts(app.tree)).not.toContain('+10 成长');
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  await app.close();
});

test('clearing an old draft explicitly sends null with the user-confirmed reply', async () => {
  const api = apiFixture(
    todo({ kind: 'communication', draft: '不再使用的草稿' }),
  );
  const app = await mount(<TodoDetail id="one" />, api.api);
  await act(async () => label(app.tree, '修改回复草稿').props.onChangeText(''));
  await act(async () =>
    button(app.tree, '我已实际回复 → 等待').props.onPress(),
  );
  expect(api.api.request).toHaveBeenCalledWith(
    '/todos/one/actions',
    'POST',
    expect.objectContaining({ kind: 'replied', draft: null }),
  );
  expect(texts(app.tree)).not.toContain('不再使用的草稿');
  expect(api.saved().draft).toBeNull();
  await app.close();
});

test('another Todo receipt changing global XP is never attributed to this completion', async () => {
  const api = apiFixture();
  const original = api.api.request.getMockImplementation()!;
  api.api.request.mockImplementation(async (path, method, body) => {
    const result = await original(path, method, body);
    if (path === '/todos/one' && method === 'PATCH') {
      api.rewards().splice(0, api.rewards().length, {
        id: 'reward:other',
        todo_id: 'other',
        title: '另一台设备确认的另一件事',
        kind: 'general',
        xp: 10,
        active: true,
        earned_at: '2026-10-30T10:00:00Z',
        updated_at: '2026-10-30T10:00:00Z',
        version: 1,
        local_date: '2026-10-30',
        timezone: 'America/Los_Angeles',
        minutes: null,
      });
    }
    return result;
  });
  const app = await mount(
    <>
      <GrowthEntry />
      <TodoDetail id="one" />
    </>,
    api.api,
  );
  await act(async () => button(app.tree, '这件事我已完成').props.onPress());
  expect(api.saved().status).toBe('completed');
  expect(api.rewards()[0].todo_id).toBe('other');
  expect(texts(app.tree)).not.toContain('+10 成长');
  expect(label(app.tree, '收起成长提示')).toBeUndefined();
  await app.close();
});

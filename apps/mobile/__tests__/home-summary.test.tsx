import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { Today } from '../src/domain/types';
import { HomeScreen } from '../src/screens/Main';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function fixture(stats: Partial<Today['stats']> = {}, read = true): Today {
  return {
    date: '2026-10-28',
    greeting: '你好',
    briefing: '保存的简报',
    tasks: [],
    schedules: [],
    memories: [],
    notifications: [
      { id: 'preview', title: '通知', body: '', read, created_at: '' },
    ],
    stats: {
      tasks_completed: 501,
      memory_count: 501,
      active_routines: 0,
      ...stats,
    },
    runtime: {
      model_mode: 'local',
      scheduler_mode: 'local',
      storage_mode: 'sqlite',
    },
  };
}

async function render(value: Today) {
  const today = jest.fn().mockResolvedValue(value);
  const context = {
    api: { today },
    revision: 0,
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: () => '今天',
    user: { name: 'Home', timezone: 'UTC' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <HomeScreen onTasks={jest.fn()} />
      </AppProvider>,
    );
  });
  return { tree, today };
}

it.each([
  [
    'shows older unread outside the preview',
    { unread_notifications: 1 },
    true,
    true,
  ],
  ['honors an authoritative zero', { unread_notifications: 0 }, false, false],
  ['supports older servers with unread preview', {}, false, true],
  ['supports older servers with read preview', {}, true, false],
] as const)('%s', async (_label, stats, read, visible) => {
  const { tree } = await render(fixture(stats, read));
  expect(
    tree.root.findAllByProps({ accessibilityLabel: '有未读通知' }).length > 0,
  ).toBe(visible);
  await act(async () => tree.unmount());
});

it('polls owner-wide active tasks outside the preview and stops after they finish', async () => {
  const value = fixture({ active_tasks: 4 });
  const { tree, today } = await render(value);
  today.mockResolvedValue(fixture({ active_tasks: 0 }));
  await act(async () => jest.advanceTimersByTime(8000));
  expect(today).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(16000));
  expect(today).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});

it('refreshes a queued preview with zero global active tasks until both snapshots finish', async () => {
  const value = fixture({ active_tasks: 0 });
  value.tasks = [
    {
      id: 'mixed-snapshot',
      title: '等待更新',
      instruction: 'fixture',
      kind: 'general',
      status: 'queued',
      progress: 0,
      created_at: '',
      updated_at: '',
      steps: [],
      model_mode: 'local',
      approval_required: false,
    },
  ];
  const { tree, today } = await render(value);
  today.mockResolvedValue({
    ...value,
    tasks: [{ ...value.tasks[0], status: 'succeeded' }],
  });
  await act(async () => jest.advanceTimersByTime(8000));
  expect(today).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(16000));
  expect(today).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});

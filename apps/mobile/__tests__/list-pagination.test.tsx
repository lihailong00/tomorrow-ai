import React from 'react';
import { RefreshControl, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { MemoriesScreen, TasksScreen } from '../src/screens/Main';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

const memory = (id: string, kind = 'fact') => ({
  id,
  kind,
  title: `记忆${id}`,
  content: `记忆内容${id}`,
  source: 'test',
  updated_at: '',
});
const task = (id: string, status = 'succeeded') => ({
  id,
  status,
  title: `任务${id}`,
  instruction: 'fixture',
  created_at: '',
  progress: 100,
});
function context(api: unknown) {
  return {
    api,
    revision: 0,
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: () => '今天',
  } as unknown as AppContextValue;
}
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(node => node.props.children);
function pressFilter(tree: ReactTestRenderer, label: string) {
  let node = tree.root.findAllByType(Text).find(text => text.props.children === label)!;
  while (node && !node.props.onPress) node = node.parent!;
  node.props.onPress();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it('sends bounded continuation and category/status query arguments without changing default callers', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"items":[],"next_offset":null}',
    });
  const api = new ApiClient(
    'https://api.example.com',
    undefined,
    undefined,
    fetcher,
  );
  await api.tasks();
  await api.tasks({ offset: 500, limit: 50, status: 'active' });
  await api.memories('person', { offset: 50, limit: 50 });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    'https://api.example.com/v1/tasks',
    'https://api.example.com/v1/tasks?offset=500&limit=50&status=active',
    'https://api.example.com/v1/memories?offset=50&limit=50&kind=person',
  ]);
});

it('continues task pages, deduplicates overlaps, and finds older active tasks through server filtering', async () => {
  const tasks = jest
    .fn()
    .mockResolvedValueOnce({ items: [task('new')], next_offset: 50 })
    .mockResolvedValueOnce({
      items: [task('new'), task('old')],
      next_offset: null,
    })
    .mockResolvedValueOnce({
      items: [task('approval', 'waiting_approval')],
      next_offset: null,
    });
  const value = context({
    tasks,
    schedules: jest.fn().mockResolvedValue({ items: [] }),
  });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        <TasksScreen />
      </AppProvider>,
    );
  });
  await act(async () => {
    tree.root
      .findAllByType(Button)
      .find(node => node.props.children === '加载更多任务')!
      .props.onPress();
  });
  expect(tasks).toHaveBeenNthCalledWith(2, {
    status: 'all',
    offset: 50,
    limit: 50,
  });
  expect(texts(tree).filter(text => text === '任务new')).toHaveLength(1);
  expect(texts(tree)).toContain('任务old');
  await act(async () => {
    pressFilter(tree, '进行中');
  });
  expect(tasks).toHaveBeenLastCalledWith({
    status: 'active',
    offset: 0,
    limit: 50,
  });
  expect(texts(tree)).toContain('任务approval');
  expect(texts(tree)).not.toContain('任务old');
  await act(async () => tree.unmount());
});

it('discards a late memory page after refreshing the compact memory view', async () => {
  const late = deferred<{
    items: ReturnType<typeof memory>[];
    next_offset: null;
  }>();
  const memories = jest
    .fn()
    .mockResolvedValueOnce({ items: [memory('new')], next_offset: 50 })
    .mockReturnValueOnce(late.promise)
    .mockResolvedValueOnce({
      items: [memory('fresh-person', 'person')],
      next_offset: null,
    });
  const value = context({ memories });
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        <MemoriesScreen />
      </AppProvider>,
    );
  });
  await act(async () => {
    tree.root.findAll(node => node.props.accessibilityLabel === '加载更多记忆' && typeof node.props.onPress === 'function').pop()!.props.onPress();
  });
  expect(memories).toHaveBeenLastCalledWith(undefined, { offset: 50, limit: 50 });
  await act(async () => {
    tree.root.findByType(RefreshControl).props.onRefresh();
  });
  expect(memories).toHaveBeenLastCalledWith(undefined, { offset: 0, limit: 50 });
  await act(async () => {
    late.resolve({ items: [memory('stale')], next_offset: null });
  });
  expect(texts(tree)).toContain('记忆内容fresh-person');
  expect(texts(tree)).not.toContain('记忆内容stale');
  expect(texts(tree)).not.toContain('记忆内容new');
  await act(async () => tree.unmount());
});

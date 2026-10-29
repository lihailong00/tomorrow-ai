import React from 'react';
import { FlatList, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { ApiError } from '../src/api/client';
import { TodoDetail } from '../src/features/todos/TodoDetail';
import { TodoSources } from '../src/features/todos/TodoSources';
import { TodosScreen } from '../src/features/todos/TodosScreen';
import { Button, ErrorNotice } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import type { Todo } from '../src/features/todos/types';

jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
const todo = (override: Partial<Todo> = {}): Todo => ({
  id: 'one',
  title: '真实事项',
  description: '',
  kind: 'general',
  status: 'pending',
  source_kind: 'manual',
  source_label: '你添加',
  created_at: '2026-10-29T00:00:00Z',
  updated_at: '2026-10-29T00:00:00Z',
  version: 1,
  ...override,
});
const context = (api: unknown, extra = {}) =>
  ({
    api,
    user: { id: 'owner', timezone: 'Asia/Shanghai' },
    preferences: { serverUrl: 'https://api.example.com' },
    navigate: jest.fn(),
    invalidate: jest.fn(),
    revision: 0,
    formatDate: (date: string) => date,
    ...extra,
  } as unknown as AppContextValue);
const texts = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join(' ');
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root
    .findAllByType(Button)
    .find(node => [node.props.children].flat().join('') === label)!;
const byLabel = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(node => node.props.accessibilityLabel === label)[0];
async function mount(ui: React.ReactElement, value: AppContextValue) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AppProvider value={value}>{ui}</AppProvider>);
  });
  return tree;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

it('shows real compact rows, folds suggestions and queries Today/All with bounded pagination', async () => {
  const request = jest.fn(async (path: string) => {
    if (path.includes('filter=active'))
      return path.includes('offset=50')
        ? { items: [todo({ id: 'two', title: '第二页' })], next_offset: null }
        : { items: [todo()], next_offset: 50 };
    return {
      items: path.includes('filter=suggested')
        ? [todo({ id: 'candidate', title: '真实候选', status: 'suggested' })]
        : [],
      next_offset: null,
    };
  });
  const value = context({ request });
  const tree = await mount(<TodosScreen />, value);
  expect(tree.root.findAllByType(FlatList)).toHaveLength(1);
  expect(texts(tree)).toContain('真实事项');
  expect(texts(tree)).not.toContain('真实候选');
  await act(async () => button(tree, '加载更多事项').props.onPress());
  expect(texts(tree)).toContain('第二页');
  await act(async () => byLabel(tree, '新发现').props.onPress());
  expect(texts(tree)).toContain('真实候选');
  await act(async () => byLabel(tree, '全部事项').props.onPress());
  expect(request).toHaveBeenCalledWith(
    '/todos?filter=active&scope=all&offset=0&limit=50',
    'GET',
    undefined,
  );
  await act(async () => tree.unmount());
});
it('does not leak an old account list or its pending page into a new owner', async () => {
  const late = deferred<{ items: Todo[]; next_offset: null }>();
  const oldRequest = jest.fn((path: string) =>
    path.includes('filter=active')
      ? late.promise
      : Promise.resolve({ items: [], next_offset: null }),
  );
  const newRequest = jest.fn(async (path: string) => ({
    items: path.includes('filter=active') ? [todo({ title: '新账号' })] : [],
    next_offset: null,
  }));
  const tree = await mount(<TodosScreen />, context({ request: oldRequest }));
  await act(async () =>
    tree.update(
      <AppProvider
        value={context(
          { request: newRequest },
          { user: { id: 'new', timezone: 'UTC' } },
        )}
      >
        <TodosScreen />
      </AppProvider>,
    ),
  );
  await act(async () =>
    late.resolve({ items: [todo({ title: '旧账号晚到' })], next_offset: null }),
  );
  expect(texts(tree)).toContain('新账号');
  expect(texts(tree)).not.toContain('旧账号');
  await act(async () => tree.unmount());
});
it('keeps one creation intent after timeout and edits, never injecting sample todos', async () => {
  let creates = 0;
  const request = jest.fn(async (path: string, method: string) => {
    if (path === '/todos' && method === 'POST') {
      creates++;
      if (creates === 1) throw new ApiError('timeout', '结果未知');
      return todo();
    }
    return { items: [], next_offset: null };
  });
  const tree = await mount(<TodosScreen />, context({ request }));
  expect(texts(tree)).not.toContain('真实事项');
  const capture = tree.root
    .findAllByType(TextInput)
    .find(node => node.props.accessibilityLabel === '记件要做的事')!;
  const add = () => byLabel(tree, '添加事项');
  await act(async () => capture.props.onChangeText('自己的目标'));
  await act(async () => add().props.onPress());
  await act(async () => capture.props.onChangeText('修改后的目标'));
  await act(async () => add().props.onPress());
  const calls = request.mock.calls.filter(call => call[0] === '/todos');
  expect((calls[0] as any)[2].client_request_id).toBe(
    (calls[1] as any)[2].client_request_id,
  );
  await act(async () => tree.unmount());
});
it('accepts source candidates explicitly and retains evidence when dismissing or editing', async () => {
  const current = todo({
    status: 'suggested',
    source_kind: 'conversation',
    source_id: 'stored-source',
    source_excerpt: '明天我要回复客户',
  });
  const request = jest.fn(async (_path: string, method: string, patch: any) =>
    method === 'PATCH' ? { ...current, ...patch, version: 2 } : current,
  );
  const tree = await mount(
    <TodoDetail id="one" />,
    context({ request, baseUrl: 'https://api.example.com' }),
  );
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => button(tree, '确认加入').props.onPress());
  expect(request).toHaveBeenLastCalledWith('/todos/one', 'PATCH', {
    version: 1,
    status: 'pending',
  });
  expect(texts(tree)).not.toContain('已发送');
  await act(async () => tree.unmount());
});
it('shares a real draft without recording sent or waiting, then requires actual reply confirmation', async () => {
  const current = todo({ kind: 'communication', draft: '依据真实目标的草稿' });
  const request = jest.fn(async (_path: string, method: string, patch: any) =>
    method === 'PATCH' ? { ...current, ...patch, version: 2 } : current,
  );
  const tree = await mount(
    <TodoDetail id="one" />,
    context({ request, baseUrl: 'https://api.example.com' }),
  );
  await act(async () => button(tree, '分享回复').props.onPress());
  expect(platform.share).toHaveBeenCalledWith(current.draft, current.title);
  expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(
    0,
  );
  await act(async () => button(tree, '我已实际回复 → 等待').props.onPress());
  expect(request).toHaveBeenLastCalledWith('/todos/one', 'PATCH', {
    version: 1,
    status: 'waiting',
    draft: current.draft,
  });
  await act(async () => tree.unmount());
});
it('requires validated user-entered minutes before completing exercise', async () => {
  const current = todo({ kind: 'exercise', status: 'in_progress' });
  const request = jest.fn(async (_path: string, method: string, patch: any) =>
    method === 'PATCH' ? { ...current, ...patch, version: 2 } : current,
  );
  const tree = await mount(
    <TodoDetail id="one" />,
    context({ request, baseUrl: 'https://api.example.com' }),
  );
  const input = tree.root
    .findAllByType(TextInput)
    .find(node => node.props.accessibilityLabel === '实际运动分钟数（可选）')!;
  await act(async () => input.props.onChangeText('1000'));
  await act(async () => button(tree, '我已完成这次运动').props.onPress());
  expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(
    0,
  );
  expect(
    tree.root
      .findAllByType(ErrorNotice)
      .map(node => node.props.message)
      .join(''),
  ).toContain('1–360');
  await act(async () => input.props.onChangeText('20'));
  await act(async () => button(tree, '我已完成这次运动').props.onPress());
  expect(request).toHaveBeenLastCalledWith('/todos/one', 'PATCH', {
    version: 1,
    status: 'completed',
    progress_notes: '实际运动 20 分钟（自行记录）',
  });
  await act(async () => tree.unmount());
});
it('extracts only a selected persisted conversation and leaves results as candidates', async () => {
  const request = jest.fn().mockResolvedValue({
    items: [todo({ status: 'suggested' })],
    created_count: 1,
  });
  const api = {
    request,
    conversations: jest.fn().mockResolvedValue({
      items: [{ id: 'stored-conversation', title: '实际对话', updated_at: '' }],
      next_offset: null,
    }),
  };
  const value = context(api);
  const tree = await mount(
    <TodoSources conversationId="stored-conversation" />,
    value,
  );
  expect(request).not.toHaveBeenCalled();
  await act(async () => button(tree, '发现待办').props.onPress());
  expect(request).toHaveBeenCalledWith('/todos/extract', 'POST', {
    source_kind: 'conversation',
    source_id: 'stored-conversation',
    client_request_id: expect.any(String),
  });
  expect(texts(tree)).toContain('新增 1 件');
  expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(
    0,
  );
  await act(async () => tree.unmount());
});

it('polls a real preparation result without auto-completing the personal todo', async () => {
  jest.useFakeTimers();
  try {
    let current = todo({ kind: 'learning', title: '学懂用户自己的目标' });
    const request = jest.fn(async (path: string) => {
      if (path.endsWith('/prepare'))
        current = { ...current, linked_task_id: 'real-task', version: 2 };
      return current;
    });
    const tree = await mount(
      <TodoDetail id="one" />,
      context({ request, baseUrl: 'https://api.example.com' }),
    );
    await act(async () => button(tree, '准备讲解与练习').props.onPress());
    expect(request).toHaveBeenCalledWith('/todos/one/prepare', 'POST', {
      client_request_id: expect.any(String),
    });
    current = {
      ...current,
      draft: '依据用户目标生成的真实讲解和练习',
      version: 3,
    };
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4000);
    });
    expect(texts(tree)).toContain(current.draft!);
    expect(request.mock.calls.some(call => (call as any)[1] === 'PATCH')).toBe(
      false,
    );
    expect(texts(tree)).toContain('我已完成这次学习');
    await act(async () => tree.unmount());
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

it('retains the personal item and user progress when content preparation is unavailable', async () => {
  const current = todo({ kind: 'learning', progress_notes: '真实学习进度' });
  const request = jest.fn(async (path: string) => {
    if (path.endsWith('/prepare'))
      throw new ApiError('model_unavailable', '请先配置内容准备服务', 503);
    return current;
  });
  const tree = await mount(
    <TodoDetail id="one" />,
    context({ request, baseUrl: 'https://api.example.com' }),
  );
  await act(async () => button(tree, '准备讲解与练习').props.onPress());
  expect(texts(tree)).toContain('请先配置内容准备服务');
  expect(
    tree.root
      .findAllByType(TextInput)
      .some(node => node.props.value === '真实学习进度'),
  ).toBe(true);
  expect(request.mock.calls.some(call => (call as any)[1] === 'PATCH')).toBe(
    false,
  );
  expect(texts(tree)).not.toContain('内容已准备');
  await act(async () => tree.unmount());
});

it('restores a completed item while preserving its saved draft and progress', async () => {
  const current = todo({
    status: 'completed',
    draft: '已保存内容',
    progress_notes: '已保存进度',
    version: 7,
  });
  const request = jest.fn(async (_path: string, method: string, patch: any) =>
    method === 'PATCH' ? { ...current, ...patch, version: 8 } : current,
  );
  const tree = await mount(
    <TodoDetail id="one" />,
    context({ request, baseUrl: 'https://api.example.com' }),
  );
  await act(async () => button(tree, '恢复为待处理').props.onPress());
  expect(request).toHaveBeenLastCalledWith('/todos/one', 'PATCH', {
    version: 7,
    status: 'pending',
  });
  expect(texts(tree)).toContain('已保存内容');
  expect(
    tree.root
      .findAllByType(TextInput)
      .some(node => node.props.value === '已保存进度'),
  ).toBe(true);
  await act(async () => tree.unmount());
});

it('does not let an older in-flight preparation poll undo a successful user completion', async () => {
  jest.useFakeTimers();
  try {
    const current = todo({ linked_task_id: 'real-task' });
    const late = deferred<Todo>();
    let reads = 0;
    const request = jest.fn(async (_path: string, method: string) => {
      if (method === 'PATCH')
        return { ...current, version: 2, status: 'completed' };
      if (++reads > 1) return late.promise;
      return current;
    });
    const tree = await mount(
      <TodoDetail id="one" />,
      context({ request, baseUrl: 'https://api.example.com' }),
    );
    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await act(async () => button(tree, '这件事我已完成').props.onPress());
    await act(async () => late.resolve(current));
    expect(button(tree, '恢复为待处理')).toBeDefined();
    expect(button(tree, '这件事我已完成')).toBeUndefined();
    await act(async () => tree.unmount());
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

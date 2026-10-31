import React from 'react';
import { Alert, Modal, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import type { Memory } from '../src/domain/types';
import { MemoriesScreen } from '../src/screens/Main';
import { ErrorNotice } from '../src/ui/components';
import {
  describeMemory,
  memoryReviewPrompt,
  memoryTryPrompt,
  selectMemoryHighlights,
} from '../src/features/memory/memoryModel';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.setTimeout(30000);
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => jest.restoreAllMocks());

function memory(
  id: string,
  content: string,
  kind: Memory['kind'] = 'fact',
): Memory {
  return {
    id,
    title: content,
    content,
    kind,
    source: '来自真实保存的对话',
    created_at: '2026-10-31T08:00:00Z',
    updated_at: '2026-10-31T08:00:00Z',
    version: 4,
  };
}
const samples = [
  memory('project', '正在做妥啦，安卓首发。', 'project'),
  memory('voice', '回复先给结论，再说重点。', 'preference'),
  memory('pace', '上午更适合专注工作。', 'preference'),
  memory('extra', '学习 Rust 喜欢结合小例子。', 'preference'),
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup(
  items: Memory[] = samples,
  overrides: Record<string, unknown> = {},
) {
  const api = {
    baseUrl: 'https://example.test',
    memories: jest.fn().mockResolvedValue({ items, next_offset: null }),
    saveMemory: jest.fn(),
    deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  const value = {
    api,
    user: { id: 'one' },
    preferences: { serverUrl: api.baseUrl, instance: { id: 'server-one' } },
    revision: 0,
    invalidate: jest.fn(),
    navigate: jest.fn(),
    formatDate: () => '今天',
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        <MemoriesScreen />
      </AppProvider>,
    );
  });
  const text = () => tree.root.findAllByType(Text).map(n => n.props.children);
  const press = async (label: string) => {
    const target = tree.root
      .findAll(
        n =>
          n.props.accessibilityLabel === label &&
          typeof n.props.onPress === 'function',
      )
      .pop();
    if (!target) throw new Error(`Button missing: ${label}`);
    await act(async () => {
      target.props.onPress();
    });
  };
  const input = async (content: string) => {
    await act(async () =>
      tree.root
        .findAllByType(TextInput)
        .find(n => n.props.accessibilityLabel === '你希望我记住什么')!
        .props.onChangeText(content),
    );
  };
  return {
    api,
    value,
    tree,
    text,
    press,
    input,
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

test('highlights contain only saved facts, diversify three rows, and leave classification off the homepage', async () => {
  const repeated = memory('more-style', '回复再简短一些。', 'preference');
  const highlights = selectMemoryHighlights([
    samples[1],
    repeated,
    samples[0],
    samples[2],
    samples[3],
  ]);
  expect(highlights).toHaveLength(3);
  expect(highlights.map(item => describeMemory(item).label)).toEqual([
    '喜欢的沟通方式',
    '最近在忙',
    '适合你的节奏',
  ]);
  const app = await setup();
  expect(app.text()).toContain('不用每次从头说。');
  expect(app.text()).toContain('妥啦了解的你');
  expect(app.text()).not.toContain('偏好');
  expect(app.text()).not.toContain('人物');
  expect(app.text()).not.toContain('1 条待确认');
  expect(app.api.memories).toHaveBeenCalledWith(undefined, {
    offset: 0,
    limit: 50,
  });
  await app.close();
});

test('empty data has a compact honest starting point without demo memories', async () => {
  const app = await setup([]);
  expect(app.text()).toContain('先告诉我一件关于你的事');
  expect(app.text()).not.toContain(samples[0].content);
  await app.press('告诉我一件事');
  expect(app.tree.root.findAllByType(TextInput)).toHaveLength(1);
  expect(app.tree.root.findByType(TextInput).props.value).toBe('');
  await app.close();
});

test('single sentence creation retries the same intent and keeps the draft on failure', async () => {
  const content = '我周三晚上有固定课程。';
  const saved = memory('new', content);
  const app = await setup([], {
    saveMemory: jest
      .fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(saved),
  });
  await app.press('添加一条记忆');
  await app.input(content);
  await app.press('记住这件事');
  expect(app.tree.root.findByType(TextInput).props.value).toBe(content);
  expect(
    app.tree.root
      .findAllByType(ErrorNotice)
      .some(n => n.props.message === '网络中断'),
  ).toBe(true);
  const first = app.api.saveMemory.mock.calls[0];
  expect(first).toEqual([
    expect.objectContaining({
      content,
      kind: 'fact',
      source: '用户主动添加',
      client_request_id: expect.any(String),
    }),
    undefined,
  ]);
  await app.press('记住这件事');
  expect(app.api.saveMemory.mock.calls[1]).toEqual(first);
  expect(app.value.invalidate).toHaveBeenCalledTimes(1);
  expect(app.text()).toContain(content);
  expect(app.tree.root.findAllByType(TextInput)).toHaveLength(0);
  await app.close();
});

test('editing preserves server version and does not erase the draft after a conflict', async () => {
  const app = await setup(samples, {
    saveMemory: jest
      .fn()
      .mockRejectedValueOnce(
        new ApiError('conflict', '记忆已被更新，请刷新后再修改', 409),
      )
      .mockResolvedValueOnce({
        ...samples[2],
        content: '下午更专注。',
        version: 5,
      }),
  });
  await app.press(`查看记忆：${samples[2].title}`);
  expect(app.text()).toContain(samples[2].source);
  await app.press('改一下');
  await app.input('下午更专注。');
  await app.press('保存修改');
  expect(app.api.saveMemory).toHaveBeenLastCalledWith(
    expect.objectContaining({
      content: '下午更专注。',
      kind: 'preference',
      version: 4,
    }),
    'pace',
  );
  expect(app.tree.root.findByType(TextInput).props.value).toBe('下午更专注。');
  expect(app.value.invalidate).not.toHaveBeenCalled();
  await app.press('保存修改');
  expect(app.text()).toContain('下午更专注。');
  await app.close();
});

test('forget waits for confirmation, and undo recreates the exact saved content with one retry ID', async () => {
  let confirm!: () => void;
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    confirm = buttons!.find(b => b.text === '忘记')!.onPress! as () => void;
  });
  const app = await setup(samples, {
    saveMemory: jest
      .fn()
      .mockRejectedValueOnce(new Error('暂时无法恢复'))
      .mockResolvedValueOnce({ ...samples[0], id: 'restored', version: 1 }),
  });
  await app.press(`查看记忆：${samples[0].title}`);
  await app.press('忘记这件事');
  expect(app.api.deleteMemory).not.toHaveBeenCalled();
  await act(async () => {
    confirm();
  });
  expect(app.api.deleteMemory).toHaveBeenCalledWith('project');
  expect(app.text()).not.toContain(samples[0].content);
  await app.press('撤销忘记');
  const first = app.api.saveMemory.mock.calls[0][0];
  expect(first).toEqual(
    expect.objectContaining({
      title: samples[0].title,
      content: samples[0].content,
      kind: samples[0].kind,
      source: samples[0].source,
      client_request_id: expect.any(String),
    }),
  );
  await app.press('撤销忘记');
  expect(app.api.saveMemory.mock.calls[1][0]).toEqual(first);
  expect(app.text()).toContain(samples[0].content);
  await app.close();
});

test('a native delete confirmation cannot delete after its detail sheet was closed', async () => {
  let confirm!: () => void;
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons) => {
    confirm = buttons!.find(b => b.text === '忘记')!.onPress! as () => void;
  });
  const app = await setup();
  await app.press(`查看记忆：${samples[0].title}`);
  await app.press('忘记这件事');
  await app.press('关闭');
  await act(async () => {
    confirm();
  });
  expect(app.api.deleteMemory).not.toHaveBeenCalled();
  await app.close();
});

test('review and trying memory open real chat drafts without making model calls or writing memories', async () => {
  const app = await setup();
  await app.press('从对话里整理记忆，先列出候选供你确认');
  expect(app.value.navigate).toHaveBeenLastCalledWith({
    name: 'chat',
    prompt: memoryReviewPrompt,
  });
  await app.press('帮我安排明天，使用真实记忆开始对话');
  expect(app.value.navigate).toHaveBeenLastCalledWith({
    name: 'chat',
    prompt: memoryTryPrompt,
  });
  expect(app.api.saveMemory).not.toHaveBeenCalled();
  expect(app.api.deleteMemory).not.toHaveBeenCalled();
  await app.close();
});

test('switching account hides the old memory and ignores a pending old save', async () => {
  const late = deferred<Memory>();
  const app = await setup(samples, {
    saveMemory: jest.fn().mockReturnValue(late.promise),
  });
  await app.press('添加一条记忆');
  await app.input('旧账号的私有内容');
  await app.press('记住这件事');
  // A pending save cannot be dismissed accidentally by Android's back button.
  await act(async () => app.tree.root.findByType(Modal).props.onRequestClose());
  expect(app.tree.root.findByType(TextInput).props.value).toBe(
    '旧账号的私有内容',
  );
  const otherApi = {
    ...app.api,
    memories: jest.fn().mockResolvedValue({ items: [], next_offset: null }),
  };
  await act(async () =>
    app.tree.update(
      <AppProvider
        value={
          {
            ...app.value,
            api: otherApi,
            user: { id: 'two' },
          } as unknown as AppContextValue
        }
      >
        <MemoriesScreen />
      </AppProvider>,
    ),
  );
  await act(async () => late.resolve(memory('old', '旧账号的私有内容')));
  expect(app.text()).not.toContain('旧账号的私有内容');
  expect(app.text()).not.toContain(samples[0].content);
  expect(app.value.invalidate).not.toHaveBeenCalled();
  await app.close();
});

test('manage view searches loaded content and is clear when older pages have not loaded', async () => {
  const app = await setup(samples, {
    memories: jest.fn().mockResolvedValue({ items: samples, next_offset: 50 }),
  });
  await app.press('查看全部记忆');
  const search = app.tree.root
    .findAllByType(TextInput)
    .find(n => n.props.accessibilityLabel === '搜索已加载的记忆')!;
  await act(async () => search.props.onChangeText('不存在的事'));
  expect(app.text()).toContain('已加载的记忆中没有匹配项，可继续加载后查找。');
  await app.close();
});

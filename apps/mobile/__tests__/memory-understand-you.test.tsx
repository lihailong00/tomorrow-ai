import React from 'react';
import { Alert, FlatList, Modal, Switch, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import type { Memory } from '../src/domain/types';
import { MemoriesScreen } from '../src/screens/Main';
import { ErrorNotice } from '../src/ui/components';
import {
  memoryReviewPrompt,
  memoryTryPrompt,
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

test('memory categories filter saved facts without exposing internal provenance', async () => {
  const weight = {
    ...memory('weight', '体重95公斤。'),
    title: '体重',
    source:
      '对话 10d8be9f-bc1f-4e09-898a-bb67f309155b · 2026-11-02T04:07:37Z\n你的原话：我体重95公斤',
  };
  const app = await setup([...samples, weight]);
  await app.press('更多记忆操作');
  await app.press('按细分类查找');
  await app.press('分类：个人资料');
  expect(
    app.tree.root.findAll(
      n => n.props.accessibilityLabel === `查看记忆：${weight.title}`,
    ),
  ).not.toHaveLength(0);
  expect(
    app.tree.root
      .findAllByType(FlatList).find(node => node.props.testID === 'memory-search-results')!
      .props.data.map((item: Memory) => item.id),
  ).toEqual(['weight']);
  expect(JSON.stringify(app.text())).not.toContain('10d8be9f');
  await app.close();
});

test('legacy abnormal weight stays out of saved memories and offers confirmation', async () => {
  const pending = memory('weight', '体重为“−95kg”。');
  const app = await setup([...samples, pending]);
  expect(app.text()).not.toContain('体重待确认');
  expect(JSON.stringify(app.text())).not.toContain('−95kg');
  await app.press('查看待确认的记忆');
  await app.press('查看记忆：体重待确认');
  expect(JSON.stringify(app.text())).toContain('你目前的体重是 95 公斤吗？');
  expect(app.api.saveMemory).not.toHaveBeenCalled();
  await app.close();
});
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
    request: jest.fn().mockResolvedValue({ enabled: true }),
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
  const editorInputs = () => tree.root.findAllByType(TextInput)
    .filter(n => n.props.accessibilityLabel === '你希望我记住什么');
  const input = async (content: string) => {
    await act(async () => editorInputs()[0].props.onChangeText(content));
  };
  return {
    api,
    value,
    tree,
    text,
    press,
    input,
    editorInputs,
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

test('the homepage shows saved memories with filters and keeps automatic memory inside settings', async () => {
  const fact = { ...memory('fact', '周三有固定课程。'), updated_at: '2026-11-01T08:00:00Z' };
  const app = await setup([...samples, fact]);
  const visibleIds = () => app.tree.root.findAllByType(FlatList)
    .find(node => node.props.testID === 'memory-understand-home')!.props.data
    .map((item: Memory) => item.id);
  expect(app.text()).toContain('把想留住的事记下来。');
  expect(app.text()).toContain('最近更新');
  expect(visibleIds()).toEqual(['fact', 'project', 'voice', 'pace', 'extra']);
  await app.press('筛选：偏好');
  expect(visibleIds()).toEqual(['voice', 'pace', 'extra']);
  await app.press('筛选：目标');
  expect(visibleIds()).toEqual(['project']);
  await app.press('筛选：关于我');
  expect(visibleIds()).toEqual(['fact']);
  expect(app.tree.root.findAllByType(Switch)).toHaveLength(0);
  expect(app.api.request).not.toHaveBeenCalled();
  await app.press('更多记忆操作');
  await app.press('记忆设置');
  expect(app.tree.root.findByType(Switch).props.value).toBe(true);
  expect(app.api.request).toHaveBeenCalledWith('/memory/preferences');
  await app.press('关闭');
  expect(visibleIds()).toEqual(['fact']);
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
  expect(app.editorInputs()).toHaveLength(1);
  expect(app.editorInputs()[0].props.value).toBe('');
  await app.close();
});

test('single sentence creation preserves its selected category and draft when retrying', async () => {
  const content = '读完一本书之后做笔记。';
  const saved = memory('new', content, 'goal');
  const app = await setup([], {
    saveMemory: jest
      .fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(saved),
  });
  await app.press('添加一条记忆');
  await app.input(content);
  await app.press('分类为：目标');
  await app.press('记住这件事');
  expect(app.editorInputs()[0].props.value).toBe(content);
  expect(
    app.tree.root
      .findAllByType(ErrorNotice)
      .some(n => n.props.message === '网络中断'),
  ).toBe(true);
  const first = app.api.saveMemory.mock.calls[0];
  expect(first).toEqual([
    expect.objectContaining({
      content,
      kind: 'goal',
      source: '用户主动添加',
      client_request_id: expect.any(String),
    }),
    undefined,
  ]);
  await app.press('记住这件事');
  expect(app.api.saveMemory.mock.calls[1]).toEqual(first);
  expect(app.value.invalidate).toHaveBeenCalledTimes(1);
  expect(app.text()).toContain(content);
  expect(app.editorInputs()).toHaveLength(0);
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
  await app.press('修改');
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
  expect(app.editorInputs()[0].props.value).toBe('下午更专注。');
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
  await app.press('更多记忆操作');
  await app.press('从对话里整理记忆，先列出候选供你确认');
  expect(app.value.navigate).toHaveBeenLastCalledWith({
    name: 'chat',
    prompt: memoryReviewPrompt,
  });
  await app.press('私密资料：地址、银行卡、身份证');
  expect(app.value.navigate).toHaveBeenLastCalledWith({ name: 'privateVault' });
  await app.press('更多记忆操作');
  await app.press('按细分类查找');
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
  expect(app.editorInputs()[0].props.value).toBe(
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

test('homepage search combines with filters and can find results after loading another page', async () => {
  const older = memory('older', '学习 Rust 时先做练习。', 'goal');
  const app = await setup(samples, {
    memories: jest.fn()
      .mockResolvedValueOnce({ items: samples, next_offset: 50 })
      .mockResolvedValueOnce({ items: [older], next_offset: null }),
  });
  const visibleIds = () => app.tree.root.findAllByType(FlatList)
    .find(node => node.props.testID === 'memory-understand-home')!.props.data
    .map((item: Memory) => item.id);
  const search = app.tree.root
    .findAllByType(TextInput)
    .find(n => n.props.accessibilityLabel === '搜索记忆')!;
  await act(async () => search.props.onChangeText('rust'));
  expect(app.text()).toContain('搜索结果');
  expect(visibleIds()).toEqual(['extra']);
  await app.press('筛选：目标');
  expect(app.text()).toContain('已加载的记忆中没有匹配项，可继续加载后查找。');
  await app.press('加载更多记忆');
  expect(app.api.memories).toHaveBeenLastCalledWith(undefined, { offset: 50, limit: 50 });
  expect(visibleIds()).toEqual(['older']);
  await app.press('清空搜索');
  expect(visibleIds()).toEqual(['project', 'older']);
  await app.close();
});

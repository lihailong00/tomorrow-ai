import React, { Profiler } from 'react';
import { Alert, NativeModules, Text, View, RefreshControl } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ConversationsScreen } from '../src/features/conversations/ConversationsScreen';
import { conversationPinKey } from '../src/features/conversations/pins';
import { Button } from '../src/ui/components';
import { CurrentConversationPin } from '../src/features/conversations/CurrentConversationPin';

jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/ui/ChatMotion', () => ({ useChatReducedMotion: () => true }));
jest.mock('../src/platform/ports', () => ({ platform: {} }));
const values = new Map<string, string>();
const item = (id: string, date = '2026-11-02T04:00:00Z') => ({
  id,
  title: '对话 ' + id,
  updated_at: date,
});
let ownerNumber = 0;
let trees: ReactTestRenderer[] = [];
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  ownerNumber++;
  NativeModules.TomorrowPlatform = {
    getSecureItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setSecureItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
});
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees = [];
});
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0];
const section = (tree: ReactTestRenderer, id: string) =>
  tree.root.findAllByType(View).find(node => node.props.testID === id);
const rowIds = (tree: ReactTestRenderer, id: string) =>
  section(tree, id)
    ?.findAllByType(View)
    .filter(node => node.props.testID?.startsWith('conversation-row-'))
    .map(node => node.props.testID) ?? [];
const event = { nativeEvent: { pageX: 100, pageY: 240 } };
async function mount(
  items = [item('new'), item('old', '2026-11-01T00:00:00Z')],
  initialPins?: ReturnType<typeof item>[],
) {
  const preferences = {
    serverUrl: 'https://fixture',
    instance: { id: 'server' },
  };
  const user = { id: 'pins-ui-' + ownerNumber };
  if (initialPins)
    values.set(
      conversationPinKey(
        user.id,
        preferences.serverUrl,
        preferences.instance.id,
      )!,
      JSON.stringify({ version: 1, items: initialPins }),
    );
  const api = {
    conversations: jest.fn().mockResolvedValue({ items, next_offset: null }),
  };
  const context = {
    api,
    user,
    preferences,
    revision: 0,
    formatDate: (value: string) => value,
    navigate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <ConversationsScreen />
      </AppProvider>,
    );
  });
  trees.push(tree);
  return { tree, context, api };
}
test('long press pins a row, shows a separate compact section, and undo restores date order', async () => {
  const { tree } = await mount();
  const open = button(tree, '继续对话：对话 old');
  await act(async () => open.props.onLongPress(event));
  expect(button(tree, '置顶对话')).toBeDefined();
  await act(async () => button(tree, '置顶对话').props.onPress());
  expect(rowIds(tree, 'pinned-conversations')).toEqual([
    'conversation-row-old',
  ]);
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-new',
  ]);
  expect(section(tree, 'conversation-pin-toast')).toBeDefined();
  await act(async () => button(tree, '撤销置顶操作').props.onPress());
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-new',
    'conversation-row-old',
  ]);
});
test('overflow menu can unpin a cached older conversation and keep it reachable', async () => {
  const { tree } = await mount(
    [item('new')],
    [item('old', '2026-10-01T00:00:00Z')],
  );
  await act(async () =>
    button(tree, '管理对话：对话 old').props.onPress(event),
  );
  await act(async () => button(tree, '取消置顶对话').props.onPress());
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-new',
    'conversation-row-old',
  ]);
});
test('refreshing and loading later pages neither hide pinned records nor duplicate them', async () => {
  const { tree, api } = await mount(
    [item('new')],
    [item('old', '2026-10-01T00:00:00Z')],
  );
  api.conversations.mockResolvedValueOnce({
    items: [item('new')],
    next_offset: 50,
  });
  await act(async () => tree.root.findByType(RefreshControl).props.onRefresh());
  api.conversations.mockResolvedValueOnce({
    items: [item('old', '2026-10-01T00:00:00Z')],
    next_offset: null,
  });
  await act(async () =>
    tree.root
      .findAllByType(Button)
      .find(node => node.props.children === '加载更多对话')!
      .props.onPress(),
  );
  expect(rowIds(tree, 'pinned-conversations')).toEqual([
    'conversation-row-old',
  ]);
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-new',
  ]);
});
test('save failure restores the list and never claims the pin succeeded', async () => {
  const { tree } = await mount();
  NativeModules.TomorrowPlatform.setSecureItem.mockRejectedValueOnce(
    new Error('disk'),
  );
  await act(async () =>
    button(tree, '管理对话：对话 old').props.onPress(event),
  );
  await act(async () => button(tree, '置顶对话').props.onPress());
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
  expect(section(tree, 'conversation-pin-toast')).toBeUndefined();
  expect(
    tree.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .join(' '),
  ).toContain('置顶记录未能保存');
});
test('switching account hides old pins, menus and undo immediately', async () => {
  const { tree, context } = await mount([item('new')], [item('old')]);
  await act(async () =>
    button(tree, '管理对话：对话 old').props.onPress(event),
  );
  const next = {
    ...context,
    user: { ...context.user!, id: 'other-' + ownerNumber },
    api: {
      conversations: jest
        .fn()
        .mockResolvedValue({ items: [item('other')], next_offset: null }),
    },
  } as unknown as AppContextValue;
  await act(async () =>
    tree.update(
      <AppProvider value={next}>
        <ConversationsScreen />
      </AppProvider>,
    ),
  );
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
  expect(
    tree.root
      .findAllByType(View)
      .some(node => node.props.testID === 'conversation-pin-menu'),
  ).toBe(false);
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-other',
  ]);
  expect(context.navigate).not.toHaveBeenCalled();
});
function chatEntry() {
  const listeners = new Set<() => void>();
  let snapshot = {
    id: 'live',
    messages: [
      {
        id: 'question',
        role: 'user',
        content: '当前对话的问题',
        created_at: '2026-11-02T04:20:00Z',
      },
    ],
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stream: () => {
      snapshot = {
        ...snapshot,
        messages: [
          ...snapshot.messages,
          {
            id: 'answer',
            role: 'assistant',
            content: '一段新增的流式文本',
            created_at: '2026-11-02T04:21:00Z',
          },
        ],
      };
      listeners.forEach(listener => listener());
    },
  };
}
test('chat shortcut shares history state and ignores streaming token updates', async () => {
  const { tree, context } = await mount();
  const entry = chatEntry();
  const renders = jest.fn();
  await act(async () =>
    tree.update(
      <AppProvider value={context}>
        <Profiler id="pin-header" onRender={renders}>
          <CurrentConversationPin entryState={entry as any} />
        </Profiler>
        <ConversationsScreen />
      </AppProvider>,
    ),
  );
  await act(async () => button(tree, '置顶当前对话').props.onPress());
  expect(
    button(tree, '取消置顶当前对话').props.accessibilityState.selected,
  ).toBe(true);
  expect(rowIds(tree, 'pinned-conversations')).toEqual([
    'conversation-row-live',
  ]);
  const before = renders.mock.calls.length;
  await act(async () => entry.stream());
  expect(renders).toHaveBeenCalledTimes(before);
  await act(async () => button(tree, '取消置顶当前对话').props.onPress());
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
});
test('a late old-account write does not leak success or undo into the new account', async () => {
  const { tree, context } = await mount();
  let release!: () => void;
  NativeModules.TomorrowPlatform.setSecureItem.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  await act(async () =>
    button(tree, '管理对话：对话 old').props.onPress(event),
  );
  await act(async () => button(tree, '置顶对话').props.onPress());
  const next = {
    ...context,
    user: { ...context.user!, id: 'late-other-' + ownerNumber },
    api: {
      conversations: jest
        .fn()
        .mockResolvedValue({ items: [item('other')], next_offset: null }),
    },
  } as unknown as AppContextValue;
  await act(async () =>
    tree.update(
      <AppProvider value={next}>
        <ConversationsScreen />
      </AppProvider>,
    ),
  );
  await act(async () => release());
  expect(section(tree, 'pinned-conversations')).toBeUndefined();
  expect(section(tree, 'conversation-pin-toast')).toBeUndefined();
  expect(rowIds(tree, 'recent-conversations')).toEqual([
    'conversation-row-other',
  ]);
});
test('leaving chat before a failed save does not show a late alert over another screen', async () => {
  const { tree, context } = await mount();
  const entry = chatEntry();
  let reject!: (error: Error) => void;
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  NativeModules.TomorrowPlatform.setSecureItem.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  await act(async () =>
    tree.update(
      <AppProvider value={context}>
        <CurrentConversationPin entryState={entry as any} />
      </AppProvider>,
    ),
  );
  await act(async () => button(tree, '置顶当前对话').props.onPress());
  await act(async () => tree.unmount());
  await act(async () => reject(new Error('disk')));
  expect(alert).not.toHaveBeenCalled();
  alert.mockRestore();
});

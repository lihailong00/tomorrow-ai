import React from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { Button, ErrorNotice } from '../src/ui/components';
import type { Message } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const message = (id: string, index: number): Message => ({
  id, conversation_id: 'chat', role: 'user', content: id,
  created_at: new Date(index * 1000).toISOString(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(initial = [message('recent', 100)], options?: {
  firstPage?: Promise<{ items: Message[]; next_offset: number | null; next_before?: string | null }>;
  strict?: boolean;
}) {
  const late = deferred<{ items: Message[]; next_offset: null }>();
  const api = {
    messages: jest.fn().mockReturnValueOnce(options?.firstPage ?? Promise.resolve({ items: initial, next_offset: initial.length ? 40 : null, next_before: initial.length ? 'recent' : null })).mockReturnValueOnce(late.promise),
    capabilities: jest.fn().mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    chat: jest.fn().mockResolvedValue({ conversation_id: 'chat', user_message: message('new turn', 200), message: { ...message('new reply', 201), role: 'assistant' } }),
  };
  let navigation!: ReturnType<typeof useRouteStack>;
  let entry!: ReturnType<typeof createChatEntryState>;
  function Harness({ client }: { client: typeof api }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    if (route.name === 'chat') entry = navigation.getEntryState(scope => createChatEntryState(route.conversationId, undefined, scope));
    return <AppProvider value={{ api: client, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue}>
      <React.Fragment key={navigation.entry.key}>{route.name === 'chat'
        ? <ChatScreen conversationId={route.conversationId} entryState={entry} /> : <Text>{route.name}</Text>}
      </React.Fragment>
    </AppProvider>;
  }
  const render = (client: typeof api) => options?.strict
    ? <React.StrictMode><Harness client={client} /></React.StrictMode>
    : <Harness client={client} />;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render(api)); });
  await act(async () => navigation.navigate({ name: 'chat', conversationId: 'chat' }));
  return {
    api, late, tree, entry: () => entry,
    text: () => tree.root.findAllByType(Text).map(node => node.props.children).join('\n'),
    input: async (value: string) => { await act(async () => tree.root.findByType(TextInput).props.onChangeText(value)); },
    older: async () => { await act(async () => { void tree.root.findAllByType(Button).find(node => node.props.children === '加载更早消息')!.props.onPress(); }); },
    refresh: async () => { await act(async () => { void tree.root.findAllByType(ErrorNotice)[0].props.retry(); }); },
    send: async () => { await act(async () => { await tree.root.findAll(node => node.props.accessibilityLabel === '发送消息' && typeof node.props.onPress === 'function')[0].props.onPress(); }); },
    history: async () => { await act(async () => navigation.navigate({ name: 'conversations' })); },
    back: async () => { await act(async () => navigation.back()); },
    owner: async () => { await act(async () => tree.update(render({ ...api, messages: jest.fn().mockResolvedValue({ items: [message('other owner', 1)] }) }))); },
    close: async () => { await act(async () => tree.unmount()); },
  };
}

test('loads the oldest sentinel, preserves a new reply and draft, and keeps all pages through history/back', async () => {
  const app = await setup();
  expect(app.api.messages).toHaveBeenCalledWith('chat', { offset: 0, limit: 40 });
  await app.older();
  await app.input('send while older page is pending');
  await app.send();
  await app.input('unsent draft');
  await act(async () => app.late.resolve({ items: [message('earliest sentinel', 1), message('recent', 100)], next_offset: null }));
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['earliest sentinel', 'recent', 'new turn', 'new reply']);
  expect(app.text()).toContain('earliest sentinel');
  await app.history();
  await app.back();
  expect(app.api.messages).toHaveBeenCalledTimes(2);
  expect(app.text()).toContain('earliest sentinel');
  expect(app.tree.root.findByType(TextInput).props.value).toBe('unsent draft');
  await app.close();
});

test('native anchoring skips the fixed header and keeps the same message View through prepend and repeated layouts', async () => {
  const app = await setup();
  const pane = () => app.tree.root.findAllByType(ScrollView)[0];
  const children = () => React.Children.toArray(pane().props.children) as React.ReactElement<any>[];
  expect(pane().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 1 });
  expect(children()[0].props).toMatchObject({ testID: 'chat-history-header', collapsable: false });
  expect(children()[1].props).toMatchObject({ testID: 'chat-message-recent', collapsable: false });
  const retainedKey = children()[1].key;
  await act(async () => pane().props.onContentSizeChange(360, 1000));
  await act(async () => pane().props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
  await app.older();
  await act(async () => app.late.resolve({ items: [message('earliest sentinel', 1)], next_offset: null }));
  expect(children()[0].props.testID).toBe('chat-history-header');
  expect(children()[1].props.testID).toBe('chat-message-earliest sentinel');
  expect(children()[2].key).toBe(retainedKey);
  expect(children()[2].props).toMatchObject({ testID: 'chat-message-recent', collapsable: false });
  // Layout can settle over several frames. JS must not add a second height-delta
  // correction to the offset that native anchoring reports via onScroll.
  for (const height of [1600, 1840, 1800]) {
    await act(async () => pane().props.onContentSizeChange(360, height));
    expect(app.entry().history.viewport.y).toBe(120);
  }
  await act(async () => pane().props.onScroll({ nativeEvent: { contentOffset: { y: 720 } } }));
  await app.history();
  await app.back();
  await act(async () => pane().props.onContentSizeChange(360, 1800));
  expect(app.entry().history.viewport.y).toBe(720);
  await app.close();
});

test('the header keeps native child index zero when an empty conversation receives its first turn', async () => {
  const app = await setup([]);
  const children = () => React.Children.toArray(app.tree.root.findAllByType(ScrollView)[0].props.children) as React.ReactElement<any>[];
  const headerKey = children()[0].key;
  expect(children()[0].props.testID).toBe('chat-history-header');
  expect(children().filter(child => child.props.testID?.startsWith('chat-message-'))).toHaveLength(0);
  await app.input('first turn');
  await app.send();
  expect(children()[0].key).toBe(headerKey);
  expect(children()[1].props).toMatchObject({ testID: 'chat-message-new turn', collapsable: false });
  expect(children()[2].props).toMatchObject({ testID: 'chat-message-new reply', collapsable: false });
  await app.close();
});

test('a late older page cannot enter a new account after ownership changes', async () => {
  const app = await setup();
  const old = app.entry();
  await app.older();
  await app.owner();
  await act(async () => app.late.resolve({ items: [message('foreign late sentinel', 1)], next_offset: null }));
  expect(old.getSnapshot().messages.map(item => item.id)).toEqual(['recent']);
  expect(app.text()).not.toContain('foreign late sentinel');
  await app.close();
});

test('leaving while older is pending preserves the reading position and cursor until a visible retry', async () => {
  const app = await setup();
  const pane = () => app.tree.root.findAllByType(ScrollView)[0];
  await act(async () => pane().props.onContentSizeChange(360, 1000));
  await act(async () => pane().props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
  await app.input('retained draft');
  await app.older();
  await app.history();
  expect(app.entry().history.getSnapshot()).toMatchObject({ initialized: true, loading: false, nextOffset: 40, nextBefore: 'recent' });
  await act(async () => app.late.resolve({ items: [message('earliest sentinel', 1)], next_offset: null }));
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['recent']);
  await app.back();
  await act(async () => pane().props.onContentSizeChange(360, 1000));
  expect(app.entry().history.viewport.y).toBe(120);
  expect(app.api.messages).toHaveBeenCalledTimes(2);
  expect(app.tree.root.findByType(TextInput).props.value).toBe('retained draft');
  app.api.messages.mockResolvedValueOnce({ items: [message('earliest sentinel', 1)], next_offset: null });
  await app.older();
  expect(app.api.messages).toHaveBeenLastCalledWith('chat', { before: 'recent', limit: 40 });
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['earliest sentinel', 'recent']);
  await app.close();
});

test('an initial read completed while hidden is discarded and Back starts a fresh initial page', async () => {
  const first = deferred<{ items: Message[]; next_offset: null }>();
  const app = await setup([], { firstPage: first.promise });
  await app.history();
  await act(async () => first.resolve({ items: [message('hidden stale initial', 1)], next_offset: null }));
  expect(app.entry().history.getSnapshot()).toMatchObject({ initialized: false, loading: false });
  expect(app.entry().getSnapshot().messages).toEqual([]);
  await act(async () => app.late.resolve({ items: [message('current initial', 100)], next_offset: null }));
  await app.back();
  expect(app.api.messages).toHaveBeenCalledTimes(2);
  expect(app.api.messages).toHaveBeenLastCalledWith('chat', { offset: 0, limit: 40 });
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['current initial']);
  await app.close();
});

test('a refresh completed while hidden preserves loaded pages and supports an explicit retry', async () => {
  const app = await setup();
  await app.refresh();
  await app.history();
  await act(async () => app.late.resolve({ items: [message('fresh latest', 200)], next_offset: null }));
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['recent']);
  await app.back();
  app.api.messages.mockResolvedValueOnce({ items: [message('fresh latest', 200)], next_offset: null });
  await app.refresh();
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['recent', 'fresh latest']);
  expect(app.entry().history.getSnapshot()).toMatchObject({ nextOffset: 40, nextBefore: 'recent', loading: false });
  await app.close();
});

test('StrictMode cleanup invalidates its first history read without suppressing the replayed read', async () => {
  const first = deferred<{ items: Message[]; next_offset: null }>();
  const app = await setup([], { firstPage: first.promise, strict: true });
  expect(app.api.messages).toHaveBeenCalledTimes(2);
  await act(async () => first.resolve({ items: [message('obsolete effect', 1)], next_offset: null }));
  expect(app.entry().getSnapshot().messages).toEqual([]);
  await act(async () => app.late.resolve({ items: [message('current effect', 100)], next_offset: null }));
  expect(app.entry().getSnapshot().messages.map(item => item.id)).toEqual(['current effect']);
  expect(app.entry().history.getSnapshot()).toMatchObject({ initialized: true, loading: false });
  await app.close();
});

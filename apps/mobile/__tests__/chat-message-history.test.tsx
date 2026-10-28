import React from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { Button } from '../src/ui/components';
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

async function setup() {
  const late = deferred<{ items: Message[]; next_offset: null }>();
  const api = {
    messages: jest.fn().mockResolvedValueOnce({ items: [message('recent', 100)], next_offset: 40, next_before: 'recent' }).mockReturnValueOnce(late.promise),
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
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Harness client={api} />); });
  await act(async () => navigation.navigate({ name: 'chat', conversationId: 'chat' }));
  return {
    api, late, tree, entry: () => entry,
    text: () => tree.root.findAllByType(Text).map(node => node.props.children).join('\n'),
    input: async (value: string) => { await act(async () => tree.root.findByType(TextInput).props.onChangeText(value)); },
    older: async () => { await act(async () => { void tree.root.findAllByType(Button).find(node => node.props.children === '加载更早消息')!.props.onPress(); }); },
    send: async () => { await act(async () => { await tree.root.findAll(node => node.props.accessibilityLabel === '发送消息' && typeof node.props.onPress === 'function')[0].props.onPress(); }); },
    history: async () => { await act(async () => navigation.navigate({ name: 'conversations' })); },
    back: async () => { await act(async () => navigation.back()); },
    owner: async () => { await act(async () => tree.update(<Harness client={{ ...api, messages: jest.fn().mockResolvedValue({ items: [message('other owner', 1)] }) }} />)); },
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

test('older page prepend preserves the viewport instead of requesting the conversation bottom', async () => {
  const app = await setup();
  const pane = () => app.tree.root.findAllByType(ScrollView)[0];
  await act(async () => pane().props.onContentSizeChange(360, 1000));
  await act(async () => pane().props.onScroll({ nativeEvent: { contentOffset: { y: 120 } } }));
  await app.older();
  await act(async () => app.late.resolve({ items: [message('earliest sentinel', 1)], next_offset: null }));
  await act(async () => pane().props.onContentSizeChange(360, 1600));
  expect(app.entry().history.viewport.y).toBe(720);
  await app.history();
  await app.back();
  await act(async () => pane().props.onContentSizeChange(360, 1600));
  expect(app.entry().history.viewport.y).toBe(720);
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

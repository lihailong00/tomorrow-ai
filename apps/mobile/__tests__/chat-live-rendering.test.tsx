import React from 'react';
import { FlatList, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import type { SseEvent } from '../src/api/chatSse';
import type { ChatIntent, Message } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

const user: Message = { id: 'server-user', conversation_id: 'server-conversation',
  role: 'user', content: '请给我一个建议', created_at: '2026-10-28T04:00:00Z' };

async function setup() {
  let receive!: (event: SseEvent) => void;
  let finish!: () => void;
  const api = {
    capabilities: jest.fn().mockResolvedValue({ items: [], runtime: { model_mode: 'llm' } }),
    messages: jest.fn().mockResolvedValue({ items: [] }),
    chatStream: jest.fn((_intent: ChatIntent, sink: (event: SseEvent) => void) => {
      receive = sink;
      return new Promise<void>(resolve => { finish = resolve; });
    }),
  };
  const entry = createChatEntryState();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={{ api, invalidate: jest.fn(),
    formatDate: () => '', preferences: {}, user: { id: 'owner' } } as unknown as AppContextValue}>
    <ChatScreen entryState={entry} />
  </AppProvider>); });
  let sending: Promise<void> | undefined;
  await act(async () => tree.root.findByType(TextInput).props.onChangeText(user.content));
  await act(async () => {
    sending = tree.root.findAll(node => node.props.accessibilityLabel === '发送消息' &&
      typeof node.props.onPress === 'function')[0].props.onPress();
  });
  return {
    api, tree, entry,
    rows: () => [...tree.root.findByType(FlatList).props.data].reverse() as Message[],
    emit: async (id: number, event: string, data: Record<string, unknown>) => {
      await act(async () => receive({ id, event, data }));
    },
    close: async () => {
      await act(async () => { finish(); await sending; tree.unmount(); });
    },
  };
}

test('shows the user bubble before the network responds, then displays partial text before done', async () => {
  const app = await setup();
  try {
    expect(app.rows()).toHaveLength(2);
    expect(app.rows()[0]).toMatchObject({ role: 'user', content: user.content, delivery: 'sending' });
    expect(app.rows()[1].content).toBe('');
    expect(app.tree.root.findByType(TextInput).props.value).toBe('');
    const keys = app.rows().map(message => message.client_key);
    await app.emit(0, 'snapshot', { status: 'running', content: '' });
    await app.emit(1, 'accepted', { user_message: user, conversation_id: user.conversation_id, message_id: 'server-assistant' });
    await app.emit(2, 'text_delta', { delta: '先选一件' });
    expect(app.rows()[0].delivery).toBe('sent');
    expect(app.rows()[1]).toMatchObject({ id: 'server-assistant', content: '先选一件' });
    expect(app.rows().map(message => message.client_key)).toEqual(keys);
    expect(app.entry.getSnapshot().sending).toBe(true);
    await app.emit(3, 'text_delta', { delta: '最重要的事。' });
    expect(app.rows()[1].content).toBe('先选一件最重要的事。');
    await app.emit(4, 'done', { response: { conversation_id: user.conversation_id,
      user_message: user, message: { ...user, id: 'server-assistant', role: 'assistant', content: '先选一件最重要的事。' } } });
    expect(app.rows()).toHaveLength(2);
    expect(app.entry.getSnapshot().sending).toBe(false);
    expect(app.rows()[1].stream_status).toBe('');
  } finally { await app.close(); }
});

test('keeps both the submitted message and received partial answer when the model run fails', async () => {
  const app = await setup();
  try {
    await app.emit(0, 'snapshot', { status: 'running', content: '' });
    await app.emit(1, 'accepted', { user_message: user, conversation_id: user.conversation_id, message_id: 'server-assistant' });
    await app.emit(2, 'text_delta', { delta: '这段已收到的文字' });
    await app.emit(3, 'error', { message: '回复中断', partial: true });
    expect(app.rows()[0].content).toBe(user.content);
    expect(app.rows()[1].content).toBe('这段已收到的文字');
    expect(app.rows()[1].stream_error).toBeTruthy();
    expect(app.entry.getSnapshot().sending).toBe(false);
    expect(app.entry.streams.size).toBe(1);
  } finally { await app.close(); }
});

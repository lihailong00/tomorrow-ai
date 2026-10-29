import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import type { Message } from '../src/domain/types';

jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

const trees = new Set<ReactTestRenderer>();
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  await act(async () => { trees.forEach(tree => tree.unmount()); });
  trees.clear();
});

async function setup(id?: string) {
  const fetcher = jest.fn().mockResolvedValue({ ok: true, status: 200,
    text: async () => JSON.stringify({ items: [], runtime: { model_mode: 'local' } }),
  });
  const api = new ApiClient('https://synthetic.test', 'test-only', undefined, fetcher);
  api.messages = jest.fn().mockResolvedValue({ items: [], next_offset: null });
  const entry = createChatEntryState(id);
  const navigate = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AppProvider value={{ api, navigate, invalidate: jest.fn(),
      formatDate: () => '', user: { id: 'test-user' },
    } as unknown as AppContextValue}>
      <ChatScreen conversationId={id} entryState={entry} />
    </AppProvider>);
  });
  trees.add(tree);
  const button = () => tree.root.findAll(node =>
    node.props.accessibilityLabel === '从这段对话发现待办' &&
    typeof node.props.onPress === 'function')[0];
  const message: Message = { id: 'user-message', conversation_id: id ?? 'new-chat',
    role: 'user', content: '周五前整理读书笔记', created_at: '2026-10-29T01:00:00Z' };
  const update = async (patch: Parameters<typeof entry.update>[0]) => {
    await act(async () => { entry.update(patch); });
  };
  return { button, update, entry, navigate, message, api };
}

test('empty or not-yet-persisted chat has no extraction entry', async () => {
  const app = await setup();
  expect(app.button()).toBeUndefined();
  await app.update(old => ({ ...old, messages: [app.message] }));
  expect(app.button()).toBeUndefined();
});

test('discovery opens the current persisted conversation without starting extraction or losing draft', async () => {
  const app = await setup('persisted-conversation');
  await app.update(old => ({ ...old, messages: [app.message], draft: '还没有发出的想法' }));
  expect(app.button()).toBeDefined();
  await act(async () => { app.button().props.onPress(); });
  expect(app.navigate).toHaveBeenCalledWith({ name: 'todoSources', conversationId: 'persisted-conversation' });
  expect(app.entry.getSnapshot().draft).toBe('还没有发出的想法');
  expect(app.api.messages).toHaveBeenCalledTimes(1);
});

test('streaming disables discovery and enables it after the reply finishes', async () => {
  const app = await setup('persisted-conversation');
  await app.update(old => ({ ...old, messages: [app.message], sending: true }));
  expect(app.button().props.disabled).toBe(true);
  await app.update(old => ({ ...old, sending: false }));
  expect(app.button().props.disabled).toBe(false);
});

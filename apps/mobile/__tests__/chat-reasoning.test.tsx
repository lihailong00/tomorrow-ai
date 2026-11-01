import React from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import type { ChatIntent } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({ platform: { getSystemFontScale: jest.fn().mockResolvedValue(null) } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

const trees = new Set<ReactTestRenderer>();
afterEach(async () => { await act(async () => { trees.forEach(tree => tree.unmount()); trees.clear(); }); });

async function setup() {
  const requests: ChatIntent[] = [];
  let release: (() => void) | undefined;
  const api = { messages: jest.fn().mockResolvedValue({ items: [] }),
    chatStream: jest.fn(async (intent: ChatIntent, event: (value: unknown) => void) => {
      requests.push(intent);
      await new Promise<void>(resolve => { release = resolve; });
      event({ id: 1, event: 'done', data: { response: { conversation_id: 'conversation', message: {
        id: `answer-${requests.length}`, conversation_id: 'conversation', role: 'assistant', content: '测试回复',
        created_at: '2026-11-01T01:00:00Z', attachments: [],
      } } } });
    }) };
  const value = { api, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue;
  const entry = createChatEntryState();
  const render = (state = entry, context = value) => <AppProvider value={context}><ChatScreen entryState={state} /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  trees.add(tree);
  const press = async (label: string) => {
    const button = tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
    expect(button).toBeDefined();
    expect(button.props.disabled).not.toBe(true);
    await act(async () => { button.props.onPress(); });
  };
  const choose = async (current: string, label: string) => { await press(`思考：${current}`); await press(label); };
  return { api, requests, entry, tree, press, choose, render,
    complete: async () => { await act(async () => { release?.(); }); },
    send: async (text = '请帮我分析') => {
      await act(async () => tree.root.findByType(TextInput).props.onChangeText(text));
      await press('发送消息');
    },
  };
}

test('new conversations start off and all four choices are selectable', async () => {
  const view = await setup();
  expect(view.entry.getSnapshot().reasoningEffort).toBe('off');
  await view.choose('关闭', '轻度思考');
  expect(view.entry.getSnapshot().reasoningEffort).toBe('low');
  await view.choose('轻度', '深度思考');
  expect(view.entry.getSnapshot().reasoningEffort).toBe('high');
  await view.choose('深度', '最强思考');
  expect(view.entry.getSnapshot().reasoningEffort).toBe('max');
  await view.choose('最强', '关闭思考');
  await view.send();
  expect(view.requests[0].reasoning_effort).toBe('off');
  await view.complete();
});

test('switching during generation only affects subsequent messages and retained entries keep their choice', async () => {
  const view = await setup();
  await view.choose('关闭', '最强思考');
  await view.send();
  await view.choose('最强', '轻度思考');
  expect(view.requests[0].reasoning_effort).toBe('max');
  expect(Object.isFrozen(view.requests[0])).toBe(true);
  await view.complete();
  await view.send('下一条');
  expect(view.requests[1].reasoning_effort).toBe('low');
  await view.complete();
  await act(async () => view.tree.update(view.render(createChatEntryState())));
  expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '思考：关闭').length).toBeGreaterThan(0);
  await act(async () => view.tree.update(view.render()));
  expect(view.entry.getSnapshot().reasoningEffort).toBe('low');
  expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '思考：轻度').length).toBeGreaterThan(0);
});

test('the reasoning sheet closes on conversation changes and old owner callbacks cannot change the new entry', async () => {
  const view = await setup();
  await view.press('思考：关闭');
  const oldChoice = view.tree.root.findAll(node => node.props.accessibilityLabel === '最强思考' && typeof node.props.onPress === 'function')[0].props.onPress;
  const next = createChatEntryState();
  await act(async () => view.tree.update(view.render(next)));
  expect(view.tree.root.findAll(node => node.props.testID === 'chat-reasoning-sheet')).toHaveLength(0);
  await act(async () => oldChoice());
  expect(next.getSnapshot().reasoningEffort).toBe('off');
  expect(view.entry.getSnapshot().reasoningEffort).toBe('off');
});

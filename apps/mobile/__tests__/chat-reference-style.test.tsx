import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatScreen } from '../src/screens/Chat';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { platform } from '../src/platform/ports';
jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/platform/ports', () => ({ platform: {
  hasRecorder: true, startRecording: jest.fn(), stopRecording: jest.fn(), share: jest.fn(),
} }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
afterEach(async () => { await act(async () => trees.forEach(t => t.unmount())); trees.clear(); jest.clearAllMocks(); });
async function setup() {
  const api = { capabilities: jest.fn().mockResolvedValue({ runtime: { model_mode: 'pi' } }),
    messages: jest.fn().mockResolvedValue({ items: [
      { id: 'reference-user', conversation_id: 'saved', role: 'user', content: 'MY VISIBLE QUESTION', created_at: '2026-10-31T00:00:00Z' },
      { id: 'reference-answer', conversation_id: 'saved', role: 'assistant', content: 'A VISIBLE ANSWER', created_at: '2026-10-31T00:00:01Z' },
    ], next_offset: null }) };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={{ api, formatDate: () => '', invalidate: jest.fn(), navigate: jest.fn() } as unknown as AppContextValue}><ChatScreen conversationId="saved" /></AppProvider>); });
  trees.add(tree);
  return { tree, input: () => tree.root.findByType(TextInput), button: (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0] };
}
function luminance(hex: string) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
test('text and voice mode changes preserve one editable draft without starting the recorder', async () => {
  const app = await setup(); const original = app.input();
  await act(async () => original.props.onChangeText('Keep every line\nAnd this draft.'));
  await act(async () => app.button('切换语音输入').props.onPress());
  expect(app.input()).toBe(original);
  expect(app.input().props.value).toBe('Keep every line\nAnd this draft.');
  expect(app.tree.root.findAll(n => n.props.testID === 'chat-hold-to-talk').length).toBeGreaterThan(0);
  expect(platform.startRecording).not.toHaveBeenCalled();
  await act(async () => app.button('切换文字输入').props.onPress());
  expect(app.input()).toBe(original);
  expect(app.input().props.value).toBe('Keep every line\nAnd this draft.');
  expect(app.button('发送消息').props.disabled).toBe(false);
});
test('message layout removes the memory hint and per-answer identity while keeping readable contrasting user content', async () => {
  const app = await setup();
  const rendered = app.tree.root.findAllByType(Text).map(n => n.props.children).join(' ');
  expect(rendered).not.toContain('记忆由你主动添加');
  const row = (id: string) => app.tree.root.findAllByType(View).find(n => n.props.testID === 'chat-message-' + id)!;
  const user = row('reference-user'); const answer = row('reference-answer');
  expect(user).toBeDefined(); expect(answer).toBeDefined();
  const foreground = user.findAllByType(Text).find(n => n.props.children === 'MY VISIBLE QUESTION')!;
  const color = StyleSheet.flatten(foreground.props.style).color;
  const background = StyleSheet.flatten(user.props.style).backgroundColor;
  const [high, low] = [luminance(color), luminance(background)].sort((a, b) => b - a);
  expect((high + .05) / (low + .05)).toBeGreaterThanOrEqual(4.5);
  expect(StyleSheet.flatten(user.props.style).alignSelf).toBe('flex-end');
  expect(answer.findAllByType(Text).some(n => n.props.children === '妥啦')).toBe(false);
  expect(answer.findAllByType(Text).map(n => n.props.children).join(' ')).toContain('A VISIBLE ANSWER');
});

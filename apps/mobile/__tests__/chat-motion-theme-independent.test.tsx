import React from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, TextInput, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatModeMotion, ChatRecordingMotion, useChatReducedMotion } from '../src/ui/ChatMotion';
import { ChatScreen } from '../src/screens/Chat';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { chatAppearance } from '../src/ui/ChatAppearance';
jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
let readPreference!: jest.SpyInstance;
let timing!: jest.SpyInstance;
let changePreference!: (enabled: boolean) => void;
let remove!: jest.Mock;
let animations: Array<{ start: jest.Mock; stop: jest.Mock }>;
beforeEach(() => {
  animations = []; remove = jest.fn();
  readPreference = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  const subscribe = jest.spyOn(AccessibilityInfo, 'addEventListener') as unknown as jest.Mock;
  subscribe.mockImplementation((event: string, callback: (enabled: boolean) => void) => {
    if (event === 'reduceMotionChanged') changePreference = callback as (enabled: boolean) => void;
    return { remove } as any;
  });
  timing = jest.spyOn(Animated, 'timing').mockImplementation(() => {
    const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    animations.push(animation); return animation;
  });
});
afterEach(async () => { await act(async () => trees.forEach(t => t.unmount())); trees.clear(); jest.restoreAllMocks(); });
async function mount(node: React.ReactElement) {
  let tree!: ReactTestRenderer; await act(async () => { tree = create(node); }); trees.add(tree); return tree;
}
function assertStaticPose(tree: ReactTestRenderer) {
  const frame = tree.root.findAll(n => n.props.testID === 'chat-mode-motion' && n.props.style)[0];
  const style = StyleSheet.flatten(frame.props.style);
  expect(style.opacity.__getValue()).toBe(1);
  expect(style.transform[0].translateY.__getValue()).toBe(0);
}
function PreferenceHarness({ mode }: { mode: 'text' | 'voice' }) {
  const reduced = useChatReducedMotion();
  return <ChatModeMotion mode={mode} reducedMotion={reduced}><Text>{String(reduced)}</Text></ChatModeMotion>;
}
test('unknown preference and late resolution stay static; a live accessibility event wins over an older query', async () => {
  let resolve!: (value: boolean) => void;
  readPreference.mockReturnValueOnce(new Promise<boolean>(r => { resolve = r; }));
  const tree = await mount(<PreferenceHarness mode="text" />);
  await act(async () => tree.update(<PreferenceHarness mode="voice" />));
  expect(timing).not.toHaveBeenCalled(); assertStaticPose(tree);
  await act(async () => changePreference(true));
  await act(async () => resolve(false));
  expect(tree.root.findByType(Text).props.children).toBe('true');
  expect(timing).not.toHaveBeenCalled();
  await act(async () => changePreference(false));
  expect(timing).not.toHaveBeenCalled();
  await act(async () => tree.update(<PreferenceHarness mode="text" />));
  expect(timing).toHaveBeenCalledTimes(1);
  expect(timing.mock.calls[0][1]).toMatchObject({ duration: 220, useNativeDriver: true, isInteraction: false });
  await act(async () => changePreference(true));
  expect(animations[0].stop).toHaveBeenCalled(); assertStaticPose(tree);
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(remove).toHaveBeenCalledTimes(1);
});
test('failed preference read remains static and unsubscribes', async () => {
  readPreference.mockRejectedValueOnce(new Error('native preference unavailable'));
  const tree = await mount(<PreferenceHarness mode="text" />);
  await act(async () => tree.update(<PreferenceHarness mode="voice" />));
  expect(tree.root.findByType(Text).props.children).toBe('null');
  expect(timing).not.toHaveBeenCalled();
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(remove).toHaveBeenCalledTimes(1);
});
test('rapid retargets stop their old visual work, retaining the same input independently of animation completion', async () => {
  function Stable({ mode }: { mode: 'text' | 'voice' }) {
    const [draft, setDraft] = React.useState('');
    return <ChatModeMotion mode={mode} reducedMotion={false}><TextInput value={draft} onChangeText={setDraft} /></ChatModeMotion>;
  }
  const tree = await mount(<Stable mode="text" />); const input = tree.root.findByType(TextInput);
  await act(async () => input.props.onChangeText('Do not erase this draft'));
  await act(async () => tree.update(<Stable mode="voice" />));
  await act(async () => tree.update(<Stable mode="text" />));
  expect(timing).toHaveBeenCalledTimes(2);
  expect(animations[0].stop).toHaveBeenCalled();
  expect(animations.every(a => a.start.mock.calls.every(call => call.length === 0))).toBe(true);
  expect(tree.root.findByType(TextInput)).toBe(input);
  expect(input.props.value).toBe('Do not erase this draft');
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(animations[1].stop).toHaveBeenCalled();
});
test('recording support uses a bounded visual entrance only, and reduced motion skips it', async () => {
  const tree = await mount(<ChatRecordingMotion reducedMotion={false}><Text>Actual recording</Text></ChatRecordingMotion>);
  expect(timing).toHaveBeenCalledTimes(1);
  expect(timing.mock.calls[0][1]).toMatchObject({ duration: 220, useNativeDriver: true, isInteraction: false });
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(animations[0].stop).toHaveBeenCalled();
  await mount(<ChatRecordingMotion reducedMotion><Text>Actual recording</Text></ChatRecordingMotion>);
  expect(timing).toHaveBeenCalledTimes(1);
});
function luminance(hex: string) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
test('actual chat keeps the brand bubble legible and places reply recovery outside it', async () => {
  const api = { capabilities: jest.fn().mockResolvedValue({ runtime: { model_mode: 'pi' } }), messages: jest.fn().mockResolvedValue({ items: [
    { id: 'brand-user', role: 'user', content: 'Brand message', conversation_id: 'saved', created_at: '', delivery: 'failed', stream_error: 'Retryable failure', attachments: [{ upload_id: 'file', name: 'example.txt' }] },
    { id: 'brand-answer', role: 'assistant', content: '', conversation_id: 'saved', created_at: '', stream_error: 'Retryable failure' },
  ], next_offset: null }) };
  const tree = await mount(<AppProvider value={{ api, formatDate: () => '', navigate: jest.fn(), invalidate: jest.fn() } as unknown as AppContextValue}><ChatScreen conversationId="saved" /></AppProvider>);
  const row = tree.root.findAllByType(View).find(n => n.props.testID === 'chat-message-brand-user')!;
  expect(row).toBeDefined();
  const background = StyleSheet.flatten(row.props.style).backgroundColor;
  expect(background).toBe('#416CCB');
  expect(StyleSheet.flatten(row.props.style)).toMatchObject({ maxWidth: '75%', borderRadius: 18, borderBottomRightRadius: 6 });
  expect(background).toBe(chatAppearance.accent);
  const text = row.findAllByType(Text);
  const content = text.map(n => Array.isArray(n.props.children) ? n.props.children.flat(Infinity).join('') : String(n.props.children)).join(' ');
  expect(content).toContain('Brand message');
  expect(content).not.toContain('Retryable failure');
  expect(tree.root.findAllByType(Text).some(node => node.props.children === 'Retryable failure')).toBe(true);
  expect(content).toContain('example.txt');
  for (const node of text) {
    const foreground = StyleSheet.flatten(node.props.style).color;
    const children = Array.isArray(node.props.children) ? node.props.children.flat(Infinity).join('') : String(node.props.children);
    if (['Brand message', 'example.txt'].some(value => children.includes(value))) {
      expect(foreground).toBe('#FFFFFF');
    }
    if (typeof foreground !== 'string' || !/^#[0-9a-f]{6}$/i.test(foreground)) continue;
    let ancestor = node.parent;
    let nearestBackground = background;
    while (ancestor) {
      const candidate = typeof ancestor.props.style === 'function' ? ancestor.props.style({ pressed: false }) : ancestor.props.style;
      const value = StyleSheet.flatten(candidate)?.backgroundColor;
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) { nearestBackground = value; break; }
      if (ancestor === row) break;
      ancestor = ancestor.parent;
    }
    const [high, low] = [luminance(foreground), luminance(nearestBackground)].sort((a,b) => b-a);
    expect((high + .05) / (low + .05)).toBeGreaterThanOrEqual(4.5);
  }
});

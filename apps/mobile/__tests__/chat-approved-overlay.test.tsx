import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stop } from 'react-native-svg';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatVoiceOverlay } from '../src/ui/ChatVoiceOverlay';
import { ChatRecordingMotion } from '../src/ui/ChatMotion';
import { chatAppearance } from '../src/ui/ChatAppearance';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({ platform: {
  hasRecordingLevel: true, recordingLevel: jest.fn().mockResolvedValue(0),
} }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  platform.hasRecordingLevel = true;
  (platform.recordingLevel as jest.Mock).mockResolvedValue(0);
});
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees.clear(); jest.clearAllTimers(); jest.useRealTimers();
});
async function render(extra: Partial<React.ComponentProps<typeof ChatVoiceOverlay>> = {}) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatVoiceOverlay seconds={9} cancelled={false} holding
    composerHeight={78} availableHeight={600} fontScale={1} reducedMotion {...extra} />); });
  trees.add(tree); return tree;
}
const node = (tree: ReactTestRenderer, id: string) => tree.root.findAll(n => n.props.testID === id)[0];
const backdropBase = (tree: ReactTestRenderer) => tree.root.findAllByType(Stop).find(n => n.props.offset === '1')!;

test('compact feedback reaches the bottom and its opaque base cannot move with the entrance animation', async () => {
  const tree = await render();
  const overlay = node(tree, 'chat-voice-overlay');
  expect(overlay.props.pointerEvents).toBe('none');
  expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({ bottom: 0, position: 'absolute', left: 0, right: 0 });
  expect(StyleSheet.flatten(overlay.props.style).height).toBeLessThan(230);
  expect(StyleSheet.flatten(node(tree, 'chat-voice-feedback').props.style).bottom).toBe(78);
  const base = backdropBase(tree);
  expect(base.props.stopOpacity).toBe('1');
  expect(base.props.stopColor).toBe(chatAppearance.voiceSurface);
  expect(tree.root.findByType(ChatRecordingMotion).findAll(n => n.props.testID === 'chat-voice-backdrop')).toHaveLength(0);
  expect(node(tree, 'chat-voice-overlay-title').props.children).toBe('正在聆听');
  expect(node(tree, 'chat-voice-clock').props.children).toBe('00:09');
});

test('quiet audio stays flat rather than showing simulated speech', async () => {
  const tree = await render();
  await act(async () => { jest.advanceTimersByTime(600); });
  const bars = tree.root.findAllByType(View).filter(n => /^chat-voice-level-\d+$/.test(n.props.testID ?? ''));
  expect(bars).toHaveLength(29);
  expect(bars.every(bar => StyleSheet.flatten(bar.props.style).height === 4)).toBe(true);
});

test('slow meter reads never overlap and unmount prevents late updates and further polling', async () => {
  let finish!: (level: number) => void;
  (platform.recordingLevel as jest.Mock).mockImplementation(() => new Promise<number>(resolve => { finish = resolve; }));
  const tree = await render();
  await act(async () => { jest.advanceTimersByTime(900); });
  expect(platform.recordingLevel).toHaveBeenCalledTimes(1);
  await act(async () => finish(0.81));
  expect(StyleSheet.flatten(node(tree, 'chat-voice-level-28').props.style).height).toBeGreaterThan(20);
  await act(async () => { jest.advanceTimersByTime(150); });
  expect(platform.recordingLevel).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount()); trees.delete(tree);
  await act(async () => { finish(1); jest.advanceTimersByTime(900); });
  expect(platform.recordingLevel).toHaveBeenCalledTimes(2);
});

test('older adapters work without polling or changing the recording flow', async () => {
  platform.hasRecordingLevel = false;
  await render(); await act(async () => { jest.advanceTimersByTime(600); });
  expect(platform.recordingLevel).not.toHaveBeenCalled();
});

test('cancellation uses the rose surface and the matching action feedback', async () => {
  const tree = await render({ cancelled: true });
  const title = node(tree, 'chat-voice-overlay-title');
  expect(title.props.children).toBe('松开取消');
  expect(StyleSheet.flatten(title.props.style).color).toBe(chatAppearance.cancellationText);
  expect(backdropBase(tree).props.stopColor).toBe(chatAppearance.cancellation);
  expect(node(tree, 'chat-voice-hint').props.children).toBe('这段录音不会发送');
});

test('short viewports with large fonts preserve the title and clock, omitting optional decorations', async () => {
  const tree = await render({ availableHeight: 200, fontScale: 2 });
  expect(StyleSheet.flatten(node(tree, 'chat-voice-overlay').props.style).height).toBeLessThanOrEqual(200);
  expect(tree.root.findAllByType(Text)).toHaveLength(2);
  expect(node(tree, 'chat-voice-overlay-title').props.children).toBe('正在聆听');
  expect(tree.root.findAll(n => n.props.testID === 'chat-voice-levels')).toHaveLength(0);
});

test('large fonts retain gesture instructions when the viewport has enough room', async () => {
  const tree = await render({ fontScale: 2 });
  expect(node(tree, 'chat-voice-hint').props.children).toBe('松开发送，上滑取消');
  expect(StyleSheet.flatten(node(tree, 'chat-voice-overlay').props.style).height).toBeLessThan(600);
});

test('a very short viewport still covers the footer without clipping decorative text', async () => {
  const tree = await render({ availableHeight: 45, fontScale: 2 });
  expect(StyleSheet.flatten(node(tree, 'chat-voice-overlay').props.style)).toMatchObject({ bottom: 0, height: 45 });
  expect(tree.root.findAllByType(Text)).toHaveLength(0);
});

test('accessible tap recording keeps accurate end-button instructions', async () => {
  const tree = await render({ holding: false, cancelled: true });
  expect(node(tree, 'chat-voice-hint').props.children).toBe('点击结束转文字');
  expect(node(tree, 'chat-voice-overlay-title').props.children).toBe('正在聆听');
});

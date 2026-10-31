import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatVoiceOverlay } from '../src/ui/ChatVoiceOverlay';
import { chatAppearance } from '../src/ui/ChatAppearance';
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees=new Set<ReactTestRenderer>();
afterEach(async () => { await act(async () => trees.forEach(tree => tree.unmount())); trees.clear(); });
async function render(extra: Partial<React.ComponentProps<typeof ChatVoiceOverlay>>={}) {
  let tree!:ReactTestRenderer;
  await act(async () => { tree=create(<ChatVoiceOverlay seconds={9} cancelled={false} holding={true} bottom={88} availableHeight={300} fontScale={1} reducedMotion={true} {...extra} />); });
  trees.add(tree); return tree;
}
test('listening overlay is above measured composer and never receives held gestures', async () => {
  const tree=await render();
  const overlay=tree.root.findAllByType(View).find(node=>node.props.testID==='chat-voice-overlay')!;
  expect(overlay.props.pointerEvents).toBe('none');
  expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(StyleSheet.flatten(overlay.props.style)).toMatchObject({ bottom:88,height:230,position:'absolute' });
  const title=tree.root.findAllByType(Text).find(node=>node.props.testID==='chat-voice-overlay-title')!;
  expect(title.props.children.join('')).toContain('正在聆听');
  expect(title.props.children.join('')).toContain('00:09');
  expect(StyleSheet.flatten(title.props.style).color).toBe(chatAppearance.ink);
});
test('real cancellation feedback uses the approved dark rose text and no waveform', async () => {
  const tree=await render({ cancelled:true });
  const title=tree.root.findAllByType(Text).find(node=>node.props.testID==='chat-voice-overlay-title')!;
  expect(title.props.children.join('')).toContain('松开取消');
  expect(StyleSheet.flatten(title.props.style).color).toBe(chatAppearance.cancellationText);
  expect(JSON.stringify(tree.toJSON())).not.toContain('waveform');
});
test('small viewport with fontScale2 omits optional orb/caption without clipping the main feedback', async () => {
  const tree=await render({ availableHeight:110,fontScale:2 });
  const overlay=tree.root.findAllByType(View).find(node=>node.props.testID==='chat-voice-overlay')!;
  expect(StyleSheet.flatten(overlay.props.style).height).toBe(110);
  const text=tree.root.findAllByType(Text);
  expect(text).toHaveLength(1);
  expect(text[0].props.children.join('')).toContain('正在聆听');
});
test('insufficient viewport omits decorative overlay while the caller keeps its composer controls', async () => {
  const tree=await render({ availableHeight:45,fontScale:2 });
  expect(tree.toJSON()).toBeNull();
});

test('tap recording uses end-button instructions instead of hold-release instructions', async () => {
  const tree=await render({ holding:false, cancelled:true });
  const text=tree.root.findAllByType(Text).map(node=>node.props.children).join(' ');
  expect(text).toContain('点击结束转文字');
  expect(text).not.toContain('这段录音不会发送');
  expect(text).not.toContain('松开转文字，上滑取消');
});

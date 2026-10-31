import React from 'react';
import { AccessibilityInfo, Animated, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatModeMotion, ChatRecordingMotion, useChatReducedMotion } from '../src/ui/ChatMotion';

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
afterEach(async () => { await act(async () => { trees.forEach(t => t.unmount()); }); trees.clear(); jest.restoreAllMocks(); });
async function mount(content: React.ReactElement) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(content); }); trees.add(tree); return tree;
}
function animations() {
  const running: Array<{ start: jest.Mock; stop: jest.Mock; reset: jest.Mock }> = [];
  const spy = jest.spyOn(Animated, 'timing').mockImplementation(() => {
    const animation = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    running.push(animation); return animation;
  });
  return { spy, running };
}

test('mode changes animate once with bounded native-only opacity/transform and preserve the input node', async () => {
  const { spy, running } = animations();
  const content = (mode: 'text'|'voice') => <ChatModeMotion mode={mode} reducedMotion={false}><TextInput value="unchanged draft" /></ChatModeMotion>;
  const tree = await mount(content('text')); const input = tree.root.findByType(TextInput);
  expect(spy).not.toHaveBeenCalled();
  await act(async () => tree.update(content('voice')));
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]).toMatchObject({ duration:220, useNativeDriver:true, isInteraction:false, toValue:1 });
  expect(running[0].start).toHaveBeenCalledWith();
  expect(tree.root.findByType(TextInput)).toBe(input);
  expect(input.props.value).toBe('unchanged draft');
  await act(async () => tree.update(content('voice')));
  expect(spy).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(content('text')));
  expect(running[0].stop).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(running[1].stop).toHaveBeenCalledTimes(1);
});

test.each([null,true])('unresolved/reduced preference %s leaves transitions static and late enabling does not replay', async reduced => {
  const { spy }=animations();
  const content = (mode:'text'|'voice', preference:boolean|null) => <ChatModeMotion mode={mode} reducedMotion={preference}><Text>Ready</Text></ChatModeMotion>;
  const tree=await mount(content('text',reduced));
  await act(async () => tree.update(content('voice',reduced)));
  await act(async () => tree.update(content('voice',false)));
  expect(spy).not.toHaveBeenCalled();
  await act(async () => tree.update(content('text',false)));
  expect(spy).toHaveBeenCalledTimes(1);
});

test('recording panel entrance is bounded, native-only and unmount stops it immediately', async () => {
  const { spy,running }=animations();
  const tree=await mount(<ChatRecordingMotion reducedMotion={false}><Text>Actual recorder state</Text></ChatRecordingMotion>);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]).toMatchObject({ duration:220,useNativeDriver:true,isInteraction:false });
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(running[0].stop).toHaveBeenCalledTimes(1);
});

test('reduce-motion listener wins over an earlier asynchronous preference query and is removed on unmount', async () => {
  let resolve!: (value:boolean)=>void; let update!: (value:boolean)=>void;
  const remove=jest.fn();
  jest.spyOn(AccessibilityInfo,'isReduceMotionEnabled').mockImplementation(() => new Promise(r => { resolve=r; }));
  (jest.spyOn(AccessibilityInfo,'addEventListener') as unknown as jest.Mock).mockImplementation((name:string,listener:(value:boolean)=>void) => {
    expect(name).toBe('reduceMotionChanged'); update=listener as (value:boolean)=>void; return { remove };
  });
  function Preference() { return <Text testID="preference">{String(useChatReducedMotion())}</Text>; }
  const tree=await mount(<Preference />);
  expect(tree.root.findByType(Text).props.children).toBe('null');
  await act(async () => update(true));
  await act(async () => resolve(false));
  expect(tree.root.findByType(Text).props.children).toBe('true');
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(remove).toHaveBeenCalledTimes(1);
  await act(async () => update(false));
});

test('new reduced-motion preference stops a running mode transition without replaying when re-enabled', async () => {
  const { spy,running }=animations();
  const content=(mode:'text'|'voice', reducedMotion:boolean)=> <ChatModeMotion mode={mode} reducedMotion={reducedMotion}><Text>Ready</Text></ChatModeMotion>;
  const tree=await mount(content('text',false));
  await act(async () => tree.update(content('voice',false)));
  await act(async () => tree.update(content('voice',true)));
  expect(running[0].stop).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(content('voice',false)));
  expect(spy).toHaveBeenCalledTimes(1);
});

test('a failed preference query remains conservative and removes its event listener', async () => {
  const remove=jest.fn();
  jest.spyOn(AccessibilityInfo,'isReduceMotionEnabled').mockRejectedValue(new Error('adapter unavailable'));
  (jest.spyOn(AccessibilityInfo,'addEventListener') as unknown as jest.Mock).mockReturnValue({ remove });
  function Preference() { return <Text>{String(useChatReducedMotion())}</Text>; }
  const tree=await mount(<Preference />);
  expect(tree.root.findByType(Text).props.children).toBe('null');
  await act(async () => tree.unmount()); trees.delete(tree);
  expect(remove).toHaveBeenCalledTimes(1);
});

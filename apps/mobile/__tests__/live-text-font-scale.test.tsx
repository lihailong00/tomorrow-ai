import React, { useState } from 'react';
import { Dimensions, Platform, Text as NativeText, TextInput, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Text } from '../src/ui/Text';
import { createFontScaleStore } from '../src/ui/systemFontScale';

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
const originalOS = Platform.OS;
const initialDimensions = Dimensions.get('window');

async function setDimensions(fontScale: number, width = 360) {
  await act(async () => Dimensions.set({
    window: { width, height: 640, scale: 2.75, fontScale },
  }));
}
async function render(children: React.ReactElement) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(children); });
  trees.add(tree);
  return tree;
}
beforeEach(async () => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  await setDimensions(1);
});
afterEach(async () => {
  await act(async () => { trees.forEach(tree => tree.unmount()); });
  trees.clear();
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS });
  await act(async () => Dimensions.set({ window: initialDimensions }));
  jest.restoreAllMocks();
});

test('live 1→2→1 replaces native text paragraphs without remounting the screen or editable draft', async () => {
  const mounted = jest.fn();
  function Screen() {
    const [draft, setDraft] = useState('keep this draft');
    React.useEffect(() => { mounted(); }, []);
    return <View>
      <Text testID="heading">Readable heading</Text>
      <TextInput value={draft} onChangeText={setDraft} />
    </View>;
  }
  const tree = await render(<Screen />);
  const input = tree.root.findByType(TextInput).instance;
  const first = tree.root.findByType(NativeText).instance;
  await act(async () => tree.root.findByType(TextInput).props.onChangeText('edited six-line draft'));
  await setDimensions(2);
  const second = tree.root.findByType(NativeText).instance;
  expect(second).not.toBe(first);
  expect(tree.root.findByType(TextInput).instance).toBe(input);
  expect(tree.root.findByType(TextInput).props.value).toBe('edited six-line draft');
  await setDimensions(1);
  expect(tree.root.findByType(NativeText).instance).not.toBe(second);
  expect(tree.root.findByType(TextInput).instance).toBe(input);
  expect(tree.root.findByType(TextInput).props.value).toBe('edited six-line draft');
  expect(mounted).toHaveBeenCalledTimes(1);
});

test('rotation and unchanged scale leave the native paragraph and forwarded ref intact', async () => {
  const ref = React.createRef<React.ElementRef<typeof NativeText>>();
  const onPress = jest.fn();
  const style = { fontSize: 17, lineHeight: 25 };
  const tree = await render(<Text ref={ref} testID="readable" style={style}
    accessibilityLabel="Read this" selectable numberOfLines={2} onPress={onPress}>Agjpqy</Text>);
  const native = tree.root.findByType(NativeText).instance;
  expect(ref.current).toBe(native);
  expect(tree.root.findByType(NativeText).props).toMatchObject({
    testID: 'readable', style, accessibilityLabel: 'Read this', selectable: true,
    numberOfLines: 2, onPress, children: 'Agjpqy',
  });
  await setDimensions(1, 640);
  expect(tree.root.findByType(NativeText).instance).toBe(native);
  expect(ref.current).toBe(native);
  await setDimensions(2, 640);
  expect(ref.current).toBe(tree.root.findByType(NativeText).instance);
  expect(ref.current).not.toBe(native);
});

test.each([0, -1, NaN, Infinity])('invalid scale %s does not replace text with invalid font metrics', async value => {
  const tree = await render(<Text>Stable text</Text>);
  const native = tree.root.findByType(NativeText).instance;
  await setDimensions(value);
  expect(tree.root.findByType(NativeText).instance).toBe(native);
});

test('nested text keeps children and explicit font-scaling choices', async () => {
  const tree = await render(<Text testID="parent">Prefix <Text testID="child" allowFontScaling={false}
    maxFontSizeMultiplier={1.4}>Nested link</Text></Text>);
  const initialParent = tree.root.findAllByType(NativeText).find(node => node.props.testID === 'parent')!;
  expect(initialParent.props.children[1].type).toBe(Text);
  await setDimensions(2);
  const nested = tree.root.findAllByType(NativeText).find(node => node.props.testID === 'child')!;
  expect(nested.props).toMatchObject({ allowFontScaling: false, maxFontSizeMultiplier: 1.4, children: 'Nested link' });
});

test('one Dimensions listener is shared, removed at last unmount and catches missed changes on remount', async () => {
  const add = jest.spyOn(Dimensions, 'addEventListener');
  const tree = await render(<View><Text>First</Text><Text>Second</Text><Text>Third</Text></View>);
  expect(add).toHaveBeenCalledTimes(1);
  const remove = jest.spyOn(add.mock.results[0].value, 'remove');
  await act(async () => tree.unmount());
  trees.delete(tree);
  expect(remove).toHaveBeenCalledTimes(1);
  await setDimensions(2);
  const next = await render(<Text>New screen</Text>);
  const native = next.root.findByType(NativeText).instance;
  await setDimensions(2);
  expect(next.root.findByType(NativeText).instance).toBe(native);
  await setDimensions(1);
  expect(next.root.findByType(NativeText).instance).not.toBe(native);
  expect(add).toHaveBeenCalledTimes(2);
});

test.each(['ios', 'harmony'] as const)('%s keeps the existing native text identity during scale changes', async os => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: os });
  const tree = await render(<Text allowFontScaling maxFontSizeMultiplier={2.5}>Native platform text</Text>);
  const native = tree.root.findByType(NativeText).instance;
  await setDimensions(2);
  expect(tree.root.findByType(NativeText).instance).toBe(native);
  expect(tree.root.findByType(NativeText).props).toMatchObject({ allowFontScaling: true, maxFontSizeMultiplier: 2.5 });
});

test('reentrant text subscription changes cannot extend an in-flight font notification', () => {
  let value = 1;
  let signal!: (scale: number) => void;
  const disconnect = jest.fn();
  const store = createFontScaleStore({
    current: () => value,
    subscribe: listener => { signal = listener; return disconnect; },
  });
  const fresh = jest.fn();
  const removed = jest.fn();
  let removeSecond = () => {};
  let removeFresh = () => {};
  const first = jest.fn(() => {
    removeSecond();
    removeFresh = store.subscribe(fresh);
  });
  const removeFirst = store.subscribe(first);
  removeSecond = store.subscribe(removed);
  value = 2;
  signal(value);
  expect(first).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
  expect(fresh).not.toHaveBeenCalled();
  expect(store.getSnapshot()).toBe(2);
  // The replacement listener participates in the next event, never this one.
  value = 1;
  signal(value);
  expect(first).toHaveBeenCalledTimes(2);
  expect(fresh).toHaveBeenCalledTimes(1);
  removeFirst();
  removeFresh();
  expect(disconnect).toHaveBeenCalledTimes(1);
});

import React from 'react';
import { Dimensions, Text } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import type { Message } from '../src/domain/types';
import type { FlashList as EngineDouble } from '../test/flashListMock';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import { createMessageViewport, messageAnchorAt, messageAnchorInset,
  messageInitialIndex, messageRowKey, MessageViewport } from '../src/screens/messageListLayout';

jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
const dimensions = (width = 360, height = 640, fontScale = 1) =>
  Dimensions.set({ window: { width, height, fontScale, scale: 2.75 } });
beforeEach(() => dimensions());
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees.clear();
});
const message = (index: number): Message => ({ id: `message-${index}`,
  conversation_id: 'retained-chat', role: 'user', content: `Message ${index}`,
  created_at: new Date(index * 1000).toISOString() });
const allMessages = () => Array.from({ length: 1004 }, (_, index) => message(index));
const layoutEvent = (width = 360, height = 640) => ({
  nativeEvent: { layout: { x: 0, y: 0, width, height } },
});

async function setup(initial = allMessages(), anchor: { id: string; offset: number } | null = null,
  savedViewport?: MessageViewport, initialVersion = 0) {
  let messages = initial;
  let viewport = savedViewport ?? createMessageViewport();
  if (!savedViewport) viewport.anchor = anchor;
  let latestVersion = initialVersion;
  let header = <Text testID="history">Load older</Text>;
  let footer = <Text testID="tail">Tail spacing</Text>;
  const rowRender = jest.fn((item: Message) =>
    <Text testID={`row-${messageRowKey(item)}`}>{item.content}</Text>);
  const Row = React.memo(({ item }: { item: Message }) => rowRender(item));
  const renderItem = jest.fn(({ item }: { item: Message }) => <Row item={item} />);
  const render = () => <ChatMessageList messages={messages} viewport={viewport}
    latestVersion={latestVersion} hasOlder={header.props.children === 'Load older'}
    renderItem={renderItem} header={header} footer={footer}
    style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} />;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  trees.add(tree);
  const list = () => tree.root.findByType(FlashList);
  const engine = () => list().instance as EngineDouble<Message>;
  let width = 360, height = 640, contentHeight = 121000;
  const packet = (y: number) => ({ nativeEvent: {
    contentOffset: { x: 0, y }, contentSize: { width, height: contentHeight },
    layoutMeasurement: { width, height }, zoomScale: 1 }, timeStamp: Date.now() });
  return {
    tree, list, engine, rowRender, renderItem,
    get viewport() { return viewport; },
    rows: () => tree.root.findAllByType(Text).filter(row => row.props.testID?.startsWith('row-')),
    async bounds(nextWidth = width, nextHeight = height, content = contentHeight) {
      width = nextWidth; height = nextHeight; contentHeight = content;
      await act(async () => {
        list().props.onLayout(layoutEvent(width, height));
        list().props.onContentSizeChange(width, contentHeight);
      });
    },
    measure(id: string, y: number, rowHeight: number, measured = true) {
      const index = list().props.data.findIndex((item: Message) => messageRowKey(item) === id);
      engine().layouts.set(index, { x: 0, y, width, height: rowHeight,
        isHeightMeasured: measured, isWidthMeasured: measured });
      return index;
    },
    async commit() { await act(async () => list().props.onCommitLayoutEffect()); },
    async native(y: number, user = false) {
      const indices = [...engine().layouts].filter(([, row]) =>
        row.y + engine().firstItemOffset + row.height > y &&
        row.y + engine().firstItemOffset < y + height).map(([index]) => index);
      engine().visible = { startIndex: Math.min(...indices), endIndex: Math.max(...indices) };
      engine().nativeOffset = y;
      await act(async () => {
        if (user) list().props.onScrollBeginDrag(packet(y));
        list().props.onScroll(packet(y));
      });
    },
    async end(y: number) { await act(async () => list().props.onScrollEndDrag(packet(y))); },
    async update(next = messages, version = latestVersion) {
      messages = next; latestVersion = version;
      await act(async () => tree.update(render()));
    },
    async history(next: Message[], final = false) {
      messages = next;
      header = final ? <Text testID="history">All loaded</Text> : header;
      await act(async () => tree.update(render()));
    },
    async footer() { footer = <Text>Voice/draft footer changed</Text>;
      await act(async () => tree.update(render())); },
    async owner() { const old = viewport; viewport = createMessageViewport();
      await act(async () => tree.update(render())); return old; },
  };
}

async function pendingAppend() {
  const old = { ...message(1), role: 'assistant' as const, content: 'Original' };
  const data = [message(0), old];
  const app = await setup(data);
  await app.bounds(); app.measure(old.id, 0, 900); app.measure('message-0', 900, 900);
  await app.native(400, true); await app.end(400);
  const grown = [data[0], { ...old, content: 'Original plus a real streamed fragment' }];
  await app.update(grown);
  app.measure(old.id, 0, 1200); app.measure('message-0', 1200, 900); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 700, animated: false });
  return { app, grown };
}

test('append growth retains translated reading intent through History before acknowledgment and a second detach', async () => {
  const { app, grown } = await pendingAppend();
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-1', offset: 676 });
  expect(viewport.pendingAppendAnchor).toEqual(viewport.anchor);
  const returned = await setup(grown, null, viewport);
  expect(returned.list().props.initialScrollIndexParams).toEqual({ viewOffset: 676 });
  await returned.bounds(); returned.measure('message-1', 0, 1200); await returned.commit();
  expect(returned.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 700, animated: false });
  await act(async () => returned.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-1', offset: 676 });
  expect(viewport.pendingAppendAnchor).toEqual(viewport.anchor);
});

test.each([400, 1400])('wrong current-geometry native Y%i cannot replace pending append intent on History detach', async y => {
  const { app } = await pendingAppend();
  await app.native(y);
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-1', offset: 676 });
  expect(viewport.pendingAppendAnchor).toEqual(viewport.anchor);
});

test('a genuine gesture cancels pending append protection and History saves the actual different row', async () => {
  const { app } = await pendingAppend();
  await app.native(1400, true); await app.end(1400);
  const viewport = app.viewport;
  expect(viewport.pendingAppendAnchor).toBeNull();
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-0', offset: 176 });
});

test('real matching measured acknowledgment clears append protection and later AX movement saves actual intent', async () => {
  const { app } = await pendingAppend();
  await app.native(700);
  expect(app.viewport.pendingAppendAnchor).toBeNull();
  expect(app.viewport.anchor).toEqual({ id: 'message-1', offset: 676 });
  await app.native(1400);
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-0', offset: 176 });
});

test('own send replaces pending append protection with latest intent before History detach', async () => {
  const { app, grown } = await pendingAppend();
  await app.update(grown, 1);
  const viewport = app.viewport;
  expect(viewport.pendingAppendAnchor).toBeNull();
  expect(viewport.followTail).toBe(true);
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toBeNull();
});

test('removing a pending append row clears its protection and lets actual remaining rows become the anchor', async () => {
  const { app, grown } = await pendingAppend();
  await app.update([grown[0]]);
  expect(app.viewport.pendingAppendAnchor).toBeNull();
  app.measure('message-0', 0, 900); await app.native(200);
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 176 });
});

test('geometry during pending append remeasures its target without retiring protection on a wrong packet', async () => {
  const { app } = await pendingAppend();
  await act(async () => dimensions(640, 640, 2));
  expect(app.viewport.pendingAppendAnchor).toEqual({ id: 'message-1', offset: 676 });
  await app.bounds(640); app.measure('message-1', 1000, 1400); app.measure('message-0', 2400, 900);
  await app.commit(); await app.native(2600);
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-1', offset: 676 });
  expect(viewport.pendingAppendAnchor).toEqual(viewport.anchor);
});

test('a legal measured end clamp acknowledges and clears pending append protection', async () => {
  const { app } = await pendingAppend();
  await app.bounds(360, 2000, 2150);
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 150, animated: false });
  await app.native(150);
  expect(app.viewport.pendingAppendAnchor).toBeNull();
  expect(app.viewport.anchor).toEqual({ id: 'message-1', offset: 126 });
});

test('an old account callback cannot retire its pending append or replace the new account intent', async () => {
  const { app } = await pendingAppend();
  const callbacks = app.list().props;
  const previous = await app.owner();
  await act(async () => {
    callbacks.onScrollBeginDrag();
    callbacks.onScroll({ nativeEvent: { contentOffset: { y: 700 } } });
    callbacks.onMomentumScrollEnd();
  });
  expect(previous.pendingAppendAnchor).toEqual({ id: 'message-1', offset: 676 });
  expect(previous.anchor).toEqual(previous.pendingAppendAnchor);
  expect(app.viewport.pendingAppendAnchor).toBeNull();
  expect(app.viewport.anchor).toBeNull();
});

test.each([0, 502, 1003])('History Back delegates deep index %i and signed inset to FlashList', async index => {
  const messages = allMessages();
  const app = await setup(messages, { id: messages[index].id, offset: -53 });
  expect(app.list().props.data).toEqual(messages.slice().reverse());
  expect(app.list().props.initialScrollIndex).toBe(1003 - index);
  expect(app.list().props.initialScrollIndexParams).toEqual({ viewOffset: -53 });
  expect(app.list().props.inverted).toBe(true);
  expect(app.list().props.maintainVisibleContentPosition).toEqual({ disabled: false, startRenderingFromBottom: true });
  expect(app.list().props.renderScrollComponent).toBeUndefined();
  expect(app.list().props.getItemLayout).toBeUndefined();
  expect(app.list().props.estimatedItemSize).toBeUndefined();
});

test('retained row waits for measured height; neither an estimate nor a resolved index Promise proves arrival', async () => {
  const saved = { id: 'message-6', offset: -587 };
  const app = await setup(allMessages(), saved);
  await app.bounds();
  app.measure(saved.id, 6000, 900, false);
  await app.commit();
  await app.native(5437);
  await app.native(5437);
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  expect(app.viewport.anchor).toEqual(saved);
  app.measure(saved.id, 6000, 900);
  await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 5437, animated: false });
  expect(app.engine().scrollToIndex).not.toHaveBeenCalled();
  // A command alone cannot replace this saved row, even after arbitrary time.
  await app.native(851);
  expect(app.viewport.anchor).toEqual(saved);
  await app.native(5437);
  expect(app.viewport.y).toBe(5437);
  expect(app.viewport.anchor).toEqual(saved);
});

test('a measured bottom-partial target keeps its exact 53px overlap through mixed neighbors', async () => {
  const app = await setup(allMessages(), { id: 'message-6', offset: -587 });
  await app.bounds();
  app.measure('message-7', 5000, 1000);
  app.measure('message-6', 6000, 900);
  await app.commit();
  await app.native(5437);
  expect(Math.min(5437 + 640, 24 + 6000 + 900) - Math.max(5437, 24 + 6000)).toBe(53);
  expect(app.viewport.anchor).toEqual({ id: 'message-6', offset: -587 });
});

test('a render before native text remeasurement cannot consume a later real streaming height increase', async () => {
  const old = { ...message(0), role: 'assistant' as const, content: 'Original' };
  const app = await setup([old]);
  await app.bounds(); app.measure(old.id, 0, 900); await app.native(400, true); await app.end(400);
  await app.update([{ ...old, content: 'Original with a real appended fragment' }]);
  // The list may commit changed data while its old measurement is still valid.
  await app.commit(); await app.native(400);
  expect(app.viewport.heights.get(old.id)?.message).toBe(old);
  app.measure(old.id, 0, 1200); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 700, animated: false });
});

test('History detach during pending restoration captures the actually visible measured row', async () => {
  const app = await setup(allMessages(), { id: 'message-6', offset: 175 });
  await app.bounds(); app.measure('message-6', 6000, 900); await app.commit();
  app.measure('message-50', 3000, 900);
  await app.native(3200);
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  expect(viewport.anchor).toEqual({ id: 'message-50', offset: 176 });
  expect(viewport.followTail).toBe(false);
});

test.each([
  ['scroll', false], ['end-drag', false], ['momentum-end', true], ['AX', true],
] as const)('%s saves measured636 for History when scroll content size precedes its callback (late callback=%s)', async (kind, lateCallback) => {
  const data = allMessages();
  const app = await setup(data);
  await app.bounds();
  app.measure('message-347', 60000, 900);
  await app.native(60200, true); await app.end(60200);
  expect(app.viewport.anchor).toEqual({ id: 'message-347', offset: 176 });
  const index = app.measure('message-636', 30000, 900);
  // FlashList has processed this actual offset before its public callback.
  // Progressive total-size notification is independent of that callback.
  app.engine().visible = { startIndex: index, endIndex: index };
  app.engine().nativeOffset = 30200;
  const packet = { nativeEvent: {
    contentOffset: { x: 0, y: 30200 }, contentSize: { width: 360, height: 121733 },
    layoutMeasurement: { width: 360, height: 640 }, zoomScale: 1,
  }, timeStamp: Date.now() };
  await act(async () => {
    if (kind === 'scroll') app.list().props.onScroll(packet);
    if (kind === 'end-drag') app.list().props.onScrollEndDrag(packet);
    if (kind === 'momentum-end') app.list().props.onMomentumScrollEnd(packet);
    if (kind === 'AX') app.list().props.onScroll(packet);
    if (lateCallback) app.list().props.onContentSizeChange(360, 121733);
  });
  const viewport = app.viewport;
  await act(async () => app.tree.unmount());
  const returned = await setup(data, null, viewport);
  expect(returned.list().props.initialScrollIndex).toBe(1003 - 636);
  expect(viewport.anchor).toEqual({ id: 'message-636', offset: 176 });
  expect(returned.list().props.initialScrollIndexParams).toEqual({ viewOffset: 176 });
  expect(viewport.followTail).toBe(false);
});

test('a pending programmatic append target still needs a matching content-size native acknowledgment', async () => {
  const { app } = await pendingAppend();
  const engine = app.engine();
  engine.visible = { startIndex: 0, endIndex: 0 };
  engine.nativeOffset = 700;
  await act(async () => app.list().props.onScroll({ nativeEvent: {
    contentOffset: { x: 0, y: 700 }, contentSize: { width: 360, height: 121733 },
    layoutMeasurement: { width: 360, height: 640 }, zoomScale: 1,
  } }));
  expect(app.viewport.pendingAppendAnchor).toEqual({ id: 'message-1', offset: 676 });
  // A size notification or the engine's projected offset is not a new native
  // arrival packet. Only the later matching real callback clears protection.
  await app.bounds(360, 640, 121733);
  expect(app.viewport.pendingAppendAnchor).toEqual({ id: 'message-1', offset: 676 });
  await app.native(700);
  expect(app.viewport.pendingAppendAnchor).toBeNull();
});

test.each(['unmeasured', 'foreign-viewport'] as const)('ordinary capture still rejects %s row evidence while content size changes', async reason => {
  const app = await setup();
  await app.bounds(); app.measure('message-347', 60000, 900);
  await app.native(60200, true); await app.end(60200);
  const index = app.measure('message-636', 30000, 900, reason !== 'unmeasured');
  app.engine().visible = { startIndex: index, endIndex: index };
  await act(async () => app.list().props.onScroll({ nativeEvent: {
    contentOffset: { x: 0, y: 30200 }, contentSize: { width: 360, height: 121733 },
    layoutMeasurement: { width: 360, height: reason === 'foreign-viewport' ? 360 : 640 }, zoomScale: 1,
  } }));
  expect(app.viewport.anchor).toEqual({ id: 'message-347', offset: 176 });
});

test('latest follows actual streamed height changes until the user reads older text', async () => {
  const data = [message(0), { ...message(1), role: 'assistant' as const, content: 'First' }];
  const app = await setup(data);
  await app.bounds(); app.measure('message-1', 0, 900);
  await app.commit(); await app.native(0);
  expect(app.viewport.followTail).toBe(true);
  await app.update([data[0], { ...data[1], content: 'First real fragment' }]);
  app.measure('message-1', 0, 1200); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  await app.native(400, true); await app.end(400);
  app.engine().scrollToOffset.mockClear();
  await app.update([data[0], { ...data[1], content: 'First real fragment grows' }]);
  app.measure('message-1', 0, 1400); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 600, animated: false });
  expect(app.viewport.followTail).toBe(false);
  await app.native(600);
  expect(app.viewport.anchor).toEqual({ id: 'message-1', offset: 576 });
});

test('streaming a different row while reading leaves MVCP in charge without a second offset correction', async () => {
  const data = [message(0), { ...message(1), role: 'assistant' as const }];
  const app = await setup(data);
  await app.bounds(); app.measure('message-0', 900, 900);
  await app.native(1100, true); await app.end(1100);
  await app.commit(); app.engine().scrollToOffset.mockClear();
  await app.update([data[0], { ...data[1], content: 'A real partial reply' }]);
  app.measure('message-0', 1100, 900); await app.commit();
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
});

test('own send retires the old reading window and starts a coherent latest window', async () => {
  const data = [message(0), message(1)];
  const app = await setup(data, { id: 'message-0', offset: 15 });
  await app.bounds(); app.measure('message-0', 900, 900); await app.commit();
  await app.native(939);
  const engine = app.engine(); const heights = app.viewport.heights;
  const callbacks = app.list().props;
  await app.update([...data, message(2)], 1);
  expect(app.engine() === engine).toBe(false);
  expect(app.list().props.initialScrollIndex).toBe(0);
  expect(app.viewport.anchor).toBeNull();
  expect(app.viewport.followTail).toBe(true);
  expect(app.viewport.heights).toBe(heights);
  expect(heights.get('message-0')?.height).toBe(900);
  await act(async () => {
    callbacks.onScrollBeginDrag(); callbacks.onContentSizeChange(360, 100);
    callbacks.onCommitLayoutEffect();
  });
  expect(app.viewport.anchor).toBeNull();
  expect(app.viewport.followTail).toBe(true);
  await app.bounds(); app.measure('message-2', 0, 88); await app.native(0);
  expect(app.viewport.anchor?.id).toBe('message-2');
});

test('retired own-send geometry and scroll callbacks cannot overwrite a newer window', async () => {
  const old = { ...message(0), role: 'assistant' as const };
  const app = await setup([old]);
  await app.bounds(360, 640, 924); app.measure(old.id, 0, 900); await app.native(0);
  const user = { ...message(1), delivery: 'sending' as const };
  const assistant = { ...message(2), role: 'assistant' as const, content: '', stream_status: '发送中…' };
  const retired = app.list().props;
  await app.update([old, user, assistant], 1);
  app.measure(assistant.id, 0, 88); app.measure(user.id, 88, 88); app.measure(old.id, 176, 900);
  await app.bounds(360, 640, 1100); await app.native(0);
  const latest = { ...app.viewport.anchor! };
  await act(async () => {
    retired.onContentSizeChange(360, 924);
    retired.onScroll({ nativeEvent: { contentOffset: { y: 176 },
      contentSize: { height: 924 }, layoutMeasurement: { width: 360, height: 640 } } });
    retired.onCommitLayoutEffect();
  });
  // A measured live reply retains its reading location, including at native zero.
  expect(app.viewport.followTail).toBe(false);
  expect(app.viewport.anchor).toEqual(latest);
});

test('a real reading gesture cancels pending local-send layout intent before streaming continues', async () => {
  const old = { ...message(0), role: 'assistant' as const };
  const app = await setup([old]);
  await app.bounds(360, 640, 924); app.measure(old.id, 0, 900); await app.native(0);
  const user = message(1);
  const assistant = { ...message(2), role: 'assistant' as const, content: '', stream_status: '发送中…' };
  await app.update([old, user, assistant], 1);
  app.measure(assistant.id, 0, 88); app.measure(user.id, 88, 88); app.measure(old.id, 176, 900);
  await app.bounds(360, 640, 1100);
  await app.native(400, true); await app.end(400);
  const reading = { ...app.viewport.anchor! };
  app.engine().scrollToOffset.mockClear();
  await app.bounds(360, 640, 1100);
  await app.update([old, user, { ...assistant, content: 'A real streamed fragment' }]);
  app.measure(assistant.id, 0, 188); app.measure(user.id, 188, 88); app.measure(old.id, 276, 900);
  await app.commit();
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  expect(app.viewport.followTail).toBe(false);
  expect(app.viewport.anchor).toEqual(reading);
});

test('a gesture before the new send window first lays out cancels pending latest work', async () => {
  const old = { ...message(0), role: 'assistant' as const };
  const app = await setup([old]);
  await app.bounds(360, 640, 924); app.measure(old.id, 0, 900); await app.native(0);
  const user = message(1);
  const assistant = { ...message(2), role: 'assistant' as const, content: '' };
  await app.update([old, user, assistant], 1);
  await act(async () => app.list().props.onScrollBeginDrag());
  app.engine().scrollToOffset.mockClear();
  app.measure(assistant.id, 0, 88); app.measure(user.id, 88, 88); app.measure(old.id, 176, 900);
  await app.bounds(360, 640, 1100); await app.commit();
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  expect(app.engine().scrollToIndex).not.toHaveBeenCalled();
  await app.native(400, true); await app.end(400);
  const reading = { ...app.viewport.anchor! };
  app.engine().scrollToOffset.mockClear();
  await app.update([old, user, { ...assistant, content: 'A partial while reading older text' }]);
  app.measure(assistant.id, 0, 188); app.measure(user.id, 188, 88); app.measure(old.id, 276, 900);
  await app.bounds(360, 640, 1200); await app.native(500);
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  expect(app.viewport.followTail).toBe(false);
  expect(app.viewport.anchor).toEqual(reading);
});

test('rapid consecutive sends fence every retired owner without clearing measured history', async () => {
  const app = await setup([message(0)]);
  await app.bounds(); app.measure('message-0', 0, 900); await app.native(400, true); await app.end(400);
  const first = app.list().props;
  await app.update([message(0), message(1)], 1);
  const second = app.list().props;
  const retiredEngine = app.engine();
  await app.update([message(0), message(1), message(2)], 3);
  expect(app.engine() === retiredEngine).toBe(false);
  await act(async () => [first, second].forEach(callbacks => {
    callbacks.onScrollBeginDrag(); callbacks.onMomentumScrollEnd();
    callbacks.onContentSizeChange(360, 100); callbacks.onCommitLayoutEffect();
  }));
  expect(app.viewport.followTail).toBe(true);
  expect(app.viewport.anchor).toBeNull();
  expect(app.viewport.heights.get('message-0')?.height).toBe(900);
  await app.bounds(); app.measure('message-2', 0, 88); await app.native(0);
  expect(app.viewport.anchor?.id).toBe('message-2');
});

test('History reopening at a nonzero send version retains its actual saved reading anchor', async () => {
  const app = await setup([message(0)], { id: 'message-0', offset: 175 }, undefined, 7);
  await app.bounds(); app.measure('message-0', 0, 900); await app.commit(); await app.native(199);
  const saved = app.viewport;
  await act(async () => app.tree.unmount());
  const returned = await setup([message(0)], null, saved, 7);
  expect(returned.list().props.initialScrollIndexParams).toEqual({ viewOffset: 175 });
  expect(saved.anchor).toEqual({ id: 'message-0', offset: 175 });
  expect(saved.followTail).toBe(false);
});

test.each(['drag', 'momentum', 'end-drag'])('%s immediately cancels a pending retained destination', async interaction => {
  const app = await setup(allMessages(), { id: 'message-6', offset: 175 });
  await app.bounds(); app.measure('message-6', 6000, 900); await app.commit();
  const callbacks: Record<string, string> = { drag: 'onScrollBeginDrag', momentum: 'onMomentumScrollBegin', 'end-drag': 'onScrollEndDrag' };
  await act(async () => app.list().props[callbacks[interaction]]());
  app.engine().scrollToOffset.mockClear();
  app.measure('message-6', 6200, 900); await app.commit();
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  await app.native(6400);
  expect(app.viewport.anchor).toEqual({ id: 'message-6', offset: 176 });
});

test('drag and momentum own same-row streaming reflow until momentum ends', async () => {
  const old = { ...message(1), role: 'assistant' as const, content: 'Old text' };
  const app = await setup([old]);
  await app.bounds(); app.measure(old.id, 0, 900); await app.native(400, true); await app.commit();
  await act(async () => app.list().props.onMomentumScrollBegin());
  app.engine().scrollToOffset.mockClear();
  await app.update([{ ...old, content: 'Old text plus real fragment' }]);
  app.measure(old.id, 0, 1200); await app.commit();
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
  await app.native(500);
  await act(async () => app.list().props.onMomentumScrollEnd());
  expect(app.viewport.anchor).toEqual({ id: old.id, offset: 476 });
});

test('accessibility scroll without gesture events saves actual measured reading intent after arrival', async () => {
  const app = await setup(allMessages(), { id: 'message-6', offset: 175 });
  await app.bounds(); app.measure('message-6', 6000, 900); await app.commit();
  await app.native(6199); await app.native(6350);
  expect(app.viewport.anchor).toEqual({ id: 'message-6', offset: 326 });
  expect(app.viewport.followTail).toBe(false);
});

test.each(['font', 'width'])('%s invalidates once, preserves saved ID/inset, and waits for fresh measurement', async kind => {
  const app = await setup(allMessages(), { id: 'message-6', offset: 175 });
  await app.bounds(); app.measure('message-6', 6000, 900); await app.commit(); await app.native(6199);
  const engine = app.engine(); const oldScroll = app.list().props.onScroll;
  await act(async () => dimensions(kind === 'width' ? 640 : 360, 640, kind === 'font' ? 2 : 1));
  expect(app.engine()).toBe(engine);
  expect(engine.clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(1);
  expect(engine.layouts.size).toBe(0);
  expect(app.list().props.extraData).toBe(kind === 'font' ? '360:2' : '640:1');
  engine.scrollToOffset.mockClear(); await app.commit();
  expect(engine.scrollToOffset).not.toHaveBeenCalled();
  await act(async () => oldScroll({ nativeEvent: { contentOffset: { y: 0 } } }));
  expect(app.viewport.anchor).toEqual({ id: 'message-6', offset: 175 });
  await app.bounds(kind === 'width' ? 640 : 360);
  app.measure('message-6', 9000, 1200); await app.commit();
  expect(engine.scrollToOffset).toHaveBeenLastCalledWith({ offset: 9199, animated: false });
  await app.native(9199);
  expect(app.viewport.anchor).toEqual({ id: 'message-6', offset: 175 });
  await app.footer();
  expect(engine.clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(1);
});

test('font 1 to 2 to 1 clears each geometry once while retaining the same list instance', async () => {
  const app = await setup([message(1)]); const engine = app.engine();
  await act(async () => dimensions(360, 640, 2));
  await act(async () => dimensions(360, 640, 1));
  expect(app.engine()).toBe(engine);
  expect(engine.clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(2);
});

test('a shrinking reflow clamps positive and negative insets to a visible measured row', async () => {
  const app = await setup([message(0)], { id: 'message-0', offset: 175 });
  await app.bounds(); app.measure('message-0', 6000, 50); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 6073, animated: false });
  await app.native(6073);
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 49 });
  expect(messageAnchorInset(-587, 50, 360)).toBe(-359);
});

test('viewport height changes retain the measured reading row without invalidating row heights', async () => {
  const app = await setup([message(0)], { id: 'message-0', offset: -587 });
  await app.bounds(); app.measure('message-0', 6000, 900); await app.commit(); await app.native(5437);
  await app.bounds(360, 360);
  expect(app.engine().clearLayoutCacheOnUpdate).not.toHaveBeenCalled();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 5665, animated: false });
});

test('a clamped stale native range cannot acknowledge an offscreen anchor; content expansion retries measured offset', async () => {
  const saved = { id: 'message-0', offset: 175 };
  const app = await setup([message(0)], saved);
  await app.bounds(360, 640, 900); app.measure(saved.id, 6000, 900); await app.commit();
  await app.native(260);
  expect(app.viewport.anchor).toEqual(saved);
  await app.bounds(360, 640, 9000);
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 6199, animated: false });
  await app.native(6199);
  expect(app.viewport.y).toBe(6199);
});

test('an anchored assistant appended while hidden restores its retained old-text inset from real measured height', async () => {
  const old = { ...message(0), role: 'assistant' as const, content: 'Original' };
  const app = await setup([{ ...old, content: 'Original plus fragment while hidden' }], { id: old.id, offset: 175 });
  app.viewport.heights.set(old.id, { message: old, height: 900 });
  await app.bounds(); app.measure(old.id, 6000, 1200); await app.commit();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 6499, animated: false });
});

test.each(['owner', 'unmount', 'send', 'geometry'])('late callbacks from a previous %s cannot overwrite current intent', async reason => {
  const app = await setup([message(0)], { id: 'message-0', offset: 175 });
  await app.bounds(); app.measure('message-0', 6000, 900); await app.commit(); await app.native(6199);
  const oldCallbacks = app.list().props; const previous = app.viewport;
  if (reason === 'owner') await app.owner();
  if (reason === 'unmount') await act(async () => app.tree.unmount());
  if (reason === 'send') await app.update(undefined, 1);
  if (reason === 'geometry') await act(async () => dimensions(640));
  const saved = { ...app.viewport, anchor: app.viewport.anchor && { ...app.viewport.anchor } };
  await act(async () => {
    oldCallbacks.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    oldCallbacks.onScrollBeginDrag(); oldCallbacks.onMomentumScrollEnd();
    oldCallbacks.onContentSizeChange(360, 500); oldCallbacks.onCommitLayoutEffect();
  });
  expect(app.viewport.anchor).toEqual(saved.anchor);
  expect(app.viewport.followTail).toBe(saved.followTail);
  expect(app.viewport.y).toBe(saved.y);
  if (reason === 'owner') expect(previous.anchor).toEqual({ id: 'message-0', offset: 175 });
});

test('unrelated footer/draft renders preserve memoized rows; real streaming updates only its changed object', async () => {
  const data = [message(0), message(1)]; const app = await setup(data);
  const calls = app.rowRender.mock.calls.length;
  await app.footer(); await app.update();
  expect(app.rowRender).toHaveBeenCalledTimes(calls);
  await app.update([data[0], { ...data[1], content: 'Actual fragment' }]);
  expect(app.rowRender).toHaveBeenCalledTimes(calls + 1);
  expect(app.rows().find(row => row.props.testID === 'row-message-1')?.props.children).toBe('Actual fragment');
});

test('stable optimistic keys survive canonical IDs and updated delivery/attachments in the same row', async () => {
  const optimistic = { ...message(0), client_key: 'client-0', delivery: 'sending' as const };
  const app = await setup([optimistic]); const row = app.rows()[0];
  const accepted = { ...optimistic, id: 'server-42', delivery: 'sent' as const,
    attachments: [{ upload_id: 'upload-1', name: 'report.txt', unavailable: true, mime_type: 'text/plain', size: 12 }] };
  await app.update([accepted]);
  expect(app.list().props.keyExtractor(accepted)).toBe('client-0');
  expect(app.rows()[0]).toBe(row);
  expect(app.list().props.data[0]).toBe(accepted);
});

test('all 26 pages remain in reversed stable data; final and empty-final controls retire without a synthetic spacer', async () => {
  const all = allMessages(); const app = await setup(all.slice(-40));
  const instance = app.engine(); const retainedRow = app.rows()[0];
  for (let page = 2; page <= 26; page++) {
    const data = all.slice(-Math.min(1004, page * 40));
    await app.history(data, page === 26);
    expect(app.list().props.data).toHaveLength(data.length);
    expect(app.list().props.data[0]).toBe(all[1003]);
    expect(app.rows()[0]).toBe(retainedRow);
    expect(app.engine()).toBe(instance);
  }
  expect(app.list().props.data.at(-1)).toBe(all[0]);
  expect(app.list().props.ListFooterComponent.props.children).toBe('All loaded');
  expect(app.list().props.ListFooterComponent.props.style).toBeUndefined();
  await app.history(all, true);
  expect(app.list().props.ListFooterComponent.props.children).toBe('All loaded');
  expect(instance.scrollToOffset).not.toHaveBeenCalled();
});

test('empty conversation keeps header/footer roles and starts a fresh inverted first-turn window', async () => {
  const app = await setup([]); const instance = app.engine();
  expect(app.list().props.inverted).toBe(false);
  expect(app.list().props.ListHeaderComponent.props.children.props.testID).toBe('history');
  await app.update([message(0)], 1);
  expect(app.engine() === instance).toBe(false);
  expect(app.list().props.inverted).toBe(true);
  expect(app.list().props.ListFooterComponent.props.testID).toBe('history');
  expect(app.list().props.ListHeaderComponent.props.children.props.testID).toBe('tail');
});

test('anchor helpers preserve native boundaries, missing IDs and reachable insets', () => {
  const frames = new Map([['later', { y: 400, height: 73 }], ['earlier', { y: 70, height: 330 }]]);
  expect(messageAnchorAt(250, frames)).toEqual({ id: 'earlier', offset: 180 });
  expect(messageAnchorAt(400, frames)).toEqual({ id: 'later', offset: 0 });
  expect(messageAnchorAt(20, frames)).toEqual({ id: 'earlier', offset: -50 });
  expect(messageAnchorAt(473, frames)).toBeNull();
  expect(messageAnchorAt(0, new Map([['offscreen', { y: 5000, height: 400 }]]), 640)).toBeNull();
  expect(messageInitialIndex([message(3), message(2)], { id: 'message-2', offset: 8 })).toBe(1);
  expect(messageInitialIndex([message(3), message(2)], { id: 'missing', offset: 8 })).toBe(0);
  expect(messageAnchorInset(175, 50, 640)).toBe(49);
});

test('empty and nonempty lists use stable separate MVCP options without dropping explicit tail index zero', async () => {
  const app=await setup([]);
  const emptyOptions=app.list().props.maintainVisibleContentPosition;
  expect(emptyOptions).toEqual({ disabled:false });
  expect(app.list().props.inverted).toBe(false);
  expect(app.list().props.initialScrollIndex).toBeUndefined();
  await app.update([message(0),message(1)]);
  const filledOptions=app.list().props.maintainVisibleContentPosition;
  expect(filledOptions).toEqual({ disabled:false,startRenderingFromBottom:true });
  expect(app.list().props.inverted).toBe(true);
  expect(app.list().props.initialScrollIndex).toBe(0);
  await app.footer();
  expect(app.list().props.maintainVisibleContentPosition).toBe(filledOptions);
  await app.update([]);
  expect(app.list().props.maintainVisibleContentPosition).toBe(emptyOptions);
});

import React from 'react';
import {
  Dimensions,
  FlatList,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import type { Message } from '../src/domain/types';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import { AppContextValue, AppProvider } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';

import { Button } from '../src/ui/components';
import {
  createMessageViewport,
  messageAnchorAt,
  messageAnchorInset,
  messageInitialIndex,
  messageRowKey,
} from '../src/screens/messageListLayout';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  AssistantOrb: () => null,
  Icon: () => null,
}));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
const trees = new Set<ReactTestRenderer>();
beforeEach(() => {
  jest.useFakeTimers();
  Dimensions.set({
    window: { width: 360, height: 640, scale: 2.75, fontScale: 1 },
  });
});
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees.clear();
  jest.useRealTimers();
});
const message = (index: number): Message => ({
  id: `message-${index}`,
  conversation_id: 'retained-chat',
  role: 'user',
  content: `Message ${index}`,
  created_at: new Date(index * 1000).toISOString(),
});
const allMessages = () =>
  Array.from({ length: 1004 }, (_, index) => message(index));
const layoutEvent = (y: number, height: number) => ({
  nativeEvent: { layout: { x: 0, y, width: 360, height } },
});
const scrollEvent = (y: number, height = 121000) => ({
  nativeEvent: {
    contentOffset: { x: 0, y },
    contentSize: { width: 360, height },
    layoutMeasurement: { width: 360, height: 640 },
    zoomScale: 1,
  },
  timeStamp: Date.now(),
});

async function setup(
  initial = allMessages(),
  anchor: { id: string; offset: number } | null = null,
  history?: { hasOlder: boolean; header: React.ReactElement },
) {
  const viewport = createMessageViewport();
  viewport.anchor = anchor;
  const rowRender = jest.fn((item: Message) => (
    <Text testID={`row-${messageRowKey(item)}`}>{item.content}</Text>
  ));
  const Row = React.memo(({ item }: { item: Message; testID: string }) =>
    rowRender(item),
  );
  const renderItem = jest.fn(({ item }: { item: Message }) => (
    <Row item={item} testID={`row-${messageRowKey(item)}`} />
  ));
  let header = history?.header ?? (
    <Text testID="history-heading">Load older messages</Text>
  );
  let hasOlder = history?.hasOlder;
  let messages = initial;
  let latestVersion = 0;
  const render = (footer = '') => (
    <ChatMessageList
      messages={messages}
      viewport={viewport}
      latestVersion={latestVersion}
      hasOlder={hasOlder}
      renderItem={renderItem}
      header={header}
      footer={<Text>{footer}</Text>}
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
    />
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render());
  });
  trees.add(tree);
  const list = () => tree.root.findByType(FlatList);
  const virtual = () => (list().instance as any)._listRef;
  const rows = () =>
    tree.root
      .findAllByType(Text)
      .filter(node => node.props.testID?.startsWith('row-'));
  const cell = (id: string) =>
    tree.root
      .findAllByType(View)
      .find(
        node =>
          typeof node.props.onLayout === 'function' &&
          React.Children.toArray(node.props.children).some(
            child =>
              React.isValidElement<{ testID?: string }>(child) &&
              child.props.testID === `row-${id}`,
          ),
      )!;
  return {
    tree,
    list,
    virtual,
    rows,
    cell,
    viewport,
    renderItem,
    rowRender,
    async dimensions(contentHeight = 121000) {
      await act(async () => {
        virtual()._onLayout(layoutEvent(0, 640));
        list().props.ListHeaderComponent.props.onLayout(layoutEvent(0, 24));
        list().props.ListFooterComponent.props.onLayout?.(
          layoutEvent(contentHeight - 48, 48),
        );
        virtual()._onContentSizeChange(360, contentHeight);
      });
    },
    async measure(id: string, y: number, height: number) {
      await act(async () => cell(id).props.onLayout(layoutEvent(y, height)));
    },
    async scroll(y: number, drag = true, contentHeight = 121000) {
      await act(async () => {
        if (drag) list().props.onScrollBeginDrag(scrollEvent(y, contentHeight));
        virtual()._onScroll(scrollEvent(y, contentHeight));
      });
    },
    async update(next = messages, footer = '', version = latestVersion) {
      messages = next;
      latestVersion = version;
      await act(async () => tree.update(render(footer)));
    },
    async history(
      next: Message[],
      more: boolean,
      nextHeader: React.ReactElement,
    ) {
      messages = next;
      hasOlder = more;
      header = nextHeader;
      await act(async () => tree.update(render()));
    },
    async tick(ms = 40) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(ms);
      });
    },
  };
}

test.each([0, 502, 1003])(
  'Back starts a bounded native window at retained message %i without a false exact layout',
  async index => {
    const messages = allMessages();
    const app = await setup(messages, { id: messages[index].id, offset: 27 });
    expect(app.list().props.data).toEqual(messages.slice().reverse());
    expect(app.list().props.initialScrollIndex).toBe(1003 - index);
    expect(app.rows().map(row => row.props.testID)).toContain(
      `row-${messages[index].id}`,
    );
    expect(app.rows().length).toBeGreaterThan(0);
    expect(app.rows().length).toBeLessThanOrEqual(6);
    expect(app.list().props.getItemLayout).toBeUndefined();
    expect(app.list().props.inverted).toBe(true);
    expect(app.list().props.removeClippedSubviews).toBe(false);
  },
);

test('latest starts at native zero, measures full growing content, and follows only while the user stays at the bottom', async () => {
  const messages = allMessages();
  const app = await setup(messages);
  expect(app.list().props.initialScrollIndex).toBe(0);
  expect(app.rows().map(row => row.props.testID)).toEqual(
    messages
      .slice(-6)
      .reverse()
      .map(item => `row-${item.id}`),
  );
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.dimensions();
  await app.measure('message-1003', 24, 900);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  await app.scroll(0, false);
  await app.tick();
  const growing = messages.map(item =>
    item.id === 'message-1003'
      ? { ...item, content: 'A much taller real streamed reply' }
      : item,
  );
  await app.update(growing);
  await app.measure('message-1003', 24, 1400);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  await app.scroll(400);
  const before = scroll.mock.calls.length;
  await app.update(
    growing.map(item =>
      item.id === 'message-1003'
        ? { ...item, content: 'Further live text' }
        : item,
    ),
  );
  await app.measure('message-1003', 24, 1800);
  expect(scroll).toHaveBeenCalledTimes(before);
  expect(app.viewport.followTail).toBe(false);
});

test('deep Back waits for the real RN prefix and native arrival rather than expiring after two quiet frames', async () => {
  const app = await setup(allMessages(), { id: 'message-502', offset: 27 });
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.dimensions(180000);
  await app.measure('message-502', 24, 255);
  expect(scroll).not.toHaveBeenCalled();
  // RN receives the actual natural height; the app supplies no synthetic frame.
  expect(
    app.virtual()._listMetrics.getCellMetrics(501, app.virtual().props),
  ).toMatchObject({ offset: 24, length: 255 });
  const prefix = app.virtual()._listMetrics.getAverageCellLength() * 501;
  await app.measure('message-502', prefix + 24, 255);
  expect(scroll).toHaveBeenLastCalledWith({
    offset: prefix + 51,
    animated: false,
  });
  await app.tick(100);
  const beforeArrival = scroll.mock.calls.length;
  await app.dimensions(190000);
  expect(scroll.mock.calls.length).toBeGreaterThan(beforeArrival);
  await app.tick(100);
  await app.scroll(prefix + 51, false, 190000);
  await app.tick();
  const settled = scroll.mock.calls.length;
  await app.measure('message-502', prefix + 30, 270);
  expect(scroll.mock.calls.length).toBeGreaterThan(settled);
  expect(scroll).toHaveBeenLastCalledWith({ offset: prefix + 57, animated: false });
});

test('deep Back keeps the installed RN initial window when an old 851px native scroll arrives after the 5270px prefix layout', async () => {
  const messages = Array.from({ length: 40 }, (_, index) => message(index + 43));
  const app = await setup(messages, { id: 'message-48', offset: 175.619 });
  const nativePane = () => app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  expect(app.list().props.initialScrollIndex).toBe(34);
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(1);
  await app.dimensions(851.429);
  await act(async () => app.virtual()._onLayout(layoutEvent(0, 651.429)));
  await app.measure('message-48', 24, 190.857);
  await app.measure('message-43', 734.476, 69.333);
  // The real new native cell layout may reach JS before its content-size event.
  // Neither that mixed geometry nor its old range-clamped packet is arrival.
  await app.measure('message-48', 4443.048, 190.857);
  await act(async () => nativePane().props.onScroll(scrollEvent(200, 851.429)));
  await app.tick(100);
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(1);
  expect(app.rows().map(row => row.props.testID)).toContain('row-message-48');
  expect(app.rows().length).toBeLessThanOrEqual(6);
  await app.dimensions(5270.095);
  await act(async () => app.virtual()._onLayout(layoutEvent(0, 651.429)));
  const destination = 5270.095 - 651.429;
  expect(scroll).toHaveBeenLastCalledWith({
    offset: expect.closeTo(destination, 3), animated: false,
  });
  const commands = scroll.mock.calls.length;
  // This is the exact observed Android ordering: old content851/Y200 arrives
  // after fresh content5270 and scrollTo4618. RN must not consume that packet.
  await act(async () => nativePane().props.onScroll(scrollEvent(200, 851.429)));
  await app.tick(100);
  expect(scroll.mock.calls.length).toBeGreaterThan(commands);
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(1);
  expect(app.virtual().state.cellsAroundViewport).toEqual({ first: 34, last: 39 });
  expect(app.rows().map(row => row.props.testID)).toContain('row-message-43');
  expect(app.viewport.anchor).toEqual({ id: 'message-48', offset: 175.619 });
  await act(async () => nativePane().props.onScroll(scrollEvent(destination, 5270.095)));
  await app.tick(100);
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(0);
  expect(app.viewport.anchor?.id).toBe('message-48');
  // The gate retires after real arrival: normal scrolling is forwarded again.
  await act(async () => nativePane().props.onScroll(scrollEvent(4500, 5270.095)));
  expect(app.viewport.y).toBe(4500);
});

test('a real gesture releases a deep bootstrap immediately and an obsolete retry cannot scroll its replacement', async () => {
  const app = await setup(allMessages(), { id: 'message-502', offset: 27 });
  await app.dimensions(180000);
  await app.measure('message-502', 24, 255);
  const nativePane = () => app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  await act(async () => nativePane().props.onScroll(scrollEvent(0, 640)));
  const obsoleteScroll = nativePane().props.onScroll;
  await act(async () => app.list().props.onScrollBeginDrag());
  await act(async () => nativePane().props.onScroll(scrollEvent(10, 180000)));
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(0);
  expect(app.viewport.y).toBe(10);
  await app.update(allMessages(), '', 1);
  const freshScroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await act(async () => obsoleteScroll(scrollEvent(200, 851)));
  await app.tick(100);
  expect(freshScroll).not.toHaveBeenCalled();
});

test.each(['native-scroll-first', 'content-size-first'])(
  '%s preserves a settled Back anchor through later real RN spacer refinement and still yields to no-drag accessibility scrolling',
  async order => {
    const messages = Array.from({ length: 40 }, (_, index) => message(index + 43));
    const app = await setup(messages, { id: 'message-48', offset: 175 });
    const nativePane = () => app.tree.root.findAllByType(ScrollView)
      .find(node => node.props.testID === 'chat-message-list')!;
    const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
    const heightFor = (item: Message) => {
      const index = Number(item.id.slice(8));
      return index === 50 ? 800 : index % 2 ? 69 : 190;
    };
    const snapshotNative = () => {
      const children = React.Children.toArray(nativePane().props.children) as React.ReactElement<any>[];
      const cells: { id: string; y: number; height: number }[] = [];
      let y = 0;
      for (const child of children) {
        if (child.props.item) {
          const item = child.props.item as Message;
          const height = heightFor(item);
          cells.push({ id: item.id, y, height });
          y += height;
        } else if (child.key?.toString().includes('$header')) y += 24;
        else if (child.key?.toString().includes('$footer')) y += 48;
        else y += Number(child.props.style?.height ?? 0);
      }
      return { cells, height: Math.max(640, y) };
    };
    const commitNative = async (snapshot: ReturnType<typeof snapshotNative>) => {
      await act(async () => {
        for (const cell of snapshot.cells)
          app.cell(cell.id).props.onLayout(layoutEvent(cell.y, cell.height));
        app.virtual()._onContentSizeChange(360, snapshot.height);
      });
    };
    await app.dimensions(640);
    await commitNative(snapshotNative());
    const initial = snapshotNative();
    await commitNative(initial);
    const arrival = (scroll.mock.calls.at(-1)![0] as { offset: number }).offset;
    await act(async () => nativePane().props.onScroll(scrollEvent(arrival, initial.height)));
    await app.tick(1200);
    expect(app.virtual().state.pendingScrollUpdateCount).toBe(0);
    const original = initial.cells.find(cell => cell.id === 'message-48')!;
    const refined = snapshotNative();
    const moved = refined.cells.find(cell => cell.id === 'message-48')!;
    expect(moved.y).not.toBe(original.y);
    expect(refined.height).not.toBe(initial.height);
    const beforeRefinement = scroll.mock.calls.length;
    if (order === 'content-size-first')
      await act(async () => app.virtual()._onContentSizeChange(360, refined.height));
    // The late native batch changes geometry after the earlier target retired.
    // This is not a user AX move despite the absence of any begin-drag event.
    await act(async () => nativePane().props.onScroll(scrollEvent(arrival - 200, refined.height)));
    await commitNative(refined);
    expect(scroll.mock.calls.length).toBeGreaterThan(beforeRefinement);
    const corrected = Math.min(moved.y + 175, refined.height - 640);
    expect(scroll).toHaveBeenLastCalledWith({ offset: corrected, animated: false });
    expect(app.viewport.anchor).toEqual({ id: 'message-48', offset: 175 });
    await act(async () => nativePane().props.onScroll(scrollEvent(arrival, initial.height)));
    expect(app.viewport.anchor).toEqual({ id: 'message-48', offset: 175 });
    await act(async () => nativePane().props.onScroll(scrollEvent(corrected, refined.height)));
    await app.tick(100);
    const beforeNoOpGeometry = scroll.mock.calls.length;
    await app.dimensions(refined.height + 20);
    await app.tick(100);
    expect(scroll).toHaveBeenCalledTimes(beforeNoOpGeometry);
    const beforeUser = scroll.mock.calls.length;
    // An isolated old-height packet after settlement must not start a same-Y
    // restore: native Android need not emit another arrival for an unchanged Y.
    await act(async () => nativePane().props.onScroll(scrollEvent(corrected, initial.height)));
    await app.tick(100);
    expect(scroll).toHaveBeenCalledTimes(beforeUser);
    // The unchanged row emits no new onLayout or onScroll acknowledgment.
    // The first packet after the confirmed no-op extent is the real AX move;
    // no same-Y acknowledgment is required to make it take ownership directly.
    await act(async () => nativePane().props.onScroll(scrollEvent(corrected - 100, refined.height + 20)));
    expect(app.viewport.y).toBe(corrected - 100);
    await app.tick(40);
    await app.measure('message-48', moved.y + 10, moved.height);
    expect(scroll).toHaveBeenCalledTimes(beforeUser);
    expect(app.rows().length).toBeLessThan(40);
  },
);

test('a stable-geometry accessibility scroll needs no begin-drag or deferred layout acknowledgment', async () => {
  const app = await setup([message(0)], { id: 'message-0', offset: 27 });
  await app.dimensions(3000);
  await app.measure('message-0', 24, 900);
  const nativePane = () => app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  await act(async () => nativePane().props.onScroll(scrollEvent(51, 3000)));
  await app.tick(100);
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await act(async () => nativePane().props.onScroll(scrollEvent(151, 3000)));
  expect(app.viewport.y).toBe(151);
  await app.measure('message-0', 34, 900);
  expect(scroll).not.toHaveBeenCalled();
});

test('same-row append growth preserves already-read text after dragging, while momentum remains in control', async () => {
  const original = {
    ...message(0),
    role: 'assistant' as const,
    content: 'Already read text',
  };
  const app = await setup([original]);
  await app.dimensions(3000);
  await app.measure('message-0', 24, 900);
  await app.scroll(400);
  await act(async () => {
    app.list().props.onScrollEndDrag();
    app.list().props.onMomentumScrollBegin();
  });
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  const first = { ...original, content: `${original.content} plus live text` };
  await app.update([first]);
  await app.measure('message-0', 24, 1200);
  expect(scroll).not.toHaveBeenCalled();
  await app.scroll(450, false, 3000);
  await act(async () => app.list().props.onMomentumScrollEnd());
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 426 });
  const second = { ...first, content: `${first.content} and the next chunk` };
  await app.update([second]);
  await app.measure('message-0', 24, 1400);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 650, animated: false });
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 626 });
});

test('a taller return viewport accepts native end clamping only after the true oldest row is mounted', async () => {
  const app = await setup(allMessages().slice(0, 40), {
    id: 'message-0',
    offset: 27,
  });
  await app.dimensions(2632);
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.measure('message-0', 2520, 64);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 1992, animated: false });
  await app.scroll(1992, false, 2632);
  // RN expands its native region after the first clamped scroll. Deliver the
  // resulting fresh layout and final arrival rather than treating that batch
  // transition as already settled geometry.
  await app.tick(400);
  await app.measure('message-0', 2520, 64);
  await app.scroll(1992, false, 2632);
  await app.tick();
  const settled = scroll.mock.calls.length;
  await app.measure('message-0', 2520, 64);
  expect(scroll).toHaveBeenCalledTimes(settled);
});

test.each([0, 48])('a clamped arrival waits for the last measured row and %ipx footer extent to reach native content size', async tailHeight => {
  const fullHeight = 2800 + tailHeight;
  const requested = fullHeight - 640;
  const app = await setup(Array.from({ length: 5 }, (_, index) => message(index)), {
    id: 'message-4', offset: requested - 24,
  });
  const nativePane = () => app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.dimensions(fullHeight - 20);
  await act(async () => app.list().props.ListFooterComponent.props.onLayout(
    layoutEvent(2800, tailHeight),
  ));
  // Actual installed RN cell layouts reach JS before the next content-size
  // notification. The visible tall anchor fits even in the stale content size.
  for (const [id, y, height] of [
    ['message-4', 24, 2200],
    ['message-3', 2224, 150],
    ['message-2', 2374, 150],
    ['message-1', 2524, 212],
    ['message-0', 2736, 64],
  ] as const) await app.measure(id, y, height);
  expect(app.virtual()._listMetrics.getCellMetrics(4, app.virtual().props))
    .toMatchObject({ offset: 2736, length: 64 });
  await act(async () => nativePane().props.onScroll(
    scrollEvent(requested - 20, fullHeight - 20),
  ));
  await app.tick(100);
  const beforeExtent = scroll.mock.calls.length;
  await app.dimensions(fullHeight);
  expect(scroll.mock.calls.length).toBeGreaterThan(beforeExtent);
  expect(scroll).toHaveBeenLastCalledWith({ offset: requested, animated: false });
  await act(async () => nativePane().props.onScroll(scrollEvent(requested, fullHeight)));
  await app.tick(100);
  const settled = scroll.mock.calls.length;
  await app.dimensions(fullHeight);
  expect(scroll).toHaveBeenCalledTimes(settled);
});

test('a negative retained inset stays reachable when a reflow makes the viewport shorter', async () => {
  const app = await setup(allMessages(), { id: 'message-502', offset: -528 });
  await app.dimensions(121000);
  await app.measure('message-502', 2520, 255);
  await app.scroll(1992, false, 121000);
  await app.tick(100);
  const oldList = app.list().instance;
  await act(async () => Dimensions.set({
    window: { width: 720, height: 500, scale: 2.75, fontScale: 1 },
  }));
  expect(app.list().instance).not.toBe(oldList);
  expect(app.rows().length).toBeLessThanOrEqual(6);
  await app.dimensions(121000);
  await act(async () => app.virtual()._onLayout(layoutEvent(0, 500)));
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.measure('message-502', 2520, 255);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 2021, animated: false });
  expect(app.viewport.anchor).toEqual({ id: 'message-502', offset: -499 });
  const nativePane = () => app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  await act(async () => nativePane().props.onScroll(scrollEvent(2021, 121000)));
  await app.tick(100);
  expect(app.virtual().state.pendingScrollUpdateCount).toBe(0);
  const settled = scroll.mock.calls.length;
  await app.measure('message-502', 2520, 255);
  expect(scroll).toHaveBeenCalledTimes(settled);
  expect(messageAnchorInset(-20, 255, 500)).toBe(-20);
  expect(messageAnchorInset(27, 255, 500)).toBe(27);
});

test('an anchor reply that appended text while hidden translates its retained old-text inset on the first fresh measurement', async () => {
  const original = {
    ...message(0),
    role: 'assistant' as const,
    content: 'Already read text',
  };
  const app = await setup([original], { id: 'message-0', offset: 376 });
  app.viewport.heights.set('message-0', { message: original, height: 900 });
  await app.update([
    {
      ...original,
      content: `${original.content} received while History was open`,
    },
  ]);
  await app.dimensions(3000);
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.measure('message-0', 24, 1200);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 700, animated: false });
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 676 });
});

test('end-drag without begin keeps user control through layout arriving before its deferred frame', async () => {
  const original = {
    ...message(0),
    role: 'assistant' as const,
    content: 'Read text',
  };
  const app = await setup([original], { id: 'message-0', offset: 200 });
  await app.dimensions(3000);
  await app.measure('message-0', 24, 900);
  await app.scroll(450, false, 3000);
  await act(async () => app.list().props.onScrollEndDrag());
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  const appended = {
    ...original,
    content: `${original.content} appended during gesture transition`,
  };
  await app.update([appended]);
  await app.measure('message-0', 24, 1200);
  expect(scroll).not.toHaveBeenCalled();
  await app.tick();
  expect(app.viewport.anchor).toEqual({ id: 'message-0', offset: 426 });
  expect(app.viewport.followTail).toBe(false);
});

test('reflow remounts only the bounded window, rejects old callbacks, and clamps an inset inside a shrinking reply', async () => {
  const app = await setup(allMessages(), { id: 'message-502', offset: 500 });
  await app.dimensions();
  await app.measure('message-502', 60240, 900);
  await app.scroll(60740);
  const stale = app.cell('message-502').props.onLayout;
  const oldList = app.list().instance;
  await act(async () =>
    Dimensions.set({
      window: { width: 720, height: 640, scale: 2.75, fontScale: 0.8 },
    }),
  );
  expect(app.list().instance).not.toBe(oldList);
  expect(app.list().props.initialScrollIndex).toBe(501);
  expect(app.rows().length).toBeLessThanOrEqual(6);
  await act(async () => stale(layoutEvent(60240, 999)));
  expect(app.viewport.heights.size).toBe(0);
  await app.dimensions();
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.measure('message-502', 60240, 300);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 60539, animated: false });
  expect(app.viewport.anchor).toEqual({ id: 'message-502', offset: 299 });
});

test('replacing a nonempty owner resets its native window and rejects the old owner callbacks', async () => {
  const messages = allMessages();
  const app = await setup(messages, { id: 'message-502', offset: 27 });
  await app.measure('message-502', 60240, 255);
  const old = app.list().instance;
  const oldLayout = app.cell('message-502').props.onLayout;
  const oldScroll = app.list().props.onScroll;
  const next = createMessageViewport();
  next.layoutKey = app.viewport.layoutKey;
  next.anchor = { id: 'message-104', offset: 13 };
  next.heights.set('message-104', { message: messages[104], height: 77 });
  const renderItem = app.list().props.renderItem;
  await act(async () =>
    app.tree.update(
      <ChatMessageList
        messages={messages}
        viewport={next}
        latestVersion={0}
        renderItem={renderItem}
        header={<Text>Other entry</Text>}
        footer={<Text />}
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1 }}
      />,
    ),
  );
  expect(app.list().instance).not.toBe(old);
  expect(app.list().props.initialScrollIndex).toBe(899);
  expect(app.rows()).toHaveLength(6);
  await act(async () => {
    oldLayout(layoutEvent(60240, 999));
    oldScroll(scrollEvent(60300));
  });
  expect(next.heights.size).toBe(1);
  expect(next.anchor).toEqual({ id: 'message-104', offset: 13 });
  expect(app.viewport.heights.get('message-502')?.height).toBe(255);
});

test('late gesture callbacks from a reflowed window cannot disable the retained current tail intent', async () => {
  const app = await setup();
  const stale = app.list().props;
  await act(async () =>
    Dimensions.set({
      window: { width: 720, height: 640, scale: 2.75, fontScale: 1 },
    }),
  );
  expect(app.viewport.followTail).toBe(true);
  await act(async () => {
    stale.onScrollBeginDrag();
    stale.onScrollEndDrag();
    stale.onMomentumScrollBegin();
    stale.onMomentumScrollEnd();
  });
  await app.tick();
  expect(app.viewport.followTail).toBe(true);
});

test('an old window detach cannot overwrite a new own-send latest intent', async () => {
  const messages = allMessages();
  const app = await setup(messages, { id: 'message-502', offset: 27 });
  await app.dimensions(180000);
  await app.measure('message-502', 60240, 255);
  await app.scroll(60267, false, 180000);
  app.viewport.anchor = null;
  app.viewport.followTail = true;
  await app.update([...messages, message(1004)], '', 1);
  expect(app.list().props.initialScrollIndex).toBe(0);
  expect(app.viewport.anchor).toBeNull();
  expect(app.viewport.followTail).toBe(true);
});

test('unrelated draft/voice/footer updates leave mounted memoized message rows untouched', async () => {
  const app = await setup();
  expect(app.rowRender).toHaveBeenCalledTimes(6);
  await app.update(undefined, 'Draft changed');
  await app.update(undefined, 'Voice recording: 1 second');
  expect(app.rowRender).toHaveBeenCalledTimes(6);
});

test('stable optimistic keys survive canonical IDs and live object updates without replacing the native cell', async () => {
  const optimistic = {
    ...message(0),
    id: 'temporary',
    client_key: 'optimistic-key',
  };
  const app = await setup([optimistic]);
  const before = app.cell('optimistic-key');
  await app.update([
    { ...optimistic, id: 'canonical', content: 'real streamed text' },
  ]);
  expect(app.list().props.keyExtractor(app.list().props.data[0])).toBe(
    'optimistic-key',
  );
  expect(app.cell('optimistic-key')).toBe(before);
});

async function finalPageFixture() {
  const all = Array.from({ length: 16 }, (_, index) => message(index));
  const older = jest.fn();
  const history = (
    <View testID="history-control">
      <Button variant="ghost" onPress={older}>
        加载更早消息
      </Button>
    </View>
  );
  const app = await setup(
    all.slice(4),
    { id: 'message-13', offset: 48 },
    { hasOlder: true, header: history },
  );
  await app.dimensions(840);
  await app.measure('message-13', 152, 64);
  await app.scroll(200, false, 840);
  await app.tick(400);
  for (let index = 0; index < 12; index++)
    await app.measure(`message-${15 - index}`, 24 + index * 64, 64);
  await app.dimensions(840);
  await app.scroll(200, false, 840);
  await app.tick(100);
  expect(app.viewport.anchor).toEqual({ id: 'message-13', offset: 48 });
  return { app, all, older };
}

test('the final history control retires only after native added rows expand the range, preserving the visible anchor without a gap', async () => {
  const { app, all, older } = await finalPageFixture();
  const scroll = jest.spyOn(app.list().instance, 'scrollToOffset');
  await app.history(all, false, <View testID="history-control" />);
  await app.tick(100);
  const pending = app.tree.root.findByType(Button);
  expect(pending.props.disabled).toBe(true);
  expect(pending.props.children).toBe('正在加载…');
  await act(async () => pending.props.onPress());
  expect(older).not.toHaveBeenCalled();
  // Without the retained control, native range 840->792 would clamp200->152
  // before unmeasured rows contribute any tail space: the observed48dp jump.
  expect(Math.min(200, 792 - 640)).toBe(152);
  await app.dimensions(840);
  expect(app.tree.root.findAllByType(Button)).toHaveLength(1);
  for (let index = 12; index < 16; index++)
    await app.measure(`message-${15 - index}`, 24 + index * 64, 64);
  // Row onLayout alone is insufficient; wait for actual native content growth.
  expect(app.tree.root.findAllByType(Button)).toHaveLength(1);
  await act(async () => app.virtual()._onContentSizeChange(360, 1096));
  expect(app.tree.root.findAllByType(Button)).toHaveLength(0);
  await act(async () => {
    app.list().props.ListFooterComponent.props.onLayout(layoutEvent(1048, 0));
    app.virtual()._onContentSizeChange(360, 1048);
  });
  await app.scroll(200, false, 1048);
  await app.tick(100);
  expect(scroll).toHaveBeenLastCalledWith({ offset: 200, animated: false });
  expect(app.viewport.anchor).toEqual({ id: 'message-13', offset: 48 });
  expect(app.list().props.ListFooterComponent.props.style).toBeUndefined();
  expect(app.list().props.ListFooterComponent.props.children).toBeUndefined();
});

test('an empty final history response removes the control immediately and accepts the physically shorter native end', async () => {
  const { app, all } = await finalPageFixture();
  await app.history(all.slice(4), false, <View testID="history-control" />);
  expect(app.tree.root.findAllByType(Button)).toHaveLength(0);
  await act(async () => {
    app.list().props.ListFooterComponent.props.onLayout(layoutEvent(792, 0));
    app.virtual()._onContentSizeChange(360, 792);
  });
  const nativePane = app.tree.root.findAllByType(ScrollView)
    .find(node => node.props.testID === 'chat-message-list')!;
  await act(async () => nativePane.props.onScroll(scrollEvent(152, 792)));
  await app.tick(100);
  expect(app.viewport.y).toBe(152);
  expect(app.viewport.anchor).toEqual({ id: 'message-13', offset: 0 });
});

test('all 26 older pages keep the installed RN render window nonempty and bounded with natural mixed heights', async () => {
  const all = allMessages();
  const history = (
    <View>
      <Button onPress={() => {}}>加载更早消息</Button>
    </View>
  );
  const app = await setup(all.slice(-40), null, {
    hasOlder: true,
    header: history,
  });
  const heightFor = (item: Message) =>
    Number(item.id.slice(8)) % 10 === 0 ? 520 : 64;
  // Walk the ACTUAL rendered RN children, including RN's own current spacer
  // elements. These are native-layout inputs, not fabricated app getItemLayout.
  async function nativePass() {
    const pane = app.tree.root
      .findAllByType(ScrollView)
      .find(node => node.props.testID === 'chat-message-list')!;
    const children = React.Children.toArray(
      pane.props.children,
    ) as React.ReactElement<any>[];
    let y = 0;
    await act(async () => {
      for (const child of children) {
        if (child.props.item) {
          const item = child.props.item as Message;
          const height = heightFor(item);
          app.cell(messageRowKey(item)).props.onLayout(layoutEvent(y, height));
          y += height;
        } else if (child.key?.toString().includes('$header')) y += 24;
        else if (child.key?.toString().includes('$footer')) {
          const height = app.tree.root.findAllByType(Button).length ? 48 : 0;
          app
            .list()
            .props.ListFooterComponent.props.onLayout?.(layoutEvent(y, height));
          y += height;
        } else y += Number(child.props.style?.height ?? 0);
      }
      app.virtual()._onContentSizeChange(360, Math.max(640, y));
    });
    return Math.max(640, y);
  }
  await app.dimensions(640);
  for (let page = 1; page <= 26; page++) {
    const loaded = all.slice(-Math.min(1004, page * 40));
    await app.history(loaded, page < 26, page < 26 ? history : <View />);
    for (let pass = 0; pass < 12; pass++) {
      const content = await nativePass();
      await app.scroll(Math.max(0, content - 640), true, content);
      await app.tick(60);
      const state = app.virtual().state;
      expect(state.cellsAroundViewport.last).toBeGreaterThanOrEqual(
        state.cellsAroundViewport.first,
      );
      expect(app.rows().length).toBeGreaterThan(0);
      expect(app.rows().length).toBeLessThan(150);
    }
    expect(app.list().props.data).toHaveLength(loaded.length);
    expect(app.rows().map(row => row.props.testID)).toContain(
      `row-${loaded[0].id}`,
    );
    // Older history is appended in native inverted order. RN must not accrue
    // a pending prepend correction for every page and freeze its render mask.
    expect(app.virtual().state.pendingScrollUpdateCount).toBe(0);
  }
  expect(app.list().props.data.at(-1).id).toBe('message-0');
  expect(app.list().props.getItemLayout).toBeUndefined();
  expect(app.tree.root.findAllByType(Button)).toHaveLength(0);
}, 120000);

test('native-coordinate anchor helpers preserve tall-row offsets, exact boundaries, header gaps, and missing IDs', () => {
  const frames = new Map([
    ['later', { y: 400, height: 73 }],
    ['earlier', { y: 70, height: 330 }],
  ]);
  expect(messageAnchorAt(250, frames)).toEqual({ id: 'earlier', offset: 180 });
  expect(messageAnchorAt(400, frames)).toEqual({ id: 'later', offset: 0 });
  expect(messageAnchorAt(20, frames)).toEqual({ id: 'earlier', offset: -50 });
  expect(messageAnchorAt(473, frames)).toBeNull();
  expect(
    messageAnchorAt(0, new Map([['offscreen', { y: 5000, height: 400 }]]), 640),
  ).toBeNull();
  expect(
    messageInitialIndex([message(3), message(2)], {
      id: 'message-2',
      offset: 8,
    }),
  ).toBe(1);
  expect(
    messageInitialIndex([message(3), message(2)], { id: 'missing', offset: 8 }),
  ).toBe(0);
});

const mixedMessage = (index: number): Message => ({
  id: `mixed-${index}`,
  role: index === 80 ? 'assistant' : 'user',
  conversation_id: 'mixed',
  content: index === 80 ? 'Tall mixed reply\n'.repeat(100) : `Mixed ${index}`,
  created_at: new Date(index * 1000).toISOString(),
});

test.each([
  'momentum-without-begin-drag',
  'accessibility-scroll-without-gesture-events',
])(
  '%s snapshots the actual mixed-history viewport before pending older/History detach',
  async mode => {
    const initial = Array.from({ length: 40 }, (_, index) =>
      mixedMessage(index + 43),
    );
    let complete!: (page: { items: Message[]; next_offset: null }) => void;
    const late = new Promise<{ items: Message[]; next_offset: null }>(
      resolve => {
        complete = resolve;
      },
    );
    const api = {
      capabilities: jest
        .fn()
        .mockResolvedValue({ runtime: { model_mode: 'local' } }),
      messages: jest
        .fn()
        .mockResolvedValueOnce({
          items: initial,
          next_offset: 40,
          next_before: 'mixed-43',
        })
        .mockReturnValueOnce(late),
    };
    let navigation!: ReturnType<typeof useRouteStack>;
    let entry!: ReturnType<typeof createChatEntryState>;
    function Harness() {
      navigation = useRouteStack(api);
      const route = navigation.entry.route;
      if (route.name === 'chat')
        entry = navigation.getEntryState(scope => {
          const state = createChatEntryState('mixed', undefined, scope);
          state.update(old => ({ ...old, messages: initial }));
          state.history.viewport.anchor = { id: 'mixed-80', offset: 300 };
          return state;
        });
      return (
        <AppProvider
          value={
            {
              api,
              invalidate: jest.fn(),
              formatDate: () => '',
            } as unknown as AppContextValue
          }
        >
          <React.Fragment key={navigation.entry.key}>
            {route.name === 'chat' ? (
              <ChatScreen conversationId="mixed" entryState={entry} />
            ) : (
              <Text>History</Text>
            )}
          </React.Fragment>
        </AppProvider>
      );
    }
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Harness />);
    });
    trees.add(tree);
    await act(async () =>
      navigation.navigate({ name: 'chat', conversationId: 'mixed' }),
    );
    const list = () => tree.root.findByType(FlatList);
    const virtual = () => (list().instance as any)._listRef;
    const nativeCell = (id: string) => {
      let node = tree.root
        .findAllByType(View)
        .find(view => view.props.testID === `chat-message-${id}`)!.parent!;
      while (!(node.type === View && typeof node.props.onLayout === 'function'))
        node = node.parent!;
      return node;
    };
    await act(async () => {
      tree.root
        .findByType(TextInput)
        .props.onChangeText('mixed retained draft');
      virtual()._onLayout(layoutEvent(0, 640));
      list().props.ListHeaderComponent.props.onLayout(layoutEvent(0, 24));
      list().props.ListFooterComponent.props.onLayout(layoutEvent(0, 48));
      virtual()._onContentSizeChange(360, 640);
      if (mode === 'momentum-without-begin-drag')
        list().props.onMomentumScrollBegin();
    });
    let actualFrames = new Map<string, { y: number; height: number }>();
    let actualY = 0;
    let contentHeight = 640;
    // Feed actual installed-RN render-mask/spacer children through delayed native
    // layout and scroll events. No fake fixed getItemLayout or begin-drag event.
    for (let pass = 0; pass < 14; pass++) {
      const pane = tree.root
        .findAllByType(ScrollView)
        .find(node => node.props.testID === 'chat-message-list')!;
      const children = React.Children.toArray(
        pane.props.children,
      ) as React.ReactElement<any>[];
      actualFrames = new Map();
      let y = 0;
      await act(async () => {
        for (const child of children) {
          if (child.props.item) {
            const item = child.props.item as Message;
            const height = item.id === 'mixed-80' ? 1600 : 64;
            actualFrames.set(item.id, { y, height });
            nativeCell(item.id).props.onLayout(layoutEvent(y, height));
            y += height;
          } else if (child.key?.toString().includes('$header')) y += 24;
          else if (child.key?.toString().includes('$footer')) y += 48;
          else y += Number(child.props.style?.height ?? 0);
        }
        contentHeight = Math.max(640, y);
        actualY = Math.max(0, contentHeight - 640);
        virtual()._onContentSizeChange(360, contentHeight);
        virtual()._onScroll(scrollEvent(actualY, contentHeight));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60);
      });
    }
    expect(
      tree.root
        .findAllByType(View)
        .some(node => node.props.testID === 'chat-message-mixed-43'),
    ).toBe(true);
    const visible = messageAnchorAt(actualY, actualFrames, 640)!;
    expect(visible).not.toBeNull();
    expect(visible.id).not.toBe('mixed-80');
    await act(async () => {
      if (mode === 'momentum-without-begin-drag')
        list().props.onMomentumScrollEnd();
      void tree.root
        .findAllByType(Button)
        .find(node => node.props.children === '加载更早消息')!
        .props.onPress();
    });
    expect(api.messages).toHaveBeenLastCalledWith('mixed', {
      before: 'mixed-43',
      limit: 40,
    });
    if (mode === 'momentum-without-begin-drag') {
      const commands = jest.spyOn(list().instance, 'scrollToOffset');
      const frame = actualFrames.get(visible.id)!;
      // A late layout after the request starts must not resurrect the old80
      // restore target merely because this window never received begin-drag.
      await act(async () =>
        nativeCell(visible.id).props.onLayout(
          layoutEvent(frame.y, frame.height + 1),
        ),
      );
      expect(commands).not.toHaveBeenCalled();
    }
    await act(async () => navigation.navigate({ name: 'conversations' }));
    expect(entry.history.viewport.anchor).toEqual(visible);
    expect(entry.history.viewport.followTail).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
      complete({ items: [mixedMessage(42)], next_offset: null });
    });
    expect(entry.getSnapshot().messages).toHaveLength(40);
    await act(async () => navigation.back());
    expect(tree.root.findByType(TextInput).props.value).toBe(
      'mixed retained draft',
    );
    expect(list().props.initialScrollIndex).toBe(
      initial
        .slice()
        .reverse()
        .findIndex(item => item.id === visible.id),
    );
    const backScroll = jest.spyOn(list().instance, 'scrollToOffset');
    const backPane = () => tree.root.findAllByType(ScrollView)
      .find(node => node.props.testID === 'chat-message-list')!;
    await act(async () => {
      virtual()._onLayout(layoutEvent(0, 640));
      list().props.ListHeaderComponent.props.onLayout(layoutEvent(0, 24));
      list().props.ListFooterComponent.props.onLayout(layoutEvent(0, 48));
    });
    async function backNativePass() {
      const children = React.Children.toArray(
        backPane().props.children,
      ) as React.ReactElement<any>[];
      let y = 0;
      await act(async () => {
        for (const child of children) {
          if (child.props.item) {
            const item = child.props.item as Message;
            const height = item.id === 'mixed-80' ? 1600 : 64;
            nativeCell(item.id).props.onLayout(layoutEvent(y, height));
            y += height;
          } else if (child.key?.toString().includes('$header')) y += 24;
          else if (child.key?.toString().includes('$footer')) y += 48;
          else y += Number(child.props.style?.height ?? 0);
        }
        virtual()._onContentSizeChange(360, Math.max(640, y));
      });
      return Math.max(640, y);
    }
    const initialNativeHeight = await backNativePass();
    const prefixedNativeHeight = await backNativePass();
    expect(prefixedNativeHeight).toBeGreaterThan(initialNativeHeight);
    // A delayed initial native packet must not move the real RN Back window
    // toward tall80, even after the pending older response completed hidden.
    await act(async () => backPane().props.onScroll(
      scrollEvent(Math.max(0, initialNativeHeight - 640), initialNativeHeight),
    ));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(virtual().state.pendingScrollUpdateCount).toBe(1);
    expect(tree.root.findAllByType(View).some(node =>
      node.props.testID === `chat-message-${visible.id}`,
    )).toBe(true);
    const arrival = (backScroll.mock.calls.at(-1)![0] as { offset: number }).offset;
    await act(async () => backPane().props.onScroll(
      scrollEvent(arrival, prefixedNativeHeight),
    ));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(virtual().state.pendingScrollUpdateCount).toBe(0);
    expect(entry.history.viewport.anchor?.id).toBe(visible.id);
    expect(api.messages).toHaveBeenCalledTimes(2);
    api.messages.mockResolvedValueOnce({
      items: [mixedMessage(42)],
      next_offset: null,
    });
    await act(async () => {
      void tree.root
        .findAllByType(Button)
        .find(node => node.props.children === '加载更早消息')!
        .props.onPress();
    });
    expect(api.messages).toHaveBeenLastCalledWith('mixed', {
      before: 'mixed-43',
      limit: 40,
    });
    expect(entry.getSnapshot().messages).toHaveLength(41);
  },
  30000,
);

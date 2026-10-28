import React from 'react';
import { Dimensions, FlatList, ScrollView, Text, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import type { Message } from '../src/domain/types';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import {
  createMessageViewport,
  messageAnchorAt,
  messageInitialIndex,
  messageRowKey,
} from '../src/screens/messageListLayout';

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
  const header = <Text testID="history-heading">Load older messages</Text>;
  let messages = initial;
  let latestVersion = 0;
  const render = (footer = '') => (
    <ChatMessageList
      messages={messages}
      viewport={viewport}
      latestVersion={latestVersion}
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
  expect(scroll).toHaveBeenCalledTimes(settled);
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
  await app.measure('message-0', 2525, 64);
  expect(scroll).toHaveBeenCalledTimes(settled);
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

test('all 26 older pages keep the installed RN render window nonempty and bounded with natural mixed heights', async () => {
  const all = allMessages();
  const app = await setup(all.slice(-40));
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
        else if (child.key?.toString().includes('$footer')) y += 48;
        else y += Number(child.props.style?.height ?? 0);
      }
      app.virtual()._onContentSizeChange(360, Math.max(640, y));
    });
    return Math.max(640, y);
  }
  await app.dimensions(640);
  for (let page = 1; page <= 26; page++) {
    const loaded = all.slice(-Math.min(1004, page * 40));
    await app.update(loaded);
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
}, 30000);

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
    messageInitialIndex([message(3), message(2)], {
      id: 'message-2',
      offset: 8,
    }),
  ).toBe(1);
  expect(
    messageInitialIndex([message(3), message(2)], { id: 'missing', offset: 8 }),
  ).toBe(0);
});

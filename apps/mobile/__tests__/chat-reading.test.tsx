import React from 'react';
import { Dimensions, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FlashList } from '@shopify/flash-list';
import type { FlashList as EngineDouble } from '../test/flashListMock';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import { createMessageViewport, messageRowKey } from '../src/screens/messageListLayout';
import type { Message } from '../src/domain/types';
import { ResultText } from '../src/ui/ResultText';
import { formatReadingCharacters, messageReadingCharacters, readingCharacters,
  unreadReadingCharacters, type ReadingRow } from '../src/ui/ChatReadingMetrics';

const mockTextFrames = new Map<string, { top: number; height: number }>();
const mockMeasurements: Array<() => void> = [];
let mockDelayMeasurements = false;
jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.mock('../src/ui/Text', () => {
  const R = require('react');
  const NativeText = require('react-native').Text;
  return { Text: R.forwardRef((props: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ measureLayout: (_root: unknown, success: Function) => {
      const frame = mockTextFrames.get(String(props.children ?? ''));
      if (!frame) return;
      const measured = () => success(0, frame.top, 300, frame.height);
      if (mockDelayMeasurements) mockMeasurements.push(measured); else measured();
    } }));
    return R.createElement(NativeText, props);
  }) };
});

const question: Message = { id: 'question', conversation_id: 'reading', role: 'user',
  content: '给我一份长回答', created_at: '2026-11-01T01:00:00Z' };
const reply: Message = { ...question, id: 'answer', client_key: 'local-answer', role: 'assistant',
  content: '一二三四五六七八九十', stream_status: '正在回复…' };
const trees = new Set<ReactTestRenderer>();
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { mockTextFrames.clear(); mockMeasurements.length = 0; mockDelayMeasurements = false; });
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees.clear();
});

async function setup() {
  let data = [question, reply];
  let viewport = createMessageViewport();
  let version = 0;
  const renderItem = jest.fn(({ item }: { item: Message }) => <ResultText content={item.content} />);
  const render = () => <ChatMessageList messages={data} viewport={viewport}
    latestVersion={version} renderItem={renderItem}
    header={<Text>历史</Text>} footer={<Text>页尾</Text>}
    style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} />;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  trees.add(tree);
  const list = () => tree.root.findByType(FlashList);
  const engine = () => list().instance as EngineDouble<Message>;
  const packet = (offset: number) => ({ nativeEvent: { contentOffset: { x: 0, y: offset },
    contentSize: { width: 360, height: 2000 }, layoutMeasurement: { width: 360, height: 300 } } });
  function measure(height = 200) {
    engine().layouts.set(0, { x: 0, y: 0, width: 360, height, isHeightMeasured: true });
    engine().layouts.set(1, { x: 0, y: height, width: 360, height: 400, isHeightMeasured: true });
    engine().visible = { startIndex: 0, endIndex: 1 };
  }
  return {
    tree, engine, renderItem, list,
    get viewport() { return viewport; },
    async layout(height = 200) {
      measure(height);
      await act(async () => {
        list().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 300 } } });
        list().props.onContentSizeChange(360, 2000);
      });
    },
    async native(offset: number, user = false) {
      engine().nativeOffset = offset;
      await act(async () => {
        if (user) list().props.onScrollBeginDrag(packet(offset));
        list().props.onScroll(packet(offset));
        if (user) list().props.onScrollEndDrag(packet(offset));
      });
    },
    async textLayout(text: string, top = 20) {
      const chunks = text.match(/.{1,2}/gu)!;
      mockTextFrames.set(text, { top, height: chunks.length * 20 });
      const block = tree.root.findAllByType(Text).find(node =>
        node.props.children === text && node.props.onTextLayout)!;
      expect(block).toBeDefined();
      const callback = block.props.onTextLayout;
      await act(async () => callback({ nativeEvent: { lines: chunks.map((value, index) =>
        ({ text: value, x: 0, y: index * 20, height: 20, width: 100 })) } }));
      return callback;
    },
    async update(message = reply) { data = [question, message]; await act(async () => tree.update(render())); },
    async commit(height: number) { measure(height); await act(async () => list().props.onCommitLayoutEffect()); },
    async jump() { await act(async () => tree.root.findByProps({ testID: 'chat-unread-jump' }).props.onPress()); },
    count() { return tree.root.findAllByProps({ testID: 'chat-unread-count' })
      .find(node => typeof node.props.children === 'string')?.props.children; },
    async owner() { viewport = createMessageViewport(); version = 0;
      await act(async () => tree.update(render())); },
  };
}

test('counts rendered characters instead of tokens or raw Markdown syntax', () => {
  expect(readingCharacters('AI hi 世界 \n')).toBe(6);
  expect(messageReadingCharacters({ ...reply, content: '# 标题\n\n**AI**\n| 项目 | 时长 |\n|---|---|\n| 散步 | 20分钟 |' })).toBe(14);
  expect(messageReadingCharacters({ ...reply, content: '```ts\nconst n = 2;\n```' })).toBe(9);
  expect(formatReadingCharacters(128)).toBe('128字');
  expect(formatReadingCharacters(1000)).toBe('1千字');
  expect(formatReadingCharacters(1234)).toBe('1.2千字');
});

test('partial unread counts require real current native line positions; unmeasured rows are not guessed', () => {
  const row: ReadingRow = { content: reply.content, pending: new Set(), blocks: new Map([
    ['block', { text: reply.content, top: 20, height: 100, geometry: '360:1',
      lines: ['一二', '三四', '五六', '七八', '九十'].map((text, index) => ({ text, y: index * 20, height: 20, characters: 2 })) }],
  ]) };
  const frame = { y: 0, height: 200, isHeightMeasured: true };
  expect(unreadReadingCharacters(reply, row, '360:1', frame, 24, 124)).toBe(2);
  expect(unreadReadingCharacters(reply, row, '360:1', frame, 24, 144)).toBe(4);
  expect(unreadReadingCharacters(reply, row, '360:1', frame, 24, 224)).toBe(10);
  expect(unreadReadingCharacters(reply, row, '360:1', frame, 24, 0)).toBe(0);
  expect(unreadReadingCharacters(reply, row, '360:2', frame, 24, 144)).toBeNull();
  expect(unreadReadingCharacters(reply, row, '360:1', { ...frame, isHeightMeasured: false }, 24, 144)).toBeNull();
  row.pending.add('new-block');
  expect(unreadReadingCharacters(reply, row, '360:1', frame, 24, 144)).toBeNull();
});

test('real line callbacks update the compact badge as native scroll positions change without repainting messages', async () => {
  const app = await setup();
  await app.layout(); await app.native(0); await app.textLayout(reply.content);
  expect(app.viewport.followTail).toBe(false);
  await app.native(124, true);
  expect(app.count()).toBe('2字');
  const rendered = app.renderItem.mock.calls.length;
  await app.native(144, true); expect(app.count()).toBe('4字');
  await app.native(124, true); expect(app.count()).toBe('2字');
  expect(app.renderItem).toHaveBeenCalledTimes(rendered);
});

test('streaming at native zero retains the same old-text location, even without a first native arrival packet', async () => {
  const app = await setup(); await app.layout();
  app.engine().scrollToOffset.mockClear();
  const extended = { ...reply, content: reply.content + '十一十二' };
  await app.update(extended); await app.commit(260);
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 60, animated: false });
  // The 60px correction offsets precisely 60px of inverted row growth.
  expect(300 + 60 - 24 - 260 + 20).toBe(300 - 24 - 200 + 20);
  expect(app.viewport.followTail).toBe(false);
});

test('jump is one-shot; later text preserves the new reading position and completion leaves only the arrow', async () => {
  const app = await setup(); await app.layout(); await app.native(0); await app.textLayout(reply.content);
  await app.native(144, true); expect(app.count()).toBe('4字');
  await app.jump();
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
  await app.native(0);
  app.engine().scrollToOffset.mockClear();
  const extended = { ...reply, content: reply.content + '十一十二' };
  await app.update(extended); await app.commit(260); await app.textLayout(extended.content);
  expect(app.engine().scrollToOffset).toHaveBeenLastCalledWith({ offset: 60, animated: false });
  await app.native(60);
  const position = app.viewport.y;
  app.engine().scrollToOffset.mockClear();
  await app.update({ ...extended, stream_status: undefined });
  expect(app.count()).toBeUndefined();
  expect(app.tree.root.findByProps({ testID: 'chat-unread-jump' }).props.accessibilityLabel).toBe('回到最新内容');
  expect(app.viewport.y).toBe(position);
  expect(app.engine().scrollToOffset).not.toHaveBeenCalled();
});

test('unknown partial layout shows a navigation arrow rather than a fabricated character count', async () => {
  const app = await setup(); await app.layout(); await app.native(144, true);
  expect(app.count()).toBeUndefined();
  expect(app.tree.root.findByProps({ testID: 'chat-unread-jump' }).props.accessibilityLabel).toBe('回到最新内容');
});

test('FlashList measurement copies cannot replace the visible reply measurements', async () => {
  const app = await setup(); await app.layout(); await app.native(0); await app.textLayout(reply.content);
  await app.native(144, true); expect(app.count()).toBe('4字');
  let measurement!: ReactTestRenderer;
  await act(async () => {
    measurement = create(app.list().props.renderItem({ item: reply, index: 0, target: 'Measurement' }));
  });
  trees.add(measurement);
  const copy = measurement.root.findAllByType(Text).find(node => node.props.children === reply.content)!;
  expect(copy.props.onTextLayout).toBeUndefined();
  await app.native(124, true); expect(app.count()).toBe('2字');
});

test('a width or font change waits for new native lines before measuring the new geometry', async () => {
  const app = await setup(); await app.layout(); await app.native(0); await app.textLayout(reply.content);
  const previous = Dimensions.get('window');
  try {
    await act(async () => Dimensions.set({ window: { ...previous, width: previous.width + 100 } }));
    await app.layout();
    mockDelayMeasurements = true;
    const block = app.tree.root.findAllByType(Text).find(node =>
      node.props.children === reply.content && node.props.onTextLayout)!;
    await act(async () => block.props.onLayout({ nativeEvent: { layout: { x: 0, y: 20, width: 360, height: 100 } } }));
    expect(mockMeasurements).toHaveLength(0);
    await app.textLayout(reply.content);
    expect(mockMeasurements.length).toBeGreaterThan(0);
    await act(async () => mockMeasurements.splice(0).forEach(measured => measured()));
  } finally {
    await act(async () => Dimensions.set({ window: previous }));
  }
});

test('late native text and scroll callbacks cannot leak counts into a different account or conversation', async () => {
  const app = await setup(); await app.layout(); await app.native(0);
  mockDelayMeasurements = true;
  const previous = await app.textLayout(reply.content);
  expect(mockMeasurements.length).toBeGreaterThan(0);
  await app.owner();
  await act(async () => {
    previous({ nativeEvent: { lines: [{ text: '旧账号内容', y: 0, height: 20 }] } });
    mockMeasurements.splice(0).forEach(measured => measured());
  });
  expect(app.count()).toBeUndefined();
  expect(app.viewport.anchor).toBeNull();
});

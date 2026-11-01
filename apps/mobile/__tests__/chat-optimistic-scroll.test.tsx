import React from 'react';
import { ScrollView, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import * as measurements from '@shopify/flash-list/dist/recyclerview/utils/measureLayout';
import type { Message } from '../src/domain/types';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import { createMessageViewport, messageRowKey } from '../src/screens/messageListLayout';


// Run the installed recycler and compare its mounted window with actual native offsets.
test('own send from 1004 deep history keeps the mounted recycler window over the actual native viewport', async () => {
  jest.useFakeTimers();
  let messages: Message[] = Array.from({ length: 1004 }, (_, index) => ({
    id: `history-${index}`, conversation_id: 'deep-chat', role: 'assistant',
    content: `History ${index}`, created_at: new Date(index * 1000).toISOString(),
  }));
  let version = 7;
  const viewport = createMessageViewport();
  viewport.anchor = { id: 'history-636', offset: 175 };
  const data = () => messages.slice().reverse();
  (measurements.measureParentSize as jest.Mock).mockImplementation(() => ({ width: 360, height: 640 }));
  (measurements.measureFirstChildLayout as jest.Mock).mockImplementation(() =>
    ({ x: 0, y: 24, width: 360, height: 640 }));
  (measurements.measureItemLayout as jest.Mock).mockImplementation((view: any) => ({
    x: 0, y: 0, width: 360, height: data()[view.props.index]?.id.startsWith('history-') ? 900
      : data()[view.props.index]?.content === 'Actual partial extended' ? 188 : 88,
  }));
  const render = () => <ChatMessageList messages={messages} viewport={viewport}
    latestVersion={version} renderItem={({ item }) => <Text testID={`row-${messageRowKey(item)}`}>{item.content}</Text>}
    header={<Text>History</Text>} footer={<Text>Latest spacing</Text>}
    style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} />;
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(render()); });
    const engine = () => tree.root.findByType(FlashList).props.ref.current as FlashListRef<Message>;
    const pane = () => tree.root.findAllByType(ScrollView).find(node => node.props.testID === 'chat-message-list')!;
    const packet = (y: number) => ({ nativeEvent: {
      contentOffset: { x: 0, y }, contentSize: { width: 360, height: engine().getChildContainerDimensions().height + 24 },
      layoutMeasurement: { width: 360, height: 640 }, zoomScale: 1, velocity: { x: 0, y: 0 },
    }, timeStamp: Date.now() });
    const bounds = async () => {
      await act(async () => {
        pane().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 640 } } });
        pane().props.onContentSizeChange(360, engine().getChildContainerDimensions().height + 24);
      });
    };
    await act(async () => { await jest.advanceTimersByTimeAsync(200); });
    await bounds();
    const retainedIndex = engine().props.data!.findIndex(item => item.id === 'history-636');
    const savedY = engine().getFirstItemOffset() + engine().getLayout(retainedIndex)!.y + 175;
    await act(async () => pane().props.onScroll(packet(savedY)));
    expect(tree.root.findAllByType(Text).some(row => row.props.testID === 'row-history-636')).toBe(true);

    for (let turn = 1; turn <= 2; turn++) {
      const retired = pane().props;
      const user: Message = { id: `local-user-${turn}`, client_key: `local-user-${turn}`,
        conversation_id: 'deep-chat', role: 'user', content: `Immediate user ${turn}`,
        created_at: new Date().toISOString(), delivery: 'sending' };
      const assistant: Message = { ...user, id: `local-assistant-${turn}`, client_key: `local-assistant-${turn}`,
        role: 'assistant', content: '', stream_status: '发送中…' };
      messages = [...messages, user, assistant]; version++;
      await act(async () => { tree.update(render()); });
      await bounds();
      // Model an actual native zero event during the SDK's prepend suppression.
      // Waiting only releases that suppression; it must not manufacture a new event.
      const nativeY = 0;
      await act(async () => pane().props.onScroll(packet(nativeY)));
      await act(async () => { await jest.advanceTimersByTimeAsync(200); });
      const mounted = tree.root.findAllByType(Text).filter(row => row.props.testID?.startsWith('row-'));
      expect(mounted.length).toBeLessThan(100);
      for (const item of [user, assistant]) {
        expect(mounted.some(row => row.props.testID === `row-${messageRowKey(item)}`)).toBe(true);
        const index = engine().props.data!.findIndex(row => messageRowKey(row) === messageRowKey(item));
        const frame = engine().getLayout(index)!;
        const top = engine().getFirstItemOffset() + frame.y;
        expect(frame.isHeightMeasured).toBe(true);
        expect(Math.min(top + frame.height, nativeY + 640) - Math.max(top, nativeY)).toBe(frame.height);
        const visible = engine().computeVisibleIndices();
        expect(index).toBeGreaterThanOrEqual(visible.startIndex);
        expect(index).toBeLessThanOrEqual(visible.endIndex);
      }
      const currentEngine = engine();
      const beforeStale = { ...viewport.anchor };
      await act(async () => {
        retired.onScroll(packet(savedY)); retired.onContentSizeChange(360, 100);
        retired.onScrollBeginDrag(packet(savedY)); retired.onCommitLayoutEffect?.();
      });
      expect(viewport.followTail).toBe(false);
      expect(viewport.anchor).toEqual(beforeStale);
      messages = messages.map(item => item === user ? { ...item, id: `server-user-${turn}`, delivery: 'sent' }
        : item === assistant ? { ...item, id: `server-assistant-${turn}`, content: 'Actual partial', stream_status: '正在处理操作…' } : item);
      await act(async () => { tree.update(render()); });
      expect(engine()).toBe(currentEngine);
      if (turn === 1) {
        await act(async () => {
          pane().props.onScrollBeginDrag(packet(400));
          pane().props.onScroll(packet(400));
          pane().props.onScrollEndDrag(packet(400));
        });
        const reading = { ...viewport.anchor };
        expect(viewport.followTail).toBe(false);
        const scrollTo = jest.spyOn(pane().instance, 'scrollTo');
        scrollTo.mockClear();
        messages = messages.map(item => item.client_key === assistant.client_key
          ? { ...item, content: 'Actual partial extended' } : item);
        await act(async () => { tree.update(render()); });
        expect(engine()).toBe(currentEngine);
        expect(scrollTo.mock.calls.some(([command]) => (command as { y?: number })?.y === 0)).toBe(false);
        await act(async () => pane().props.onScroll(packet(500)));
        await bounds();
        expect(viewport.followTail).toBe(false);
        expect(viewport.anchor).toEqual(reading);
      }
    }
  } finally {
    await act(async () => tree?.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  }
});

import React from 'react';
import { ScrollView, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { FlashList, FlashListRef } from '@shopify/flash-list';
import * as measurements from '@shopify/flash-list/dist/recyclerview/utils/measureLayout';
import type { Message } from '../src/domain/types';
import { ChatMessageList } from '../src/screens/ChatMessageList';
import { createMessageViewport, messageRowKey } from '../src/screens/messageListLayout';

// Exercise the installed recycler's real prepend correction, rather than the
// adapter double. Native layout/scroll arrival still require device acceptance.
test('an unaccepted local send makes the whole user row visible after inverted prepend layout', async () => {
  jest.useFakeTimers();
  const old: Message = { id: 'old-answer', conversation_id: 'chat', role: 'assistant',
    content: 'A long previous answer', created_at: '2026-10-28T00:00:00Z' };
  let messages = [old];
  let version = 0;
  const viewport = createMessageViewport();
  const height = (item: Message) => item.id === old.id ? 900 : 88;
  (measurements.measureParentSize as jest.Mock).mockImplementation(() => ({ width: 360, height: 640 }));
  (measurements.measureFirstChildLayout as jest.Mock).mockImplementation(() =>
    ({ x: 0, y: 24, width: 360, height: 640 }));
  (measurements.measureItemLayout as jest.Mock).mockImplementation((view: any) => ({
    x: 0, y: 0, width: 360, height: height(messages.slice().reverse()[view.props.index]),
  }));
  const render = () => <ChatMessageList messages={messages} viewport={viewport}
    latestVersion={version} renderItem={({ item }) => <Text>{item.content}</Text>}
    header={<Text>History</Text>} footer={<Text>Tail spacing</Text>}
    style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }} />;
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(render()); });
    const engine = () => tree.root.findByType(FlashList).props.ref.current as FlashListRef<Message>;
    const pane = () => tree.root.findAllByType(ScrollView).find(node => node.props.testID === 'chat-message-list')!;
    const native = async (y: number, contentHeight = engine().getChildContainerDimensions().height + 24) => {
      await act(async () => pane().props.onScroll({ nativeEvent: {
        contentOffset: { x: 0, y }, contentSize: { width: 360, height: contentHeight },
        layoutMeasurement: { width: 360, height: 640 }, zoomScale: 1,
        velocity: { x: 0, y: 0 },
      }, timeStamp: Date.now() }));
    };
    await act(async () => {
      pane().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 360, height: 640 } } });
      pane().props.onContentSizeChange(360, engine().getChildContainerDimensions().height + 24);
    });
    await native(0);
    await act(async () => { await jest.advanceTimersByTimeAsync(200); tree.update(render()); });
    const oldContentHeight = engine().getChildContainerDimensions().height + 24;
    const scrollTo = jest.spyOn(pane().instance, 'scrollTo');
    const user: Message = { ...old, id: 'local-user', client_key: 'local-user',
      role: 'user', content: 'Show this submitted prompt immediately', delivery: 'sending' };
    const assistant: Message = { ...old, id: 'local-assistant', client_key: 'local-assistant',
      content: '', stream_status: '发送中…' };
    messages = [...messages, user, assistant]; version++;
    await act(async () => { tree.update(render()); });
    // FlashList projects the same old-row shift that native MVCP applies after
    // the adapter's first offset-zero command. No server event has occurred.
    const afterPrepend = engine().getAbsoluteLastScrollOffset();
    await native(0, oldContentHeight);
    await native(afterPrepend);
    scrollTo.mockClear();
    await act(async () => pane().props.onContentSizeChange(360,
      engine().getChildContainerDimensions().height + 24));
    const finalCommand = scrollTo.mock.calls.at(-1)?.[0] as { y: number } | undefined;
    const nativeOffset = finalCommand?.y ?? afterPrepend;
    await native(nativeOffset);
    const index = engine().props.data!.findIndex(item => messageRowKey(item) === user.client_key);
    const row = engine().getLayout(index)!;
    const top = engine().getFirstItemOffset() + row.y;
    const visibleHeight = Math.max(0, Math.min(top + row.height, nativeOffset + 640) - Math.max(top, nativeOffset));
    expect(user.delivery).toBe('sending');
    expect(row.isHeightMeasured).toBe(true);
    expect(visibleHeight).toBe(row.height);
    expect(viewport.followTail).toBe(true);
  } finally {
    await act(async () => tree?.unmount());
    jest.clearAllTimers(); jest.useRealTimers();
  }
});

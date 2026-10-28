import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ListRenderItem,
  ScrollViewProps,
  StyleProp,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { FlashList, FlashListRef, ListRenderItem as FlashRenderItem } from '@shopify/flash-list';
import type { Message } from '../domain/types';
import {
  messageAnchorInset,
  messageInitialIndex,
  messageRowKey,
  MessageAnchor,
  MessageViewport,
} from './messageListLayout';

type Props = {
  messages: Message[];
  viewport: MessageViewport;
  latestVersion: number;
  hasOlder?: boolean;
  renderItem: ListRenderItem<Message>;
  header: React.ReactElement;
  footer: React.ReactElement;
  style: StyleProp<ViewStyle>;
  contentContainerStyle: StyleProp<ViewStyle>;
};
type ScrollPacket = Parameters<NonNullable<ScrollViewProps['onScroll']>>[0];
type Destination = { anchor: MessageAnchor } | { latest: true };
const separators = { highlight() {}, unhighlight() {}, updateProps() {} };
const maintainVisibleContentPosition = { disabled: false };

function rememberHeight(viewport: MessageViewport, item: Message, height: number) {
  const key = messageRowKey(item);
  const cached = viewport.heights.get(key);
  // A data render can precede the native text remeasurement. Keep the last
  // measured content/height pair until append growth actually changes height.
  if (cached && height === cached.height && item.role === 'assistant' &&
    item.content.length > cached.message.content.length &&
    item.content.startsWith(cached.message.content)) return;
  viewport.heights.set(key, { message: item, height });
}

export const ChatMessageList = memo(function ChatMessageListView(props: Props) {
  const { width, fontScale } = useWindowDimensions();
  const owner = useRef({ viewport: props.viewport, epoch: 0 });
  if (owner.current.viewport !== props.viewport)
    owner.current = { viewport: props.viewport, epoch: owner.current.epoch + 1 };
  const token = owner.current;
  const isCurrent = useCallback(() => owner.current === token, [token]);
  const messages = useMemo(() => props.messages.slice().reverse(), [props.messages]);
  return <MessageWindow key={token.epoch} {...props} messages={messages}
    layoutKey={`${width}:${fontScale}`} isCurrent={isCurrent} />;
});

function MessageWindow({ messages, viewport, latestVersion, renderItem, header,
  footer, style, contentContainerStyle, layoutKey, isCurrent,
}: Props & { layoutKey: string; isCurrent: () => boolean }) {
  const list = useRef<FlashListRef<Message>>(null);
  const active = useRef(true);
  const retained = viewport.anchor && messages.some(item =>
    messageRowKey(item) === viewport.anchor!.id) ? viewport.anchor : null;
  if (!retained) {
    viewport.anchor = null;
    viewport.pendingAppendAnchor = null;
  }
  const initial = useRef(retained && !viewport.followTail ? { ...retained } : null).current;
  const initialIndex = useRef(messageInitialIndex(messages, initial)).current;
  const target = useRef<Destination | null>(initial ? { anchor: initial } : { latest: true });
  const followTail = useRef(!initial);
  const interacting = useRef(false);
  const metrics = useRef({ width: 0, height: 0, contentHeight: 0 });
  // Only real scroll callbacks establish native arrival. Engine offsets can be
  // projected during layout and are useful for capture, never acknowledgment.
  const observed = useRef<number | null>(null);
  const observedAnchor = useRef<MessageAnchor | null>(null);
  const command = useRef<number | null>(null);
  const retainedDestination = target.current;
  if (retainedDestination && 'anchor' in retainedDestination && !messages.some(item =>
    messageRowKey(item) === retainedDestination.anchor.id)) {
    target.current = null;
    command.current = null;
    viewport.pendingAppendAnchor = null;
  }
  const current = useRef({ messages, layoutKey, latestVersion });
  const previous = current.current;
  current.current = { messages, layoutKey, latestVersion };
  if (viewport.layoutKey !== layoutKey) {
    if (viewport.layoutKey) list.current?.clearLayoutCacheOnUpdate();
    viewport.layoutKey = layoutKey;
    viewport.heights.clear();
    if (!interacting.current) target.current = followTail.current
      ? { latest: true } : viewport.anchor ? { anchor: { ...viewport.anchor } } : null;
    observed.current = null;
    observedAnchor.current = null;
    command.current = null;
  }
  if (previous.latestVersion !== latestVersion) {
    // An own-send is explicit latest intent, even while reading old history.
    // Keep this recycler mounted; offset zero needs no unknown older heights.
    followTail.current = true;
    interacting.current = false;
    viewport.followTail = true;
    viewport.anchor = null;
    viewport.pendingAppendAnchor = null;
    target.current = { latest: true };
    command.current = null;
    observed.current = null;
    observedAnchor.current = null;
  }
  const valid = useCallback(() => active.current && isCurrent() &&
    current.current.layoutKey === layoutKey &&
    current.current.latestVersion === latestVersion, [isCurrent, layoutKey, latestVersion]);

  const measuredAnchor = useCallback((y: number, preferred?: string): MessageAnchor | null => {
    const engine = list.current;
    if (!engine || metrics.current.height <= 0 || !engine.getLayout(0)) return null;
    const data = current.current.messages;
    const headerOffset = engine.getFirstItemOffset();
    const visible = engine.computeVisibleIndices();
    const anchorAt = (index: number) => {
      const item = data[index];
      const row = item && engine.getLayout(index);
      if (!row?.isHeightMeasured || row.height <= 0) return null;
      const top = headerOffset + row.y;
      return top + row.height > y && top < y + metrics.current.height
        ? { id: messageRowKey(item), offset: y - top } : null;
    };
    // Preserve the requested bottom-partial row if it is physically visible.
    // Estimated or offscreen layouts must never become saved reading intent.
    if (preferred) {
      const index = data.findIndex(item => messageRowKey(item) === preferred);
      if (index >= visible.startIndex && index <= visible.endIndex) {
        const anchor = anchorAt(index);
        if (anchor) return anchor;
      }
    }
    for (let index = Math.max(0, visible.startIndex);
      index <= Math.min(data.length - 1, visible.endIndex); index++) {
      const anchor = anchorAt(index);
      if (anchor) return anchor;
    }
    return null;
  }, []);

  const capture = useCallback((y: number, preferred?: string) => {
    viewport.y = y;
    viewport.followTail = followTail.current = y <= 2;
    const anchor = measuredAnchor(y, preferred);
    observedAnchor.current = anchor;
    if (anchor) {
      viewport.anchor = anchor;
      const index = current.current.messages.findIndex(item => messageRowKey(item) === anchor.id);
      const row = list.current?.getLayout(index);
      if (row?.isHeightMeasured) rememberHeight(viewport, current.current.messages[index], row.height);
    }
  }, [measuredAnchor, viewport]);

  const destinationOffset = useCallback((destination: Destination) => {
    if ('latest' in destination) return 0;
    const engine = list.current;
    const index = current.current.messages.findIndex(item =>
      messageRowKey(item) === destination.anchor.id);
    const row = index >= 0 && engine?.getLayout(index);
    if (!engine || !row || !row.isHeightMeasured || metrics.current.height <= 0)
      return null;
    const requested = engine.getFirstItemOffset() + row.y + messageAnchorInset(
      destination.anchor.offset, row.height, metrics.current.height);
    return Math.max(0, Math.min(requested,
      Math.max(0, metrics.current.contentHeight - metrics.current.height)));
  }, []);

  const restore = useCallback(() => {
    if (!valid() || interacting.current || !target.current ||
      !messages.length || metrics.current.height <= 0 || metrics.current.contentHeight <= 0)
      return;
    const offset = destinationOffset(target.current);
    if (offset === null) return;
    // No async index job, retry timer, native-event interception or forwarding.
    // FlashList owns progressive rendering and visible-position correction.
    if (command.current === null || Math.abs(command.current - offset) > 1) {
      command.current = offset;
      list.current?.scrollToOffset({ offset, animated: false });
    }
  }, [destinationOffset, messages.length, valid]);

  const commitLayout = useCallback(() => {
    if (!valid()) return;
    const anchor = target.current && 'anchor' in target.current
      ? target.current.anchor : viewport.anchor;
    const index = anchor ? messages.findIndex(item => messageRowKey(item) === anchor.id) : -1;
    const row = index >= 0 ? list.current?.getLayout(index) : undefined;
    const item = messages[index];
    if (anchor && item && row?.isHeightMeasured) {
      const cached = viewport.heights.get(anchor.id);
      // Inverted row growth moves the visual start of old text. Adjust only a
      // genuine appended assistant fragment, never estimates or unrelated rows.
      if (!followTail.current && !interacting.current && cached &&
        item.role === 'assistant' && row.height > cached.height &&
        item.content.length > cached.message.content.length &&
        item.content.startsWith(cached.message.content)) {
        const adjusted = { id: anchor.id, offset: anchor.offset + row.height - cached.height };
        viewport.anchor = adjusted;
        viewport.pendingAppendAnchor = adjusted;
        target.current = { anchor: adjusted };
        command.current = null;
        observed.current = null;
        observedAnchor.current = null;
      }
      rememberHeight(viewport, item, row.height);
    }
    if (followTail.current && !interacting.current) target.current = { latest: true };
    restore();
  }, [messages, restore, valid, viewport]);

  const scroll = useCallback((event: ScrollPacket) => {
    if (!valid()) return;
    const y = event.nativeEvent.contentOffset.y;
    if (!Number.isFinite(y)) return;
    const bounds = event.nativeEvent.layoutMeasurement;
    if (bounds && (Math.abs(bounds.width - metrics.current.width) > 1 ||
      Math.abs(bounds.height - metrics.current.height) > 1)) return;
    const contentHeight = event.nativeEvent.contentSize?.height;
    if (Number.isFinite(contentHeight) && Math.abs(contentHeight - metrics.current.contentHeight) > 1)
      return;
    const preferred = observed.current !== null && Math.abs(observed.current - y) <= 2
      ? viewport.anchor?.id : undefined;
    observed.current = y;
    const destination = target.current;
    observedAnchor.current = measuredAnchor(y,
      destination && 'anchor' in destination ? destination.anchor.id : preferred);
    if (destination) {
      const desired = destinationOffset(destination);
      if (desired === null || command.current === null || Math.abs(y - desired) > 2) return;
      const anchor = 'anchor' in destination
        ? measuredAnchor(y, destination.anchor.id) : measuredAnchor(y);
      if ('anchor' in destination && anchor?.id !== destination.anchor.id) return;
      target.current = null;
      viewport.pendingAppendAnchor = null;
      command.current = null;
      capture(y, anchor?.id);
    } else capture(y, preferred);
  }, [capture, destinationOffset, measuredAnchor, valid, viewport]);

  const takeControl = useCallback((event?: ScrollPacket) => {
    if (!valid()) return;
    target.current = null;
    viewport.pendingAppendAnchor = null;
    command.current = null;
    interacting.current = true;
    // A gesture without a packet still cancels pending tail/restore work.
    followTail.current = viewport.followTail = false;
    if (event?.nativeEvent?.contentOffset) scroll(event);
  }, [scroll, valid, viewport]);
  const finishInteraction = useCallback((event?: ScrollPacket) => {
    if (!valid()) return;
    takeControl(event);
    interacting.current = false;
    if (observed.current !== null) {
      viewport.y = observed.current;
      viewport.followTail = followTail.current = observed.current <= 2;
      if (observedAnchor.current) viewport.anchor = { ...observedAnchor.current };
    }
  }, [takeControl, valid, viewport]);

  useEffect(() => {
    active.current = true;
    viewport.followTail = followTail.current;
    return () => {
      // History can detach while an initial target is still settling. Prefer
      // the last actual visible measured row, while newer send/geometry intent
      // clears that observation and a replacement owner fences this cleanup.
      // An append's translated reading intent survives History, including a
      // wrong-offset packet showing another row while its command is pending.
      // Only matching measured arrival or explicit user control retires it.
      if (isCurrent() && !viewport.pendingAppendAnchor &&
        observed.current !== null && observedAnchor.current) {
        viewport.y = observed.current;
        viewport.followTail = followTail.current = observed.current <= 2;
        viewport.anchor = { ...observedAnchor.current };
      }
      active.current = false;
    };
  }, [isCurrent, viewport]);
  useEffect(() => { restore(); }, [latestVersion, restore]);

  const renderMessage = useCallback<FlashRenderItem<Message>>(({ item, index }) =>
    renderItem({ item, index, separators }), [renderItem]);
  const inverted = messages.length > 0;
  const firstItem = useMemo(() => <View>{inverted ? footer : header}</View>,
    [footer, header, inverted]);
  return <FlashList<Message>
    ref={list}
    testID="chat-message-list"
    data={messages}
    extraData={layoutKey}
    renderItem={renderMessage}
    keyExtractor={messageRowKey}
    getItemType={item => item.role}
    inverted={inverted}
    initialScrollIndex={messages.length ? initialIndex : undefined}
    initialScrollIndexParams={initial ? { viewOffset: initial.offset } : undefined}
    maintainVisibleContentPosition={maintainVisibleContentPosition}
    style={style}
    contentContainerStyle={contentContainerStyle}
    ListHeaderComponent={firstItem}
    ListFooterComponent={inverted ? header : footer}
    keyboardShouldPersistTaps="handled"
    onCommitLayoutEffect={commitLayout}
    onLoad={commitLayout}
    onLayout={event => {
      if (!valid()) return;
      const bounds = event.nativeEvent.layout;
      if (metrics.current.height > 0 && metrics.current.height !== bounds.height &&
        !interacting.current) {
        target.current = followTail.current ? { latest: true }
          : viewport.anchor ? { anchor: { ...viewport.anchor } } : null;
        command.current = null;
      }
      metrics.current.width = bounds.width;
      metrics.current.height = bounds.height;
      restore();
    }}
    onContentSizeChange={(_width, height) => {
      if (!valid()) return;
      metrics.current.contentHeight = height;
      commitLayout();
    }}
    onScroll={scroll}
    onScrollBeginDrag={takeControl}
    onScrollEndDrag={finishInteraction}
    onMomentumScrollBegin={takeControl}
    onMomentumScrollEnd={finishInteraction}
    scrollEventThrottle={16}
  />;
}

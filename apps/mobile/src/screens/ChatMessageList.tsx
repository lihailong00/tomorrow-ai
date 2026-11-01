import React, { memo, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  ListRenderItem,
  Pressable,
  ScrollViewProps,
  StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { FlashList, FlashListRef, ListRenderItem as FlashRenderItem } from '@shopify/flash-list';
import type { Message } from '../domain/types';
import { Text } from '../ui/Text';
import { Icon } from '../ui/visuals';
import { chatAppearance } from '../ui/ChatAppearance';
import { ChatReadingRow, formatReadingCharacters, isReadingStream, unreadReadingCharacters,
  type ReadingRegistry } from '../ui/ChatReadingMetrics';
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
// Inverted short collections put this SDK adjustment on the visual bottom,
// keeping the oldest visible message next to the header without a spacer.
const invertedMaintainVisibleContentPosition = { disabled: false, startRenderingFromBottom: true };

type ReadingSnapshot = { offset: number; unread: number | null; streamKey: string | null };
function createReadingState(offset: number) {
  let snapshot: ReadingSnapshot = { offset, unread: null, streamKey: null };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: ReadingSnapshot) => {
      if (next.offset === snapshot.offset && next.unread === snapshot.unread && next.streamKey === snapshot.streamKey) return;
      snapshot = next;
      listeners.forEach(listener => listener());
    },
  };
}

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

const ReadingMessage = memo(function ReadingMessage({ item, index, renderItem, geometry, registry, valid }: {
  item: Message; index: number; renderItem: ListRenderItem<Message>;
  geometry: string; registry: ReadingRegistry; valid: () => boolean;
}) {
  const key = messageRowKey(item);
  const tracked = useRef({ key, enabled: false });
  if (tracked.current.key !== key) tracked.current = { key, enabled: false };
  if (isReadingStream(item)) tracked.current.enabled = true;
  const content = renderItem({ item, index, separators });
  // History rows never need native line measurement. Once a live reply is
  // tracked, keep its native hierarchy unchanged when generation completes.
  return tracked.current.enabled ? <ChatReadingRow message={item} geometry={geometry}
    registry={registry} valid={valid}>{content}</ChatReadingRow> : content;
});

export const ChatMessageList = memo(function ChatMessageListView(props: Props) {
  const { width, fontScale } = useWindowDimensions();
  const owner = useRef({ viewport: props.viewport, latestVersion: props.latestVersion, epoch: 0 });
  if (owner.current.viewport !== props.viewport || owner.current.latestVersion !== props.latestVersion) {
    if (owner.current.viewport === props.viewport) {
      // Own-send starts a fresh latest window. Retire the old recycler before
      // cleanup so its MVCP projection cannot compete with a native-only jump.
      props.viewport.anchor = null;
      props.viewport.pendingAppendAnchor = null;
      props.viewport.followTail = true;
    }
    owner.current = { viewport: props.viewport, latestVersion: props.latestVersion,
      epoch: owner.current.epoch + 1 };
  }
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
  const readingState = useRef(createReadingState(viewport.y)).current;
  const registry = useRef<ReadingRegistry>({ rows: new Map(), notify: () => {} }).current;
  const retainedDestination = target.current;
  if (retainedDestination && 'anchor' in retainedDestination && !messages.some(item =>
    messageRowKey(item) === retainedDestination.anchor.id)) {
    target.current = null;
    command.current = null;
    viewport.pendingAppendAnchor = null;
  }
  const streamIndex = messages.findIndex(isReadingStream);
  const current = useRef({ messages, layoutKey, latestVersion, streamIndex });
  current.current = { messages, layoutKey, latestVersion, streamIndex };
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
  const valid = useCallback(() => active.current && isCurrent() &&
    current.current.layoutKey === layoutKey &&
    current.current.latestVersion === latestVersion, [isCurrent, layoutKey, latestVersion]);
  const refreshReading = useCallback(() => {
    if (!valid()) return;
    const engine = list.current;
    const offset = observed.current ?? viewport.y;
    const streamIndex = current.current.streamIndex;
    const stream = current.current.messages[streamIndex];
    const streamKey = stream ? messageRowKey(stream) : null;
    const unread = observed.current !== null && engine && stream ? unreadReadingCharacters(stream,
      registry.rows.get(messageRowKey(stream)), layoutKey, engine.getLayout(streamIndex),
      engine.getFirstItemOffset(), offset) : null;
    const previous = readingState.getSnapshot();
    readingState.update({ offset, streamKey, unread: stream && unread === null && streamKey === previous.streamKey
      ? previous.unread : unread });
  }, [layoutKey, readingState, registry, valid, viewport]);
  registry.notify = refreshReading;

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
    viewport.followTail = followTail.current = y <= 2 && current.current.streamIndex < 0;
    const anchor = measuredAnchor(y, preferred);
    observedAnchor.current = anchor;
    if (anchor) {
      viewport.anchor = anchor;
      const index = current.current.messages.findIndex(item => messageRowKey(item) === anchor.id);
      const row = list.current?.getLayout(index);
      if (row?.isHeightMeasured) rememberHeight(viewport, current.current.messages[index], row.height);
    }
    refreshReading();
  }, [measuredAnchor, refreshReading, viewport]);

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
    // Initial/send positioning is a one-time intent. As soon as a streamed row
    // is measured, retain its reading location even without an initial zero packet.
    if (followTail.current && !interacting.current) {
      const streamIndex = messages.findIndex(isReadingStream);
      const stream = messages[streamIndex];
      const frame = stream && list.current?.getLayout(streamIndex);
      if (stream && frame?.isHeightMeasured) {
        const anchor = viewport.anchor ?? observedAnchor.current ??
          (target.current && 'latest' in target.current ? { id: messageRowKey(stream),
            offset: -(list.current!.getFirstItemOffset() + frame.y) } : null);
        if (anchor) {
          followTail.current = viewport.followTail = false;
          viewport.anchor = anchor;
          target.current = { anchor: { ...anchor } };
          command.current = null;
        }
      }
    }
    const anchor = target.current && 'latest' in target.current ? null
      : target.current && 'anchor' in target.current ? target.current.anchor : viewport.anchor;
    const index = anchor ? messages.findIndex(item => messageRowKey(item) === anchor.id) : -1;
    const row = index >= 0 ? list.current?.getLayout(index) : undefined;
    const item = messages[index];
    if (anchor && item && row?.isHeightMeasured) {
      const cached = viewport.heights.get(anchor.id);
      // Inverted row growth moves the visual start of old text. Adjust only a
      // genuine appended assistant fragment, never estimates or unrelated rows.
      if (!followTail.current && !interacting.current && cached &&
        item.role === 'assistant' && row.height !== cached.height &&
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
    refreshReading();
  }, [messages, refreshReading, restore, valid, viewport]);

  const scroll = useCallback((event: ScrollPacket) => {
    if (!valid()) return;
    const y = event.nativeEvent.contentOffset.y;
    if (!Number.isFinite(y)) return;
    const bounds = event.nativeEvent.layoutMeasurement;
    if (bounds && (Math.abs(bounds.width - metrics.current.width) > 1 ||
      Math.abs(bounds.height - metrics.current.height) > 1)) return;
    const contentHeight = event.nativeEvent.contentSize?.height;
    // FlashList's progressive total size and RN's content-size callback are
    // independent of a real user's measured visible row. A lagging callback
    // must not freeze reading capture at an older message. Size agreement is
    // still required to acknowledge our own pending programmatic destination.
    if (target.current && Number.isFinite(contentHeight) &&
      Math.abs(contentHeight - metrics.current.contentHeight) > 1)
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
      viewport.followTail = followTail.current = observed.current <= 2 && current.current.streamIndex < 0;
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
        viewport.followTail = followTail.current = observed.current <= 2 && current.current.streamIndex < 0;
        viewport.anchor = { ...observedAnchor.current };
      }
      active.current = false;
    };
  }, [isCurrent, viewport]);
  useEffect(() => { restore(); }, [latestVersion, restore]);
  useEffect(() => { refreshReading(); }, [messages, refreshReading]);

  const renderMessage = useCallback<FlashRenderItem<Message>>(({ item, index, target }) => {
    // Offscreen measurement/sticky copies must never replace the visible row's metrics.
    if (target && target !== 'Cell') return renderItem({ item, index, separators });
    return <ReadingMessage item={item} index={index} renderItem={renderItem}
      geometry={layoutKey} registry={registry} valid={valid} />;
  }, [renderItem, layoutKey, registry, valid]);
  const inverted = messages.length > 0;
  const firstItem = useMemo(() => <View>{inverted ? footer : header}</View>,
    [footer, header, inverted]);
  const streaming = streamIndex >= 0;
  const jumpToLatest = () => {
    if (!valid()) return;
    interacting.current = false;
    target.current = { latest: true };
    viewport.pendingAppendAnchor = null;
    command.current = null;
    // Arrival is acknowledged by the next native packet. Later streamed text
    // keeps that new reading location; this action never enables auto-follow.
    restore();
  };
  return <View style={readingStyles.container}>
    <FlashList<Message>
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
    maintainVisibleContentPosition={inverted ? invertedMaintainVisibleContentPosition : maintainVisibleContentPosition}
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
    />
    <UnreadIndicator state={readingState} streaming={streaming} jump={jumpToLatest} />
  </View>;
}

function UnreadIndicator({ state, streaming, jump }: {
  state: ReturnType<typeof createReadingState>; streaming: boolean; jump: () => void;
}) {
  const reading = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const showCount = streaming && reading.unread !== null && reading.unread > 0;
  return reading.offset > 2 ? <Pressable testID="chat-unread-jump"
      accessibilityRole="button"
      accessibilityLabel={showCount ? `下方还有${reading.unread}字，跳到最新内容` : '回到最新内容'}
      onPress={jump}
      style={[readingStyles.jump, !showCount && readingStyles.circle]}>
      <View style={readingStyles.arrow}><Icon name="arrowUp" size={17} color={chatAppearance.accent} /></View>
      {showCount && <Text testID="chat-unread-count" style={readingStyles.count}>
        {formatReadingCharacters(reading.unread!)}
      </Text>}
    </Pressable> : null;
}

const readingStyles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  jump: { position: 'absolute', right: 16, bottom: 14, minHeight: 44, minWidth: 44,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 24,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: chatAppearance.surface, borderWidth: StyleSheet.hairlineWidth,
    borderColor: chatAppearance.line, elevation: 3,
    shadowColor: chatAppearance.ink, shadowOpacity: 0.08, shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 } },
  circle: { width: 44, paddingHorizontal: 0 },
  arrow: { transform: [{ rotate: '180deg' }] },
  count: { color: chatAppearance.accent, fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] },
});

import React, {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  FlatList,
  LayoutChangeEvent,
  ListRenderItem,
  StyleProp,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import type { CellRendererProps } from '@react-native/virtualized-lists';
import type { Message } from '../domain/types';
import {
  messageAnchorAt,
  messageInitialIndex,
  messageRowKey,
  MessageAnchor,
  MessageViewport,
} from './messageListLayout';

const Measurements = createContext<{
  layout: (message: Message, event: LayoutChangeEvent) => void;
  remove: (id: string) => void;
} | null>(null);

const MessageCell = memo(function MessageCell({
  item,
  children,
  onLayout,
  onFocusCapture,
  style,
}: CellRendererProps<Message>) {
  const measurements = useContext(Measurements)!;
  const rowKey = messageRowKey(item);
  useEffect(() => () => measurements.remove(rowKey), [rowKey, measurements]);
  return (
    <View
      collapsable={false}
      style={style}
      {...{ onFocusCapture }}
      onLayout={event => {
        // Native VirtualizedList measurements remain authoritative. Never supply
        // an estimated getItemLayout for a variable-height message.
        onLayout?.(event);
        measurements.layout(item, event);
      }}
    >
      {children}
    </View>
  );
});

type Props = {
  messages: Message[];
  viewport: MessageViewport;
  latestVersion: number;
  renderItem: ListRenderItem<Message>;
  header: React.ReactElement;
  footer: React.ReactElement;
  style: StyleProp<ViewStyle>;
  contentContainerStyle: StyleProp<ViewStyle>;
};

export const ChatMessageList = memo(function ChatMessageList(props: Props) {
  const { width, fontScale } = useWindowDimensions();
  const layoutKey = `${width}:${fontScale}`;
  const owner = useRef({ viewport: props.viewport, epoch: 0 });
  if (owner.current.viewport !== props.viewport) {
    owner.current = {
      viewport: props.viewport,
      epoch: owner.current.epoch + 1,
    };
  }
  // Latest is native offset zero. Unknown older heights never participate in
  // finding the bottom, including while a streaming reply grows.
  const ordered = useMemo(
    () => props.messages.slice().reverse(),
    [props.messages],
  );
  return (
    <MessageWindow
      key={`${owner.current.epoch}:${
        props.messages.length ? 'messages' : 'empty'
      }:${layoutKey}:${props.latestVersion}`}
      {...props}
      messages={ordered}
      layoutKey={layoutKey}
    />
  );
});

function MessageWindow({
  messages,
  viewport,
  renderItem,
  header,
  footer,
  style,
  contentContainerStyle,
  layoutKey,
}: Props & { layoutKey: string }) {
  if (viewport.layoutKey !== layoutKey) {
    viewport.layoutKey = layoutKey;
    viewport.heights.clear();
  }
  const retained =
    viewport.anchor &&
    messages.some(message => messageRowKey(message) === viewport.anchor?.id)
      ? viewport.anchor
      : null;
  if (!retained) viewport.anchor = null;
  const initialAnchor = useRef(
    retained && !viewport.followTail ? { ...retained } : null,
  ).current;
  const initialIndex = useRef(
    messageInitialIndex(messages, initialAnchor),
  ).current;
  const list = useRef<FlatList<Message>>(null);
  const frames = useRef(new Map<string, { y: number; height: number }>());
  const current = useRef({ messages, viewport, layoutKey });
  current.current = { messages, viewport, layoutKey };
  const active = useRef(true);
  const interacting = useRef(false);
  const dragging = useRef(false);
  const momentum = useRef(false);
  const endDragFrame = useRef<number | null>(null);
  const followTail = useRef(!initialAnchor);
  const target = useRef<{ anchor: MessageAnchor } | { latest: true } | null>(
    initialAnchor ? { anchor: { ...initialAnchor } } : { latest: true },
  );
  const metrics = useRef({
    contentHeight: 0,
    viewportHeight: 0,
    headHeight: 0,
    headMeasured: false,
  });
  const observed = useRef<number | null>(null);
  const settleFrame = useRef<number | null>(null);
  const [geometry, setGeometry] = useState(0);
  const cancelSettle = useCallback(() => {
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = null;
  }, []);
  const valid = useCallback(
    () => active.current && current.current.viewport.layoutKey === layoutKey,
    [layoutKey],
  );
  const verifyArrival = useCallback(() => {
    cancelSettle();
    const destination = target.current;
    if (!destination) return;
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = requestAnimationFrame(() => {
        settleFrame.current = null;
        if (
          !valid() ||
          target.current !== destination ||
          observed.current === null
        )
          return;
        const dimensions = metrics.current;
        if (
          !dimensions.headMeasured ||
          dimensions.viewportHeight <= 0 ||
          dimensions.contentHeight <= 0
        )
          return;
        const frame =
          'anchor' in destination
            ? frames.current.get(destination.anchor.id)
            : null;
        if (
          'anchor' in destination &&
          (!frame || (initialIndex > 0 && frame.y <= dimensions.headHeight + 1))
        )
          return;
        if (
          'latest' in destination &&
          (!current.current.messages.length ||
            !frames.current.has(messageRowKey(current.current.messages[0])))
        )
          return;
        const requested =
          frame && 'anchor' in destination
            ? Math.max(
                0,
                frame.y +
                  Math.min(
                    destination.anchor.offset,
                    Math.max(0, frame.height - 1),
                  ),
              )
            : 0;
        const maxOffset = Math.max(
          0,
          dimensions.contentHeight - dimensions.viewportHeight,
        );
        // Before RN has measured the older tail, a clamped scroll merely wakes
        // its next render batch. It is not proof of arrival. At the true oldest
        // row, however, a taller viewport may make the old inset unreachable.
        if (
          requested > maxOffset &&
          !frames.current.has(messageRowKey(current.current.messages.at(-1)!))
        )
          return;
        const desired = Math.min(requested, maxOffset);
        if (Math.abs(observed.current - desired) > 2) return;
        target.current = null;
        current.current.viewport.anchor =
          messageAnchorAt(observed.current, frames.current) ??
          current.current.viewport.anchor;
      });
    });
  }, [cancelSettle, initialIndex, valid]);
  const restore = useCallback(() => {
    cancelSettle();
    if (
      !valid() ||
      interacting.current ||
      !target.current ||
      !current.current.messages.length
    )
      return;
    const destination = target.current;
    const dimensions = metrics.current;
    if (
      !dimensions.headMeasured ||
      dimensions.viewportHeight <= 0 ||
      dimensions.contentHeight <= 0
    )
      return;
    let offset = 0;
    if ('anchor' in destination) {
      const frame = frames.current.get(destination.anchor.id);
      if (!frame) return;
      // A deep initial region first lays out beside a zero-height spacer. Wait
      // until RN's own measured average has produced the actual native prefix.
      // contentOffset below suppresses its one-shot, premature index scroll.
      if (initialIndex > 0 && frame.y <= dimensions.headHeight + 1) return;
      const inset = Math.min(
        destination.anchor.offset,
        Math.max(0, frame.height - 1),
      );
      current.current.viewport.anchor = {
        id: destination.anchor.id,
        offset: inset,
      };
      offset = Math.max(0, frame.y + inset);
    } else if (!frames.current.has(messageRowKey(current.current.messages[0])))
      return;
    list.current?.scrollToOffset({
      offset: Math.min(
        offset,
        Math.max(0, dimensions.contentHeight - dimensions.viewportHeight),
      ),
      animated: false,
    });
    // Geometry being quiet alone is insufficient. Retire a target only after a
    // native scroll event reports arrival at its current, measured destination.
    verifyArrival();
  }, [cancelSettle, initialIndex, valid, verifyArrival]);
  useEffect(() => {
    active.current = true;
    viewport.followTail = followTail.current;
    return () => {
      active.current = false;
      cancelSettle();
      if (endDragFrame.current !== null)
        cancelAnimationFrame(endDragFrame.current);
    };
  }, [cancelSettle, viewport]);
  const measurements = useMemo(
    () => ({
      layout: (message: Message, event: LayoutChangeEvent) => {
        if (!valid()) return;
        const { y, height } = event.nativeEvent.layout;
        const key = messageRowKey(message);
        const previous = frames.current.get(key);
        const cached = current.current.viewport.heights.get(key);
        const anchor = current.current.viewport.anchor;
        // In an inverted cell, appended text moves its visual top while native
        // MVCP sees the same row.y. Keep previously read text in place only for
        // genuine append growth inside the anchor, including hidden growth.
        // Other rows and prepend position deltas remain native MVCP's job.
        if (
          !followTail.current &&
          !interacting.current &&
          anchor?.id === key &&
          cached &&
          message.role === 'assistant' &&
          height > cached.height &&
          message.content.length > cached.message.content.length &&
          message.content.startsWith(cached.message.content)
        ) {
          const adjusted = {
            id: key,
            offset: anchor.offset + height - cached.height,
          };
          current.current.viewport.anchor = adjusted;
          target.current = { anchor: adjusted };
          observed.current = null;
        }
        frames.current.set(key, { y, height });
        current.current.viewport.heights.set(key, { message, height });
        if (!previous || previous.y !== y || previous.height !== height) {
          // This render lets RN recalculate its own spacer after its first native
          // cell measurements, without falsely declaring estimated row lengths.
          setGeometry(value => value + 1);
        }
        if (followTail.current && !interacting.current)
          target.current = { latest: true };
        restore();
      },
      remove: (id: string) => {
        frames.current.delete(id);
      },
    }),
    [restore, valid],
  );
  useEffect(() => {
    if (followTail.current && !interacting.current)
      target.current = { latest: true };
    restore();
  }, [geometry, messages, restore]);
  const headLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (!valid()) return;
      const height = event.nativeEvent.layout.height;
      viewport.headerHeight = height;
      metrics.current.headMeasured = true;
      if (metrics.current.headHeight !== height) {
        metrics.current.headHeight = height;
        setGeometry(value => value + 1);
      }
      restore();
    },
    [restore, valid, viewport],
  );
  const inverted = messages.length > 0;
  const finishInteraction = () => {
    interacting.current = false;
    followTail.current = observed.current !== null && observed.current <= 2;
    viewport.followTail = followTail.current;
    if (observed.current !== null)
      viewport.anchor =
        messageAnchorAt(observed.current, frames.current) ?? viewport.anchor;
  };
  return (
    <Measurements.Provider value={measurements}>
      <FlatList<Message>
        ref={list}
        testID="chat-message-list"
        style={style}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        data={messages}
        renderItem={renderItem}
        keyExtractor={messageRowKey}
        inverted={inverted}
        CellRendererComponent={MessageCell}
        ListHeaderComponent={
          <View onLayout={headLayout}>{inverted ? footer : header}</View>
        }
        ListFooterComponent={inverted ? header : footer}
        initialScrollIndex={messages.length ? initialIndex : undefined}
        contentOffset={{ x: 0, y: 0 }}
        onScrollToIndexFailed={restore}
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews={false}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onLayout={event => {
          if (!valid()) return;
          metrics.current.viewportHeight = event.nativeEvent.layout.height;
          restore();
        }}
        onScrollBeginDrag={() => {
          if (!valid()) return;
          dragging.current = true;
          momentum.current = false;
          if (endDragFrame.current !== null)
            cancelAnimationFrame(endDragFrame.current);
          endDragFrame.current = null;
          interacting.current = true;
          followTail.current = false;
          viewport.followTail = false;
          target.current = null;
          cancelSettle();
        }}
        onScrollEndDrag={() => {
          if (!valid()) return;
          dragging.current = false;
          // Momentum starts after end-drag; let the gesture retain control
          // through that transition and any concurrent streaming layouts.
          if (endDragFrame.current !== null)
            cancelAnimationFrame(endDragFrame.current);
          endDragFrame.current = requestAnimationFrame(() => {
            endDragFrame.current = null;
            if (valid() && !momentum.current && !dragging.current)
              finishInteraction();
          });
        }}
        onMomentumScrollBegin={() => {
          if (!valid()) return;
          momentum.current = true;
          interacting.current = true;
        }}
        onMomentumScrollEnd={() => {
          if (!valid()) return;
          momentum.current = false;
          if (endDragFrame.current !== null)
            cancelAnimationFrame(endDragFrame.current);
          endDragFrame.current = null;
          if (valid() && !dragging.current) finishInteraction();
        }}
        onScroll={event => {
          if (!valid()) return;
          const y = event.nativeEvent.contentOffset.y;
          observed.current = y;
          viewport.y = y;
          if (target.current) {
            verifyArrival();
            return;
          }
          if (!interacting.current) {
            followTail.current = y <= 2;
            viewport.followTail = followTail.current;
          }
          viewport.anchor =
            messageAnchorAt(y, frames.current) ?? viewport.anchor;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          if (!valid()) return;
          metrics.current.contentHeight = height;
          if (followTail.current && !interacting.current)
            target.current = { latest: true };
          restore();
        }}
      />
    </Measurements.Provider>
  );
}

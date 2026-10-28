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
  ScrollView,
  ScrollViewProps,
  StyleProp,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import type { CellRendererProps } from '@react-native/virtualized-lists';
import type { Message } from '../domain/types';
import {
  messageAnchorAt,
  messageAnchorInset,
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
  hasOlder?: boolean;
  renderItem: ListRenderItem<Message>;
  header: React.ReactElement;
  footer: React.ReactElement;
  style: StyleProp<ViewStyle>;
  contentContainerStyle: StyleProp<ViewStyle>;
};

function pendingHistoryHeader(header: React.ReactElement) {
  const element = header as React.ReactElement<{ children?: React.ReactNode }>;
  return React.cloneElement(element, {
    ...{
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    },
    children: React.Children.map(element.props.children, child => {
      if (
        !React.isValidElement<{
          onPress?: () => void;
          disabled?: boolean;
          children?: React.ReactNode;
        }>(child) ||
        typeof child.props.onPress !== 'function'
      )
        return child;
      return React.cloneElement(child, {
        disabled: true,
        onPress: () => {},
        children: '正在加载…',
      });
    }),
  });
}

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
  const windowKey = `${owner.current.epoch}:${
    props.messages.length ? 'messages' : 'empty'
  }:${layoutKey}:${props.latestVersion}`;
  const liveWindow = useRef(windowKey);
  liveWindow.current = windowKey;
  const isCurrent = useCallback(
    () => liveWindow.current === windowKey,
    [windowKey],
  );
  return (
    <MessageWindow
      key={windowKey}
      {...props}
      messages={ordered}
      layoutKey={layoutKey}
      isCurrent={isCurrent}
    />
  );
});

function MessageWindow({
  messages,
  viewport,
  hasOlder,
  renderItem,
  header,
  footer,
  style,
  contentContainerStyle,
  layoutKey,
  isCurrent,
}: Props & { layoutKey: string; isCurrent: () => boolean }) {
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
  const current = useRef({ messages, viewport, layoutKey, hasOlder });
  current.current = { messages, viewport, layoutKey, hasOlder };
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
    tailHeight: 0,
  });
  const observed = useRef<number | null>(null);
  const settleFrame = useRef<number | null>(null);
  const bootstrap = useRef({
    pending: initialIndex > 0,
    commandOffset: null as number | null,
    retryFrame: null as number | null,
  });
  const settledRestoration = useRef<{
    anchor: MessageAnchor;
    frame: { y: number; height: number };
    y: number;
    contentHeight: number;
    viewportHeight: number;
    awaitingFrame: boolean;
  } | null>(null);
  const userScrollFrame = useRef<number | null>(null);
  const [geometry, setGeometry] = useState(0);
  const oldestKey = messages.length ? messageRowKey(messages.at(-1)!) : null;
  const firstKey = messages.length ? messageRowKey(messages[0]) : null;
  const priorHistory = useRef({
    header,
    hasOlder,
    oldestKey,
    firstKey,
    count: messages.length,
  });
  const unmeasuredOlderTail = useRef<string | null>(null);
  const heldHistory = useRef<{
    header: React.ReactElement;
    oldestKey: string;
    height: number;
    y: number;
    anchor: MessageAnchor | null;
    interacted: boolean;
  } | null>(null);
  if (
    messages.length > priorHistory.current.count &&
    firstKey === priorHistory.current.firstKey &&
    oldestKey !== priorHistory.current.oldestKey
  )
    unmeasuredOlderTail.current = oldestKey;
  if (
    priorHistory.current.hasOlder === true &&
    hasOlder === false &&
    oldestKey &&
    unmeasuredOlderTail.current === oldestKey &&
    metrics.current.tailHeight > 0 &&
    !followTail.current
  ) {
    // Removing the control before new native tail cells exist temporarily
    // shrinks Android's scroll range. Keep the real control disabled until the
    // added body has committed; no permanent spacer or obsolete action remains.
    heldHistory.current = {
      header: pendingHistoryHeader(priorHistory.current.header),
      oldestKey,
      height: metrics.current.tailHeight,
      y: observed.current ?? viewport.y,
      anchor: viewport.anchor ? { ...viewport.anchor } : null,
      interacted: interacting.current,
    };
  }
  priorHistory.current = {
    header,
    hasOlder,
    oldestKey,
    firstKey,
    count: messages.length,
  };
  const cancelSettle = useCallback(() => {
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = null;
  }, []);
  const valid = useCallback(
    () =>
      active.current &&
      isCurrent() &&
      current.current.viewport.layoutKey === layoutKey,
    [layoutKey, isCurrent],
  );
  const restoreAfterGeometry = useCallback((nativePacket = false, confirmedGeometry = false, confirmedFrame = false) => {
    const settled = settledRestoration.current;
    if (
      !valid() || !settled || target.current ||
      followTail.current || interacting.current
    ) return false;
    const frame = frames.current.get(settled.anchor.id);
    if (!frame) return false;
    const requested = Math.max(0, frame.y + messageAnchorInset(
        settled.anchor.offset, frame.height, metrics.current.viewportHeight,
      ));
    const offset = Math.min(
      requested,
      Math.max(0, metrics.current.contentHeight - metrics.current.viewportHeight),
    );
    // A size change elsewhere may leave this row exactly where it already was.
    // Do not wait for an event from a no-op scroll. A real current native packet
    // can itself prove arrival when its geometry marker changes.
    if (!nativePacket && observed.current !== null && Math.abs(observed.current - offset) <= 2) {
      const oldest = frames.current.get(messageRowKey(current.current.messages.at(-1)!));
      if (
        confirmedGeometry && metrics.current.contentHeight + 1 >= frame.y + frame.height &&
        (requested <= offset || (oldest && metrics.current.contentHeight + 1 >=
          oldest.y + oldest.height + metrics.current.tailHeight))
      ) settledRestoration.current = {
        anchor: { ...settled.anchor }, frame: { ...frame }, y: observed.current,
        contentHeight: metrics.current.contentHeight,
        viewportHeight: metrics.current.viewportHeight,
        awaitingFrame: !confirmedFrame && (
          settled.awaitingFrame || settled.contentHeight !== metrics.current.contentHeight ||
          settled.viewportHeight !== metrics.current.viewportHeight
        ),
      };
      return false;
    }
    if (userScrollFrame.current !== null) cancelAnimationFrame(userScrollFrame.current);
    userScrollFrame.current = null;
    current.current.viewport.anchor = { ...settled.anchor };
    target.current = { anchor: { ...settled.anchor } };
    observed.current = null;
    bootstrap.current.pending = true;
    bootstrap.current.commandOffset = null;
    return true;
  }, [valid]);
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
                  messageAnchorInset(
                    destination.anchor.offset,
                    frame.height,
                    dimensions.viewportHeight,
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
        if (requested > maxOffset) {
          const oldest = frames.current.get(
            messageRowKey(current.current.messages.at(-1)!),
          );
          // Cell layout and content size can arrive in different native batches.
          // Existence of the last row alone does not prove the end is committed.
          if (
            !oldest ||
            dimensions.contentHeight + 1 <
              oldest.y + oldest.height + dimensions.tailHeight
          )
            return;
        }
        const desired = Math.min(requested, maxOffset);
        if (Math.abs(observed.current - desired) > 2) return;
        target.current = null;
        const visible = messageAnchorAt(
          observed.current, frames.current, dimensions.viewportHeight,
        ) ?? current.current.viewport.anchor;
        current.current.viewport.anchor = visible;
        const visibleFrame = visible && frames.current.get(visible.id);
        settledRestoration.current = 'anchor' in destination && visible && visibleFrame
          ? {
              anchor: { ...visible }, frame: { ...visibleFrame },
              y: observed.current, contentHeight: dimensions.contentHeight,
              viewportHeight: dimensions.viewportHeight,
              awaitingFrame: false,
            }
          : null;
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
      const inset = messageAnchorInset(
        destination.anchor.offset,
        frame.height,
        dimensions.viewportHeight,
      );
      current.current.viewport.anchor = {
        id: destination.anchor.id,
        offset: inset,
      };
      offset = Math.max(0, frame.y + inset);
    } else if (!frames.current.has(messageRowKey(current.current.messages[0])))
      return;
    const commandOffset = Math.min(
      offset,
      Math.max(0, dimensions.contentHeight - dimensions.viewportHeight),
    );
    bootstrap.current.commandOffset = commandOffset;
    list.current?.scrollToOffset({
      offset: commandOffset,
      animated: false,
    });
    // Geometry being quiet alone is insufficient. Retire a target only after a
    // native scroll event reports arrival at its current, measured destination.
    verifyArrival();
  }, [cancelSettle, initialIndex, valid, verifyArrival]);
  const releaseHistory = useCallback(() => {
    const held = heldHistory.current;
    if (!valid() || !held) return;
    const end = frames.current.get(held.oldestKey);
    if (
      !end ||
      metrics.current.contentHeight + 1 < end.y + end.height + held.height
    )
      return;
    heldHistory.current = null;
    unmeasuredOlderTail.current = null;
    if (
      !held.interacted &&
      held.anchor &&
      !followTail.current &&
      !interacting.current
    ) {
      target.current = { anchor: held.anchor };
      observed.current = null;
    }
    // All added native rows now exist. Usually the old offset fits after the
    // control disappears; genuinely shorter final content uses normal end clamp.
    setGeometry(value => value + 1);
  }, [valid]);
  useEffect(() => {
    active.current = true;
    viewport.followTail = followTail.current;
    return () => {
      // History can detach during an accessibility scroll or delayed restore,
      // even when no begin-drag reached this window. Preserve the last actual
      // visible native row, not the pending destination from a prior viewport.
      // A newer owner/reflow/send window must keep its own retained intent.
      if (
        valid() &&
        observed.current !== null &&
        metrics.current.viewportHeight > 0
      ) {
        const visible = messageAnchorAt(
          observed.current,
          frames.current,
          metrics.current.viewportHeight,
        );
        if (visible) {
          viewport.anchor = visible;
          viewport.followTail = observed.current <= 2;
        }
      }
      active.current = false;
      cancelSettle();
      if (endDragFrame.current !== null)
        cancelAnimationFrame(endDragFrame.current);
      if (bootstrap.current.retryFrame !== null)
        cancelAnimationFrame(bootstrap.current.retryFrame);
      if (userScrollFrame.current !== null)
        cancelAnimationFrame(userScrollFrame.current);
    };
  }, [cancelSettle, viewport, valid]);
  const measurements = useMemo(
    () => ({
      layout: (message: Message, event: LayoutChangeEvent) => {
        if (!valid()) return;
        const { y, height } = event.nativeEvent.layout;
        const key = messageRowKey(message);
        const previous = frames.current.get(key);
        const cached = current.current.viewport.heights.get(key);
        frames.current.set(key, { y, height });
        const settled = settledRestoration.current;
        if (settled?.anchor.id === key) {
          if (
            userScrollFrame.current !== null &&
            settled.frame.y === y && settled.frame.height === height
          ) {
            cancelAnimationFrame(userScrollFrame.current);
            userScrollFrame.current = null;
            settledRestoration.current = null;
          } else restoreAfterGeometry(false, true, true);
        }
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
        if (
          unmeasuredOlderTail.current === key &&
          current.current.hasOlder !== false
        ) {
          unmeasuredOlderTail.current = null;
        }
        current.current.viewport.heights.set(key, { message, height });
        if (!previous || previous.y !== y || previous.height !== height) {
          // This render lets RN recalculate its own spacer after its first native
          // cell measurements, without falsely declaring estimated row lengths.
          setGeometry(value => value + 1);
        }
        if (followTail.current && !interacting.current)
          target.current = { latest: true };
        releaseHistory();
        restore();
      },
      remove: (id: string) => {
        frames.current.delete(id);
      },
    }),
    [restore, valid, releaseHistory, restoreAfterGeometry],
  );
  useEffect(() => {
    if (followTail.current && !interacting.current)
      target.current = { latest: true };
    restore();
    releaseHistory();
  }, [geometry, messages, restore, releaseHistory]);
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
  const historyFooter = heldHistory.current?.header ?? header;
  const footerElement = inverted
    ? React.cloneElement(
        historyFooter as React.ReactElement<{
          onLayout?: (event: LayoutChangeEvent) => void;
        }>,
        {
          onLayout: event => {
            (
              historyFooter.props as {
                onLayout?: (event: LayoutChangeEvent) => void;
              }
            ).onLayout?.(event);
            if (!valid()) return;
            metrics.current.tailHeight = event.nativeEvent.layout.height;
            releaseHistory();
          },
        },
      )
    : footer;
  const finishInteraction = () => {
    interacting.current = false;
    followTail.current = observed.current !== null && observed.current <= 2;
    viewport.followTail = followTail.current;
    if (observed.current !== null)
      viewport.anchor =
        messageAnchorAt(
          observed.current,
          frames.current,
          metrics.current.viewportHeight,
        ) ?? viewport.anchor;
  };
  const takeUserControl = () => {
    if (userScrollFrame.current !== null) cancelAnimationFrame(userScrollFrame.current);
    userScrollFrame.current = null;
    settledRestoration.current = null;
    bootstrap.current.pending = false;
    interacting.current = true;
    followTail.current = false;
    viewport.followTail = false;
    target.current = null;
    if (heldHistory.current) heldHistory.current.interacted = true;
    cancelSettle();
  };
  const renderScrollComponent = useCallback(
    (scrollProps: ScrollViewProps) => (
      <ScrollView
        {...scrollProps}
        onScroll={event => {
          if (!valid()) return;
          const settled = settledRestoration.current;
          if (settled && !target.current) {
            const { contentOffset, contentSize } = event.nativeEvent;
            // A packet can describe either an older native batch or a newer
            // batch whose layout callback is still queued. It cannot establish
            // new geometry by itself, or an unchanged scrollTo could leave us
            // waiting for an arrival event that Android never needs to emit.
            if (Math.abs(contentSize.height - metrics.current.contentHeight) > 1)
              return;
            const frame = frames.current.get(settled.anchor.id);
            const geometryChanged =
              Math.abs(contentSize.height - settled.contentHeight) > 1 ||
              Math.abs(metrics.current.contentHeight - settled.contentHeight) > 1 ||
              metrics.current.viewportHeight !== settled.viewportHeight ||
              (frame && (frame.y !== settled.frame.y || frame.height !== settled.frame.height));
            if (geometryChanged) {
              if (restoreAfterGeometry(true)) restore();
            } else if (Math.abs(contentOffset.y - settled.y) > 2) {
              // Accessibility scrolls need not emit begin-drag. A move against
              // unchanged geometry is new user control, not late list reflow.
              if (!settled.awaitingFrame) settledRestoration.current = null;
              else {
                // Size and saved-row layout notifications from one native batch
                // may straddle this packet. Forward the real scroll immediately;
                // coalesce only ownership until that frame's layouts arrive.
                if (userScrollFrame.current === null)
                  userScrollFrame.current = requestAnimationFrame(() => {
                    userScrollFrame.current = null;
                    if (valid() && settledRestoration.current === settled && !target.current)
                      settledRestoration.current = null;
                  });
              }
            }
          }
          if (bootstrap.current.pending) {
            const { contentOffset, contentSize } = event.nativeEvent;
            const commandOffset = bootstrap.current.commandOffset;
            const destination = target.current;
            const anchorFrame = destination && 'anchor' in destination
              ? frames.current.get(destination.anchor.id)
              : null;
            if (
              commandOffset === null ||
              !anchorFrame ||
              metrics.current.contentHeight + 1 <
                anchorFrame.y + anchorFrame.height ||
              anchorFrame.y + anchorFrame.height <= contentOffset.y ||
              anchorFrame.y >=
                contentOffset.y + metrics.current.viewportHeight ||
              Math.abs(contentSize.height - metrics.current.contentHeight) > 1 ||
              Math.abs(contentOffset.y - commandOffset) > 2
            ) {
              // Android can deliver a scroll clamped to the first, prefix-free
              // layout after the real prefix was measured. Forwarding it lets
              // RN retire its pending initial scroll and unmount the saved row.
              // Keep that bounded initial region until a current native command
              // arrives; retry after the stale packet's native commit settles.
              if (bootstrap.current.retryFrame === null)
                bootstrap.current.retryFrame = requestAnimationFrame(() => {
                  bootstrap.current.retryFrame = null;
                  restore();
                });
              return;
            }
            bootstrap.current.pending = false;
          }
          scrollProps.onScroll?.(event);
        }}
      />
    ),
    [restore, restoreAfterGeometry, valid],
  );
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
        renderScrollComponent={renderScrollComponent}
        keyExtractor={messageRowKey}
        inverted={inverted}
        CellRendererComponent={MessageCell}
        ListHeaderComponent={
          <View onLayout={headLayout}>{inverted ? footer : header}</View>
        }
        ListFooterComponent={footerElement}
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
          restoreAfterGeometry(false, true);
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
          takeUserControl();
        }}
        onScrollEndDrag={() => {
          if (!valid()) return;
          takeUserControl();
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
          takeUserControl();
          momentum.current = true;
          interacting.current = true;
        }}
        onMomentumScrollEnd={() => {
          if (!valid()) return;
          takeUserControl();
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
            messageAnchorAt(
              y,
              frames.current,
              metrics.current.viewportHeight,
            ) ?? viewport.anchor;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          if (!valid()) return;
          metrics.current.contentHeight = height;
          restoreAfterGeometry(false, true);
          if (followTail.current && !interacting.current)
            target.current = { latest: true };
          restore();
          releaseHistory();
        }}
      />
    </Measurements.Provider>
  );
}

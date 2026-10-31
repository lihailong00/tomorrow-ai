import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

/** Unknown accessibility preference is deliberately treated as reduced motion. */
export function useChatReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    let changed = false;
    let subscription: { remove(): void } | undefined;
    try {
      subscription = AccessibilityInfo?.addEventListener?.('reduceMotionChanged', value => {
        changed = true;
        if (active && typeof value === 'boolean') setReduced(value);
      });
      void Promise.resolve(AccessibilityInfo?.isReduceMotionEnabled?.()).then(value => {
        if (active && !changed && typeof value === 'boolean') setReduced(value);
      }).catch(() => {});
    } catch {
      // A platform without this accessibility adapter keeps the static state.
    }
    return () => { active = false; subscription?.remove(); };
  }, []);
  return reduced;
}

function MotionFrame({ children, eventKey, reducedMotion, entrance, duration, offset, testID }: {
  children: React.ReactNode;
  eventKey: string;
  reducedMotion: boolean | null;
  entrance: boolean;
  duration: number;
  offset: number;
  testID: string;
}) {
  const progress = useRef(new Animated.Value(1)).current;
  const last = useRef({ mounted: false, key: eventKey });
  useEffect(() => {
    const shouldEnter = last.current.mounted ? last.current.key !== eventKey : entrance;
    last.current = { mounted: true, key: eventKey };
    progress.stopAnimation();
    progress.setValue(1);
    // Resolving the preference must not replay a transition already on screen.
    if (reducedMotion !== false || !shouldEnter) return;
    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
      isInteraction: false,
    });
    animation.start();
    return () => { animation.stop(); progress.stopAnimation(); };
  }, [duration, entrance, eventKey, offset, progress, reducedMotion]);
  return <Animated.View testID={testID} collapsable={false} style={{
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }),
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) }],
  }}>{children}</Animated.View>;
}

export function ChatModeMotion({ children, mode, reducedMotion }: {
  children: React.ReactNode;
  mode: 'text' | 'voice';
  reducedMotion: boolean | null;
}) {
  return <MotionFrame eventKey={mode} reducedMotion={reducedMotion} entrance={false}
    duration={220} offset={5} testID="chat-mode-motion">{children}</MotionFrame>;
}

/** The recording surface leaves immediately on stop/cancel; no gesture is retained for an exit animation. */
export function ChatRecordingMotion({ children, reducedMotion }: {
  children: React.ReactNode;
  reducedMotion: boolean | null;
}) {
  return <MotionFrame eventKey="recording" reducedMotion={reducedMotion} entrance
    duration={220} offset={12} testID="chat-recording-motion">{children}</MotionFrame>;
}

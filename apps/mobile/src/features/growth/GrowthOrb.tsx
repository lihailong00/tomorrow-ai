import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import { AssistantOrb } from '../../ui/visuals';

export function GrowthOrb({
  size = 44,
  halo = 'classic',
  pulseKey,
}: {
  size?: number;
  halo?: string;
  pulseKey?: string;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const previous = useRef<string | undefined>(undefined);
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled())
      .then(value => {
        if (active) setReduced(!!value);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    );
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  useEffect(() => {
    if (!pulseKey || pulseKey === previous.current) return;
    if (reduced === null) return;
    previous.current = pulseKey;
    if (reduced) return;
    const animation = Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.13,
        duration: 260,
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 460,
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => {
      animation.stop();
      scale.setValue(1);
    };
  }, [pulseKey, reduced, scale]);
  return (
    <Animated.View
      accessible={false}
      style={{ width: size, height: size, transform: [{ scale }] }}
    >
      {halo === 'sunrise' && (
        <View
          style={[
            orbStyles.halo,
            { width: size * 0.88, height: size * 0.88, borderRadius: size },
          ]}
        />
      )}
      {halo === 'starlight' && <View style={[orbStyles.halo, { width: size * 0.94, height: size * 0.94, borderRadius: size, borderColor: '#9B96D7', borderWidth: 2, backgroundColor: '#EDEAFF66', transform: [{ rotate: '25deg' }, { scaleY: 0.7 }] }]} />}
      <AssistantOrb size={size} />
    </Animated.View>
  );
}
const orbStyles = StyleSheet.create({
  halo: {
    position: 'absolute',
    left: '6%',
    top: '6%',
    borderWidth: 1,
    borderColor: '#D3AC65',
    backgroundColor: '#FFF3D733',
    transform: [{ rotate: '-23deg' }, { scaleY: 0.83 }],
  },
});

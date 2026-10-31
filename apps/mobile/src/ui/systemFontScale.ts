import { Dimensions } from 'react-native';

type ScaleSource = {
  current: () => number;
  subscribe: (listener: (scale: number) => void) => () => void;
};

function validScale(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createFontScaleStore(source: ScaleSource) {
  let fontScale = validScale(source.current()) ?? 1;
  const listeners = new Set<() => void>();
  let unsubscribe: (() => void) | undefined;
  const update = (value: number) => {
    const next = validScale(value);
    if (next === undefined || next === fontScale) return;
    fontScale = next;
    // Native text replacement can unmount nested text and subscribe fresh ones.
    // Only notify the still-mounted subscribers present at this event's start.
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener();
    }
  };
  return {
    getSnapshot: () => fontScale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!unsubscribe) unsubscribe = source.subscribe(update);
      // Catch changes during the render/subscribe gap or while all text was absent.
      update(source.current());
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}

export const systemFontScale = createFontScaleStore({
  current: () => Dimensions.get('window').fontScale,
  subscribe: listener => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => listener(window.fontScale));
    return () => subscription.remove();
  },
});

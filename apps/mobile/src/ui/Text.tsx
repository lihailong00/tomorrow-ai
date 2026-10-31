import React, { forwardRef, useSyncExternalStore } from 'react';
import { Platform, Text as NativeText, type TextProps } from 'react-native';
import { systemFontScale } from './systemFontScale';

/** Recreate Android text paragraphs after a font change, preserving screen/input state. */
export const Text = forwardRef<React.ElementRef<typeof NativeText>, TextProps>(
  function Text(props, ref) {
    const scale = useSyncExternalStore(systemFontScale.subscribe, systemFontScale.getSnapshot, systemFontScale.getSnapshot);
    // RN 0.82 can retain pre-change paragraph measurements. A fresh native Text
    // rebuilds those metrics without remounting its screen or editable input.
    const key = Platform.OS === 'android' && props.allowFontScaling !== false
      ? `font-scale:${scale}` : 'system-text';
    return <NativeText {...props} ref={ref} key={key} />;
  },
);

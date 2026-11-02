import React, { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
import { colors } from './theme';

const paths = {
  today:
    'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16.5 12a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z',
  tasks: 'M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2',
  memory:
    'M12 20s-8-4.8-8-11a4.5 4.5 0 0 1 8-2.7A4.5 4.5 0 0 1 20 9c0 6.2-8 11-8 11Z',
  sparkles:
    'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3ZM20 2v4m-2-2h4',
  plus: 'M12 5v14M5 12h14',
  plusCircle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v10M7 12h10',
  camera: 'M4 6h3l2-3h6l2 3h3a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  image: 'M3 3h18v18H3V3Zm0 13 5-5 5 5 3-3 5 5M9 7h.1',
  compose: 'M12 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M14 5l5 5M11 13l-1 4 4-1 8-8a2 2 0 0 0-4-4l-7 9Z',
  arrowUp: 'M12 19V5m-6 6 6-6 6 6',
  send: 'M12 19V5m-6 6 6-6 6 6',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  chevronRight: 'm9 5 7 7-7 7',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  calendar:
    'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM8 3v4m8-4v4M4 10h16',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-2 7-2 9h16c0-2-2-2-2-9ZM10 21h4',
  history: 'M3 11a9 9 0 1 1 2 6M3 4v7h7m2-4v5l3 2',
  file: 'M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Zm0 0v5h5M8 12h8m-8 4h6',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5Zm-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-3 0h6',
  keyboard:
    'M3 5h18v14H3V5Zm3 4h.1M9 9h.1M12 9h.1M15 9h.1M18 9h.1M6 12h.1M9 12h.1M12 12h.1M15 12h.1M18 12h.1M7 16h10',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  settings:
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm-2-5h4l.7 2.5 2 .9 2.4-.7 2 3.5-1.8 1.8.1 2.2 1.7 1.8-2 3.5-2.5-.7-1.9 1L14 22h-4l-.7-2.4-2-1-2.4.7-2-3.5 1.8-1.8-.1-2.2-1.7-1.8 2-3.5 2.5.7 1.9-.9L10 3Z',
  attachment:
    'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9',
  back: 'm15 5-7 7 7 7',
  search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 4 6 6',
  menu: 'M4 6h16M4 12h11M4 18h16',
  more: 'M5 12h.1M12 12h.1M19 12h.1',
  pin: 'M8 3h8M9 3v7l-3 3v3h12v-3l-3-3V3M12 16v6',
  pinOff: 'm3 3 18 18M8 3h8m-1 0v7l3 3v1M9 9v1l-3 3v3h9M12 16v6',
  copy: 'M9 8h11v13H9V8ZM5 16H3V3h12v2',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  code: 'm8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20',
  edit: 'm15 4 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16l-1 4Zm0 0h15',
  quote: 'M4 7h6v7H6c0 3-1 5-3 6M14 7h6v7h-4c0 3-1 5-3 6',
  select: 'M4 7V4h3m10 0h3v3M4 17v3h3m10 0h3v-3M8 8h8m-4 0v8m-3 0h6',
  share: 'm14 3 7 6-7 6V11c-6 0-9 3-11 8 0-9 4-13 11-13V3Z',
  chevronDown: 'm5 9 7 7 7-7',
  delete: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
} as const;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 22,
  color = colors.ink,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        d={paths[name]}
        fill="none"
        stroke={color}
        strokeWidth={1.65}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// Vector treatments stay in one module so another renderer can replace them on HarmonyOS.
export function AssistantOrb({ size = 40 }: { size?: number }) {
  const key = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" accessible={false}>
      <Defs>
        <RadialGradient id={key + 'halo'} cx="50%" cy="48%" r="50%">
          <Stop offset="0" stopColor="#B5C8FF" stopOpacity={0.5} />
          <Stop offset="1" stopColor="#D8DEFF" stopOpacity={0} />
        </RadialGradient>
        <LinearGradient id={key + 'sphere'} x1="10%" y1="5%" x2="85%" y2="95%">
          <Stop offset="0" stopColor="#C4DEFF" />
          <Stop offset="0.38" stopColor="#91B6F8" />
          <Stop offset="0.7" stopColor="#B7AAEE" />
          <Stop offset="1" stopColor="#F6DDDD" />
        </LinearGradient>
        <RadialGradient id={key + 'light'} cx="37%" cy="28%" r="65%">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.98} />
          <Stop offset="0.5" stopColor="#F5F8FF" stopOpacity={0.52} />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx="50" cy="50" r="50" fill={'url(#' + key + 'halo)'} />
      <Circle cx="50" cy="50" r="35" fill={'url(#' + key + 'sphere)'} />
      <Circle cx="50" cy="50" r="34" fill={'url(#' + key + 'light)'} />
      <Ellipse
        cx="45"
        cy="35"
        rx="18"
        ry="9"
        fill="#FFFFFF"
        opacity={0.23}
        transform="rotate(-28 45 35)"
      />
      <Path
        d="M23 61c12 20 39 25 55-2"
        stroke="#FFFFFF"
        strokeWidth="2"
        strokeLinecap="round"
        opacity={0.5}
        fill="none"
      />
    </Svg>
  );
}

export function AmbientBackground() {
  const key = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessible={false}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 400 850"
        preserveAspectRatio="none"
      >
        <Defs>
          <RadialGradient id={key + 'blue'} cx="70%" cy="12%" r="70%">
            <Stop offset="0" stopColor="#DCE9FF" stopOpacity={0.9} />
            <Stop offset="1" stopColor="#E8F0FF" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={key + 'peach'} cx="5%" cy="80%" r="65%">
            <Stop offset="0" stopColor="#FFE8DC" stopOpacity={0.66} />
            <Stop offset="1" stopColor="#FFF0E8" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <G>
          <Rect width="400" height="850" fill={colors.background} />
          <Rect width="400" height="850" fill={'url(#' + key + 'blue)'} />
          <Rect width="400" height="850" fill={'url(#' + key + 'peach)'} />
        </G>
      </Svg>
    </View>
  );
}

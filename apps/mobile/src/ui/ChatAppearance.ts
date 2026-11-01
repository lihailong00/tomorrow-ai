import { colors } from './theme';

/** Chat shares the home palette; its canvas lets the same ambient background through. */
export const chatAppearance = {
  background: colors.background,
  surface: colors.surface,
  ink: colors.ink,
  secondary: colors.secondary,
  line: colors.line,
  accent: colors.action,
  onAccent: '#FFFFFF',
  tint: colors.blueLight,
  keyboard: colors.cream,
  cancellation: '#FAEDF2',
  cancellationText: '#9C365D',
} as const;

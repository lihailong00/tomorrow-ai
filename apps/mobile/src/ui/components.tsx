import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  TextInput,
  TextInputProps,
  View,
  ViewProps,
} from 'react-native';
import { Text } from './Text';
import { colors, styles as s } from './theme';
import { Icon, IconName } from './visuals';

const symbolIcons: Record<string, IconName> = {
  '‹': 'back',
  '⚙': 'settings',
  '＋': 'plus',
  '✧': 'sparkles',
  '↗': 'arrowRight',
  '☷': 'tasks',
  '◷': 'clock',
  '↻': 'history',
  '▤': 'file',
  '♧': 'memory',
};

export function Button({
  children,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        variant === 'secondary' && s.buttonSecondary,
        variant === 'ghost' && s.buttonGhost,
        variant === 'danger' && { backgroundColor: colors.danger },
        (disabled || loading) && s.disabled,
        pressed && { opacity: 0.7 },
      ]}
    >
      {loading && (
        <ActivityIndicator
          size="small"
          color={
            variant === 'primary' || variant === 'danger'
              ? '#FFFFFF'
              : colors.ink
          }
        />
      )}
      <Text
        style={[
          s.buttonText,
          (variant === 'secondary' || variant === 'ghost') &&
            s.buttonSecondaryText,
        ]}
      >
        {children}
      </Text>
    </Pressable>
  );
}

export function Card({ children, style, ...rest }: ViewProps) {
  return (
    <View {...rest} style={[s.card, style]}>
      {children}
    </View>
  );
}
export function IconButton({
  symbol,
  icon,
  label,
  onPress,
}: {
  symbol?: string;
  icon?: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.iconButton, pressed && { opacity: 0.6 }]}
    >
      {icon || (symbol && symbolIcons[symbol]) ? (
        <Icon name={icon ?? symbolIcons[symbol!]} size={21} />
      ) : (
        <Text style={[s.iconText, { fontSize: 14 }]}>{symbol}</Text>
      )}
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View>
      <Text style={s.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        {...props}
        style={[s.input, props.multiline && s.inputMultiline, props.style]}
      />
    </View>
  );
}
export function Pill({
  children,
  tone = 'green',
}: {
  children: React.ReactNode;
  tone?: 'green' | 'amber' | 'neutral' | 'red';
}) {
  const backgroundColor =
    tone === 'amber'
      ? colors.amberLight
      : tone === 'neutral'
      ? colors.cream
      : tone === 'red'
      ? colors.dangerLight
      : colors.mint;
  const color =
    tone === 'amber'
      ? colors.amber
      : tone === 'red'
      ? colors.danger
      : tone === 'green'
      ? '#4C76C2'
      : colors.secondary;
  return (
    <View style={[s.pill, { backgroundColor }]}>
      <Text style={[s.pillText, { color }]}>{children}</Text>
    </View>
  );
}
export function ErrorNotice({
  message,
  retry,
}: {
  message?: string | null;
  retry?: () => void;
}) {
  if (!message) {
    return null;
  }
  return (
    <View accessibilityRole="alert" style={s.error}>
      <Text selectable style={s.errorText}>
        {message}
      </Text>
      {retry && (
        <Button variant="ghost" onPress={retry}>
          重新试一次 ↗
        </Button>
      )}
    </View>
  );
}
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.notice}>
      <Text style={s.noticeText}>{children}</Text>
    </View>
  );
}
export function Section({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {action && (
        <Pressable accessibilityRole="button" onPress={onAction} hitSlop={12}>
          <Text style={s.link}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}
export function Empty({
  symbol = '✧',
  title,
  body,
  action,
  onAction,
}: {
  symbol?: string;
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={s.empty}>
      <View style={s.emptySymbol}>
        <Icon
          name={symbolIcons[symbol] ?? 'sparkles'}
          size={26}
          color={colors.accent}
        />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyBody}>{body}</Text>
      {action && onAction && (
        <View style={s.topGap}>
          <Button variant="secondary" onPress={onAction}>
            {action}
          </Button>
        </View>
      )}
    </View>
  );
}
export function Loading({ label = '正在整理…' }: { label?: string }) {
  return (
    <View style={[s.empty, s.gap]}>
      <ActivityIndicator color={colors.ink} />
      <Text style={s.small}>{label}</Text>
    </View>
  );
}

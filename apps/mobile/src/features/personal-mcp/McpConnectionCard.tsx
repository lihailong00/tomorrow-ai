import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Card, Pill } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { Icon } from '../../ui/visuals';

export function McpConnectionCard({
  title,
  status,
  tone = 'neutral',
  description,
  descriptionLines,
  action,
  children,
}: {
  title?: string;
  status: string;
  tone?: 'neutral' | 'green' | 'amber';
  description: string;
  descriptionLines?: number;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card testID="mcp-connection-card" style={v.card}>
      <View style={v.status} accessibilityLiveRegion="polite">
        <View style={s.between}>
          {title ? <Text style={[s.cardTitle, s.fill]}>{title}</Text> : null}
          <Pill tone={tone}>{status}</Pill>
        </View>
        <Text style={s.body} numberOfLines={descriptionLines}>
          {description}
        </Text>
      </View>
      {action}
      {children}
    </Card>
  );
}

export function McpConnectionRow({
  label,
  accessibilityLabel = label,
  onPress,
  expanded,
  disabled,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  expanded?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [v.row, pressed && { opacity: 0.65 }]}
    >
      <Text style={[s.body, s.fill]}>{label}</Text>
      <View
        style={
          expanded === undefined
            ? undefined
            : { transform: [{ rotate: expanded ? '-90deg' : '90deg' }] }
        }
      >
        <Icon name="chevronRight" size={15} color={colors.muted} />
      </View>
    </Pressable>
  );
}

const v = StyleSheet.create({
  card: { padding: 0, gap: 8, backgroundColor: 'transparent', borderWidth: 0 },
  status: {
    backgroundColor: colors.blueLight,
    padding: 14,
    gap: 8,
    borderRadius: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    gap: 8,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
});

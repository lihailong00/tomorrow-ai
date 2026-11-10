import React from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import { dayName } from './model';
import { growthStyles as s } from './styles';
import type { GrowthSummary } from './types';
export function GrowthDays({
  summary,
  onOpen,
}: {
  summary: GrowthSummary;
  onOpen?: () => void;
}) {
  return (
    <View style={s.days} accessibilityLabel="本周实际行动记录">
      {summary.week.days.map(day => (
        <Pressable
          key={day.date}
          style={[s.day, { minHeight: 55 }]}
          accessibilityRole={onOpen ? 'button' : undefined}
          accessibilityLabel={`${dayName(day.date)}，${day.action_count}次行动${
            day.paused ? '，休息' : ''
          }`}
          disabled={!onOpen}
          onPress={onOpen}
        >
          <View
            style={[
              s.dayDot,
              day.action_count > 0 && s.dayLit,
              day.date === summary.today.date && s.dayCurrent,
            ]}
          >
            {day.action_count > 0 ? (
              <Icon name="check" size={16} color="#39775F" />
            ) : (
              <Text style={s.muted}>{day.paused ? '休' : '·'}</Text>
            )}
          </View>
          <Text style={s.muted}>{dayName(day.date)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

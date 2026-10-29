import React from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { Button, ErrorNotice, Loading } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { updateGrowthPreferences } from './api';
import { useGrowthData } from './context';
import { GrowthOrb } from './GrowthOrb';
import { dayName, levelProgress, localDateLabel } from './model';
import { growthStyles as s } from './styles';
import type { GrowthSummary } from './types';

export function GrowthDays({ summary }: { summary: GrowthSummary }) {
  return (
    <View style={s.days} accessibilityLabel="本周实际行动记录">
      {summary.week.days.map(day => (
        <View key={day.date} style={s.day}>
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
        </View>
      ))}
    </View>
  );
}

export function GrowthScreen() {
  const { api, navigate, invalidate } = useApp();
  const growth = useGrowthData();
  const action = useAction();
  const data = growth?.data;
  const summary = data?.summary;
  const changeHalo = (halo: 'classic' | 'sunrise') =>
    action.run(async guard => {
      if (!data) return;
      const updated = await updateGrowthPreferences(api, {
        version: data.preferences.version,
        halo,
      });
      if (!guard.isCurrent()) return;
      growth?.updatePreferences(updated);
      invalidate();
    });
  return (
    <ScrollView
      contentContainerStyle={s.page}
      keyboardShouldPersistTaps="handled"
    >
      <View style={s.heading}>
        <Text style={s.title}>我的成长</Text>
        <Pressable
          accessibilityRole="button"
          style={s.textAction}
          onPress={() => navigate({ name: 'growthSettings' })}
        >
          <Text style={s.link}>调整节奏</Text>
        </Pressable>
      </View>
      <ErrorNotice message={growth?.error} retry={growth?.refresh} />
      <ErrorNotice message={action.error} retry={growth?.refresh} />
      {growth?.loading && !data && <Loading />}
      {summary && (
        <>
          <View style={s.hero}>
            <GrowthOrb size={128} halo={summary.halo} />
            <Text style={s.level}>成长 Lv.{summary.level}</Text>
            <Text style={s.small}>
              {summary.level_xp} / {summary.xp_per_level} 成长 · 累计{' '}
              {summary.total_xp}
            </Text>
            <View
              style={[s.track, s.heroTrack]}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="当前等级成长"
              accessibilityValue={{
                min: 0,
                max: summary.xp_per_level,
                now: summary.level_xp,
              }}
            >
              <View
                style={[
                  s.trackFill,
                  {
                    width: `${
                      levelProgress(summary.level_xp, summary.xp_per_level) *
                      100
                    }%`,
                  },
                ]}
              />
            </View>
            <Text style={s.small}>
              {summary.total_xp === 0
                ? '从你确认完成的第一件事，开始留下成长记录。'
                : '现实里向前走过的每一步，都保存在这里。'}
            </Text>
          </View>
          {!data.preferences.enabled && (
            <View style={s.panel}>
              <Text style={s.section}>每日成长还未开启</Text>
              <Text style={s.small}>
                开启后选择自己的目标与时间，完成的行动会按规则记入成长。已有记录会一直保留。
              </Text>
              <Button
                variant="secondary"
                onPress={() => navigate({ name: 'growthSettings' })}
              >
                选择目标与时间
              </Button>
            </View>
          )}
          <View style={[s.groupHeading, { marginTop: 20 }]}>
            <Text style={s.section}>每一步，都有痕迹</Text>
            <Text style={s.small}>
              本周已行动 {summary.week.active_days} 天
            </Text>
          </View>
          <GrowthDays summary={summary} />
          <Text style={s.small}>
            休息不会抹掉已经积累的成长。日期按当前服务器的账号时区记录。
          </Text>
          <View style={[s.groupHeading, { marginTop: 22 }]}>
            <Text style={s.section}>成长里程碑</Text>
          </View>
          {summary.milestones.map(milestone => (
            <View key={milestone.id} style={s.milestone}>
              <View style={[s.medal, milestone.unlocked && s.medalOpen]}>
                <Icon
                  name={milestone.unlocked ? 'sparkles' : 'clock'}
                  size={20}
                  color={milestone.unlocked ? colors.amber : colors.secondary}
                />
              </View>
              <View style={s.flex}>
                <Text style={s.section}>{milestone.title}</Text>
                <Text style={s.small}>{milestone.description}</Text>
                <Text style={s.muted}>
                  {milestone.progress} / {milestone.target}
                  {milestone.unlocked ? ' · 已达成' : ''}
                </Text>
              </View>
              {milestone.unlocked && (
                <Icon name="check" size={17} color={colors.action} />
              )}
            </View>
          ))}
          <View style={[s.groupHeading, { marginTop: 22 }]}>
            <Text style={s.section}>光球光环</Text>
            <Text style={s.muted}>晨光在 Lv.3 解锁</Text>
          </View>
          <View style={s.chips}>
            {(['classic', 'sunrise'] as const).map(halo => (
              <Pressable
                key={halo}
                accessibilityRole="button"
                accessibilityLabel={
                  halo === 'classic' ? '使用柔光光环' : '使用晨光光环'
                }
                accessibilityState={{
                  selected: summary.halo === halo,
                  disabled: !summary.available_halos.includes(halo),
                }}
                disabled={
                  action.busy || !summary.available_halos.includes(halo)
                }
                onPress={() => {
                  void changeHalo(halo);
                }}
                style={[
                  s.chip,
                  summary.halo === halo && s.chipSelected,
                  !summary.available_halos.includes(halo) && { opacity: 0.55 },
                ]}
              >
                <Text style={s.body}>
                  {halo === 'classic' ? '柔光' : '晨光'}
                  {summary.halo === halo ? ' · 使用中' : ''}
                </Text>
              </Pressable>
            ))}
          </View>
          <Button
            variant="secondary"
            onPress={() => navigate({ name: 'growthWeek' })}
          >
            看看这一周做成了什么
          </Button>
        </>
      )}
    </ScrollView>
  );
}

export function GrowthWeekScreen() {
  const growth = useGrowthData();
  const { navigate } = useApp();
  const summary = growth?.data?.summary;
  const records = summary?.week.records ?? [];
  return (
    <FlatList
      contentContainerStyle={s.page}
      data={records}
      keyExtractor={record => record.id}
      initialNumToRender={16}
      maxToRenderPerBatch={16}
      windowSize={5}
      refreshing={!!growth?.loading && !!summary}
      onRefresh={growth?.refresh}
      ListHeaderComponent={
        <>
          <Text style={s.title}>这一周，你做成了这些</Text>
          <ErrorNotice message={growth?.error} retry={growth?.refresh} />
          {growth?.loading && !summary && <Loading />}
          {summary && (
            <>
              <Text style={[s.small, { marginTop: 8 }]}>
                {localDateLabel(summary.week.start_date)}—
                {localDateLabel(summary.week.end_date)} ·{' '}
                {summary.today.timezone}
              </Text>
              <GrowthDays summary={summary} />
              <View style={s.stat}>
                <Icon name="file" size={21} color={colors.secondary} />
                <View style={s.flex}>
                  <Text style={s.body}>处理沟通</Text>
                  <Text style={s.muted}>按你明确确认的行动统计</Text>
                </View>
                <Text style={s.statValue}>
                  {summary.week.communication_actions} 次
                </Text>
              </View>
              <View style={s.stat}>
                <Icon name="memory" size={21} color={colors.secondary} />
                <View style={s.flex}>
                  <Text style={s.body}>学习行动</Text>
                  <Text style={s.muted}>准备学习材料本身不算完成</Text>
                </View>
                <Text style={s.statValue}>
                  {summary.week.learning_actions} 次
                </Text>
              </View>
              <View style={s.stat}>
                <Icon name="today" size={21} color={colors.secondary} />
                <View style={s.flex}>
                  <Text style={s.body}>已记录活动时长</Text>
                  <Text style={s.muted}>仅计自行填写的时长，未填的不估算</Text>
                </View>
                <Text style={s.statValue}>
                  {summary.week.exercise_minutes} 分钟
                </Text>
              </View>
              <View style={[s.groupHeading, { marginTop: 24 }]}>
                <Text style={s.section}>最近做成的事情</Text>
                <Text style={s.muted}>最多显示最近 100 条</Text>
              </View>
              {!records.length && (
                <Text style={[s.small, { marginVertical: 20 }]}>
                  这一周还没有已确认的成长行动。完成一件真实的事情，就能在这里回看。
                </Text>
              )}
            </>
          )}
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={'查看成长来源事项：' + item.title}
          style={s.history}
          onPress={() => navigate({ name: 'todo', id: item.todo_id })}
        >
          <Text style={[s.small, s.historyDate]}>
            {dayName(item.local_date)}
          </Text>
          <View style={s.flex}>
            <Text style={s.body}>{item.title}</Text>
            <Text style={s.muted}>
              {localDateLabel(item.local_date)}
              {item.kind === 'exercise'
                ? item.minutes == null
                  ? ' · 未填写时长'
                  : ` · ${item.minutes} 分钟（自行记录）`
                : ''}
            </Text>
          </View>
          <Text style={s.small}>+{item.xp}</Text>
        </Pressable>
      )}
    />
  );
}

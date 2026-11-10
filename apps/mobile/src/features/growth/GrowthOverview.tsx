import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { Button, ErrorNotice, Loading } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { updateGrowthPreferences } from './api';
import { useGrowthData } from './context';
import { useDailyGrowth, DailyRecommendations } from './DailyGrowth';
import { GrowthDays } from './GrowthDays';
import { GrowthOrb } from './GrowthOrb';
import { JourneyCard, JourneySetup, journeyStyles as j } from './JourneyCards';
import { levelProgress, localDateLabel } from './model';
import { growthStyles as s } from './styles';
import { useGrowthJourney } from './useGrowthJourney';
import type { GrowthPreferences } from './types';

const haloNames = { classic: '柔光', sunrise: '晨光', starlight: '星光' };
export function GrowthOverview() {
  const { api, navigate, invalidate } = useApp();
  const growth = useGrowthData();
  const daily = useDailyGrowth();
  const journey = useGrowthJourney();
  const action = useAction();
  const [setup, setSetup] = useState(false);
  const [collection, setCollection] = useState(false);
  const [pastId, setPastId] = useState<string | null>(null);
  const data = growth?.data;
  const summary = data?.summary;
  const active = journey.value?.active;
  const past = journey.value?.past ?? [];
  const showSetup = !active && journey.value && (setup || !past.length);
  const latest = past.find(
    item => item.status === 'completed' && item.completed_steps > 0,
  );
  const routeTodoIds = new Set(
    active?.steps.flatMap(step => (step.todo ? [step.todo.id] : [])) ?? [],
  );
  const dailyItems = daily.items
    .filter(item => !item.todo_id || !routeTodoIds.has(item.todo_id))
    .filter(item => !active || item.todo_id || item.kind !== active.kind)
    .slice(0, active ? 2 : 3);
  const changeHalo = (halo: GrowthPreferences['halo']) =>
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
      <ErrorNotice message={journey.error} retry={journey.refresh} />
      <ErrorNotice
        message={journey.action.error}
        retry={() => {
          journey.refresh();
          growth?.refresh();
        }}
      />
      {growth?.loading && !data && <Loading />}
      {summary && data && (
        <>
          <View style={j.compactHero} testID="growth-compact-hero">
            <GrowthOrb
              size={52}
              halo={summary.halo}
              pulseKey={String(summary.total_xp)}
            />
            <View style={s.flex}>
              <Text style={j.title}>
                成长 Lv.{summary.level} ·{' '}
                {summary.level >= 5
                  ? '星光成线'
                  : summary.level >= 3
                  ? '初见晨光'
                  : '开始发光'}
              </Text>
              <Text style={s.small}>
                本周已行动 {summary.week.active_days} 天 · 累计{' '}
                {summary.total_xp} 成长
              </Text>
              <View
                style={s.track}
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
              <Text style={s.muted}>
                {summary.level_xp} / {summary.xp_per_level} · 休息不会清空积累
              </Text>
            </View>
          </View>
          {summary.total_xp === 0 && (
            <Text style={[s.small, { marginBottom: 14 }]}>
              从你确认完成的第一件事，开始留下成长记录。
            </Text>
          )}
          {active && (
            <JourneyCard
              key={active.id}
              journey={active}
              controller={journey}
              paused={
                !data.preferences.enabled || data.preferences.paused_today
              }
            />
          )}
          {active &&
            (!data.preferences.enabled || data.preferences.paused_today) && (
              <View style={[s.panel, { marginBottom: 14 }]}>
                <Text style={s.small}>
                  {data.preferences.enabled
                    ? '今天可以休息。已经开始的待办仍能继续。'
                    : '每日成长已关闭，旅程和已完成记录仍保留。'}
                </Text>
                <Button
                  variant="secondary"
                  onPress={() => navigate({ name: 'growthSettings' })}
                >
                  调整我的节奏
                </Button>
              </View>
            )}
          {showSetup ? (
            <JourneySetup controller={journey} preferences={data.preferences} />
          ) : !active && journey.value ? (
            <View style={[s.panel, { marginBottom: 14 }]}>
              <Text style={s.section}>
                {latest ? '这一段，已经有了自己的成果' : '换个方向，再向前一点'}
              </Text>
              {latest && (
                <>
                  <Text style={s.body}>{latest.goal}</Text>
                  <Text style={s.small}>
                    确认完成 {latest.completed_steps} 步 · 跳过{' '}
                    {latest.skipped_steps} 步
                  </Text>
                  <Button
                    variant="ghost"
                    onPress={() =>
                      setPastId(pastId === latest.id ? null : latest.id)
                    }
                  >
                    回看这段旅程
                  </Button>
                </>
              )}
              <Button onPress={() => setSetup(true)}>开始下一段旅程</Button>
            </View>
          ) : journey.loading && !journey.value ? (
            <Loading />
          ) : null}
          {daily.enabled &&
            !showSetup &&
            (dailyItems.length > 0 || !active) && (
              <View style={{ marginTop: 14 }}>
                <DailyRecommendations daily={{ ...daily, items: dailyItems }} />
              </View>
            )}
          {summary.week.records.length > 0 && (
            <>
              <View style={[s.groupHeading, { marginTop: 20 }]}>
                <Text style={s.section}>最近做成的事</Text>
                <Pressable
                  accessibilityRole="button"
                  style={s.textAction}
                  onPress={() => navigate({ name: 'growthWeek' })}
                >
                  <Text style={s.link}>查看全部 ›</Text>
                </Pressable>
              </View>
              {summary.week.records.slice(0, 3).map(record => (
                <Pressable
                  key={record.id}
                  accessibilityRole="button"
                  onPress={() => navigate({ name: 'todo', id: record.todo_id })}
                  style={s.history}
                >
                  <Icon name="check" size={17} color="#39775F" />
                  <View style={s.flex}>
                    <Text style={s.body} numberOfLines={1}>
                      {record.title}
                    </Text>
                    <Text style={s.muted}>
                      {localDateLabel(record.local_date)}
                      {record.minutes != null
                        ? ` · ${record.minutes}分钟（自行记录）`
                        : ''}
                    </Text>
                  </View>
                  <Text style={s.badge}>+{record.xp}</Text>
                </Pressable>
              ))}
            </>
          )}
          <View style={[s.groupHeading, { marginTop: 20 }]}>
            <Text style={s.section}>每一步，都有痕迹</Text>
            <Text style={s.small}>本周 {summary.week.active_days} 天</Text>
          </View>
          <GrowthDays
            summary={summary}
            onOpen={() => navigate({ name: 'growthWeek' })}
          />
          <Button
            variant="secondary"
            onPress={() => navigate({ name: 'growthWeek' })}
          >
            看看这一周做成了什么
          </Button>
          <View style={[s.groupHeading, { marginTop: 22 }]}>
            <Text style={s.section}>我的收藏</Text>
            <Pressable
              accessibilityRole="button"
              style={s.textAction}
              accessibilityState={{ expanded: collection }}
              onPress={() => setCollection(value => !value)}
            >
              <Text style={s.link}>{collection ? '收起' : '查看全部'} ›</Text>
            </Pressable>
          </View>
          <View style={j.collection}>
            {(collection
              ? summary.milestones
              : [
                  ...summary.milestones.filter(item => item.unlocked).slice(-1),
                  ...summary.milestones
                    .filter(item => !item.unlocked)
                    .slice(0, 1),
                ]
            ).map(item => (
              <View key={item.id} style={j.collectible}>
                <Icon
                  name={item.unlocked ? 'sparkles' : 'clock'}
                  size={21}
                  color={item.unlocked ? colors.amber : colors.secondary}
                />
                <Text style={s.section}>{item.title}</Text>
                <Text style={s.small}>{item.description}</Text>
                <Text style={s.muted}>
                  {item.unlocked
                    ? '已达成'
                    : `${item.progress} / ${item.target}`}
                </Text>
              </View>
            ))}
          </View>
          <Text style={[s.section, { marginTop: 18, marginBottom: 8 }]}>
            光球光环
          </Text>
          <View style={[s.chips, { gap: 10 }]}>
            {(['classic', 'sunrise', 'starlight'] as const).map(halo => (
              <Pressable
                key={halo}
                accessibilityRole="button"
                accessibilityLabel={`使用${haloNames[halo]}光环`}
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
                  {
                    minHeight: 74,
                    gap: 4,
                    alignItems: 'center',
                    opacity: summary.available_halos.includes(halo) ? 1 : 0.55,
                  },
                ]}
              >
                <GrowthOrb size={30} halo={halo} />
                <Text style={s.small}>
                  {haloNames[halo]}
                  {!summary.available_halos.includes(halo)
                    ? ` · Lv.${halo === 'sunrise' ? 3 : 5}`
                    : summary.halo === halo
                    ? ' · 使用中'
                    : ''}
                </Text>
              </Pressable>
            ))}
          </View>
          {past.length > 0 && (
            <>
              <Text style={[s.section, { marginTop: 20, marginBottom: 8 }]}>
                走过的旅程
              </Text>
              {past.map(item => (
                <View key={item.id}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: pastId === item.id }}
                    onPress={() =>
                      setPastId(pastId === item.id ? null : item.id)
                    }
                    style={s.history}
                  >
                    <View style={s.flex}>
                      <Text style={s.body}>{item.goal}</Text>
                      <Text style={s.muted}>
                        {item.status === 'archived'
                          ? '暂时放一放'
                          : `完成${item.completed_steps}步 · 跳过${item.skipped_steps}步`}
                      </Text>
                    </View>
                    <Icon
                      name="chevronRight"
                      size={16}
                      color={colors.secondary}
                    />
                  </Pressable>
                  {pastId === item.id && (
                    <JourneyCard journey={item} controller={journey} paused />
                  )}
                </View>
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

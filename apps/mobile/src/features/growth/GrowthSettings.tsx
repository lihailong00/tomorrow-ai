import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import {
  Button,
  ErrorNotice,
  Field,
  Loading,
  Notice,
} from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { getGrowthPreferences, updateGrowthPreferences } from './api';
import { useGrowthData } from './context';
import { growthStyles as s } from './styles';
import type { GrowthGoal, GrowthPreferences } from './types';

const choices: Array<{
  kind: GrowthGoal['kind'];
  label: string;
  placeholder: string;
}> = [
  {
    kind: 'learning',
    label: '学点新知识',
    placeholder: '例如：练习旅行英语、学一点编程',
  },
  {
    kind: 'exercise',
    label: '多活动一点',
    placeholder: '例如：午间散步、培养活动习惯',
  },
  {
    kind: 'general',
    label: '生活更有条理',
    placeholder: '例如：整理房间、推进自己的小计划',
  },
];

export function GrowthSettingsScreen() {
  const growth = useGrowthData();
  const { api, user, invalidate } = useApp();
  const [editor, setEditor] = useState(0);
  const action = useAction();
  const data = growth?.data;
  const preferences = data?.preferences;
  const pause = () =>
    action.run(async guard => {
      if (!preferences) return;
      const updated = await updateGrowthPreferences(api, {
        version: preferences.version,
        paused_today: !preferences.paused_today,
      });
      if (!guard.isCurrent()) return;
      growth?.updatePreferences(updated);
      invalidate();
    });
  const reload = () =>
    action.run(async guard => {
      const latest = await getGrowthPreferences(api);
      if (!guard.isCurrent()) return;
      growth?.updatePreferences(latest);
      setEditor(value => value + 1);
    });
  return (
    <ScrollView
      contentContainerStyle={[s.page, s.gap]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={s.title}>按自己的节奏来</Text>
      <Text style={s.small}>
        选择最近想改善的事，再留出一点时间。原来的待办照常使用。
      </Text>
      <ErrorNotice message={growth?.error} retry={growth?.refresh} />
      <ErrorNotice message={action.error} retry={growth?.refresh} />
      {growth?.loading && !preferences && <Loading />}
      {preferences && (
        <>
          {preferences.enabled && (
            <View style={s.panel}>
              <Text style={s.section}>
                {preferences.paused_today
                  ? '今天的新建议已经暂停'
                  : '需要给今天留点空白吗？'}
              </Text>
              <Text style={s.small}>
                今天休息会暂停未开始的新建议，明天按账号当地日期恢复。原有待办、已接纳的事项与成长会保留。
              </Text>
              <Button
                variant="secondary"
                loading={action.busy}
                onPress={() => {
                  void pause();
                }}
              >
                {preferences.paused_today ? '恢复今天的建议' : '今天休息一下'}
              </Button>
            </View>
          )}
          <GrowthSettingsForm
            key={`${api.baseUrl}:${user?.id}:${editor}`}
            preferences={preferences}
            onSaved={updated => {
              growth?.updatePreferences(updated);
              invalidate();
            }}
          />
          <Button
            variant="ghost"
            loading={action.busy}
            onPress={() => {
              void reload();
            }}
          >
            重新载入服务器设置
          </Button>
          <Text style={s.muted}>
            账号时区：{preferences.timezone}
            。日期和成长归属由服务器确认，不随手机时钟改变。
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function GrowthSettingsForm({
  preferences,
  onSaved,
}: {
  preferences: GrowthPreferences;
  onSaved: (value: GrowthPreferences) => void;
}) {
  const { api } = useApp();
  const action = useAction();
  const [version, setVersion] = useState(preferences.version);
  const [enabled, setEnabled] = useState(preferences.enabled);
  const [goals, setGoals] = useState(
    preferences.goals.map(goal => ({ ...goal })),
  );
  const [minutes, setMinutes] = useState(String(preferences.daily_minutes));
  const [useExisting, setUseExisting] = useState(
    preferences.use_existing_todos,
  );
  const [notice, setNotice] = useState('');
  const baseline = useRef(preferences);
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = preferences;
    // A pause/halo change is not an overwrite of this form's goal draft.
    const editable = (value: GrowthPreferences) =>
      JSON.stringify([
        value.enabled,
        value.daily_minutes,
        value.use_existing_todos,
        value.goals,
      ]);
    if (editable(previous) === editable(preferences))
      setVersion(value =>
        value === previous.version ? preferences.version : value,
      );
  }, [preferences]);
  const toggle = (kind: GrowthGoal['kind']) => {
    setGoals(previous =>
      previous.some(goal => goal.kind === kind)
        ? previous.filter(goal => goal.kind !== kind)
        : [...previous, { kind, title: '' }],
    );
  };
  const save = () =>
    action.run(async guard => {
      if (!enabled) {
        const updated = await updateGrowthPreferences(api, {
          version,
          enabled: false,
        });
        if (!guard.isCurrent()) return;
        setVersion(updated.version);
        setNotice('每日成长已关闭，已积累的成长和原有事项仍会保留。');
        onSaved(updated);
        return;
      }
      if (
        !/^\d+$/.test(minutes.trim()) ||
        Number(minutes) < 5 ||
        Number(minutes) > 120
      )
        throw new Error('每天的时间请填写 5–120 的整数分钟。');
      if (enabled && !goals.length && !useExisting)
        throw new Error('请选择一个目标，或允许从已有待办里安排。');
      if (goals.some(goal => !goal.title.trim()))
        throw new Error('给选中的目标写一句具体想做的事就好。');
      const updated = await updateGrowthPreferences(api, {
        version,
        enabled,
        daily_minutes: Number(minutes),
        use_existing_todos: useExisting,
        goals: goals.map(goal => ({ ...goal, title: goal.title.trim() })),
      });
      if (!guard.isCurrent()) return;
      setVersion(updated.version);
      setNotice(
        updated.enabled
          ? '已保存，妥啦会根据这些目标与时间准备每天的建议。'
          : '每日成长已关闭，已积累的成长和原有事项仍会保留。',
      );
      onSaved(updated);
    });
  return (
    <View style={s.gap}>
      <ErrorNotice message={action.error} />
      {!!notice && <Notice>{notice}</Notice>}
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel="开启每日成长"
        accessibilityState={{ checked: enabled }}
        style={s.consent}
        onPress={() => setEnabled(value => !value)}
      >
        <View style={[s.checkbox, enabled && s.checked]}>
          {enabled && <Icon name="check" size={16} color={colors.action} />}
        </View>
        <View style={s.flex}>
          <Text style={s.section}>开启每日成长</Text>
          <Text style={s.small}>
            按所选目标生成少量建议，明确完成后记录成长。
          </Text>
        </View>
      </Pressable>
      <Text style={s.section}>最近想改善什么？</Text>
      <View style={s.chips}>
        {choices.map(choice => (
          <Pressable
            key={choice.kind}
            accessibilityRole="checkbox"
            accessibilityLabel={choice.label}
            accessibilityState={{
              checked: goals.some(goal => goal.kind === choice.kind),
            }}
            style={[
              s.chip,
              goals.some(goal => goal.kind === choice.kind) && s.chipSelected,
            ]}
            onPress={() => toggle(choice.kind)}
          >
            <Text style={s.body}>{choice.label}</Text>
          </Pressable>
        ))}
      </View>
      {choices
        .filter(choice => goals.some(goal => goal.kind === choice.kind))
        .map(choice => (
          <Field
            key={choice.kind}
            label={choice.label + '：我的目标'}
            maxLength={100}
            placeholder={choice.placeholder}
            value={goals.find(goal => goal.kind === choice.kind)?.title ?? ''}
            onChangeText={title =>
              setGoals(previous =>
                previous.map(goal =>
                  goal.kind === choice.kind ? { ...goal, title } : goal,
                ),
              )
            }
          />
        ))}
      <Text style={s.section}>每天愿意留出多少时间？</Text>
      <View style={s.chips}>
        {[5, 15, 30, 60].map(value => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityLabel={`${value} 分钟`}
            accessibilityState={{ selected: minutes === String(value) }}
            onPress={() => setMinutes(String(value))}
            style={[s.chip, minutes === String(value) && s.chipSelected]}
          >
            <Text style={s.body}>{value} 分钟</Text>
          </Pressable>
        ))}
      </View>
      <Field
        label="每日分钟数（5–120）"
        keyboardType="number-pad"
        maxLength={6}
        value={minutes}
        onChangeText={setMinutes}
      />
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="允许使用已有待办"
        accessibilityState={{ checked: useExisting }}
        style={s.consent}
        onPress={() => setUseExisting(value => !value)}
      >
        <View style={[s.checkbox, useExisting && s.checked]}>
          {useExisting && <Icon name="check" size={16} color={colors.action} />}
        </View>
        <View style={s.flex}>
          <Text style={s.body}>也帮我安排已有待办</Text>
          <Text style={s.small}>
            优先从当前账号已保存的待办里挑选，不会自动读取其他 App。
          </Text>
        </View>
      </Pressable>
      <Text style={s.small}>
        开启后，所选目标及你允许使用的已保存待办会交给当前服务配置的 AI
        生成建议。模型不可用时会明确显示，普通事项仍可继续使用。
      </Text>
      <Button
        loading={action.busy}
        onPress={() => {
          void save();
        }}
      >
        {preferences.enabled
          ? '保存我的节奏'
          : enabled
          ? '开启并保存'
          : '保存设置'}
      </Button>
    </View>
  );
}

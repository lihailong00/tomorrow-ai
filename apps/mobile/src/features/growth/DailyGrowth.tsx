import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ApiError, newRequestId } from '../../api/client';
import { useAction, useApp, useResource } from '../../app/context';
import { Button, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import { kindIcons, nextAction, shortSourceLabel } from '../todos/model';
import {
  acceptDailyPlanItem,
  ensureDailyPlan,
  getDailyPlan,
  replaceDailyPlanItem,
  skipDailyPlanItem,
} from './api';
import { useGrowthData } from './context';
import { GrowthOrb } from './GrowthOrb';
import { levelProgress, localDateLabel, visiblePlanItems } from './model';
import { growthStyles as s } from './styles';
import type { DailyPlan, DailyPlanItem } from './types';

export function GrowthEntry() {
  const growth = useGrowthData();
  const { navigate } = useApp();
  if (!growth) return null;
  const data = growth.data;
  const enabled = data?.preferences.enabled;
  const summary = data?.summary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={enabled ? '查看我的成长' : '开启每日成长'}
      onPress={() => navigate({ name: enabled ? 'growth' : 'growthSettings' })}
      style={s.entry}
    >
      {summary && enabled && (
        <GrowthOrb
          size={43}
          halo={summary.halo}
          pulseKey={growth.feedback?.id}
        />
      )}
      <View style={s.entryText}>
        <Text style={s.section}>
          {enabled && summary
            ? summary.today.action_count > 0
              ? `今天已前进 ${summary.today.action_count} 步`
              : summary.today.paused
              ? '今天，给自己留点空白'
              : '今天，从一件小事开始'
            : growth.error
            ? '每日成长暂时不可用'
            : '让妥啦帮你安排每日小行动'}
        </Text>
        <Text style={s.small}>
          {enabled && summary
            ? `成长 Lv.${summary.level} · 本周已行动 ${summary.week.active_days} 天`
            : growth.error
            ? '点开检查服务，原有事项仍可使用'
            : '选择目标与时间后开启，完成时看见成长'}
        </Text>
        {enabled && summary && (
          <View style={s.track}>
            <View
              style={[
                s.trackFill,
                {
                  width: `${
                    levelProgress(summary.level_xp, summary.xp_per_level) * 100
                  }%`,
                },
              ]}
            />
          </View>
        )}
      </View>
      <Icon name="chevronRight" size={17} color={colors.secondary} />
    </Pressable>
  );
}

export function useDailyGrowth() {
  const { api, user, revision, navigate, invalidate } = useApp();
  const growth = useGrowthData();
  const enabled = !!growth?.data?.preferences.enabled;
  const localDate = growth?.data?.summary.today.date;
  const owner = useMemo(
    () => ({ api, userId: user?.id, enabled, localDate }),
    [api, user?.id, enabled, localDate],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const resource = useResource<DailyPlan | null>(
    () => (enabled ? getDailyPlan(api) : Promise.resolve(null)),
    [owner],
  );
  const action = useAction();
  const [menu, setMenu] = useState<string | null>(null);
  const [pollPaused, setPollPaused] = useState(false);
  const requests = useRef({
    owner,
    ensure: '',
    ensureDate: '',
    ensureFrom: null as DailyPlan | null,
    items: new Map<string, { version: number; client_request_id: string }>(),
    attempted: '',
  });
  if (requests.current.owner !== owner)
    requests.current = {
      owner,
      ensure: '',
      ensureDate: '',
      ensureFrom: null,
      items: new Map(),
      attempted: '',
    };
  const pollCount = useRef(0);
  const clearActionError = action.setError;
  const previousRevision = useRef({ owner, revision });
  const { refresh, setValue } = resource;
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { owner, revision };
    if (previous.owner === owner && previous.revision !== revision) refresh();
  }, [owner, revision, refresh]);
  useEffect(() => {
    setMenu(null);
    pollCount.current = 0;
    setPollPaused(false);
    clearActionError(null);
  }, [owner, clearActionError]);
  const ensure = () =>
    action.run(async guard => {
      // An uncertain POST replays the same intent. Only a newly fetched,
      // authoritative failed plan with retry permission admits a fresh attempt.
      if (
        requests.current.ensureDate !== resource.value?.local_date ||
        (resource.value?.status === 'failed' &&
          resource.value.can_retry === true &&
          resource.value !== requests.current.ensureFrom)
      )
        requests.current.ensure = '';
      if (!requests.current.ensure) {
        requests.current.ensure = newRequestId();
        requests.current.ensureDate = resource.value?.local_date ?? '';
        requests.current.ensureFrom = resource.value;
      }
      let result;
      try {
        result = await ensureDailyPlan(api, requests.current.ensure);
      } catch (failure) {
        if (currentOwner.current !== owner || !guard.isCurrent()) return;
        throw failure;
      }
      if (!guard.isCurrent() || currentOwner.current !== owner) return;
      requests.current.ensure = '';
      requests.current.ensureDate = '';
      requests.current.ensureFrom = null;
      pollCount.current = 0;
      setPollPaused(false);
      setValue(result);
    });
  const plan = resource.value;
  const visibleItems = useMemo(() => visiblePlanItems(plan), [plan]);
  useEffect(() => {
    if (
      !enabled ||
      !plan ||
      plan.id ||
      plan.status === 'failed' ||
      plan.status === 'paused' ||
      growth?.data?.preferences.paused_today ||
      resource.loading ||
      action.busy ||
      action.error
    )
      return;
    const key = plan.local_date;
    if (requests.current.attempted === key) return;
    requests.current.attempted = key;
    void ensure();
    // One durable ensure request for this owner/day; re-render does not pay again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    owner,
    plan,
    resource.loading,
    action.busy,
    action.error,
    growth?.data?.preferences.paused_today,
  ]);
  useEffect(() => {
    if (
      !plan ||
      !['queued', 'generating'].includes(plan.status) ||
      resource.loading ||
      resource.error ||
      pollPaused
    )
      return;
    const timer = setTimeout(() => {
      if (++pollCount.current > 60) {
        setPollPaused(true);
        return;
      }
      refresh();
    }, 4000);
    return () => clearTimeout(timer);
  }, [plan, resource.loading, resource.error, pollPaused, refresh]);
  const act = (item: DailyPlanItem, kind: 'accept' | 'skip' | 'replace') =>
    action.run(async guard => {
      if (kind === 'accept' && item.status === 'accepted' && item.todo_id) {
        if (guard.isCurrent() && currentOwner.current === owner)
          navigate({ name: 'todo', id: item.todo_id });
        return;
      }
      const key = item.id + ':' + kind;
      let input = requests.current.items.get(key);
      if (!input) {
        input = { version: item.version, client_request_id: newRequestId() };
        requests.current.items.set(key, input);
      }
      try {
        if (kind === 'accept') {
          const result = await acceptDailyPlanItem(api, item.id, input);
          if (!guard.isCurrent() || currentOwner.current !== owner) return;
          requests.current.items.delete(key);
          if (!result?.todo?.id)
            throw new Error('未能确认这条建议，请刷新后重试。');
          invalidate();
          refresh();
          setMenu(null);
          navigate({ name: 'todo', id: result.todo.id });
        } else {
          const result =
            kind === 'skip'
              ? await skipDailyPlanItem(api, item.id, input)
              : await replaceDailyPlanItem(api, item.id, input);
          if (!guard.isCurrent() || currentOwner.current !== owner) return;
          requests.current.items.delete(key);
          setValue(result);
          setMenu(null);
          invalidate();
        }
      } catch (failure) {
        if (currentOwner.current !== owner || !guard.isCurrent()) return;
        if (
          guard.isCurrent() &&
          currentOwner.current === owner &&
          failure instanceof ApiError &&
          [400, 409, 410, 422].includes(failure.status)
        )
          requests.current.items.delete(key);
        throw failure;
      }
    });
  return {
    enabled,
    plan,
    loading: resource.loading,
    error: resource.error,
    action,
    items: visibleItems,
    menu,
    setMenu,
    ensure,
    act,
    pollPaused,
    refresh: () => {
      pollCount.current = 0;
      setPollPaused(false);
      refresh();
    },
  };
}
export type DailyGrowthController = ReturnType<typeof useDailyGrowth>;

export function DailyRecommendations({
  daily,
}: {
  daily: DailyGrowthController;
}) {
  const { navigate } = useApp();
  if (!daily.enabled) return null;
  const currentMenu = daily.items.find(item => item.id === daily.menu);
  const status = daily.plan?.status;
  return (
    <View>
      <View style={s.groupHeading}>
        <Text style={s.section}>
          {status === 'paused' ? '已经开始的事' : '今天推荐'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="调整每日成长节奏"
          onPress={() => navigate({ name: 'growthSettings' })}
          style={s.textAction}
        >
          <Text style={s.small}>调整节奏</Text>
        </Pressable>
      </View>
      {!!daily.plan && (
        <Text style={s.muted}>
          {localDateLabel(daily.plan.local_date)} ·{' '}
          {status === 'paused'
            ? '今天暂停新建议，原有事项会保留'
            : '根据你的目标与时间安排'}
        </Text>
      )}
      <ErrorNotice message={daily.error} retry={daily.refresh} />
      <ErrorNotice message={daily.action.error} retry={daily.refresh} />
      {currentMenu && (
        <View style={s.menu}>
          <Text style={s.section}>{currentMenu.title}</Text>
          {!!currentMenu.reason && (
            <Text style={s.small}>{currentMenu.reason}</Text>
          )}
          {!!currentMenu.description && (
            <Text style={s.body}>{currentMenu.description}</Text>
          )}
          <View style={s.menuActions}>
            {currentMenu.can_replace && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={'换一个建议：' + currentMenu.title}
                disabled={daily.action.busy}
                style={s.textAction}
                onPress={() => {
                  void daily.act(currentMenu, 'replace');
                }}
              >
                <Text style={s.link}>换一个</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={daily.action.busy}
              style={s.textAction}
              onPress={() => {
                void daily.act(currentMenu, 'skip');
              }}
            >
              <Text style={s.link}>
                {currentMenu.status === 'accepted'
                  ? '移出今天推荐'
                  : '今天不做'}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={s.textAction}
              onPress={() => daily.setMenu(null)}
            >
              <Text style={s.small}>收起</Text>
            </Pressable>
          </View>
          <Text style={s.muted}>原有待办与已经接纳的事情不会因此删除。</Text>
        </View>
      )}
      {daily.items.map(item => (
        <View key={item.id} style={s.row}>
          <View style={s.rowIcon}>
            <Icon name={kindIcons[item.kind]} size={19} color={colors.action} />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={'查看推荐理由：' + item.title}
            onPress={() =>
              daily.setMenu(daily.menu === item.id ? null : item.id)
            }
            style={s.rowContent}
          >
            <Text style={s.rowTitle} numberOfLines={2}>
              {item.title}
            </Text>
            <Text style={s.small} numberOfLines={1}>
              {item.todo ? shortSourceLabel(item.todo) : 'AI 建议'}
              {item.focus ? ' · 今日重点' : ''}
              {item.estimated_minutes
                ? ` · 约 ${item.estimated_minutes} 分钟`
                : ''}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              (item.status === 'accepted' ? '继续事项：' : '开始建议：') +
              item.title
            }
            style={s.rowAction}
            disabled={daily.action.busy}
            onPress={() => {
              void daily.act(item, 'accept');
            }}
          >
            <Text style={s.link}>
              {item.todo ? nextAction(item.todo) : '开始'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={'调整推荐：' + item.title}
            style={s.menuAction}
            onPress={() =>
              daily.setMenu(daily.menu === item.id ? null : item.id)
            }
          >
            <Icon name="more" size={17} color={colors.secondary} />
          </Pressable>
        </View>
      ))}
      {status === 'failed' && (
        <View style={{ marginVertical: 12 }}>
          <ErrorNotice
            message={
              daily.plan?.error || '今天的建议还没准备成功。原有事项仍然保留。'
            }
          />
          {daily.plan?.can_retry === true ? (
            <Button
              variant="secondary"
              loading={daily.action.busy}
              onPress={() => {
                void daily.ensure();
              }}
            >
              重新准备今天的建议
            </Button>
          ) : (
            <Button variant="ghost" onPress={daily.refresh}>
              刷新准备状态
            </Button>
          )}
        </View>
      )}
      {!!daily.plan &&
        !daily.plan.id &&
        status !== 'paused' &&
        status !== 'failed' &&
        !daily.loading && (
          <Button
            variant="secondary"
            loading={daily.action.busy}
            onPress={() => {
              void daily.ensure();
            }}
          >
            准备今天的建议
          </Button>
        )}
      {['queued', 'generating'].includes(status ?? '') && (
        <Text style={[s.small, { marginVertical: 12 }]}>
          {daily.pollPaused
            ? '准备结果还未确认，可以稍后刷新查看。'
            : '正在准备少量适合今天的建议，原有事项可以先继续。'}
        </Text>
      )}
      {daily.pollPaused && (
        <Button variant="ghost" onPress={daily.refresh}>
          更新每日建议
        </Button>
      )}
      {status === 'ready' && !daily.items.length && (
        <Text style={[s.small, { marginVertical: 12 }]}>
          今天没有新的推荐。已经接纳的事情仍在事项中，可以按自己的节奏继续。
        </Text>
      )}
      {status === 'paused' && !daily.items.length && (
        <Text style={[s.small, { marginVertical: 12 }]}>
          今天留点空白也可以。原有事项和已经积累的成长都会保留。
        </Text>
      )}
      {daily.items.length > 0 && (
        <View style={[s.groupHeading, { marginTop: 18 }]}>
          <Text style={s.section}>其他事项</Text>
          <Text style={s.muted}>原来的待办，一直都在</Text>
        </View>
      )}
    </View>
  );
}

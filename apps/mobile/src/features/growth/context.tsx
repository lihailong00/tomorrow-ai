import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Pressable, View } from 'react-native';
import { useApp, useResource } from '../../app/context';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import { colors } from '../../ui/theme';
import { platform } from '../../platform/ports';
import { getGrowthPreferences, getGrowthSummary, getTodoReward } from './api';
import { GrowthOrb } from './GrowthOrb';
import { growthStyles as s } from './styles';
import type { GrowthPreferences, GrowthSummary, TodoReward } from './types';

type Owner = { api: ReturnType<typeof useApp>['api']; userId?: string };
export type RewardObservation = {
  owner: Owner;
  todoId: string;
  generation: number;
  before: TodoReward | null;
};
type RewardBaseline = {
  generation: number;
  readSequence: number;
  value: TodoReward | null;
};
type GrowthData = { preferences: GrowthPreferences; summary: GrowthSummary };
type Feedback = {
  owner: Owner;
  id: string;
  todoId: string;
  title: string;
  detail: string;
  halo: string;
};
type GrowthContextValue = {
  data: GrowthData | null;
  loading: boolean;
  error: string | null;
  feedback: Feedback | null;
  refresh: () => void;
  updatePreferences: (preferences: GrowthPreferences) => void;
  prefetchReward: (todoId: string) => Promise<void>;
  prepareReward: (todoId: string) => RewardObservation | null;
  confirmReward: (observation: RewardObservation | null) => Promise<void>;
  dismissFeedback: () => void;
  activate: () => void;
};
const GrowthContext = createContext<GrowthContextValue | null>(null);
export const useGrowth = () => useContext(GrowthContext);
export function useGrowthData() {
  const value = useGrowth();
  const activate = value?.activate;
  useEffect(() => {
    activate?.();
  }, [activate]);
  return value;
}

/** Growth failure must never turn an already-saved Todo into a failed mutation. */
export function GrowthProvider({ children }: { children: React.ReactNode }) {
  const { api, user, revision } = useApp();
  const owner = useMemo(() => ({ api, userId: user?.id }), [api, user?.id]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const mounted = useRef(true);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [requestedOwner, setRequestedOwner] = useState<Owner | null>(null);
  const activate = useCallback(() => {
    if (currentOwner.current === owner) setRequestedOwner(owner);
  }, [owner]);
  const requested = requestedOwner === owner;
  const dataRef = useRef<GrowthData | null>(null);
  const requestSequence = useRef(0);
  const appliedSequence = useRef(0);
  const seen = useRef({ owner, ids: new Set<string>() });
  if (seen.current.owner !== owner) seen.current = { owner, ids: new Set() };
  const baselines = useRef({ owner, todos: new Map<string, RewardBaseline>() });
  if (baselines.current.owner !== owner)
    baselines.current = { owner, todos: new Map() };
  const resource = useResource<GrowthData | null>(async () => {
    if (!owner.userId || !requested) return null;
    const sequence = ++requestSequence.current;
    const [preferences, summary] = await Promise.all([
      getGrowthPreferences(api),
      getGrowthSummary(api),
    ]);
    if (currentOwner.current !== owner) return { preferences, summary };
    if (sequence < appliedSequence.current && dataRef.current)
      return dataRef.current;
    appliedSequence.current = sequence;
    const latest = dataRef.current;
    return {
      preferences:
        latest && latest.preferences.version > preferences.version
          ? latest.preferences
          : preferences,
      summary,
    };
  }, [owner, requested]);
  dataRef.current = resource.value;
  const { refresh, setValue } = resource;
  const previousRevision = useRef({ owner, revision });
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { owner, revision };
    if (previous.owner === owner && previous.revision !== revision) refresh();
  }, [owner, revision, refresh]);
  useEffect(
    () =>
      platform.onForeground?.(() => {
        if (requested) refresh();
      }),
    [requested, refresh],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, [owner]);
  const current = useCallback(
    (candidate: Owner) => mounted.current && currentOwner.current === candidate,
    [],
  );
  const updatePreferences = useCallback(
    (preferences: GrowthPreferences) => {
      if (!current(owner)) return;
      const latest = dataRef.current;
      if (latest) dataRef.current = { ...latest, preferences };
      appliedSequence.current = ++requestSequence.current;
      setValue(previous =>
        previous ? { ...previous, preferences } : previous,
      );
      refresh();
    },
    [current, owner, refresh, setValue],
  );
  const baselineFor = useCallback((todoId: string) => {
    let baseline = baselines.current.todos.get(todoId);
    if (!baseline) {
      baseline = { generation: 0, readSequence: 0, value: null };
      baselines.current.todos.set(todoId, baseline);
    }
    return baseline;
  }, []);
  const prefetchReward = useCallback(
    async (todoId: string) => {
      if (!owner.userId || !current(owner)) return;
      const baseline = baselineFor(todoId);
      const generation = baseline.generation;
      const sequence = ++baseline.readSequence;
      try {
        const value = await getTodoReward(api, todoId);
        if (
          !current(owner) ||
          generation !== baseline.generation ||
          sequence !== baseline.readSequence
        )
          return;
        baseline.value = value;
      } catch {
        if (
          current(owner) &&
          generation === baseline.generation &&
          sequence === baseline.readSequence
        )
          baseline.value = null;
      }
    },
    [api, baselineFor, current, owner],
  );
  const prepareReward = useCallback(
    (todoId: string) => {
      if (!owner.userId || !current(owner)) return null;
      const baseline = baselineFor(todoId);
      // Every new action fences older reads and celebrations, even when no
      // growth baseline is available. The actual Todo request never waits here.
      const generation = ++baseline.generation;
      ++baseline.readSequence;
      setFeedback(previous =>
        previous?.owner === owner && previous.todoId === todoId
          ? null
          : previous,
      );
      return { owner, todoId, generation, before: baseline.value };
    },
    [baselineFor, current, owner],
  );
  const confirmReward = useCallback(
    async (observation: RewardObservation | null) => {
      if (!current(owner)) return;
      if (!observation) {
        refresh();
        return;
      }
      if (observation.owner !== owner) return;
      const baseline = baselineFor(observation.todoId);
      const valid = () =>
        current(observation.owner) &&
        baseline.generation === observation.generation;
      const readSequence = ++baseline.readSequence;
      try {
        const after = await getTodoReward(api, observation.todoId);
        if (!valid()) return;
        if (readSequence === baseline.readSequence) baseline.value = after;
        const before = observation.before?.reward;
        const reward = after.reward;
        if (!reward?.active) {
          setFeedback(previous =>
            previous?.owner === owner && previous.todoId === observation.todoId
              ? null
              : previous,
          );
          refresh();
          return;
        }
        // Attribute the change to the same Todo, not another device's global XP.
        if (
          reward.todo_id !== observation.todoId ||
          !observation.before ||
          before?.active ||
          reward.xp <= 0
        ) {
          refresh();
          return;
        }
        // Metadata corrections also bump version. Only the stable entitlement
        // identity can suppress a replay without inventing another celebration.
        const eventId = reward.id + ':' + reward.earned_at;
        if (seen.current.owner !== owner || seen.current.ids.has(eventId))
          return;
        const sequence = ++requestSequence.current;
        const summary = await getGrowthSummary(api);
        if (!valid() || sequence < appliedSequence.current) return;
        const latestReward = baseline.value?.reward;
        if (
          latestReward &&
          latestReward.id === reward.id &&
          (latestReward.version > reward.version || !latestReward.active)
        )
          return;
        const latestData = dataRef.current;
        if (!latestData?.preferences.enabled) return;
        seen.current.ids.add(eventId);
        appliedSequence.current = sequence;
        dataRef.current = { ...latestData, summary };
        setValue(previous => (previous ? { ...previous, summary } : previous));
        const upgraded = summary.level > observation.before.level;
        setFeedback({
          owner,
          id: eventId,
          todoId: observation.todoId,
          title: upgraded
            ? `成长 Lv.${summary.level} · 又向前走了一步`
            : `+${reward.xp} 成长 · 今天已前进 ${summary.today.action_count} 步`,
          detail:
            summary.level >= 5 && observation.before.level < 5
              ? '星光光环已经解锁，可以在我的成长里使用。'
              : summary.level >= 3 && observation.before.level < 3
              ? '晨光光环已经解锁，可以在我的成长里使用。'
              : reward.kind === 'communication'
              ? '你确认的这一步已记录，等待反馈的事项会继续保留。'
              : '又一件真实做成的事，留下了自己的记录。',
          halo: summary.halo,
        });
      } catch {
        // The mutation has already succeeded. Reconcile on the next normal read.
        if (valid()) {
          if (readSequence === baseline.readSequence) baseline.value = null;
          refresh();
        }
      }
    },
    [api, baselineFor, current, owner, refresh, setValue],
  );
  const visibleFeedback = feedback?.owner === owner ? feedback : null;
  useEffect(() => {
    if (!visibleFeedback) return;
    const timer = setTimeout(
      () =>
        setFeedback(previous =>
          previous === visibleFeedback ? null : previous,
        ),
      7000,
    );
    return () => clearTimeout(timer);
  }, [visibleFeedback]);
  const value = useMemo(
    () => ({
      data: resource.value,
      loading: resource.loading,
      error: resource.error,
      feedback: visibleFeedback,
      refresh,
      updatePreferences,
      prefetchReward,
      prepareReward,
      confirmReward,
      dismissFeedback: () => setFeedback(null),
      activate,
    }),
    [
      resource.value,
      resource.loading,
      resource.error,
      visibleFeedback,
      refresh,
      updatePreferences,
      prefetchReward,
      prepareReward,
      confirmReward,
      activate,
    ],
  );
  return (
    <GrowthContext.Provider value={value}>{children}</GrowthContext.Provider>
  );
}

export function GrowthFeedbackBanner() {
  const growth = useGrowth();
  const feedback = growth?.feedback;
  if (!feedback) return null;
  return (
    <View
      style={s.notice}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <GrowthOrb size={40} halo={feedback.halo} pulseKey={feedback.id} />
      <View style={s.flex}>
        <Text style={s.noticeTitle}>{feedback.title}</Text>
        <Text style={s.small}>{feedback.detail}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="收起成长提示"
        onPress={growth.dismissFeedback}
        style={s.noticeClose}
      >
        <Icon name="close" size={16} color={colors.secondary} />
      </Pressable>
    </View>
  );
}

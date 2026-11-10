import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ApiError, newRequestId } from '../../api/client';
import { useAction, useApp, useResource } from '../../app/context';
import {
  commandGrowthJourney,
  feedbackGrowthStep,
  getGrowthJourneys,
  startGrowthJourney,
  startGrowthStep,
} from './api';
import { useGrowthData } from './context';
import { coachingPrompt } from './coachingPrompt';
import type { GrowthGoal, GrowthJourney, JourneyStep } from './types';

export function useGrowthJourney() {
  const { api, user, revision, navigate, invalidate } = useApp();
  const growth = useGrowthData();
  const owner = useMemo(() => ({ api, userId: user?.id }), [api, user?.id]);
  const current = useRef(owner);
  current.current = owner;
  const resource = useResource(() => getGrowthJourneys(api), [owner]);
  const action = useAction();
  const keys = useRef({ owner, items: new Map<string, string>() });
  if (keys.current.owner !== owner) keys.current = { owner, items: new Map() };
  const requestId = (key: string, input: unknown) => {
    const fingerprint = key + ':' + JSON.stringify(input);
    if (!keys.current.items.has(fingerprint))
      keys.current.items.set(fingerprint, newRequestId());
    return keys.current.items.get(fingerprint)!;
  };
  const [pollPaused, setPollPaused] = useState(false);
  const active = resource.value?.active;
  const refresh = resource.refresh;
  const previousRevision = useRef({ owner, revision });
  useEffect(() => {
    const previous = previousRevision.current;
    previousRevision.current = { owner, revision };
    if (previous.owner === owner && previous.revision !== revision) refresh();
  }, [revision, owner, refresh]);
  useEffect(() => {
    setPollPaused(false);
    if (!active || !['queued', 'generating'].includes(active.status)) return;
    let reads = 0;
    let timer: ReturnType<typeof setInterval>;
    const poll = () => {
      if (['background', 'inactive'].includes(AppState.currentState)) return;
      if (reads++ >= 40) {
        setPollPaused(true);
        clearInterval(timer);
        return;
      }
      refresh();
    };
    timer = setInterval(poll, 3000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        reads = 0;
        setPollPaused(false);
        clearInterval(timer);
        timer = setInterval(poll, 3000);
        poll();
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [active?.id, active?.status, refresh, owner]);
  const create = (goal: string, kind: GrowthGoal['kind'], minutes: number) =>
    action.run(async guard => {
      const prefs = growth?.data?.preferences;
      if (!prefs) throw new Error('成长设置还在加载，请稍后再试。');
      const input = {
        goal: goal.trim(),
        kind,
        daily_minutes: minutes,
        preferences_version: prefs.version,
      };
      try {
        const journey = await startGrowthJourney(api, {
          ...input,
          client_request_id: requestId('create', input),
        });
        if (!guard.isCurrent() || current.current !== owner) return;
        resource.setValue(previous => ({
          active: journey,
          past: previous?.past ?? [],
        }));
        growth?.refresh();
        invalidate();
      } catch (error) {
        if (
          guard.isCurrent() &&
          current.current === owner &&
          error instanceof ApiError &&
          [400, 409, 422].includes(error.status)
        ) {
          refresh();
          growth?.refresh();
        }
        throw error;
      }
    });
  const command = (journey: GrowthJourney, kind: 'archive' | 'retry') =>
    action.run(async guard => {
      const input = { version: journey.version, action: kind };
      const result = await commandGrowthJourney(api, journey.id, {
        ...input,
        client_request_id: requestId(journey.id, input),
      });
      if (!guard.isCurrent() || current.current !== owner) return;
      resource.setValue(previous => ({
        active: kind === 'archive' ? null : result,
        past:
          kind === 'archive'
            ? [
                result,
                ...(previous?.past.filter(j => j.id !== result.id) ?? []),
              ].slice(0, 20)
            : previous?.past ?? [],
      }));
      refresh();
      invalidate();
    });
  const begin = (
    journey: GrowthJourney,
    step: JourneyStep,
    coach = false,
    easier = false,
    alternative = false,
  ) =>
    action.run(async guard => {
      const input = { version: step.version };
      const todo =
        step.todo ??
        (await startGrowthStep(api, journey.id, step.id, {
          ...input,
          client_request_id: requestId('begin:' + step.id, input),
        }));
      if (!guard.isCurrent() || current.current !== owner) return;
      if (!todo?.id) throw new Error('未能确认这一步，请刷新后重试。');
      refresh();
      invalidate();
      if (coach)
        navigate({
          name: 'chat',
          prompt: coachingPrompt(journey, step, easier, alternative),
        });
      else navigate({ name: 'todo', id: todo.id });
    });
  const feedback = (
    journey: GrowthJourney,
    step: JourneyStep,
    kind: 'skip' | 'too_hard' | 'just_right' | 'too_easy',
  ) =>
    action.run(async guard => {
      const input = { version: step.version, action: kind };
      const result = await feedbackGrowthStep(api, journey.id, step.id, {
        ...input,
        client_request_id: requestId('feedback:' + step.id, input),
      });
      if (!guard.isCurrent() || current.current !== owner) return;
      resource.setValue(previous =>
        result.status === 'completed'
          ? {
              active: null,
              past: [
                result,
                ...(previous?.past.filter(j => j.id !== result.id) ?? []),
              ].slice(0, 20),
            }
          : { active: result, past: previous?.past ?? [] },
      );
      invalidate();
      refresh();
    });
  return { ...resource, action, create, command, begin, feedback, pollPaused };
}
export type GrowthJourneyController = ReturnType<typeof useGrowthJourney>;

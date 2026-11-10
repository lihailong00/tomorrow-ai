import {
  getGrowthHistory,
  getGrowthJourneys,
  startGrowthStep,
} from '../src/features/growth/api';
import { coachingPrompt } from '../src/features/growth/coachingPrompt';
import type { GrowthJourney, JourneyStep } from '../src/features/growth/types';
const api = (value: unknown) =>
  ({ request: jest.fn().mockResolvedValue(value) } as any);
test('rejects an incomplete or null journey before it reaches a native view', async () => {
  for (const value of [
    null,
    {},
    { active: undefined, past: [] },
    { active: { id: 'one', steps: [null], version: 1 }, past: [] },
    {
      active: {
        id: 'one',
        goal: '我的目标',
        kind: 'learning',
        daily_minutes: 15,
        status: 'failed',
        error: { message: 'old server shape' },
        can_retry: true,
        version: 1,
        steps: [],
        completed_steps: 0,
        skipped_steps: 0,
      },
      past: [],
    },
  ]) {
    await expect(getGrowthJourneys(api(value))).rejects.toThrow('成长数据');
  }
});
test('accepts the actual empty collection without inventing seeded routes', async () => {
  await expect(
    getGrowthJourneys(api({ active: null, past: [] })),
  ).resolves.toEqual({ active: null, past: [] });
});
test('rejects malformed history and a backwards pagination cursor', async () => {
  const empty = {
    period: 'all',
    action_count: 0,
    active_days: 0,
    learning_actions: 0,
    exercise_minutes: 0,
    total_xp: 0,
    records: [],
    next_offset: null,
  };
  for (const patch of [
    { records: [null] },
    { active_days: -1 },
    { next_offset: 0 },
    { period: 'month' },
  ])
    await expect(
      getGrowthHistory(api({ ...empty, ...patch }), 'all'),
    ).rejects.toThrow('成长数据');
  await expect(getGrowthHistory(api(empty), 'all')).resolves.toEqual(empty);
});
test('a missing step Todo cannot navigate the user into a phantom task', async () => {
  for (const value of [null, {}, { id: 'one', status: 'pending', version: 1 }])
    await expect(
      startGrowthStep(api(value), 'route', 'step', {
        version: 1,
        client_request_id: 'intent',
      }),
    ).rejects.toThrow('成长数据');
});
test('coaching adapts to the previous real difficulty feedback and keeps the completion criterion', () => {
  const step = {
    id: 'current',
    title: '写一个借用例子',
    criterion: '保存自己的修改与解释',
    estimated_minutes: 15,
    difficulty: null,
  } as JourneyStep;
  const route = {
    goal: '理解 Rust 借用',
    steps: [{ id: 'prior', difficulty: 'too_hard' }, step],
  } as GrowthJourney;
  expect(coachingPrompt(route, step)).toContain('5分钟能开始');
  expect(coachingPrompt(route, step)).toContain(step.criterion);
  expect(coachingPrompt(route, step)).toContain('不要替我勾选完成');
  route.steps[0].difficulty = 'too_easy';
  expect(coachingPrompt(route, step)).toContain('先用一个小问题确认基础');
  expect(coachingPrompt(route, step, false, true)).toContain(
    '看一个例子／自己动手试／边问边学',
  );
});

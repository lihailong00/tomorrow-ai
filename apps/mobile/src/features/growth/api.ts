import { ApiClient, ApiError } from '../../api/client';
import type { Todo } from '../todos/types';
import type {
  AcceptDailyPlanItem,
  DailyPlan,
  GrowthPreferences,
  GrowthSummary,
  TodoActionResult,
  TodoActions,
  TodoReward,
  UpdateGrowthPreferences,
  GrowthJourneys,
  GrowthJourney,
  GrowthGoal,
  GrowthHistory,
  GrowthPeriod,
} from './types';

async function request<T>(
  api: ApiClient,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  try {
    return await api.request<T>(path, method, body);
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status))
      throw new ApiError(
        'growth_unsupported',
        '当前服务还不支持每日成长，请更新服务后重试。原有事项仍可使用。',
        error.status,
      );
    throw error;
  }
}
const invalid = () => new Error('暂时无法读取成长数据，请检查服务版本后重试。');
export async function getGrowthPreferences(api: ApiClient) {
  const value = await request<GrowthPreferences>(api, '/growth/preferences');
  if (
    typeof value?.enabled !== 'boolean' ||
    !Number.isSafeInteger(value.version) ||
    !Array.isArray(value.goals)
  )
    throw invalid();
  return value;
}
export function updateGrowthPreferences(
  api: ApiClient,
  input: UpdateGrowthPreferences,
) {
  return request<GrowthPreferences>(api, '/growth/preferences', 'PATCH', input);
}
export async function getGrowthSummary(api: ApiClient) {
  const value = await request<GrowthSummary>(api, '/growth/summary');
  if (
    !Number.isSafeInteger(value?.total_xp) ||
    value.total_xp < 0 ||
    !Number.isSafeInteger(value.level) ||
    value.level < 1 ||
    !value.today ||
    !Array.isArray(value.week?.days) ||
    !Array.isArray(value.week?.records) ||
    !Array.isArray(value.milestones)
  )
    throw invalid();
  return value;
}
export async function getTodoReward(api: ApiClient, id: string) {
  const value = await request<TodoReward>(
    api,
    '/growth/todos/' + encodeURIComponent(id),
  );
  if (
    !Number.isSafeInteger(value?.total_xp) ||
    value.total_xp < 0 ||
    !Number.isSafeInteger(value.level) ||
    value.level < 1 ||
    (value.reward !== null &&
      (value.reward?.todo_id !== id ||
        typeof value.reward.active !== 'boolean' ||
        !Number.isSafeInteger(value.reward.version) ||
        !Number.isSafeInteger(value.reward.xp)))
  )
    throw invalid();
  return value;
}
export const getTodoActions = (api: ApiClient, id: string) =>
  request<TodoActions>(api, '/todos/' + encodeURIComponent(id) + '/actions');
export const confirmTodoAction = async (
  api: ApiClient,
  id: string,
  input: {
    kind: 'replied' | 'undo_replied' | 'exercise_completed';
    version: number;
    client_request_id: string;
    draft?: string | null;
    actual_minutes?: number | null;
    progress_notes?: string | null;
  },
) => {
  const value = await request<TodoActionResult>(
    api,
    '/todos/' + encodeURIComponent(id) + '/actions',
    'POST',
    input,
  );
  if (value?.todo?.id !== id || typeof value.actions?.replied !== 'boolean')
    throw invalid();
  return value;
};
export async function getDailyPlan(api: ApiClient) {
  const value = await request<DailyPlan>(api, '/daily-plan');
  if (!value || !Array.isArray(value.items) || typeof value.status !== 'string')
    throw invalid();
  return value;
}
export const ensureDailyPlan = (api: ApiClient, client_request_id: string) =>
  request<DailyPlan>(api, '/daily-plan/ensure', 'POST', { client_request_id });
const itemPath = (id: string, action: string) =>
  '/daily-plan/items/' + encodeURIComponent(id) + '/' + action;
export const acceptDailyPlanItem = (
  api: ApiClient,
  id: string,
  input: { version: number; client_request_id: string },
) => request<AcceptDailyPlanItem>(api, itemPath(id, 'accept'), 'POST', input);
export const skipDailyPlanItem = (
  api: ApiClient,
  id: string,
  input: { version: number; client_request_id: string },
) => request<DailyPlan>(api, itemPath(id, 'skip'), 'POST', input);
export const replaceDailyPlanItem = (
  api: ApiClient,
  id: string,
  input: { version: number; client_request_id: string },
) => request<DailyPlan>(api, itemPath(id, 'replace'), 'POST', input);

export async function getGrowthJourneys(api: ApiClient) {
  const value = await request<GrowthJourneys>(api, '/growth/journeys');
  if (
    !value ||
    !Array.isArray(value.past) ||
    value.past.length > 20 ||
    !('active' in value) ||
    (value.active !== null && !value.active)
  )
    throw invalid();
  for (const j of [...value.past, ...(value.active ? [value.active] : [])]) {
    checkedJourney(j);
  }
  return value;
}
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
function validTodo(value: Todo | null): boolean {
  return (
    value === null ||
    (!!value &&
      typeof value.id === 'string' &&
      typeof value.title === 'string' &&
      typeof value.status === 'string' &&
      count(value.version) &&
      value.version > 0)
  );
}
function checkedJourney(j: GrowthJourney): GrowthJourney {
  if (
    !j ||
    typeof j.id !== 'string' ||
    !j.id ||
    typeof j.goal !== 'string' ||
    !['learning', 'exercise', 'general'].includes(j.kind) ||
    ![
      'queued',
      'generating',
      'ready',
      'failed',
      'completed',
      'archived',
    ].includes(j.status) ||
    !Number.isSafeInteger(j.daily_minutes) ||
    j.daily_minutes < 5 ||
    j.daily_minutes > 120 ||
    !Array.isArray(j.steps) ||
    j.steps.length > 6 ||
    !count(j.version) ||
    j.version < 1 ||
    !count(j.completed_steps) ||
    !count(j.skipped_steps) ||
    j.completed_steps + j.skipped_steps > j.steps.length ||
    typeof j.can_retry !== 'boolean' ||
    (j.error !== null && typeof j.error !== 'string')
  )
    throw invalid();
  const ids = new Set<string>();
  for (const step of j.steps) {
    if (
      !step ||
      typeof step.id !== 'string' ||
      !step.id ||
      ids.has(step.id) ||
      typeof step.title !== 'string' ||
      typeof step.description !== 'string' ||
      typeof step.criterion !== 'string' ||
      !['locked', 'current', 'completed', 'skipped', 'deleted'].includes(
        step.status,
      ) ||
      !Number.isSafeInteger(step.estimated_minutes) ||
      step.estimated_minutes < 1 ||
      step.estimated_minutes > 120 ||
      !count(step.version) ||
      step.version < 1 ||
      !validTodo(step.todo) ||
      (step.difficulty !== null &&
        !['too_hard', 'just_right', 'too_easy'].includes(step.difficulty))
    )
      throw invalid();
    ids.add(step.id);
  }
  return j;
}
export const startGrowthJourney = (
  api: ApiClient,
  input: {
    goal: string;
    kind: GrowthGoal['kind'];
    daily_minutes: number;
    preferences_version: number;
    client_request_id: string;
  },
) =>
  request<GrowthJourney>(api, '/growth/journeys', 'POST', input).then(
    checkedJourney,
  );
export const commandGrowthJourney = (
  api: ApiClient,
  id: string,
  input: {
    version: number;
    client_request_id: string;
    action: 'retry' | 'archive';
  },
) =>
  request<GrowthJourney>(
    api,
    '/growth/journeys/' + encodeURIComponent(id) + '/commands',
    'POST',
    input,
  ).then(checkedJourney);
const journeyStepPath = (id: string, step: string, action: string) =>
  '/growth/journeys/' +
  encodeURIComponent(id) +
  '/steps/' +
  encodeURIComponent(step) +
  '/' +
  action;
export const startGrowthStep = (
  api: ApiClient,
  id: string,
  step: string,
  input: { version: number; client_request_id: string },
) =>
  request<Todo>(api, journeyStepPath(id, step, 'start'), 'POST', input).then(
    value => {
      if (!value || !validTodo(value)) throw invalid();
      return value;
    },
  );
export const feedbackGrowthStep = (
  api: ApiClient,
  id: string,
  step: string,
  input: {
    version: number;
    client_request_id: string;
    action: 'skip' | 'too_hard' | 'just_right' | 'too_easy';
  },
) =>
  request<GrowthJourney>(
    api,
    journeyStepPath(id, step, 'commands'),
    'POST',
    input,
  ).then(checkedJourney);
export async function getGrowthHistory(
  api: ApiClient,
  period: GrowthPeriod,
  offset = 0,
) {
  const value = await request<GrowthHistory>(
    api,
    `/growth/history?period=${period}&offset=${offset}&limit=30`,
  );
  if (
    !value ||
    value.period !== period ||
    !Array.isArray(value.records) ||
    value.records.length > 30 ||
    ![
      value.action_count,
      value.active_days,
      value.learning_actions,
      value.exercise_minutes,
      value.total_xp,
    ].every(count) ||
    (value.next_offset !== null && value.next_offset !== offset + 30)
  )
    throw invalid();
  for (const item of value.records) {
    const r = item?.reward;
    if (
      !r ||
      typeof r.id !== 'string' ||
      typeof r.todo_id !== 'string' ||
      typeof r.title !== 'string' ||
      typeof r.local_date !== 'string' ||
      !count(r.xp) ||
      r.active !== true ||
      (item.note !== null && typeof item.note !== 'string')
    )
      throw invalid();
  }
  return value;
}

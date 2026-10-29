import { ApiClient, ApiError } from '../../api/client';
import type {
  AcceptDailyPlanItem,
  DailyPlan,
  GrowthPreferences,
  GrowthSummary,
  TodoActionResult,
  TodoActions,
  TodoReward,
  UpdateGrowthPreferences,
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

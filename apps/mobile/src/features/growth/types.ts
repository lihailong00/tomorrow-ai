import type { Todo, TodoKind } from '../todos/types';

export type GrowthGoal = {
  kind: 'learning' | 'exercise' | 'general';
  title: string;
};
export type GrowthPreferences = {
  enabled: boolean;
  daily_minutes: number;
  use_existing_todos: boolean;
  goals: GrowthGoal[];
  paused_today: boolean;
  timezone: string;
  version: number;
  halo: 'classic' | 'sunrise';
};
export type UpdateGrowthPreferences = Partial<
  Pick<
    GrowthPreferences,
    | 'enabled'
    | 'daily_minutes'
    | 'use_existing_todos'
    | 'goals'
    | 'paused_today'
    | 'halo'
  >
> & { version: number };
export type GrowthReward = {
  id: string;
  todo_id: string;
  title: string;
  kind: TodoKind;
  xp: number;
  active: boolean;
  earned_at: string;
  updated_at: string;
  version: number;
  local_date: string;
  timezone: string;
  minutes: number | null;
};
export type TodoReward = {
  reward: GrowthReward | null;
  total_xp: number;
  level: number;
};
export type TodoActions = { replied: boolean; replied_at: string | null };
export type TodoActionResult = {
  todo: Todo;
  actions: TodoActions;
  reward: GrowthReward | null;
};
export type GrowthSummary = {
  total_xp: number;
  level: number;
  level_xp: number;
  xp_per_level: number;
  halo: 'classic' | 'sunrise';
  available_halos: string[];
  today: {
    date: string;
    timezone: string;
    action_count: number;
    xp: number;
    paused: boolean;
  };
  week: {
    start_date: string;
    end_date: string;
    active_days: number;
    days: Array<{
      date: string;
      action_count: number;
      xp: number;
      paused: boolean;
    }>;
    communication_actions: number;
    learning_actions: number;
    exercise_minutes: number;
    records: GrowthReward[];
  };
  milestones: Array<{
    id: string;
    title: string;
    description: string;
    progress: number;
    target: number;
    unlocked: boolean;
  }>;
};
export type DailyPlanItem = {
  id: string;
  title: string;
  description: string;
  kind: TodoKind;
  reason: string;
  estimated_minutes: number;
  source_kind: string;
  source_label: string;
  todo_id: string | null;
  todo: Todo | null;
  status: 'suggested' | 'accepted' | 'skipped';
  focus: boolean;
  can_replace: boolean;
  version: number;
};
export type DailyPlan = {
  id: string | null;
  local_date: string;
  timezone: string;
  status: 'disabled' | 'paused' | 'queued' | 'generating' | 'ready' | 'failed';
  error: string | null;
  items: DailyPlanItem[];
  can_retry?: boolean;
};
export type AcceptDailyPlanItem = { item: DailyPlanItem; todo: Todo };

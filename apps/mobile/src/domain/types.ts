/** Versioned API DTOs. Keep aligned with docs/implementation-contract.md. */
export type User = {
  id: string;
  email: string;
  phone?: string;
  name: string;
  timezone: string;
  created_at: string;
};
export type AuthSession = { token: string; user: User };
export type MemoryKind = 'preference' | 'person' | 'project' | 'goal' | 'fact';
export type Memory = {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
};
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';
export type Step = {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detail?: string | null;
};
export type Task = {
  id: string;
  title: string;
  instruction: string;
  kind: string;
  status: TaskStatus;
  progress: number;
  summary?: string | null;
  result?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  steps: Step[];
  model_mode: string;
  approval_required: boolean;
  approved_at?: string | null;
  artifact_id?: string | null;
};
export type Schedule = {
  id: string;
  title: string;
  instruction: string;
  frequency: 'daily' | 'weekdays' | 'weekly' | 'once';
  time: string;
  timezone: string;
  enabled: boolean;
  next_run_at: string;
  last_run_at?: string | null;
  created_at: string;
};
export type Message = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  model_mode?: string | null;
};
export type Conversation = { id: string; title: string; updated_at: string };
export type Artifact = {
  id: string;
  task_id: string;
  title: string;
  content: string;
  mime_type: string;
  created_at: string;
};
export type Notification = {
  id: string;
  title: string;
  body: string;
  task_id?: string | null;
  read: boolean;
  created_at: string;
};
export type Capability = {
  id: string;
  name: string;
  description: string;
  category: string;
  status: 'available' | 'not_configured' | 'coming_soon';
  detail: string;
};
export type RuntimeInfo = {
  agent_harness?: 'pi' | 'direct';
  model_mode: string;
  model_name?: string | null;
  scheduler_mode: string;
  storage_mode: string;
};
export type Today = {
  date: string;
  greeting: string;
  briefing: string;
  tasks: Task[];
  schedules: Schedule[];
  memories: Memory[];
  notifications: Notification[];
  stats: {
    tasks_completed: number;
    active_routines: number;
    memory_count: number;
  };
  runtime: RuntimeInfo;
};
export type CapabilityResponse = { items: Capability[]; runtime: RuntimeInfo };
export type ChatResponse = {
  conversation_id: string;
  message: Message;
  agent_run_id?: string;
};
export type Upload = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  created_at: string;
  uri: string;
};
export type Connector = {
  id: string;
  name: string;
  status: 'connected' | 'not_connected' | 'not_configured';
  detail: string;
};
export type ConnectorItem = {
  id: string;
  title: string;
  preview: string;
  date?: string | null;
  link?: string | null;
};

export const memoryKinds: Record<MemoryKind, string> = {
  preference: '偏好',
  person: '人物',
  project: '项目',
  goal: '目标',
  fact: '其他',
};
export const taskStatuses: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '进行中',
  waiting_approval: '等你确认',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  uncertain: '结果待核实',
};
export const frequencies: Record<Schedule['frequency'], string> = {
  daily: '每天',
  weekdays: '工作日',
  weekly: '每周',
  once: '一次',
};
export const isActiveTask = (task: Task) =>
  ['queued', 'running', 'waiting_approval', 'uncertain'].includes(task.status);
type DateFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

/** Hermes may fall back to English locale data. Read numeric time-zone parts
 * and compose the Chinese label ourselves rather than relying on locale text.
 */
function dateFields(date: Date, timezone?: string): DateFields {
  const parts = new Intl.DateTimeFormat('en-US', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timezone ? { timeZone: timezone } : {}),
  }).formatToParts(date);
  const numeric = (name: string) => {
    const part = parts.find(item => item.type === name);
    const number = Number(part?.value);
    if (!part || !Number.isFinite(number)) {
      throw new Error('Invalid date field');
    }
    return number;
  };
  return {
    year: numeric('year'),
    month: numeric('month'),
    day: numeric('day'),
    hour: numeric('hour') % 24,
    minute: numeric('minute'),
  };
}

export function chineseDayLabel(
  date = new Date(),
  timezone = 'Asia/Shanghai',
): string {
  try {
    const fields = dateFields(date, timezone);
    const weekday = new Date(
      Date.UTC(fields.year, fields.month - 1, fields.day),
    ).getUTCDay();
    return (
      fields.month + '月' + fields.day + '日 · 星期' + '日一二三四五六'[weekday]
    );
  } catch {
    return '今天';
  }
}

export function readableDate(value: string, timezone?: string): string {
  try {
    const fields = dateFields(new Date(value), timezone);
    return (
      fields.month +
      '月' +
      fields.day +
      '日 ' +
      String(fields.hour).padStart(2, '0') +
      ':' +
      String(fields.minute).padStart(2, '0')
    );
  } catch {
    return value;
  }
}

import type { ApiClient } from '../../api/client';
import { isDate } from './model';

export type UsagePeriod = 'today' | 'week' | 'month' | 'all' | 'custom';
export type UsageQuery = { period: Exclude<UsagePeriod, 'custom'> } |
  { period: 'custom'; start: string; end: string };
export type UsageStatus = 'complete' | 'partial' | 'unknown';
export interface UsageMetrics {
  call_count: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  audio_ms: number | null;
  image_count: number | null;
  usage_status: UsageStatus;
  estimated_cost_cny_micros: number | null;
  known_cost_cny_micros: number;
  unknown_cost_call_count: number;
  cost_status: UsageStatus;
}
export type UsageCapability = 'llm' | 'asr' | 'vision' | 'embedding';
export type UsagePurpose = 'chat' | 'brief' | 'todo' | 'memory' | 'voice' | 'image' | 'gallery' | 'index' | 'other';
export interface UsageCell extends UsageMetrics {
  model_key: string;
  model: string;
  model_name: string;
  provider: string;
  capability: UsageCapability;
  purpose: UsagePurpose;
}
export const reminderThresholds = [5000000, 10000000, 20000000, 50000000] as const;
export interface UsageReminder {
  enabled: boolean;
  threshold_cny_micros: number;
  month: string;
  known_cost_cny_micros: number;
  cost_status: UsageStatus;
  reached: boolean;
  notice_key: string | null;
}
export interface UsageReport {
  period: UsagePeriod;
  timezone: string;
  start_date: string;
  end_date: string;
  today: string;
  generated_at: string;
  recording_start: string;
  history_status: 'complete' | 'partial';
  totals: UsageMetrics;
  cells: UsageCell[];
  monthly_reminder: UsageReminder;
}

const incompatible = () => new Error('用量数据格式不兼容，请更新服务器后重试。');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw incompatible();
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw incompatible();
  return value;
}
function optionalInteger(value: unknown) { return value === null ? null : integer(value); }
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000) throw incompatible();
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw incompatible();
  return value as T;
}
const statuses = ['complete', 'partial', 'unknown'] as const;
export function readMetrics(value: unknown): UsageMetrics {
  const row = object(value);
  const metrics: UsageMetrics = {
    call_count: integer(row.call_count),
    input_tokens: optionalInteger(row.input_tokens), output_tokens: optionalInteger(row.output_tokens),
    cache_read_tokens: optionalInteger(row.cache_read_tokens), cache_write_tokens: optionalInteger(row.cache_write_tokens),
    audio_ms: optionalInteger(row.audio_ms), image_count: optionalInteger(row.image_count),
    usage_status: choice(row.usage_status, statuses),
    estimated_cost_cny_micros: optionalInteger(row.estimated_cost_cny_micros),
    known_cost_cny_micros: integer(row.known_cost_cny_micros),
    unknown_cost_call_count: integer(row.unknown_cost_call_count),
    cost_status: choice(row.cost_status, statuses),
  };
  if (metrics.unknown_cost_call_count > metrics.call_count ||
      (metrics.unknown_cost_call_count === 0 ?
        metrics.estimated_cost_cny_micros !== metrics.known_cost_cny_micros || metrics.cost_status !== 'complete' :
        metrics.estimated_cost_cny_micros !== null || metrics.cost_status === 'complete')) throw incompatible();
  return metrics;
}
export function readReminder(value: unknown): UsageReminder {
  const row = object(value);
  if (typeof row.enabled !== 'boolean' || typeof row.reached !== 'boolean' ||
      !reminderThresholds.includes(row.threshold_cny_micros as typeof reminderThresholds[number]) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(text(row.month))) throw incompatible();
  return {
    enabled: row.enabled, reached: row.reached,
    threshold_cny_micros: integer(row.threshold_cny_micros), month: text(row.month),
    known_cost_cny_micros: integer(row.known_cost_cny_micros),
    cost_status: choice(row.cost_status, statuses),
    notice_key: row.notice_key === null ? null : text(row.notice_key),
  };
}
export function readReport(value: unknown): UsageReport {
  const row = object(value);
  for (const key of ['start_date', 'end_date', 'today']) if (!isDate(row[key])) throw incompatible();
  if (text(row.timezone) !== 'Asia/Shanghai' || !Array.isArray(row.cells) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(text(row.recording_start)) || !Number.isFinite(Date.parse(text(row.recording_start))) ||
      !Number.isFinite(Date.parse(text(row.generated_at))) ||
      text(row.start_date) > text(row.end_date) || text(row.end_date) > text(row.today)) throw incompatible();
  const cells = row.cells.map(valueCell => {
    const cell = object(valueCell);
    return { ...readMetrics(cell), model_key: text(cell.model_key), model: text(cell.model),
      model_name: text(cell.model_name), provider: text(cell.provider),
      capability: choice(cell.capability, ['llm', 'asr', 'vision', 'embedding'] as const),
      purpose: choice(cell.purpose, ['chat', 'brief', 'todo', 'memory', 'voice', 'image', 'gallery', 'index', 'other'] as const) };
  });
  return { period: choice(row.period, ['today', 'week', 'month', 'all', 'custom'] as const),
    timezone: text(row.timezone), start_date: text(row.start_date), end_date: text(row.end_date), today: text(row.today),
    generated_at: text(row.generated_at), recording_start: text(row.recording_start),
    history_status: choice(row.history_status, ['complete', 'partial'] as const),
    totals: readMetrics(row.totals), cells, monthly_reminder: readReminder(row.monthly_reminder) };
}

export function usagePath(query: UsageQuery): string {
  if (query.period === 'custom') {
    if (!isDate(query.start) || !isDate(query.end) || query.start > query.end) throw new Error('请选择有效的起止日期。');
    return `/usage?period=custom&start=${encodeURIComponent(query.start)}&end=${encodeURIComponent(query.end)}`;
  }
  return '/usage?period=' + query.period;
}
export function usageApi(api: ApiClient, signal?: AbortSignal) {
  return {
    load: async (query: UsageQuery) => readReport(await api.request(usagePath(query), 'GET', undefined, signal)),
    reminder: async () => readReminder(await api.request('/usage/reminder', 'GET', undefined, signal)),
    saveReminder: async (settings: Pick<UsageReminder, 'enabled' | 'threshold_cny_micros'>) => {
      if (!reminderThresholds.includes(settings.threshold_cny_micros as typeof reminderThresholds[number])) throw new Error('请选择提醒金额。');
      return readReminder(await api.request('/usage/reminder', 'PATCH', settings, signal));
    },
  };
}

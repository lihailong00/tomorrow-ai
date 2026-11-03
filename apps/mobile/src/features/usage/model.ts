import type { UsageCell, UsageMetrics, UsagePurpose, UsageReport, UsageStatus } from './api';

const dayMs = 86400000;
export const periodLabels = { today: '今天', week: '近7天', month: '本月', all: '全部', custom: '自定义' } as const;
export const purposeLabels: Record<UsagePurpose, string> = {
  chat: '对话问答', brief: '每日简报', todo: '待办建议', memory: '记忆整理', voice: '语音输入',
  image: '图片问答', gallery: '相册整理', index: '资料索引', other: '其他用途',
};
export const capabilityLabels = { llm: '对话与思考', asr: '语音转文字', vision: '图片理解', embedding: '向量检索' };

/** Date-only arithmetic always uses UTC, never the phone's clock or locale. */
export function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * dayMs).toISOString().slice(0, 10);
}
export function dateLabel(date: string): string {
  return isDate(date) ? date.replace(/-/g, '.') : '日期未知';
}
export function coverageDate(report: Pick<UsageReport, 'recording_start'>): string {
  return new Date(Date.parse(report.recording_start) + 8 * 3600000).toISOString().slice(0, 10);
}
export function rangeError(start: string, end: string, minimum: string, today: string): string {
  if (!isDate(start) || !isDate(end)) return '请选择开始和结束日期。';
  if (start > end) return '开始日期不能晚于结束日期。';
  if (end > today) return '结束日期不能晚于今天。';
  if (start < minimum) return '开始日期不能早于开始记录的日期。';
  return '';
}
export function inclusiveDays(start: string, end: string): number {
  return Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / dayMs) + 1;
}
export function shortcutRange(kind: 'last30' | 'lastmonth', today: string) {
  if (kind === 'last30') return { start: shiftDate(today, -29), end: today };
  const end = shiftDate(today.slice(0, 8) + '01', -1);
  return { start: end.slice(0, 8) + '01', end };
}
export function shiftMonth(month: string, offset: number): string {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + offset, 1)).toISOString().slice(0, 7);
}
export function monthDays(month: string): Array<string | null> {
  const first = month + '-01';
  const next = shiftMonth(month, 1) + '-01';
  const count = inclusiveDays(first, shiftDate(next, -1));
  const offset = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const days: Array<string | null> = Array(offset).fill(null);
  for (let day = 0; day < count; day++) days.push(shiftDate(first, day));
  while (days.length % 7) days.push(null);
  return days;
}
export function integerLabel(value: number): string { return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
export function tokenLabel(value: number | null): string {
  if (value === null) return '未测量';
  return value >= 1000000 ? (value / 1000000).toFixed(2) + 'M' : value >= 1000 ? (value / 1000).toFixed(value % 1000 ? 1 : 0) + 'K' : integerLabel(value);
}
export function moneyLabel(micros: number): string {
  if (micros > 0 && micros < 10000) return '<¥0.01';
  return '¥' + (micros / 1000000).toFixed(2);
}
export function durationLabel(ms: number | null): string {
  if (ms === null) return '未测量';
  if (ms > 0 && ms < 1000) return '<1秒';
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? seconds + '秒' : Math.floor(seconds / 60) + '分' + (seconds % 60 ? seconds % 60 + '秒' : '钟');
}
export function costPresentation(metrics: UsageMetrics) {
  const missingPrice = metrics.missing_price_call_count ?? 0;
  const missingUsage = metrics.missing_measurement_call_count ?? 0;
  if (metrics.cost_status === 'unknown' && missingPrice > 0 && missingUsage === 0)
    return { title: '缺少模型单价', amount: '待配置价格', note: '用量已记录，请管理员配置单价或启用官方参考价格后补算' };
  if (metrics.cost_status === 'unknown' && missingUsage > 0 && missingPrice === 0)
    return { title: '计费用量未齐', amount: '等待完整用量', note: '单价已匹配，服务商尚未返回计算费用所需的完整用量' };
  if (metrics.cost_status === 'unknown' && missingPrice > 0 && missingUsage > 0)
    return { title: '计价资料未齐', amount: '暂无法估算', note: `${missingPrice} 次缺少单价，${missingUsage} 次缺少完整计费用量` };
  if (metrics.cost_status === 'unknown') return { title: '价格未配置 / 暂无法估算', amount: '暂无法估算', note: '价格未配置或计费所需用量未返回' };
  if (metrics.cost_status === 'partial') return { title: '已知预估', amount: moneyLabel(metrics.known_cost_cny_micros), note: '部分费用未定价' };
  return { title: '预估费用', amount: moneyLabel(metrics.known_cost_cny_micros), note: '预估' };
}
export function usageSummary(metrics: UsageMetrics): string {
  if (metrics.usage_status === 'unknown') return '用量未返回';
  const pieces: string[] = [];
  if (metrics.input_tokens !== null || metrics.output_tokens !== null) pieces.push(tokenLabel((metrics.input_tokens ?? 0) + (metrics.output_tokens ?? 0)) + ' Token');
  if (metrics.audio_ms !== null) pieces.push(durationLabel(metrics.audio_ms));
  if (metrics.image_count !== null) pieces.push(integerLabel(metrics.image_count) + ' 张图片');
  return (metrics.usage_status === 'partial' ? '部分已记录 · ' : '') + (pieces.join(' · ') || '暂无适用的测量');
}
const nullableKeys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'audio_ms', 'image_count'] as const;
function safeSum(values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum)) throw new Error('汇总用量超过安全范围，请缩短日期范围。');
  return sum;
}
export function sumMetrics(cells: UsageMetrics[]): UsageMetrics {
  const known = safeSum(cells.map(cell => cell.known_cost_cny_micros));
  const unknown = safeSum(cells.map(cell => cell.unknown_cost_call_count));
  const count = safeSum(cells.map(cell => cell.call_count));
  const status: UsageStatus = cells.every(cell => cell.usage_status === 'complete') ? 'complete' : cells.every(cell => cell.usage_status === 'unknown') ? 'unknown' : 'partial';
  const result: UsageMetrics = { call_count: count, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    audio_ms: null, image_count: null, usage_status: status, known_cost_cny_micros: known,
    estimated_cost_cny_micros: unknown ? null : known, unknown_cost_call_count: unknown,
    cost_status: unknown === 0 ? 'complete' : unknown === count ? 'unknown' : 'partial' };
  for (const key of ['missing_price_call_count','missing_measurement_call_count','reconstructed_cost_call_count'] as const) {
    if (cells.some(cell => cell[key] !== undefined)) result[key] = safeSum(cells.map(cell => cell[key] ?? 0));
  }
  for (const key of nullableKeys) {
    const measured = cells.flatMap(cell => cell[key] === null ? [] : [cell[key] as number]);
    if (cells.length) result[key] = measured.length ? safeSum(measured) : null;
  }
  return result;
}
export type UsageGrouping = 'model' | 'purpose';
export interface UsageGroup { id: string; name: string; subtitle: string; cells: UsageCell[]; metrics: UsageMetrics }
export function groupCells(cells: UsageCell[], group: UsageGrouping): UsageGroup[] {
  const groups = new Map<string, UsageCell[]>();
  for (const cell of cells) {
    const key = group === 'model' ? cell.model_key : cell.purpose;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  return [...groups].map(([id, rows]) => {
    const first = rows[0];
    const models = new Set(rows.map(cell => cell.model_key));
    return { id, cells: rows, metrics: sumMetrics(rows),
      name: group === 'model' ? first.model_name || first.model || '未知模型' : purposeLabels[first.purpose],
      subtitle: group === 'model' ? (first.provider || '未知服务商') + ' · ' + [...new Set(rows.map(cell => capabilityLabels[cell.capability]))].join(' / ') :
        models.size > 1 ? `${models.size} 个模型` : first.model_name || first.model || '未知模型' };
  }).sort((a, b) => b.metrics.known_cost_cny_micros - a.metrics.known_cost_cny_micros || b.metrics.call_count - a.metrics.call_count || a.name.localeCompare(b.name));
}

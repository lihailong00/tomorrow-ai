import type { ApiClient } from '../src/api/client';
import { readReport, usageApi, usagePath, type UsageCell, type UsageReport } from '../src/features/usage/api';
import { coverageDate, costPresentation, groupCells, inclusiveDays, isDate, moneyLabel, monthDays, rangeError, shiftDate, shortcutRange, sumMetrics, usageSummary } from '../src/features/usage/model';

const metrics = { call_count: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 0,
  audio_ms: null, image_count: null, usage_status: 'complete' as const,
  estimated_cost_cny_micros: 2500, known_cost_cny_micros: 2500, unknown_cost_call_count: 0, cost_status: 'complete' as const };
const cell: UsageCell = { ...metrics, model_key: 'deployment-a/model', model: 'actual-model', model_name: 'Actual model', provider: 'Actual provider', capability: 'llm', purpose: 'chat' };
const reminder = { enabled: true, threshold_cny_micros: 20000000, month: '2026-11', known_cost_cny_micros: 2500, cost_status: 'complete' as const, reached: false, notice_key: null };
function report(cells = [cell]): UsageReport { return { period: 'month', timezone: 'Asia/Shanghai', start_date: '2026-11-01', end_date: '2026-11-02', today: '2026-11-02',
  recording_start: '2026-09-30T16:00:00Z', generated_at: '2026-11-02T03:00:00Z', history_status: 'complete', totals: sumMetrics(cells), cells, monthly_reminder: reminder }; }

it('uses authenticated current-user API paths and inclusive custom endpoints without adding a user selector', async () => {
  const request = jest.fn().mockResolvedValue(report());
  const signal = new AbortController().signal;
  const api = usageApi({ request } as unknown as ApiClient, signal);
  await api.load({ period: 'week' });
  expect(request).toHaveBeenCalledWith('/usage?period=week', 'GET', undefined, signal);
  expect(usagePath({ period: 'custom', start: '2026-10-31', end: '2026-11-02' })).toBe('/usage?period=custom&start=2026-10-31&end=2026-11-02');
  request.mockResolvedValue(reminder);
  await api.reminder();
  await api.saveReminder({ enabled: false, threshold_cny_micros: 10000000 });
  expect(request).toHaveBeenCalledWith('/usage/reminder', 'GET', undefined, signal);
  expect(request).toHaveBeenCalledWith('/usage/reminder', 'PATCH', { enabled: false, threshold_cny_micros: 10000000 }, signal);
});

it('rejects malformed dates, unsafe counters and money rather than rendering a plausible zero', () => {
  expect(() => usagePath({ period: 'custom', start: '2026-02-30', end: '2026-11-02' })).toThrow();
  expect(() => readReport({ ...report(), totals: { ...metrics, call_count: Number.MAX_SAFE_INTEGER + 1 } })).toThrow();
  expect(() => readReport({ ...report(), cells: [{ ...cell, input_tokens: -1 }] })).toThrow();
  expect(() => readReport({ ...report(), totals: { ...metrics, estimated_cost_cny_micros: 0 } })).toThrow();
  expect(() => readReport({ ...report(), today: '2026-02-30' })).toThrow();
  expect(readReport(report()).cells[0].model_name).toBe('Actual model');
});

it('keeps no activity, missing price, partial price and unknown measurements distinct', () => {
  const empty = sumMetrics([]);
  expect(empty.call_count).toBe(0);
  expect(empty.audio_ms).toBeNull();
  expect(costPresentation(empty).amount).toBe('¥0.00');
  const unknown = { ...cell, estimated_cost_cny_micros: null, known_cost_cny_micros: 0, unknown_cost_call_count: 1, cost_status: 'unknown' as const, usage_status: 'unknown' as const,
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null };
  expect(costPresentation(unknown).amount).toBe('暂无法估算');
  expect(usageSummary(unknown)).toBe('用量未返回');
  const mixed = sumMetrics([cell, unknown]);
  expect(mixed.cost_status).toBe('partial');
  expect(mixed.estimated_cost_cny_micros).toBeNull();
  expect(costPresentation(mixed)).toEqual({ title: '已知预估', amount: '<¥0.01', note: '部分费用未定价' });
  expect(usageSummary(mixed)).toContain('部分已记录');
  expect(moneyLabel(1)).toBe('<¥0.01');
  expect(moneyLabel(10000)).toBe('¥0.01');
  expect(moneyLabel(0)).toBe('¥0.00');
});

it('reconciles model, purpose and reciprocal breakdowns from the same cells without merging deployments', () => {
  const cells = [cell, { ...cell, model_key: 'deployment-b/model', provider: 'Other provider' },
    { ...cell, purpose: 'memory' as const, capability: 'embedding' as const, output_tokens: null }];
  const models = groupCells(cells, 'model');
  const purposes = groupCells(cells, 'purpose');
  expect(models).toHaveLength(2);
  expect(purposes.find(group => group.id === 'chat')?.subtitle).toBe('2 个模型');
  expect(models.reduce((sum, group) => sum + group.metrics.known_cost_cny_micros, 0)).toBe(sumMetrics(cells).known_cost_cny_micros);
  expect(purposes.reduce((sum, group) => sum + group.metrics.call_count, 0)).toBe(3);
  const ownModel = models.find(group => group.id === cell.model_key)!;
  expect(groupCells(ownModel.cells, 'purpose').map(group => group.id).sort()).toEqual(['chat', 'memory']);
  expect(usageSummary(sumMetrics(cells))).toContain('340 Token'); // 100 + 20 + 100 + 20 + 100; cache already included.
  expect(() => sumMetrics([{ ...cell, call_count: Number.MAX_SAFE_INTEGER }, cell])).toThrow('安全范围');
});

it('does not turn missing ASR duration or missing images into measured zero', () => {
  expect(usageSummary({ ...cell, input_tokens: null, output_tokens: null, audio_ms: 64000, image_count: 3 })).toBe('1分4秒 · 3 张图片');
  expect(usageSummary({ ...cell, input_tokens: null, output_tokens: null, audio_ms: null })).toBe('暂无适用的测量');
});

it('uses real inclusive dates and rolling ranges across month/year boundaries without the device timezone', () => {
  expect(isDate('2024-02-29')).toBe(true);
  expect(isDate('2026-02-29')).toBe(false);
  expect(shiftDate('2026-01-03', -6)).toBe('2025-12-28');
  expect(shortcutRange('last30', '2026-01-03')).toEqual({ start: '2025-12-05', end: '2026-01-03' });
  expect(shortcutRange('lastmonth', '2026-01-03')).toEqual({ start: '2025-12-01', end: '2025-12-31' });
  expect(inclusiveDays('2026-10-31', '2026-11-02')).toBe(3);
  expect(coverageDate({ recording_start: '2026-10-31T18:00:00Z' })).toBe('2026-11-01');
});

it('validates the complete custom range against recording and server today bounds', () => {
  expect(rangeError('', '2026-11-02', '2026-10-01', '2026-11-02')).toContain('开始和结束');
  expect(rangeError('2026-11-02', '2026-11-01', '2026-10-01', '2026-11-02')).toContain('晚于结束');
  expect(rangeError('2026-11-01', '2026-11-03', '2026-10-01', '2026-11-02')).toContain('晚于今天');
  expect(rangeError('2026-09-30', '2026-11-02', '2026-10-01', '2026-11-02')).toContain('早于开始记录');
  expect(rangeError('2026-11-02', '2026-11-02', '2026-11-02', '2026-11-02')).toBe('');
});

it('builds a Monday-first month grid including leap day and fillers with unique dates', () => {
  const days = monthDays('2024-02');
  expect(days.length % 7).toBe(0);
  expect(days.slice(0, 3)).toEqual([null, null, null]);
  expect(days.filter(Boolean)).toHaveLength(29);
  expect(days).toContain('2024-02-29');
  expect(new Set(days.filter(Boolean)).size).toBe(29);
});

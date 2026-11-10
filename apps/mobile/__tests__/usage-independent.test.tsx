import React from 'react';
import { Text as NativeText } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { UsageScreen } from '../src/features/usage/UsageScreen';
import type { UsageCell, UsageMetrics, UsageReminder, UsageReport } from '../src/features/usage/api';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

// Deliberately literal server fixtures: these expectations do not use product aggregation.
const metrics: UsageMetrics = { call_count: 1, input_tokens: 1000, output_tokens: 100,
  cache_read_tokens: 400, cache_write_tokens: 100, audio_ms: null, image_count: null,
  usage_status: 'complete', estimated_cost_cny_micros: 975, known_cost_cny_micros: 975,
  unknown_cost_call_count: 0, cost_status: 'complete' };
const model: UsageCell = { ...metrics, model_key: 'fixture-deployment-a', model: 'fixture-model-a',
  model_name: '独立测试模型甲', provider: '独立测试服务商', capability: 'llm', purpose: 'chat' };
const reminder: UsageReminder = { enabled: true, threshold_cny_micros: 20_000_000, month: '2026-11',
  known_cost_cny_micros: 8_000_000, cost_status: 'partial', reached: false, notice_key: null };
function report(changes: Partial<UsageReport> = {}): UsageReport {
  return { period: 'month', timezone: 'Asia/Shanghai', start_date: '2026-11-01', end_date: '2026-11-02',
    today: '2026-11-02', generated_at: '2026-11-02T02:00:00Z', recording_start: '2026-10-01T16:00:00Z',
    history_status: 'complete', totals: metrics, cells: [model], monthly_reminder: reminder, ...changes };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function text(tree: ReactTestRenderer) {
  return tree.root.findAllByType(NativeText).flatMap(item => [item.props.children].flat())
    .filter(value => typeof value === 'string' || typeof value === 'number').join('\n');
}
function button(tree: ReactTestRenderer, label: string) {
  const item = tree.root.findAll(node => (node.props.accessibilityLabel === label ||
    node.props.accessibilityLabel?.startsWith(label + '，')) && typeof node.props.onPress === 'function')[0];
  if (!item) throw new Error('Missing independent test button: ' + label);
  return item;
}
async function press(tree: ReactTestRenderer, label: string) {
  const item = button(tree, label); expect(item.props.disabled).not.toBe(true);
  await act(async () => { item.props.onPress(); });
}
async function setup(request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? reminder : report())) {
  const api = { request, baseUrl: 'https://usage-fixture.example.test' } as unknown as ApiClient;
  let context = { api, user: { id: 'independent-user-a' },
    preferences: { serverUrl: api.baseUrl, instance: { id: 'independent-instance-a', name: '独立测试服务器', deployment_mode: 'self_hosted' } },
    back: jest.fn() } as unknown as AppContextValue;
  const render = () => <AppProvider value={context}><UsageScreen /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  return { tree, request, text: () => text(tree), press: (label: string) => press(tree, label),
    async identity(kind: 'user' | 'server' | 'instance' | 'logout') {
      // Preserve the same API object to independently exercise every ownership key.
      context = { ...context, user: kind === 'logout' ? null : { id: kind === 'user' ? 'independent-user-b' : 'independent-user-a' } as AppContextValue['user'],
        preferences: { ...context.preferences,
          serverUrl: kind === 'server' ? 'https://other-fixture.example.test' : context.preferences.serverUrl,
          instance: { ...context.preferences.instance!, id: kind === 'instance' ? 'independent-instance-b' : 'independent-instance-a' } } };
      await act(async () => { tree.update(render()); });
    },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

it('shows unpriced measured activity as unknown money while retaining canonical token counts', async () => {
  const unknown = { ...metrics, known_cost_cny_micros: 0, estimated_cost_cny_micros: null, unknown_cost_call_count: 1, cost_status: 'unknown' as const };
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? reminder : report({ totals: unknown, cells: [{ ...model, ...unknown }] })));
  expect(view.text()).toContain('暂无法估算');
  expect(view.text()).toContain('1.1K Token'); // 1000 input + 100 output; caches are subsets.
  expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '预估金额¥0.00')).toHaveLength(0);
  expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '预估金额暂无法估算').length).toBeGreaterThan(0);
  await view.press('查看模型独立测试模型甲');
  expect(view.text()).toContain('缓存读取 Token（输入子集）');
  expect(view.text()).toContain('400');
  expect(view.text()).toContain('输入 Token');
  expect(view.text()).not.toContain('最高占比');
  expect(view.request.mock.calls.every(call => !call[0].includes('user_id'))).toBe(true);
  await view.close();
});

it.each(['user', 'server', 'instance'] as const)('drops old usage and reminder reads after %s changes even when the API object is reused', async kind => {
  const oldUsage = deferred<UsageReport>(); const oldReminder = deferred<UsageReminder>();
  let usageCount = 0; let reminderCount = 0;
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ?
    (++reminderCount === 1 ? oldReminder.promise : { ...reminder, known_cost_cny_micros: 3_000_000 }) :
    (++usageCount === 1 ? oldUsage.promise : report({ cells: [{ ...model, model_name: '新身份专属模型' }] })));
  const view = await setup(request);
  const oldSignals = request.mock.calls.slice(0, 2).map(call => call[3] as AbortSignal);
  await view.identity(kind);
  expect(oldSignals.every(signal => signal.aborted)).toBe(true);
  await act(async () => {
    oldUsage.resolve(report({ cells: [{ ...model, model_name: '旧身份私有模型' }] }));
    oldReminder.resolve({ ...reminder, known_cost_cny_micros: 50_000_000, reached: true, notice_key: 'old-private-notice' });
  });
  expect(view.text()).toContain('新身份专属模型');
  expect(view.text()).not.toContain('旧身份私有模型');
  expect(view.text()).not.toContain('本月已知预估达到');
  expect(view.text()).not.toContain('¥50.00');
  expect(view.text()).toContain('¥3.00');
  await view.close();
});

it('a delayed query failure cannot replace a newer successful period', async () => {
  const week = deferred<UsageReport>();
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? reminder : path.endsWith('week') ? week.promise :
    path.endsWith('today') ? report({ period: 'today', start_date: '2026-11-02', cells: [{ ...model, model_name: '今天有效模型' }] }) : report());
  const view = await setup(request);
  await view.press('统计周期近7天');
  expect(view.text()).not.toContain('独立测试模型甲');
  await view.press('统计周期今天');
  await act(async () => { week.reject(new Error('过期查询错误不应显示')); });
  expect(view.text()).toContain('今天有效模型');
  expect(view.text()).not.toContain('过期查询错误不应显示');
  expect(request.mock.calls.find(call => call[0].endsWith('week'))![3].aborted).toBe(true);
  await view.close();
});

it('held reminder save callbacks cannot submit after logout and pending saves cannot repopulate a new owner', async () => {
  const save = deferred<UsageReminder>();
  const request: jest.Mock = jest.fn(async (path, method) => method === 'PATCH' ? save.promise : path === '/usage/reminder' ? reminder : report());
  const view = await setup(request);
  await view.press('设置消费提醒'); await view.press('每月提醒5元');
  const held = button(view.tree, '保存提醒设置').props.onPress;
  await view.press('保存提醒设置');
  const signal = request.mock.calls.find(call => call[1] === 'PATCH')![3] as AbortSignal;
  await view.identity('logout');
  expect(signal.aborted).toBe(true); expect(view.text()).toBe('');
  await act(async () => {
    held(); save.resolve({ ...reminder, threshold_cny_micros: 5_000_000, reached: true, notice_key: 'old-save' });
  });
  expect(request.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1);
  expect(view.text()).toBe('');
  await view.close();
});

it('manual calendar drafts reject reversed dates, retain both inclusive endpoints and cancel without a query', async () => {
  const view = await setup();
  await view.press('统计周期自定义');
  await view.press('选择日期2026-11-02'); // start Nov 2, automatic target end
  await view.press('选择日期2026-11-01');
  expect(view.text()).toContain('开始日期不能晚于结束日期');
  expect(button(view.tree, '查看这段时间的费用').props.disabled).toBe(true);
  expect(button(view.tree, '选择日期2026-11-03').props.disabled).toBe(true);
  await view.press('取消选择时间段');
  expect(view.request.mock.calls.filter(call => call[0].includes('period=custom'))).toHaveLength(0);
  await view.press('统计周期自定义');
  await view.press('选择日期2026-11-01'); await view.press('选择日期2026-11-02');
  expect(view.text()).toContain('包含首尾两天');
  expect(view.text()).toContain('已选 2 天');
  await view.press('查看这段时间的费用');
  expect(view.request).toHaveBeenCalledWith('/usage?period=custom&start=2026-11-01&end=2026-11-02', 'GET', undefined, expect.anything());
  await view.close();
});

it('uses server coverage in Beijing and leaves the monthly reminder unchanged for an old custom interval', async () => {
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? reminder : report({ period: 'custom',
    start_date: '2026-10-02', end_date: '2026-10-03', recording_start: '2026-10-01T16:30:00Z', history_status: 'partial',
    totals: { ...metrics, estimated_cost_cny_micros: 0, known_cost_cny_micros: 0, call_count: 0, input_tokens: 0, output_tokens: 0 }, cells: [] })));
  expect(view.text()).toContain('这段时间暂无调用记录');
  expect(view.text()).toContain('历史未记录，不会当成零');
  expect(view.text()).toContain('¥8.00');
  expect(view.text()).toContain('部分费用未定价');
  await view.press('用量数据说明');
  expect(view.text()).toContain('从 2026.10.02 开始记录');
  expect(view.text()).toContain('服务商最终账单');
  await view.close();
});

it('shows speech duration and images separately from tokens, including unknown applicable measurements', async () => {
  const asr: UsageCell = { ...model, model_key: 'asr', model_name: '语音测试模型', capability: 'asr', purpose: 'voice',
    input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null,
    audio_ms: null, usage_status: 'unknown', estimated_cost_cny_micros: null, known_cost_cny_micros: 0,
    unknown_cost_call_count: 1, cost_status: 'unknown' };
  const vision: UsageCell = { ...model, model_key: 'vision', model_name: '相册测试模型', capability: 'vision', purpose: 'gallery', image_count: 3 };
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? reminder : report({ cells: [asr, vision],
    totals: { ...metrics, call_count: 2, image_count: 3, usage_status: 'partial', estimated_cost_cny_micros: null,
      unknown_cost_call_count: 1, cost_status: 'partial' } })));
  await view.press('查看模型语音测试模型');
  expect(view.text()).toContain('语音时长'); expect(view.text()).toContain('未返回');
  expect(view.tree.root.findAllByType(NativeText).some(node => node.props.children === '输入 Token')).toBe(false);
  await view.press('返回用量概览'); await view.press('查看模型相册测试模型');
  expect(view.text()).toContain('提交图片数量'); expect(view.text()).toContain('3 张');
  expect(view.text()).toContain('相册整理');
  expect(view.text()).toContain('<¥0.01');
  await view.close();
});

it('uses refreshed reports for current-month reminder progress after more usage reaches the threshold', async () => {
  const initialReminder: UsageReminder = { ...reminder, threshold_cny_micros: 5_000_000,
    known_cost_cny_micros: 4_000_000, cost_status: 'complete' };
  const freshReminder: UsageReminder = { ...initialReminder, known_cost_cny_micros: 6_000_000,
    reached: true, notice_key: 'independent-new-monthly-threshold' };
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? initialReminder :
    report({ period: path.endsWith('all') ? 'all' : 'month',
      monthly_reminder: path.endsWith('all') ? freshReminder : initialReminder }));
  const view = await setup(request);
  expect(view.text()).toContain('¥4.00');
  await view.press('统计周期全部');
  expect(view.text()).toContain('¥6.00');
  expect(view.text()).not.toContain('¥4.00');
  expect(view.text()).toContain('本月已知预估达到');
  await view.press('设置消费提醒');
  expect(view.text()).toContain('¥6.00');
  expect(view.text()).not.toContain('¥4.00');
  expect(button(view.tree, '每月提醒5元').props.accessibilityState.selected).toBe(true);
  await view.close();
});

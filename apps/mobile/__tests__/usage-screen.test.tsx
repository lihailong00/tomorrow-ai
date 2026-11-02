import React from 'react';
import { Switch, Text as NativeText } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { UsageScreen } from '../src/features/usage/UsageScreen';
import { UsageDateRange } from '../src/features/usage/UsageDateRange';
import type { UsageCell, UsageReminder, UsageReport } from '../src/features/usage/api';
import { sumMetrics } from '../src/features/usage/model';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.setTimeout(15000);
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const baseCell: UsageCell = { model_key: 'actual-deployment-a', model: 'actual-model', model_name: '实际模型 A', provider: '实际服务商', capability: 'llm', purpose: 'chat',
  call_count: 2, input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 0, audio_ms: null, image_count: null,
  usage_status: 'complete', estimated_cost_cny_micros: 1200000, known_cost_cny_micros: 1200000, unknown_cost_call_count: 0, cost_status: 'complete' };
const reminder: UsageReminder = { enabled: true, threshold_cny_micros: 20000000, month: '2026-11', known_cost_cny_micros: 1200000, cost_status: 'complete', reached: false, notice_key: null };
function report(options: Partial<UsageReport> = {}): UsageReport {
  const cells = options.cells ?? [baseCell];
  return { period: 'month', timezone: 'Asia/Shanghai', start_date: '2026-11-01', end_date: '2026-11-02', today: '2026-11-02',
    recording_start: '2026-09-30T16:00:00Z', generated_at: '2026-11-02T03:00:00Z', history_status: 'complete', totals: sumMetrics(cells), cells, monthly_reminder: reminder, ...options };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function text(tree: ReactTestRenderer) { return tree.root.findAllByType(NativeText).flatMap(item => [item.props.children].flat()).filter(value => typeof value === 'string' || typeof value === 'number').join('\n'); }
function button(tree: ReactTestRenderer, label: string) { const found = tree.root.findAll(item => (item.props.accessibilityLabel === label || item.props.accessibilityLabel?.startsWith(label + '，')) && typeof item.props.onPress === 'function')[0]; if (!found) throw new Error('Missing button ' + label); return found; }
async function press(tree: ReactTestRenderer, label: string) { const found = button(tree, label); expect(found.props.disabled).not.toBe(true); await act(async () => { found.props.onPress(); }); }
async function setup(request?: jest.Mock) {
  const transport = request ?? jest.fn(async (path: string) => path === '/usage/reminder' ? reminder : report());
  let context = { api: { request: transport, baseUrl: 'https://personal.example.test' } as unknown as ApiClient, user: { id: 'user-a' },
    preferences: { serverUrl: 'https://personal.example.test', instance: { id: 'instance-a', name: '我的服务器', deployment_mode: 'self_hosted' } }, back: jest.fn() } as unknown as AppContextValue;
  const render = () => <AppProvider value={context}><UsageScreen /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  return { tree, request: transport, text: () => text(tree), press: (label: string) => press(tree, label),
    async changeIdentity(user: string, server = 'https://other.example.test', instance = 'instance-b') {
      context = { ...context, api: { request: transport, baseUrl: server } as unknown as ApiClient, user: { id: user } as AppContextValue['user'],
        preferences: { ...context.preferences, serverUrl: server, instance: { ...context.preferences.instance!, id: instance, name: '另一个服务器' } } };
      await act(async () => { tree.update(render()); });
    },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

it('loads only personal usage/reminder and uses actual server/model data with reciprocal detail', async () => {
  const cells = [baseCell, { ...baseCell, model_key: 'deployment-b', model_name: '实际模型 B', purpose: 'chat' as const }, { ...baseCell, purpose: 'memory' as const }];
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? reminder : report({ cells })));
  expect(view.request).toHaveBeenCalledWith('/usage?period=month', 'GET', undefined, expect.anything());
  expect(view.text()).toContain('自建服务');
  expect(view.text()).not.toContain('官方服务');
  expect(view.text()).toContain('实际模型 A');
  await view.press('查看模型实际模型 A');
  expect(view.text()).toContain('花在了哪些事上');
  expect(view.text()).toContain('记忆整理');
  await view.press('查看用途对话问答');
  expect(view.text()).toContain('使用了哪些模型');
  expect(view.text()).toContain('2 个模型');
  expect(view.text()).toContain('实际模型 B');
  await view.press('返回用量概览');
  await view.press('按用途分组');
  expect(view.text()).toContain('2 个模型');
  await view.close();
});

it('hides the previous period immediately, aborts old queries and rejects late responses that ignore abort', async () => {
  const week = deferred<UsageReport>();
  const today = deferred<UsageReport>();
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? reminder : path.endsWith('week') ? week.promise : path.endsWith('today') ? today.promise : report());
  const view = await setup(request);
  expect(view.text()).toContain('¥1.20');
  await view.press('统计周期近7天');
  expect(view.text()).not.toContain('¥1.20');
  const weekSignal = request.mock.calls.find(call => call[0].endsWith('week'))![3] as AbortSignal;
  await view.press('统计周期今天');
  expect(weekSignal.aborted).toBe(true);
  await act(async () => { today.resolve(report({ period: 'today', start_date: '2026-11-02', cells: [{ ...baseCell, model_name: '今天的模型' }] })); });
  expect(view.text()).toContain('今天的模型');
  await act(async () => { week.resolve(report({ period: 'week', cells: [{ ...baseCell, model_name: '过期周模型' }] })); });
  expect(view.text()).not.toContain('过期周模型');
  expect(view.text()).toContain('今天的模型');
  await view.close();
});

it.each(['account', 'server', 'instance'])('clears all reports/details/settings across an %s identity change and aborts pending reads', async kind => {
  const old = deferred<UsageReport>();
  const fresh = deferred<UsageReport>();
  let count = 0;
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? reminder : (++count === 1 ? old.promise : fresh.promise));
  const view = await setup(request);
  const signal = request.mock.calls.find(call => call[0].includes('?period='))![3] as AbortSignal;
  await view.changeIdentity(kind === 'account' ? 'user-b' : 'user-a', kind === 'server' ? 'https://other.example.test' : 'https://personal.example.test', kind === 'instance' ? 'instance-b' : 'instance-a');
  expect(signal.aborted).toBe(true);
  await act(async () => { old.resolve(report({ cells: [{ ...baseCell, model_name: '旧账号秘密模型' }] })); });
  expect(view.text()).not.toContain('旧账号秘密模型');
  await act(async () => { fresh.resolve(report({ cells: [{ ...baseCell, model_name: '新身份模型' }] })); });
  expect(view.text()).toContain('新身份模型');
  await view.close();
});

it('opens a bounded native calendar, cancels drafts, then applies both inclusive shortcut endpoints', async () => {
  const request = jest.fn(async path => path === '/usage/reminder' ? reminder : report(path.includes('period=custom') ? { period: 'custom', start_date: '2026-10-04' } : {}));
  const view = await setup(request);
  await view.press('统计周期自定义');
  expect(view.tree.root.findAllByType(UsageDateRange)).toHaveLength(1);
  await view.press('最近30天');
  expect(view.text()).toContain('已选 30 天，包含开始和结束当天。');
  await view.press('取消选择时间段');
  expect(request.mock.calls.filter(call => call[0].includes('period=custom'))).toHaveLength(0);
  expect(view.text()).toContain('2026.11.01');
  await view.press('统计周期自定义');
  await view.press('最近30天');
  await view.press('查看这段时间的费用');
  expect(request).toHaveBeenCalledWith('/usage?period=custom&start=2026-10-04&end=2026-11-02', 'GET', undefined, expect.anything());
  expect(view.tree.root.findAllByType(UsageDateRange)).toHaveLength(0);
  await view.close();
});

it('permits a today-only recording range and explains unavailable earlier shortcuts', async () => {
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? reminder : report({ recording_start: '2026-11-02T01:00:00Z', history_status: 'partial' })));
  await view.press('统计周期自定义');
  expect(view.text()).toContain('可查询 2026.11.02 — 2026.11.02');
  expect(button(view.tree, '最近30天').props.disabled).toBe(true);
  expect(button(view.tree, '上个月').props.disabled).toBe(true);
  expect(button(view.tree, '选择日期2026-11-03').props.disabled).toBe(true);
  expect(button(view.tree, '选择日期2026-11-01').props.disabled).toBe(true);
  expect(button(view.tree, '查看这段时间的费用').props.disabled).toBe(false);
  await view.close();
});

it('distinguishes no activity, missing history, unpriced activity and failures without stale zero totals', async () => {
  let result = report({ cells: [], history_status: 'partial', recording_start: '2026-11-02T01:00:00Z' });
  const request = jest.fn(async path => path === '/usage/reminder' ? reminder : result);
  const view = await setup(request);
  expect(view.text()).toContain('这段时间暂无调用记录');
  expect(view.text()).toContain('历史未记录，不会当成零');
  result = report({ cells: [{ ...baseCell, estimated_cost_cny_micros: null, known_cost_cny_micros: 0, unknown_cost_call_count: 2, cost_status: 'unknown', usage_status: 'unknown', input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null }] });
  await view.press('刷新个人用量');
  expect(view.text()).toContain('暂无法估算');
  expect(view.text()).toContain('用量未返回');
  expect(view.text()).not.toContain('这段时间暂无调用记录');
  request.mockImplementation(async path => { if (path === '/usage/reminder') return reminder; throw new Error('network fixture'); });
  await view.press('刷新个人用量');
  expect(view.text()).toContain('network fixture');
  expect(view.text()).not.toContain('实际模型 A');
  expect(view.text()).toContain('不能据此判断为零费用');
  request.mockImplementation(async path => path === '/usage/reminder' ? reminder : report());
  await view.press('重试读取用量');
  expect(view.text()).toContain('实际模型 A');
  await view.close();
});

it('persists reminder choices through PATCH, retains disabled amount and presents a reached notice without notifications', async () => {
  let saved = { ...reminder, known_cost_cny_micros: 20000000, reached: true, notice_key: 'monthly-account-key', cost_status: 'partial' as const } as UsageReminder;
  const request = jest.fn(async (path, method, body) => {
    if (path === '/usage/reminder') {
      if (method === 'PATCH') saved = { ...saved, ...body, reached: false, notice_key: null };
      return saved;
    }
    return report({ monthly_reminder: saved });
  });
  const view = await setup(request);
  expect(view.text()).toContain('本月已知预估达到');
  expect(view.text()).toContain('部分费用未定价');
  await view.press('知道本月消费提醒');
  await view.press('设置消费提醒');
  await view.press('每月提醒10元');
  await act(async () => { view.tree.root.findByType(Switch).props.onValueChange(false); });
  await view.press('保存提醒设置');
  expect(request).toHaveBeenCalledWith('/usage/reminder', 'PATCH', { enabled: false, threshold_cny_micros: 10000000 }, expect.anything());
  expect(view.text()).toContain('提醒设置已保存');
  expect(view.text()).toContain('已关闭');
  await view.press('设置消费提醒');
  expect(button(view.tree, '每月提醒10元').props.accessibilityState.selected).toBe(true);
  expect(view.tree.root.findByType(Switch).props.value).toBe(false);
  await view.close();
});

it('keeps a failed reminder draft reviewable and aborts a pending save across identity changes', async () => {
  const pending = deferred<UsageReminder>();
  let saveCount = 0;
  const request: jest.Mock = jest.fn(async (path, method) => {
    if (method === 'PATCH') { if (++saveCount === 1) throw new Error('save fixture failed'); return pending.promise; }
    return path === '/usage/reminder' ? reminder : report();
  });
  const view = await setup(request);
  await view.press('设置消费提醒');
  await view.press('每月提醒5元');
  await view.press('保存提醒设置');
  expect(view.text()).toContain('save fixture failed');
  expect(button(view.tree, '每月提醒5元').props.accessibilityState.selected).toBe(true);
  await view.press('保存提醒设置');
  const signal = request.mock.calls.filter(call => call[1] === 'PATCH').at(-1)![3] as AbortSignal;
  await view.changeIdentity('new-user');
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve({ ...reminder, threshold_cny_micros: 5000000 }); });
  expect(view.text()).not.toContain('提醒设置已保存');
  await view.press('设置消费提醒');
  expect(button(view.tree, '每月提醒20元').props.accessibilityState.selected).toBe(true);
  await view.close();
});

it('uses later report snapshots for monthly progress and notices even when the first reminder GET is delayed', async () => {
  const oldGet = deferred<UsageReminder>();
  const initial = { ...reminder, threshold_cny_micros: 5000000, known_cost_cny_micros: 4000000 };
  const fresh = { ...initial, month: '2026-12', known_cost_cny_micros: 6000000, reached: true, notice_key: 'new-month-reached' };
  const request: jest.Mock = jest.fn(async path => path === '/usage/reminder' ? oldGet.promise : report(path.endsWith('all') ?
    { period: 'all', today: '2026-12-01', end_date: '2026-12-01', monthly_reminder: fresh } : { monthly_reminder: initial }));
  const view = await setup(request);
  await view.press('统计周期全部');
  expect(view.text()).toContain('¥6.00');
  expect(view.text()).toContain('2026-12');
  expect(view.text()).toContain('本月已知预估达到');
  await act(async () => { oldGet.resolve(initial); });
  expect(view.text()).toContain('¥6.00');
  expect(view.text()).not.toContain('¥4.00');
  await view.press('设置消费提醒');
  expect(view.text()).toContain('2026-12');
  expect(view.text()).toContain('¥6.00');
  await view.close();
});

it('protects a committed reminder change from usage and reminder reads started before the save completed', async () => {
  const oldUsage = deferred<UsageReport>();
  const oldReminder = deferred<UsageReminder>();
  const patch = deferred<UsageReminder>();
  let reads = 0;
  let reminderReads = 0;
  const request: jest.Mock = jest.fn(async (path, method) => {
    if (method === 'PATCH') return patch.promise;
    if (path === '/usage/reminder') return ++reminderReads === 1 ? reminder : oldReminder.promise;
    return ++reads === 1 ? report() : oldUsage.promise;
  });
  const view = await setup(request);
  const heldRefresh = button(view.tree, '刷新个人用量').props.onPress;
  await view.press('设置消费提醒');
  await view.press('每月提醒10元');
  await act(async () => { view.tree.root.findByType(Switch).props.onValueChange(false); });
  const heldSave = button(view.tree, '保存提醒设置').props.onPress;
  await act(async () => { heldRefresh(); });
  await act(async () => { heldSave(); });
  const saved = { ...reminder, enabled: false, threshold_cny_micros: 10000000, known_cost_cny_micros: 6000000 };
  await act(async () => { patch.resolve(saved); });
  await act(async () => { oldUsage.resolve(report()); oldReminder.resolve(reminder); });
  expect(view.text()).toContain('已关闭');
  expect(view.text()).toContain('¥6.00');
  expect(view.text()).not.toContain('¥20.00 / 月');
  await view.press('设置消费提醒');
  expect(button(view.tree, '每月提醒10元').props.accessibilityState.selected).toBe(true);
  expect(view.tree.root.findByType(Switch).props.value).toBe(false);
  await view.close();
});

it('exposes visible costs, usage, unknown states and reminder limits in accessible row labels', async () => {
  const unknown: UsageCell = { ...baseCell, known_cost_cny_micros: 0, estimated_cost_cny_micros: null,
    unknown_cost_call_count: 2, cost_status: 'unknown', usage_status: 'partial' };
  const view = await setup(jest.fn(async path => path === '/usage/reminder' ? { ...reminder, cost_status: 'partial' } : report({ cells: [unknown] })));
  const rowLabel = button(view.tree, '查看模型实际模型 A').props.accessibilityLabel;
  expect(rowLabel).toContain('实际服务商');
  expect(rowLabel).toContain('2 次调用');
  expect(rowLabel).toContain('部分已记录');
  expect(rowLabel).toContain('120 Token');
  expect(rowLabel).toContain('暂无法估算');
  const reminderLabel = button(view.tree, '设置消费提醒').props.accessibilityLabel;
  expect(reminderLabel).toContain('2026-11');
  expect(reminderLabel).toContain('每月提醒金额 ¥20.00');
  expect(reminderLabel).toContain('本月已知预估 ¥1.20');
  expect(reminderLabel).toContain('部分费用未定价');
  await view.close();
});

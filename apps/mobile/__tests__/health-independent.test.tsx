import React from 'react';
import { Alert, NativeModules, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { HealthScreen } from '../src/features/health/HealthScreen';
import { healthAuthorizationUrl } from '../src/features/health/api';
import { healthStorageKey } from '../src/features/health/storage';
import { Button } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import type { ApiClient } from '../src/api/client';
import { healthReceiptFromLink } from '../src/domain/healthLink';
import type { HealthReceipt } from '../src/features/health/types';

jest.mock('../src/platform/ports', () => ({ platform: {
  onForeground: jest.fn(() => jest.fn()), openUrl: jest.fn().mockResolvedValue(undefined),
} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const record = { id: 'fixture-record', source: 'fixture-watch', metric: 'steps',
  start_at: '2026-10-28T00:00:00Z', end_at: '2026-10-28T01:00:00Z', value: 321, unit: 'count' };
const result = { records: [record], synced_at: '2026-10-29T00:00:00Z' };
const cloud = { id: 'xiaomi', name: '小米运动健康', status: 'connected', detail: 'fixture',
  metrics: ['steps', 'sleep'], has_credentials: true };
let secure: Map<string, string>;
let nativeRead: jest.Mock;
let nativePermissions: jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  secure = new Map();
  nativeRead = jest.fn().mockResolvedValue(result);
  nativePermissions = jest.fn().mockResolvedValue({ requested: ['steps'] });
  NativeModules.TadaHealth = {
    availability: jest.fn().mockResolvedValue({ provider: 'health_connect', status: 'available', detail: 'fixture local health store' }),
    requestReadPermissions: nativePermissions, readRecords: nativeRead, openSettings: jest.fn(),
  };
  NativeModules.TomorrowPlatform = {
    getSecureItem: jest.fn(async (key: string) => secure.get(key) ?? null),
    setSecureItem: jest.fn(async (key: string, value: string) => { secure.set(key, value); }),
    removeSecureItem: jest.fn(async (key: string) => { secure.delete(key); }),
  };
});
afterEach(() => { delete NativeModules.TadaHealth; delete NativeModules.TomorrowPlatform; jest.restoreAllMocks(); });

async function setup(options: { cloud?: unknown; request?: jest.Mock; user?: string; server?: string; initialReceipt?: HealthReceipt } = {}) {
  const request = options.request ?? jest.fn(async (path: string, method = 'GET') => {
    if (path === '/health/connections') return { items: options.cloud === undefined ? [cloud] : options.cloud };
    if (path === '/health/connections/xiaomi/sync') return result;
    if (path === '/health/connections/xiaomi/authorize') return { authorization_url: 'https://account.xiaomi.com/oauth2/authorize?client_id=fixture&state=fixture' };
    if (path === '/health/connections/xiaomi/finalize') return { connected: true, provider: 'xiaomi', granted_metrics: ['steps'] };
    if (path === '/health/connections/xiaomi' && method === 'DELETE') return { local_credentials_removed: true, remote_revoked: false };
    throw new Error('Unexpected independent test request ' + path);
  });
  let context = { api: { request, baseUrl: options.server ?? 'https://selfhost.example.test' } as unknown as ApiClient,
    user: { id: options.user ?? 'health-user-a' }, preferences: { serverUrl: options.server ?? 'https://selfhost.example.test', instance: { id: 'instance-a' } }, back: jest.fn() } as unknown as AppContextValue;
  const render = () => <AppProvider value={context}><HealthScreen initialReceipt={options.initialReceipt} /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  return { tree, request,
    text: () => tree.root.findAllByType(Text).flatMap(item => [item.props.children].flat()).filter(value => typeof value === 'string').join('\n'),
    button: (label: string) => {
      const button = tree.root.findAllByType(Button).find(item => item.props.accessibilityLabel === label || item.props.children === label);
      if (!button) throw new Error('Missing button ' + label);
      return button;
    },
    async press(label: string) { const button = this.button(label); await act(async () => { button.props.onPress(); }); },
    async changeIdentity(user: string, server: string) {
      context = { ...context, api: { request, baseUrl: server } as unknown as ApiClient,
        user: { id: user } as AppContextValue['user'], preferences: { ...context.preferences, serverUrl: server } };
      await act(async () => { tree.update(render()); });
    },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

it('only reads status on entry; local health stays local and does not infer granted read permissions', async () => {
  const view = await setup();
  expect(view.request.mock.calls.every(call => call[0] === '/health/connections' && (call[1] === undefined || call[1] === 'GET'))).toBe(true);
  expect(nativeRead).not.toHaveBeenCalled();
  await view.press('授权并读取本机健康记录');
  expect(nativePermissions).toHaveBeenCalledWith(['steps']);
  expect(nativeRead).toHaveBeenCalledWith({ metrics: ['steps'], days: 7 });
  expect(view.text()).toContain('fixture-watch');
  expect(view.text()).toContain('已加密保存在本机');
  expect([...secure.keys()]).toEqual([healthStorageKey('health-user-a', 'https://selfhost.example.test', 'instance-a')]);
  expect(view.request.mock.calls.every(call => call[0] === '/health/connections')).toBe(true);
  await view.close();
});

it('cloud sync waits for informed confirmation and names the selected self-host server', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await setup();
  await view.press('连接xiaomi');
  expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  const [title, message, buttons] = alert.mock.calls[0];
  expect(title).toContain('读取');
  expect(message).toContain('https://selfhost.example.test');
  expect(message).toContain('经过当前服务器');
  await act(async () => { buttons!.find(item => item.text === '同意并继续')!.onPress!(); });
  expect(view.request).toHaveBeenCalledWith('/health/connections/xiaomi/sync', 'POST', { metrics: ['steps'], days: 7 }, expect.anything());
  expect(view.text()).toContain('fixture-watch');
  await view.close();
});

it('a consent dialog held across an account change cannot submit for the old or new account', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await setup();
  await view.press('连接xiaomi');
  const continuation = alert.mock.calls[0][2]!.find(item => item.text === '同意并继续')!.onPress!;
  await view.changeIdentity('health-user-b', 'https://other-selfhost.example.test');
  await act(async () => { continuation(); });
  expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  await view.close();
});

it('health records cannot bleed across user or server changes while an old native read is in flight', async () => {
  let finish!: (value: unknown) => void;
  nativeRead.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = await setup();
  await view.press('授权并读取本机健康记录');
  await view.changeIdentity('health-user-b', 'https://other-selfhost.example.test');
  await act(async () => { finish(result); });
  expect(view.text()).not.toContain('fixture-watch');
  expect(secure.size).toBe(0);
  await view.close();
});

it('empty health reads stay unknown rather than becoming zero steps or a connected permission claim', async () => {
  nativeRead.mockResolvedValue({ records: [], synced_at: result.synced_at });
  const view = await setup();
  await view.press('授权并读取本机健康记录');
  expect(view.text()).toContain('不会将空记录视为零');
  expect(view.text()).toContain('暂无健康记录');
  await view.close();
});

it('a missing native bridge remains an honest unavailable state and does not prevent vendor setup', async () => {
  delete NativeModules.TadaHealth;
  const view = await setup();
  expect(view.text()).toContain('暂不可用');
  expect(view.button('授权并读取本机健康记录').props.disabled).toBe(true);
  expect(view.button('连接xiaomi').props.disabled).toBe(false);
  await view.close();
});

it('local encrypted storage failure is visible and does not upload the records as a fallback', async () => {
  NativeModules.TomorrowPlatform.setSecureItem.mockRejectedValue(new Error('keystore locked'));
  const view = await setup();
  await view.press('授权并读取本机健康记录');
  expect(view.text()).toContain('本机加密保存失败');
  expect(view.text()).toContain('当前页面内存保留');
  expect(view.request.mock.calls.every(call => call[0] === '/health/connections')).toBe(true);
  expect(secure.size).toBe(0);
  await view.close();
});

it('an already-connected account can revise its read scopes without disconnecting or syncing', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await setup();
  await view.press('调整xiaomi授权');
  expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  await act(async () => { alert.mock.calls[0][2]!.find(item => item.text === '同意并继续')!.onPress!(); });
  expect(view.request.mock.calls.some(call => call[0] === '/health/connections/xiaomi/authorize')).toBe(true);
  expect(view.request.mock.calls.some(call => call[0] === '/health/connections/xiaomi/sync')).toBe(false);
  expect(platform.openUrl).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/account\.xiaomi\.com\/oauth2\/authorize\?/));
  await view.close();
});

it('native partial data, truncation, and source metadata remain visible while unrequested metrics are discarded', async () => {
  nativeRead.mockResolvedValue({ ...result, truncated: true, unavailable_metrics: ['heart_rate'], records: [
    { ...record, source_app: 'health.vendor.fixture', source_device: 'fixture-band' },
    { ...record, id: 'unrequested-heart-rate', metric: 'heart_rate', value: 80, unit: 'bpm' },
  ] });
  const view = await setup();
  await view.press('授权并读取本机健康记录');
  expect(view.text()).toContain('仅包含部分数据');
  expect(view.text()).toContain('health.vendor.fixture');
  expect(view.text()).toContain('fixture-band');
  const persisted = JSON.parse([...secure.values()][0]);
  expect(persisted.buckets[0].records).toHaveLength(1);
  expect(persisted.buckets[0].records[0].metric).toBe('steps');
  expect(persisted.buckets[0].truncated).toBe(true);
  await view.close();
});

it('clear local records requires explicit confirmation and removes only the current account cache', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await setup();
  const foreignKey = healthStorageKey('health-user-b', 'https://selfhost.example.test', 'instance-a');
  secure.set(foreignKey, 'foreign-encrypted-storage-fixture');
  await view.press('授权并读取本机健康记录');
  await view.press('清除本机健康记录');
  expect(secure.size).toBe(2);
  await act(async () => { alert.mock.calls[0][2]!.find(item => item.text === '清除')!.onPress!(); });
  expect(secure.size).toBe(1);
  expect(secure.has(foreignKey)).toBe(true);
  expect(view.text()).not.toContain('fixture-watch');
  expect(view.text()).toContain('本机健康记录已清除');
  expect(view.request.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  await view.close();
});

it('a valid receipt link only prefills secret text and cannot finalize or read health data on arrival', async () => {
  const code = 'R'.repeat(43);
  const receipt = healthReceiptFromLink(`tada://health/complete?provider=xiaomi&receipt=${code}&server=${encodeURIComponent('https://selfhost.example.test')}`, 'https://selfhost.example.test');
  const view = await setup({ initialReceipt: receipt! });
  const input = view.tree.root.findByType(TextInput);
  expect(input.props.value).toBe(code);
  expect(input.props.secureTextEntry).toBe(true);
  expect(view.request.mock.calls.every(call => call[0] === '/health/connections')).toBe(true);
  expect(nativeRead).not.toHaveBeenCalled();
  expect(secure.size).toBe(0);
  await view.close();
});

it('receipt finalization requires the current explicit confirmation and does not automatically sync records', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const code = 'S'.repeat(43);
  const view = await setup({ initialReceipt: { provider: 'xiaomi', receipt: code } });
  await view.press('完成健康账号连接');
  expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  expect(alert.mock.calls[0][1]).toContain('当前已登录的妥啦账号');
  expect(alert.mock.calls[0][1]).toContain('https://selfhost.example.test');
  await act(async () => { alert.mock.calls[0][2]!.find(item => item.text === '确认连接')!.onPress!(); });
  expect(view.request).toHaveBeenCalledWith('/health/connections/xiaomi/finalize', 'POST', { receipt: code }, expect.anything());
  expect(view.request.mock.calls.some(call => call[0].endsWith('/sync'))).toBe(false);
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  expect(secure.size).toBe(0);
  await view.close();
});

it('a held receipt confirmation cannot survive a user and server switch', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await setup({ initialReceipt: { provider: 'xiaomi', receipt: 'T'.repeat(43) } });
  await view.press('完成健康账号连接');
  const confirm = alert.mock.calls[0][2]!.find(item => item.text === '确认连接')!.onPress!;
  await view.changeIdentity('health-user-b', 'https://other-selfhost.example.test');
  await act(async () => { confirm(); });
  expect(view.request.mock.calls.some(call => call[0].endsWith('/finalize'))).toBe(false);
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  await view.close();
});

it('a receipt link for another server cannot be accepted as the current self-host instance', () => {
  expect(() => healthReceiptFromLink(`tada://health/complete?provider=xiaomi&receipt=${'U'.repeat(43)}&server=${encodeURIComponent('https://attacker.example.test')}`, 'https://selfhost.example.test')).toThrow();
});

it.each([
  'https://account.xiaomi.com.evil.test/oauth2/authorize?state=x',
  'https://account.xiaomi.com@evil.test/oauth2/authorize?state=x',
  'http://account.xiaomi.com/oauth2/authorize?state=x',
  'https://account.xiaomi.com/oauth2/authorize?state=x#https://evil.test',
  'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize?state=x',
])('rejects a foreign or unsafe xiaomi authorization destination: %s', value => {
  expect(() => healthAuthorizationUrl('xiaomi', value)).toThrow();
});

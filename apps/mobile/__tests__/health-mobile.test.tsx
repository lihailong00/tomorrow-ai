import React from 'react';
import { Alert, NativeModules, Platform, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { HealthScreen } from '../src/features/health/HealthScreen';
import { healthAuthorizationUrl } from '../src/features/health/api';
import {
  healthStorageKey,
  loadHealthBuckets,
  saveHealthBuckets,
} from '../src/features/health/storage';
import {
  parseHealthRead,
  providerLabels,
  type HealthBucket,
  type HealthConnection,
  type HealthProvider,
  type HealthReceipt,
} from '../src/features/health/types';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
const records = () => [
  {
    id: 'sample1',
    source: 'health_connect',
    source_app: 'com.example.health',
    source_device: 'My watch',
    metric: 'steps' as const,
    start_at: '2026-10-29T00:00:00Z',
    end_at: '2026-10-29T00:10:00Z',
    value: 200,
    unit: 'count',
  },
];
const read = () => ({ records: records(), synced_at: '2026-10-29T01:00:00Z' });
const connection = (
  status: HealthConnection['status'] = 'not_configured',
): HealthConnection => ({
  id: 'xiaomi',
  name: '小米运动健康',
  status,
  detail: '需要配置客户端',
  metrics: ['steps', 'sleep', 'heart_rate'],
  has_credentials: status === 'connected',
});
let memory: Map<string, string>;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  memory = new Map();
  NativeModules.TomorrowPlatform = {
    getSecureItem: jest.fn(async key => memory.get(key) ?? null),
    setSecureItem: jest.fn(async (key, value) => {
      memory.set(key, value);
    }),
    removeSecureItem: jest.fn(async key => {
      memory.delete(key);
    }),
  };
  NativeModules.TadaHealth = {
    availability: jest.fn(async () => ({
      provider: 'health_connect',
      status: 'available',
      detail: '支持系统健康读取',
    })),
    requestReadPermissions: jest.fn(async metrics => ({
      requested: metrics,
      granted: metrics,
    })),
    readRecords: jest.fn(async () => read()),
    openSettings: jest.fn(async () => {}),
  };
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function setup(item = connection(), initialReceipt?: HealthReceipt) {
  const request = jest.fn(async (path: string, method = 'GET') => {
    if (path === '/health/connections') return { items: [item] };
    if (path.endsWith('/authorize'))
      return {
        authorization_url:
          'https://account.xiaomi.com/oauth2/authorize?client_id=example&state=valid',
      };
    if (path.endsWith('/sync')) return read();
    if (path.endsWith('/finalize'))
      return { connected: true, provider: item.id, granted_metrics: ['steps'] };
    if (method === 'DELETE')
      return {
        local_credentials_removed: true,
        remote_revoked: false,
        message: 'local only',
      };
    throw new Error('unexpected request');
  });
  let context = {
    api: {
      baseUrl: 'https://health.example.test',
      request,
    } as unknown as ApiClient,
    user: { id: 'user1' },
    preferences: {
      serverUrl: 'https://health.example.test',
      instance: { id: 'instance1' },
    },
    back: jest.fn(),
  } as unknown as AppContextValue;
  const render = () => (
    <AppProvider value={context}>
      <HealthScreen initialReceipt={initialReceipt} />
    </AppProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render());
  });
  const text = () =>
    tree.root
      .findAllByType(Text)
      .flatMap(node => [node.props.children].flat())
      .filter(value => typeof value === 'string' || typeof value === 'number')
      .join('\n');
  const button = (label: string) => {
    const found = tree.root
      .findAllByType(Button)
      .find(node => node.props.accessibilityLabel === label);
    if (!found) throw new Error('Missing button: ' + label);
    return found;
  };
  const control = (label: string | RegExp) =>
    tree.root.findAll(node => {
      const value = node.props.accessibilityLabel;
      return (
        typeof value === 'string' &&
        typeof node.props.onPress === 'function' &&
        (typeof label === 'string' ? value === label : label.test(value))
      );
    })[0];
  const pressControl = async (label: string | RegExp) => {
    const found = control(label);
    if (!found) throw new Error('Missing control: ' + label);
    await act(async () => {
      found.props.onPress();
    });
  };
  const openSource = async (provider: HealthProvider) => {
    if (control('关闭')) await pressControl('关闭');
    await pressControl(/^(选择健康来源|切换数据来源，当前)/);
    await pressControl('设置' + providerLabels[provider]);
  };
  return {
    tree,
    request,
    text,
    button,
    control,
    pressControl,
    openSource,
    async openReceipt() {
      if (!control('使用一次性连接确认码')) await openSource('xiaomi');
      if (!control('使用一次性连接确认码').props.accessibilityState.expanded) {
        await pressControl('使用一次性连接确认码');
      }
    },
    receiptInput: () =>
      tree.root.findAll(
        node =>
          node.props.accessibilityLabel === '一次性连接确认码' &&
          typeof node.props.onChangeText === 'function',
      )[0],
    async enterReceipt(value: string) {
      await act(async () => {
        tree.root
          .findAll(
            node =>
              node.props.accessibilityLabel === '一次性连接确认码' &&
              typeof node.props.onChangeText === 'function',
          )[0]
          .props.onChangeText(value);
      });
    },
    async press(label: string) {
      await act(async () => {
        button(label).props.onPress();
      });
    },
    async confirm(textValue = '同意并继续') {
      const buttons = (Alert.alert as jest.Mock).mock.calls.at(-1)?.[2] as {
        text: string;
        onPress?: () => void;
      }[];
      const action = buttons.find(value => value.text === textValue)?.onPress;
      if (!action) throw new Error('Missing confirmation:' + textValue);
      await act(async () => {
        action();
      });
    },
    async changeUser(id: string, instanceId = 'instance1') {
      context = {
        ...context,
        user: { id } as any,
        preferences: {
          ...context.preferences,
          instance: { id: instanceId } as any,
        },
      };
      await act(async () => {
        tree.update(render());
      });
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

it('checks availability and connection metadata without reading health data or automatically uploading', async () => {
  const view = await setup();
  await view.openSource('xiaomi');
  expect(view.text()).toContain('待配置');
  expect(view.text()).toContain('暂无健康记录');
  expect(NativeModules.TadaHealth.readRecords).not.toHaveBeenCalled();
  expect(
    NativeModules.TadaHealth.requestReadPermissions,
  ).not.toHaveBeenCalled();
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  expect(view.control('连接xiaomi')).toBeUndefined();
  await view.close();
});

it('works without a native bridge or encrypted storage and does not offer unavailable reading', async () => {
  delete NativeModules.TadaHealth;
  delete NativeModules.TomorrowPlatform;
  const view = await setup();
  await view.openSource(
    Platform.OS === 'ios' ? 'apple_health' : 'health_connect',
  );
  expect(view.control('授权并读取本机健康记录')).toBeUndefined();
  await view.pressControl('数据与权限说明');
  expect(view.text()).toContain('仅在当前页面内存保留');
  await view.close();
});

it('requests only selected read types and stores resulting data through secure storage only', async () => {
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  expect(NativeModules.TadaHealth.requestReadPermissions).toHaveBeenCalledWith([
    'steps',
  ]);
  expect(NativeModules.TadaHealth.readRecords).toHaveBeenCalledWith({
    metrics: ['steps'],
    days: 7,
  });
  expect(NativeModules.TomorrowPlatform.setSecureItem).toHaveBeenCalled();
  await view.press('查看当前来源记录明细');
  expect(view.text()).toContain('com.example.health');
  expect(view.text()).toContain('My watch');
  expect(view.text()).toContain('单条步数／睡眠记录不代表全天总量');
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  await view.close();
});

it('keeps unselected metrics out of encrypted records, preserving partial and truncated metadata', async () => {
  NativeModules.TadaHealth.readRecords.mockResolvedValue({
    ...read(),
    records: [
      ...records(),
      {
        ...records()[0],
        id: 'private-heart',
        metric: 'heart_rate',
        value: 70,
        unit: 'bpm',
      },
    ],
    truncated: true,
    unavailable_metrics: ['sleep'],
  });
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  await view.press('查看当前来源记录明细');
  expect(view.text()).toContain('本次仅包含部分数据');
  expect(view.text()).toContain('本次未能读取');
  expect([...memory.values()].join('')).not.toContain('private-heart');
  await view.close();
});

it('does not imply a denied permission or zero health measurements when iOS-style reads are empty', async () => {
  NativeModules.TadaHealth.readRecords.mockResolvedValue({
    records: [],
    synced_at: read().synced_at,
  });
  NativeModules.TadaHealth.requestReadPermissions.mockResolvedValue({
    requested: ['steps'],
  });
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  expect(view.text()).toContain('不会将空记录视为零');
  expect(view.text()).not.toContain('已获得全部权限');
  await view.close();
});

it('does not persist data after user changes while a native query is pending', async () => {
  const pending = deferred<ReturnType<typeof read>>();
  NativeModules.TadaHealth.readRecords.mockReturnValue(pending.promise);
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  await view.changeUser('user2');
  await act(async () => {
    pending.resolve(read());
  });
  expect(view.text()).not.toContain('com.example.health');
  expect(NativeModules.TomorrowPlatform.setSecureItem).not.toHaveBeenCalled();
  await view.close();
});

it('suppresses duplicate native reads while one operation is active', async () => {
  const pending = deferred<ReturnType<typeof read>>();
  NativeModules.TadaHealth.readRecords.mockReturnValue(pending.promise);
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  await view.press('授权并读取本机健康记录');
  expect(NativeModules.TadaHealth.readRecords).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(read());
  });
  await view.close();
});

it('requires cloud-data consent and opens only the official provider authorization URL', async () => {
  const view = await setup(connection('available'));
  await view.openSource('xiaomi');
  await view.press('连接xiaomi');
  expect(Alert.alert).toHaveBeenCalledWith(
    '连接小米运动健康',
    expect.stringContaining('健康记录会经过当前服务器'),
    expect.anything(),
  );
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/authorize')),
  ).toBe(false);
  await view.confirm();
  expect(platform.openUrl).toHaveBeenCalledWith(
    expect.stringMatching(
      /^https:\/\/account\.xiaomi\.com\/oauth2\/authorize\?/,
    ),
  );
  expect(view.request.mock.calls.some(call => call[0].endsWith('/sync'))).toBe(
    false,
  );
  await view.close();
});

it('rejects expired confirmation callbacks after a switch to another server identity', async () => {
  const view = await setup(connection('available'));
  await view.openSource('xiaomi');
  await view.press('连接xiaomi');
  await view.changeUser('user1', 'different-instance');
  await view.confirm();
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/authorize')),
  ).toBe(false);
  expect(platform.openUrl).not.toHaveBeenCalled();
  await view.close();
});

it('allows a connected account to adjust its read authorization instead of forcing disconnection', async () => {
  const view = await setup(connection('connected'));
  await view.openSource('xiaomi');
  await view.press('调整xiaomi授权');
  await view.confirm();
  expect(view.request).toHaveBeenCalledWith(
    '/health/connections/xiaomi/authorize',
    'POST',
    { metrics: ['steps'] },
    expect.anything(),
  );
  await view.close();
});

it('reads the granted subset after a partial cloud authorization', async () => {
  const view = await setup({
    ...connection('connected'),
    granted_metrics: ['steps'],
  });
  await view.openSource('xiaomi');
  const heart = view.tree.root.findAll(
    node =>
      node.props.accessibilityLabel === '读取心率' &&
      typeof node.props.onPress === 'function',
  )[0];
  await act(async () => {
    heart!.props.onPress();
  });
  await view.press('连接xiaomi');
  await view.confirm();
  expect(view.request).toHaveBeenCalledWith(
    '/health/connections/xiaomi/sync',
    'POST',
    { metrics: ['steps'], days: 7 },
    expect.anything(),
  );
  await view.openSource('xiaomi');
  expect(view.text()).toContain('读取仅包含已授权的所选项目');
  await view.close();
});

it('clears the selected account local health data without deleting provider records', async () => {
  const view = await setup();
  await view.openSource('health_connect');
  await view.press('授权并读取本机健康记录');
  await view.pressControl('连接与权限');
  await view.pressControl('数据与权限说明');
  await view.press('清除本机健康记录');
  await view.confirm('清除');
  expect(memory.size).toBe(0);
  expect(view.text()).not.toContain('com.example.health');
  expect(view.request.mock.calls.some(call => call[1] === 'DELETE')).toBe(
    false,
  );
  await view.close();
});

it('does not report revocation at the provider after only server credentials were removed', async () => {
  const view = await setup(connection('connected'));
  await view.openSource('xiaomi');
  await view.press('断开xiaomi');
  await view.confirm('断开并清除');
  expect(view.text()).toContain('请在厂商账号中检查并撤销授权');
  expect(view.text()).not.toContain('远程授权已撤销');
  await view.close();
});

it('validates health records and retains true source identity and explicit truncation', () => {
  const result = parseHealthRead({
    ...read(),
    records: [
      records()[0],
      records()[0],
      { ...records()[0], source_app: 'another.app' },
      { ...records()[0], source_id: 'device-a' },
      { ...records()[0], source_id: 'device-b' },
    ],
    truncated: true,
  });
  expect(result.records).toHaveLength(4);
  expect(result.records.some(record => record.source_id === 'device-a')).toBe(
    true,
  );
  expect(
    parseHealthRead({
      ...read(),
      records: [{ ...records()[0], source_id: 'x'.repeat(301) }],
    }).records[0].source_id,
  ).toBeUndefined();
  expect(result.truncated).toBe(true);
  expect(() =>
    parseHealthRead({ ...read(), records: [{ ...records()[0], value: NaN }] }),
  ).toThrow();
  expect(() =>
    parseHealthRead({
      ...read(),
      records: [{ ...records()[0], end_at: 'broken' }],
    }),
  ).toThrow();
});

it('isolates encrypted storage by user, server URL and instance ID', async () => {
  const first = healthStorageKey('a', 'https://one.test', 'one');
  const otherUser = healthStorageKey('b', 'https://one.test', 'one');
  const otherServer = healthStorageKey('a', 'https://two.test', 'one');
  const otherInstance = healthStorageKey('a', 'https://one.test', 'two');
  const bucket: HealthBucket = { ...read(), provider: 'health_connect' };
  await saveHealthBuckets(first, [bucket]);
  expect(await loadHealthBuckets(first)).toHaveLength(1);
  for (const key of [otherUser, otherServer, otherInstance])
    expect(await loadHealthBuckets(key)).toEqual([]);
  delete NativeModules.TomorrowPlatform;
  expect(await saveHealthBuckets(first, [bucket])).toBe(false);
});

it('blocks arbitrary OAuth hosts, credentials, fragments and paths', () => {
  const valid =
    'https://account.xiaomi.com/oauth2/authorize?client_id=a&state=b';
  expect(healthAuthorizationUrl('xiaomi', valid)).toBe(valid);
  for (const url of [
    valid.replace('account.xiaomi.com', 'evil.test'),
    valid.replace('.com/', '.com.evil.test/'),
    valid.replace('https://', 'https://user:secret@'),
    valid + '#fragment',
    valid.replace('/authorize?', '/other?'),
  ])
    expect(() => healthAuthorizationUrl('xiaomi', url)).toThrow();
});

it('only prefills a deep-link receipt and never finalizes it or reads data automatically', async () => {
  const code = 'A'.repeat(43);
  const view = await setup(connection('available'), {
    provider: 'xiaomi',
    receipt: code,
  });
  expect(view.receiptInput().props.value).toBe(code);
  expect(view.receiptInput().props.secureTextEntry).toBe(true);
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  expect(NativeModules.TomorrowPlatform.setSecureItem).not.toHaveBeenCalled();
  expect(NativeModules.TadaHealth.readRecords).not.toHaveBeenCalled();
  await view.close();
});

it('validates missing and malformed receipts without calling finalize', async () => {
  const view = await setup(connection('available'));
  expect(view.receiptInput()).toBeUndefined();
  await view.openReceipt();
  expect(view.button('完成健康账号连接').props.disabled).toBe(true);
  await view.press('完成健康账号连接');
  await view.enterReceipt('bad-receipt');
  await view.press('完成健康账号连接');
  expect(view.text()).toContain('43位一次性确认码');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  expect(Alert.alert).not.toHaveBeenCalled();
  await view.close();
});

it('requires in-app confirmation to finalize a manually entered receipt and clears it after success', async () => {
  const view = await setup(connection('available'));
  await view.openReceipt();
  const code = 'B'.repeat(43);
  await view.enterReceipt(code);
  await view.press('完成健康账号连接');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  expect(Alert.alert).toHaveBeenCalledWith(
    '完成健康账号连接',
    expect.stringContaining('当前已登录的妥啦账号'),
    expect.anything(),
  );
  await view.confirm('确认连接');
  expect(view.request).toHaveBeenCalledWith(
    '/health/connections/xiaomi/finalize',
    'POST',
    { receipt: code },
    expect.anything(),
  );
  expect(view.receiptInput().props.value).toBe('');
  expect(
    view.request.mock.calls.filter(call => call[0] === '/health/connections')
      .length,
  ).toBe(2);
  expect(view.request.mock.calls.some(call => call[0].endsWith('/sync'))).toBe(
    false,
  );
  expect(NativeModules.TomorrowPlatform.setSecureItem).not.toHaveBeenCalled();
  await view.close();
});

it('rejects the old confirmation and clears the receipt when the current account changes', async () => {
  const view = await setup(connection('available'), {
    provider: 'xiaomi',
    receipt: 'C'.repeat(43),
  });
  await view.press('完成健康账号连接');
  await view.changeUser('another-user');
  await view.confirm('确认连接');
  await view.openReceipt();
  expect(view.receiptInput().props.value).toBe('');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  await view.close();
});

it('clears a prefilled receipt on an instance identity change and ignores the previous confirmation', async () => {
  const view = await setup(connection('available'), {
    provider: 'xiaomi',
    receipt: 'F'.repeat(43),
  });
  await view.press('完成健康账号连接');
  await view.changeUser('user1', 'another-instance');
  await view.confirm('确认连接');
  await view.openReceipt();
  expect(view.receiptInput().props.value).toBe('');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  await view.close();
});

it('ignores a confirmation after its receipt field has changed', async () => {
  const view = await setup(connection('available'), {
    provider: 'xiaomi',
    receipt: 'G'.repeat(43),
  });
  await view.press('完成健康账号连接');
  await view.enterReceipt('H'.repeat(43));
  await view.confirm('确认连接');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  await view.close();
});

it('does not finalize a receipt for an unconfigured provider', async () => {
  const view = await setup(connection('not_configured'), {
    provider: 'xiaomi',
    receipt: 'D'.repeat(43),
  });
  expect(view.button('完成健康账号连接').props.disabled).toBe(true);
  await view.press('完成健康账号连接');
  expect(
    view.request.mock.calls.some(call => call[0].endsWith('/finalize')),
  ).toBe(false);
  expect(view.text()).toContain('此厂商通道尚未配置');
  await view.close();
});

it('shows a failed or expired receipt response without claiming connection success', async () => {
  const view = await setup(connection('available'));
  await view.openReceipt();
  await view.enterReceipt('E'.repeat(43));
  view.request.mockImplementationOnce(async () => {
    throw new Error('确认码已过期，请重新授权');
  });
  await view.press('完成健康账号连接');
  await view.confirm('确认连接');
  expect(view.text()).toContain('确认码已过期');
  expect(view.text()).not.toContain('健康账号连接已确认');
  expect(view.request.mock.calls.some(call => call[0].endsWith('/sync'))).toBe(
    false,
  );
  await view.close();
});

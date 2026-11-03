import React from 'react';
import { Alert, RefreshControl, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppContextValue, AppProvider } from '../src/app/context';
import { CapabilitiesScreen } from '../src/features/capabilities/CapabilitiesScreen';
import {
  buildHubEntries,
  splitHubEntries,
} from '../src/features/capabilities/model';
import { appInputs } from '../src/platform/appInputs';
import { phoneSources } from '../src/platform/phoneSources';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';
import { phoneAlarms } from '../src/platform/phoneAlarms';
import { unavailableWallet } from '../src/features/personal-mcp/walletModel';

jest.mock('../src/platform/phoneAlarms', () => ({ phoneAlarms: {
  supported: true, list: jest.fn().mockResolvedValue([]),
  availability: jest.fn().mockResolvedValue({ exact: true, notifications: true, system_clock: true }),
  schedule: jest.fn(), cancel: jest.fn(), openExactSettings: jest.fn(), openNotificationSettings: jest.fn(),
  openSystemClock: jest.fn(), createSystemAlarm: jest.fn(),
} }));


import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/features/phone-sources/PhoneSourcesEntry', () => ({
  PhoneSourcesEntry: () => null,
}));
jest.mock('../src/platform/phoneSources', () => ({
  phoneSourceIds: ['contacts', 'calendar', 'sms', 'photos'],
  canReadPhoneSource: (state: string) => ['granted', 'limited'].includes(state),
  phoneSources: { supported: true, status: jest.fn() },
}));
jest.mock('../src/platform/appInputs', () => ({
  appInputSources: [{ id: 'wechat', name: '微信' }],
  appInputs: {
    getStatus: jest.fn(),
    listPending: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.setTimeout(15000);
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  (phoneSources.status as jest.Mock).mockResolvedValue({
    permissions: {
      contacts: 'granted',
      calendar: 'granted',
      sms: 'requestable',
      photos: 'requestable',
    },
  });
  (appInputs.getStatus as jest.Mock).mockResolvedValue({
    supported: true,
    notification_access: true,
    selected_apps: ['wechat'],
    installed_apps: ['wechat'],
    pending_count: 0,
  });
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
function textChildren(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  if (Array.isArray(value)) return value.map(textChildren).join('');
  return React.isValidElement<{ children?: React.ReactNode }>(value)
    ? textChildren(value.props.children)
    : '';
}
async function setup(mcpCatalog: PersonalMcpConnection[] = []) {
  let catalog = [
    {
      id: 'qq_mail',
      name: 'QQ 邮箱',
      category: 'mail',
      mode: 'mail',
      status: 'connected',
      detail: '读取已授权邮件',
    },
    {
      id: 'netease163',
      name: '网易邮箱',
      category: 'mail',
      mode: 'mail',
      status: 'not_connected',
      detail: '整理收件箱里的待办',
    },
  ];
  let failed = false;
  let pending: Promise<unknown> | undefined;
  const request = jest.fn(
    async (path: string, method = 'GET', body?: Record<string, string>) => {
      if (path === '/integrations' && failed)
        throw new Error('连接目录暂时离线');
      if (path === '/integrations')
        return { items: catalog.map(item => ({ ...item })) };
      if (path === '/personal-mcp')
        return { items: mcpCatalog.map(item => ({ ...item })) };
      if (path === '/personal-wallet/alipay') return unavailableWallet;
      if (path === '/health/connections') return { items: [] };
      if (path === '/integrations/netease163/connect') {
        if (pending) await pending;
        catalog = catalog.map(item =>
          item.id === 'netease163' ? { ...item, status: 'connected' } : item,
        );
        return catalog[1];
      }
      if (path === '/integrations/qq_mail' && method === 'DELETE') {
        catalog = catalog.map(item =>
          item.id === 'qq_mail' ? { ...item, status: 'not_connected' } : item,
        );
        return { ok: true };
      }
      return { items: [] };
    },
  );
  const api = {
    baseUrl: 'https://test.example',
    request,
    connectors: jest.fn().mockResolvedValue({
      items: [
        {
          id: 'google_calendar',
          name: 'Google 日历',
          status: 'connected',
          detail: '已授权日历',
        },
        {
          id: 'gmail',
          name: 'Gmail',
          status: 'not_configured',
          detail: '服务端尚未配置',
        },
      ],
    }),
    connectorItems: jest.fn().mockResolvedValue({ items: [] }),
    authorizeConnector: jest.fn(),
    disconnectConnector: jest.fn(),
  };
  const context = {
    api,
    user: { id: 'user-a' },
    preferences: { serverUrl: api.baseUrl, instance: { id: 'instance-a' } },
    revision: 0,
    navigate: jest.fn(),
    formatDate: () => '',
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <CapabilitiesScreen />
      </AppProvider>,
    );
  });
  const section = (name: 'connected' | 'available') =>
    tree.root.findByProps({ testID: 'capabilities-' + name + '-section' });
  // Native Pressable/View wrappers forward the same testID; count logical source IDs.
  const sources = (name: 'connected' | 'available') => [
    ...new Set(
      section(name)
        .findAll(
          node =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('capability-source-'),
        )
        .map(node => node.props.testID),
    ),
  ];
  const click = async (label: string) => {
    await act(async () => {
      const node = tree.root.findAll(
        node =>
          node.props.accessibilityRole === 'button' &&
          node.props.accessibilityLabel === label &&
          typeof node.props.onPress === 'function',
      )[0];
      if (!node) throw new Error('Missing action ' + label);
      await node.props.onPress();
    });
  };
  const button = async (label: string) => {
    await act(async () => {
      const node = tree.root
        .findAllByType(Button)
        .find(node => node.props.children === label);
      if (!node) throw new Error('Missing button ' + label);
      await node.props.onPress();
    });
  };
  return {
    api,
    request,
    tree,
    context,
    sources,
    text: () =>
      tree.root
        .findAllByType(Text)
        .map(node => textChildren(node.props.children))
        .join(' '),
    click,
    button,
    setFailure: () => {
      failed = true;
    },
    setPending: (value: Promise<unknown>) => {
      pending = value;
    },
    field: async (label: string, value: string) => {
      await act(async () => {
        tree.root
          .findAllByType(TextInput)
          .find(node => node.props.accessibilityLabel === label)!
          .props.onChangeText(value);
      });
    },
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}

it('shows actual connected sources once and never treats an existing system permission as user consent', async () => {
  const view = await setup();
  expect(view.sources('connected')).toEqual(
    expect.arrayContaining([
      'capability-source-notifications',
      'capability-source-connector:google_calendar',
      'capability-source-integration:qq_mail',
    ]),
  );
  expect(view.sources('connected')).not.toContain('capability-source-phone');
  expect(view.sources('available')).toContain('capability-source-phone');
  expect(view.sources('available')).not.toContain(
    'capability-source-integration:qq_mail',
  );
  expect(
    view.tree.root.findAll(node => node.props.accessibilityRole === 'tab'),
  ).toHaveLength(0);
  expect(
    view.request.mock.calls.every(call => !call[1] || call[1] === 'GET'),
  ).toBe(true);
  await view.unmount();
});
it('searches both groups while preserving account management and import routes', async () => {
  const view = await setup();
  await view.field('搜索应用或用途', '网易');
  expect(view.sources('available')).toEqual(
    expect.arrayContaining([
      'capability-source-integration:netease163',
      'capability-source-integration:netease126',
    ]),
  );
  expect(view.sources('connected')).not.toContain(
    'capability-source-integration:qq_mail',
  );
  await view.click('导入 AI 对话');
  expect(view.context.navigate).toHaveBeenLastCalledWith({ name: 'aiHistory' });
  await view.click('管理手机通知、分享与已导入资料');
  expect(view.context.navigate).toHaveBeenLastCalledWith({
    name: 'integrations',
  });
  await view.unmount();
});
it('moves an email account only after real connect verification and refresh succeeds', async () => {
  const view = await setup(),
    gate = deferred<void>();
  view.setPending(gate.promise);
  await view.click('网易邮箱，连接');
  await view.field('邮箱地址', 'owner@163.com');
  await view.field('邮箱客户端授权码', 'testauthorization');
  await view.click('验证并连接');
  expect(view.sources('connected')).not.toContain(
    'capability-source-integration:netease163',
  );
  await act(async () => gate.resolve());
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/netease163/connect',
    'POST',
    { email: 'owner@163.com', authorization_code: 'testauthorization' },
    expect.anything(),
  );
  expect(view.sources('connected')).toContain(
    'capability-source-integration:netease163',
  );
  expect(view.sources('available')).not.toContain(
    'capability-source-integration:netease163',
  );
  await view.unmount();
});
it('requires disconnect confirmation and updates both groups from server state', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}),
    view = await setup();
  await view.click('QQ 邮箱，已连接');
  await view.button('断开云端连接');
  expect(view.request.mock.calls.some(call => call[1] === 'DELETE')).toBe(
    false,
  );
  const choices = alert.mock.calls[alert.mock.calls.length - 1][2]!;
  await act(async () =>
    choices.find(choice => choice.text === '断开连接')!.onPress!(),
  );
  expect(view.sources('connected')).not.toContain(
    'capability-source-integration:qq_mail',
  );
  expect(view.sources('available')).toContain(
    'capability-source-integration:qq_mail',
  );
  alert.mockRestore();
  await view.unmount();
});
it('does not read Google contents until requested, and preserves the original reading flow', async () => {
  const view = await setup();
  await view.click('Google 日历，已连接');
  expect(view.api.connectorItems).not.toHaveBeenCalled();
  await view.button('查看已授权资料');
  expect(view.api.connectorItems).toHaveBeenCalledWith('google_calendar');
  await view.unmount();
});
it('retains the last verified connections when a directory refresh fails', async () => {
  const view = await setup();
  view.setFailure();
  await act(async () =>
    view.tree.root.findByType(RefreshControl).props.onRefresh(),
  );
  expect(view.sources('connected')).toContain(
    'capability-source-integration:qq_mail',
  );
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(node => node.props.children === '连接目录暂时离线'),
  ).toBe(true);
  await view.unmount();
});
it('refreshes actual notification permissions on return to the app', async () => {
  const view = await setup();
  (appInputs.getStatus as jest.Mock).mockResolvedValue({
    supported: true,
    notification_access: false,
    selected_apps: [],
    installed_apps: [],
    pending_count: 0,
  });
  const foreground = (platform.onForeground as jest.Mock).mock.calls[0][0];
  await act(async () => foreground());
  expect(view.sources('connected')).not.toContain(
    'capability-source-notifications',
  );
  expect(view.sources('available')).toContain(
    'capability-source-notifications',
  );
  await view.unmount();
});
it('keeps expired grants above and one-off imports below, with no duplicate keys', () => {
  const entries = buildHubEntries({
    notifications: {
      supported: true,
      notification_access: false,
      selected_apps: ['wechat'],
      installed_apps: [],
      pending_count: 0,
    },
    phone: { supported: true, selected: 2, readable: 1 },
    integrations: [
      {
        id: 'wechat',
        name: '微信分享',
        category: 'social',
        mode: 'import',
        status: 'available',
        detail: '主动分享',
      },
    ],
  });
  const all = splitHubEntries([...entries, ...entries]);
  const groups = splitHubEntries([...entries, ...entries], '微信', '文件');
  expect(all.connected.map(entry => entry.key)).toEqual([
    'phone',
    'notifications',
  ]);
  expect(all.connected.every(entry => entry.state === 'reconnect')).toBe(true);
  expect(groups.available.map(entry => entry.key)).toEqual([
    'integration:wechat',
    'mcp:weread',
  ]);
  expect(groups.connected).toEqual([]);
});

const searchableProviders = [
  ['mcp', 'dida365', '滴答清单', 'DIDA365'],
  ['mcp', 'fliggy', '飞猪', 'FLIGGY'],
  ['mcp', 'jianguoyun', '坚果云', 'NUTSTORE'],
  ['integration', 'amap', '高德地图', 'AMAP'],
  ['mcp', 'baidu_maps', '百度地图', 'BAIDU MAPS'],
  ['integration', 'qq_mail', 'QQ邮箱', 'QQ_MAIL'],
  ['integration', 'netease163', '163邮箱', 'NETEASE163'],
  ['integration', 'netease126', '126邮箱', 'NETEASE126'],
  ['mcp', 'tencent_docs', '腾讯文档', 'TENCENT DOCS'],
  ['mcp', 'tencent_meeting', '腾讯会议', 'TENCENT MEETING'],
  ['mcp', 'didi', '滴滴出行', 'DIDI'],
  ['mcp', 'mcdonalds', '麦当劳', 'MCDONALDS'],
  ['mcp', 'notion', 'Notion', 'NOTION'],
  ['mcp', 'memos', 'Memos', 'MEMOS'],
  ['mcp', 'weread', '微信读书', 'WEREAD'],
  ['mcp', 'weiyun', '腾讯微云', 'WEIYUN'],
  ['mcp', 'luckin', '瑞幸咖啡', 'LUCKIN COFFEE'],
  ['mcp', 'qq_music', 'QQ音乐', 'QQ MUSIC'],
  ['mcp', 'ima', 'ima', 'IMA'],
] as const;

it('searches all nineteen Chinese and English service names on the actual primary page even with an older catalog', async () => {
  const view = await setup();
  try {
    await view.click('健康连接');
    for (const [kind, id, chinese, english] of searchableProviders) {
      for (const query of [chinese, english]) {
        await view.field('搜索应用或用途', query);
        expect([
          ...view.sources('connected'),
          ...view.sources('available'),
        ]).toContain('capability-source-' + kind + ':' + id);
        expect(view.text()).not.toContain('没有找到匹配的连接');
      }
    }
    await view.field('搜索应用或用途', '飞猪');
    expect(view.text()).toContain('暂不可用');
    expect(view.sources('connected')).toEqual([]);
  } finally {
    await view.unmount();
  }
});

const fliggy = (
  status: 'connected' | 'not_connected',
): PersonalMcpConnection => ({
  id: 'fliggy',
  name: '飞猪',
  description: '本人授权的旅行服务',
  help_url: 'https://example.invalid/fliggy',
  credential_label: '飞猪个人 Token',
  transport: 'official_skill',
  status,
  tool_count: status === 'connected' ? 2 : 0,
  environment: 'production',
});

it('searching an already connected Fliggy offers direct management instead of a false no-results state', async () => {
  const view = await setup([fliggy('connected')]);
  try {
    await view.field('搜索应用或用途', 'FLIGGY');
    expect(view.sources('connected')).toEqual(['capability-source-mcp:fliggy']);
    expect(view.sources('available')).toEqual([]);
    expect(view.text()).toContain('已找到已连接的服务');
    expect(view.text()).not.toContain('没有找到');
    await view.click('管理飞猪连接');
    expect(
      view.tree.root.findByType(PersonalMcpConnections).props.providerId,
    ).toBe('fliggy');
    expect(view.context.navigate).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it('opens the actual provider credential form directly from primary-page Fliggy search', async () => {
  const view = await setup([fliggy('not_connected')]);
  try {
    await view.field('搜索应用或用途', '飞猪');
    await view.click('飞猪，连接');
    expect(
      view.tree.root.findByType(PersonalMcpConnections).props.providerId,
    ).toBe('fliggy');
    await view.click('连接飞猪账号');
    const token = view.tree.root
      .findAllByType(TextInput)
      .find(input => input.props.accessibilityLabel === '飞猪个人 Token');
    expect(token?.props.value).toBe('');
    expect(token?.props.secureTextEntry).toBe(true);
    expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(
      false,
    );
    expect(view.context.navigate).not.toHaveBeenCalled();
  } finally {
    await view.unmount();
  }
});

it('finds the actual local alarm launcher without a server connector and opens the editable form', async () => {
  const view = await setup();
  for (const query of ['闹钟', '闹铃', 'ALARM']) {
    await act(async () => view.tree.root.findAllByType(TextInput).find(node => /搜索.*应用.*用途/.test(node.props.accessibilityLabel ?? ''))!.props.onChangeText(query));
    expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '设置和管理本机闹铃').length).toBeGreaterThan(0);
    expect(view.tree.root.findAllByType(Text).some(node => typeof node.props.children === 'string' && /没有找到.*连接/.test(node.props.children))).toBe(false);
  }
  await view.click('设置和管理本机闹铃');
  expect(view.tree.root.findAllByType(TextInput).some(node => node.props.accessibilityLabel === '闹铃日期')).toBe(true);
  expect(phoneAlarms.schedule).not.toHaveBeenCalled();
  expect(view.request.mock.calls.every(call => !call[1] || call[1] === 'GET')).toBe(true);
  await view.unmount();
});

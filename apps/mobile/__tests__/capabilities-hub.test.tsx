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
async function setup() {
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
      if (path === '/health/connections' || path === '/personal-mcp')
        return { items: [] };
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
it('filters only the add section and preserves connected account management and import routes', async () => {
  const view = await setup();
  await view.field('搜索未连接的应用或用途', '网易');
  expect(view.sources('available')).toEqual([
    'capability-source-integration:netease163',
  ]);
  expect(view.sources('connected')).toContain(
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
  const groups = splitHubEntries([...entries, ...entries], '微信', '文件');
  expect(groups.connected.map(entry => entry.key)).toEqual([
    'phone',
    'notifications',
  ]);
  expect(groups.connected.every(entry => entry.state === 'reconnect')).toBe(
    true,
  );
  expect(groups.available.map(entry => entry.key)).toEqual([
    'integration:wechat',
  ]);
});

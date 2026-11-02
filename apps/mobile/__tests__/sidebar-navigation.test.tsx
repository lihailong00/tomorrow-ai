import React from 'react';
import { Modal, ScrollView, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  AppProvider,
  type AppContextValue,
  type Route,
} from '../src/app/context';
import { SidebarNavigation } from '../src/features/navigation/SidebarNavigation';
import {
  sidebarActiveId,
  sidebarGroups,
  sidebarTools,
  sidebarUtilities,
  searchSidebar,
} from '../src/features/navigation/sidebarModel';
import { HelpScreen } from '../src/features/navigation/HelpScreen';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.mock('../src/ui/ChatMotion', () => ({ useChatReducedMotion: () => true }));
jest.mock('../src/features/conversations/useConversationPins', () => ({
  useConversationPins: () => ({
    items: [
      {
        id: 'pin-one',
        title: 'Rust 所有权',
        updated_at: '2026-11-02T00:00:00Z',
      },
    ],
  }),
}));
jest.mock('../src/platform/ports', () => ({
  platform: { copyText: jest.fn().mockResolvedValue(undefined) },
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
});
const item = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0];
const manifest = {
  id: 'server-a',
  name: '自己的服务',
  deployment_mode: 'self_hosted',
};
async function setup(visible = true, initialRoute: Route = { name: 'main' }) {
  const request = jest.fn(async (path: string) =>
    path.startsWith('/notifications')
      ? { items: [{ read: false }] }
      : {
          items: [
            {
              id: 'recent-one',
              title: 'Rust 接着学',
              updated_at: '2026-11-02T00:00:00Z',
            },
          ],
        },
  );
  const context = {
    api: { baseUrl: 'https://server.test', request },
    user: { id: 'user-a', name: '晓龙' },
    preferences: { instance: manifest, serverUrl: 'https://server.test' },
    navigate: jest.fn(),
  } as unknown as AppContextValue;
  const selected = jest.fn(),
    close = jest.fn();
  let tree!: ReactTestRenderer;
  const render = (open: boolean, owner = context) => (
    <AppProvider value={owner}>
      <SidebarNavigation
        visible={open}
        route={initialRoute}
        tab="today"
        onSelect={selected}
        onClose={close}
      />
    </AppProvider>
  );
  await act(async () => {
    tree = create(render(visible));
  });
  return {
    tree,
    request,
    context,
    selected,
    close,
    render,
    press: async (label: string) => {
      await act(async () => {
        const node = item(tree, label);
        if (!node) throw new Error('Missing ' + label);
        node.props.onPress();
      });
    },
    query: async (value: string) => {
      await act(async () =>
        tree.root.findAllByType(TextInput)[0].props.onChangeText(value),
      );
    },
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}
test('maps existing top-level destinations and search aliases without duplicate entries', () => {
  const all = [
    ...sidebarGroups.flatMap(group => group.items),
    ...sidebarTools,
    ...sidebarUtilities,
  ];
  expect(new Set(all.map(row => row.id)).size).toBe(all.length);
  expect(searchSidebar('邮箱').map(row => row.id)).toContain('integrations');
  expect(searchSidebar('DeepSeek').map(row => row.id)).toContain('aiHistory');
  expect(searchSidebar('自建').map(row => row.id)).toContain('server');
  expect(searchSidebar('')).toEqual([]);
  expect(sidebarActiveId({ name: 'main', tab: 'memories' }, 'today')).toBe(
    'memories',
  );
  expect(
    sidebarActiveId({ name: 'assistantTasks', view: 'schedules' }, 'today'),
  ).toBe('schedules');
  expect(sidebarActiveId({ name: 'todo', id: 't' }, 'today')).toBe('tasks');
});
test('does not mount a modal or make data requests while closed', async () => {
  const view = await setup(false);
  expect(view.tree.root.findAllByType(Modal)).toHaveLength(0);
  expect(view.request).not.toHaveBeenCalled();
  await view.unmount();
});
test('opening from a tool page reveals and highlights its selected destination', async () => {
  const view = await setup(true, { name: 'assistantTasks', view: 'schedules' });
  expect(item(view.tree, '定时安排').props.accessibilityState.selected).toBe(
    true,
  );
  expect(item(view.tree, '更多工具').props.accessibilityState.expanded).toBe(
    true,
  );
  await view.unmount();
});
test('keeps fixed header/footer outside the middle scroll and exposes all tools', async () => {
  const view = await setup();
  const scroll = view.tree.root.findAllByType(ScrollView)[0];
  expect(
    scroll.findAll(node => node.props.testID === 'sidebar-fixed-header'),
  ).toHaveLength(0);
  expect(
    scroll.findAll(node => node.props.testID === 'sidebar-fixed-footer'),
  ).toHaveLength(0);
  expect(item(view.tree, '定时安排')).toBeUndefined();
  await view.press('更多工具');
  expect(item(view.tree, '更多工具').props.accessibilityState.expanded).toBe(
    true,
  );
  await view.press('定时安排');
  expect(view.selected).toHaveBeenCalledWith({
    kind: 'route',
    route: { name: 'assistantTasks', view: 'schedules' },
  });
  expect(view.close).toHaveBeenCalledTimes(1);
  await view.unmount();
});
test('the system back request closes the drawer without changing routes or service settings', async () => {
  const view = await setup();
  await act(async () =>
    view.tree.root.findByType(Modal).props.onRequestClose(),
  );
  expect(view.close).toHaveBeenCalledTimes(1);
  expect(view.selected).not.toHaveBeenCalled();
  await view.press('服务连接：自建服务');
  expect(view.selected).toHaveBeenCalledWith({
    kind: 'route',
    route: { name: 'settings', section: 'server' },
  });
  expect(
    view.request.mock.calls.every(call => call[0].startsWith('/notifications')),
  ).toBe(true);
  await view.unmount();
});
test('search finds mailbox aliases immediately and loads only a bounded recent title list', async () => {
  jest.useFakeTimers();
  const view = await setup();
  try {
    await view.query('邮箱');
    expect(item(view.tree, '应用连接')).toBeDefined();
    await view.query('Rust');
    await act(async () => jest.advanceTimersByTime(300));
    expect(view.request).toHaveBeenCalledWith(
      '/conversations?offset=0&limit=50',
      'GET',
      undefined,
      expect.anything(),
    );
    expect(item(view.tree, '打开对话：Rust 所有权')).toBeDefined();
    await view.press('打开对话：Rust 接着学');
    expect(view.selected).toHaveBeenCalledWith({
      kind: 'route',
      route: { name: 'chat', conversationId: 'recent-one' },
    });
    expect(view.tree.root.findAllByType(TextInput)[0].props.value).toBe('');
  } finally {
    await view.unmount();
    jest.useRealTimers();
  }
});
test('footer account and help destinations use real routes rather than changing any account locally', async () => {
  const view = await setup();
  await view.press('我的账户');
  expect(view.selected).toHaveBeenLastCalledWith({
    kind: 'route',
    route: { name: 'settings', section: 'account' },
  });
  await view.press('帮助与反馈');
  expect(view.selected).toHaveBeenLastCalledWith({
    kind: 'route',
    route: { name: 'help' },
  });
  await view.unmount();
});
test('switching account and server drops old queries and rejects late conversation results', async () => {
  jest.useFakeTimers();
  const view = await setup();
  let resolve!: (value: unknown) => void;
  const pending = new Promise(yes => {
    resolve = yes;
  });
  view.request.mockImplementation((async (path: string) =>
    path.startsWith('/conversations') ? pending : { items: [] }) as any);
  try {
    await view.query('private');
    await act(async () => jest.advanceTimersByTime(300));
    const changed = {
      ...view.context,
      api: {
        baseUrl: 'https://different.test',
        request: jest.fn().mockResolvedValue({ items: [] }),
      },
      user: { id: 'user-b', name: '新用户' },
      preferences: {
        serverUrl: 'https://different.test',
        instance: { ...manifest, id: 'server-b' },
      },
    } as unknown as AppContextValue;
    await act(async () => view.tree.update(view.render(true, changed)));
    expect(view.tree.root.findAllByType(TextInput)[0].props.value).toBe('');
    await act(async () =>
      resolve({ items: [{ id: 'secret', title: 'private account text' }] }),
    );
    expect(item(view.tree, '打开对话：private account text')).toBeUndefined();
    expect(item(view.tree, '我的账户')).toBeDefined();
  } finally {
    resolve({ items: [] });
    await view.unmount();
    jest.useRealTimers();
  }
});
test('help opens connection settings and copies a user-controlled feedback template', async () => {
  const navigate = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={{ navigate } as unknown as AppContextValue}>
        <HelpScreen />
      </AppProvider>,
    );
  });
  await act(async () => item(tree, '数据保存在哪里？').props.onPress());
  expect(
    tree.root.findAll(
      node =>
        typeof node.props.children === 'string' &&
        node.props.children.includes('账号和数据独立'),
    ).length,
  ).toBeGreaterThan(0);
  await act(async () =>
    tree.root
      .findAllByType(Button)
      .find(node => node.props.children === '检查服务连接')!
      .props.onPress(),
  );
  expect(navigate).toHaveBeenCalledWith({
    name: 'settings',
    section: 'server',
  });
  await act(async () =>
    tree.root
      .findAllByType(Button)
      .find(node => node.props.children === '复制反馈模板')!
      .props.onPress(),
  );
  expect(platform.copyText).toHaveBeenCalledWith(
    expect.stringContaining('操作步骤：'),
  );
  await act(async () => tree.unmount());
});

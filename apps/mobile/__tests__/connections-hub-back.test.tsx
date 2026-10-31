import React from 'react';
import { BackHandler, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { IntegrationsScreen } from '../src/features/integrations/IntegrationsScreen';

jest.mock('../src/platform/appInputs', () => ({
  ...jest.requireActual('../src/platform/appInputs'),
  appInputs: {
    getStatus: jest
      .fn()
      .mockResolvedValue({
        supported: true,
        notification_access: false,
        installed_apps: [],
        selected_apps: [],
        pending_count: 0,
      }),
    listPending: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../src/platform/ports', () => ({
  platform: { onForeground: () => () => {} },
}));
jest.mock('../src/platform/photoIndex', () => ({
  photoIndexAvailable: false,
  photoIndex: {},
}));
jest.mock('../src/features/health/native', () => ({
  nativeHealth: {
    availability: jest
      .fn()
      .mockResolvedValue({
        provider: 'health_connect',
        status: 'unavailable',
        detail: '测试设备',
      }),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

let handlers: Array<() => boolean | null | undefined> = [];
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  handlers = [];
  jest.clearAllMocks();
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler);
      return {
        remove: () => {
          handlers = handlers.filter(value => value !== handler);
        },
      };
    });
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function setup(parentOrder: 'before' | 'after' = 'after') {
  const parent = jest.fn(() => false);
  if (parentOrder === 'before')
    BackHandler.addEventListener('hardwareBackPress', parent);
  const context = {
    api: {
      request: jest.fn().mockResolvedValue({ items: [] }),
      baseUrl: 'https://example.test',
    },
    user: { id: 'user-a' },
    preferences: {},
    back: jest.fn(),
    navigate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <IntegrationsScreen />
      </AppProvider>,
    );
  });
  if (parentOrder === 'after')
    BackHandler.addEventListener('hardwareBackPress', parent);
  const press = async (predicate: (props: any) => boolean) => {
    const target = tree.root.findAll(
      node => predicate(node.props) && typeof node.props.onPress === 'function',
    )[0];
    if (!target) throw new Error('Missing control');
    await act(async () => {
      target.props.onPress();
    });
  };
  return {
    tree,
    context,
    pressLabel: (label: string) =>
      press(props => props.accessibilityLabel === label),
    pressRow: (key: string) =>
      press(props => props.testID === 'connection-row-' + key),
    async hardwareBack() {
      let consumed = false;
      await act(async () => {
        for (const handler of [...handlers].reverse()) {
          if (handler() === true) {
            consumed = true;
            break;
          }
        }
      });
      return consumed;
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

it.each(['before', 'after'] as const)(
  'the root hub consumes Back and returns to capabilities with the parent listener registered %s',
  async order => {
    const view = await setup(order);
    expect(await view.hardwareBack()).toBe(true);
    expect(view.context.back).toHaveBeenCalledTimes(1);
    await view.close();
  },
);

it('hardware Back closes an internal app detail before leaving the connection hub', async () => {
  const view = await setup();
  await view.pressRow('app:wechat');
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).not.toHaveBeenCalled();
  expect(
    view.tree.root.findAll(
      node => node.props.testID === 'connection-row-app:wechat',
    ).length,
  ).toBeGreaterThan(0);
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).toHaveBeenCalledTimes(1);
  await view.close();
});

it('hardware Back closes the import inbox to the hub before returning to capabilities', async () => {
  const view = await setup();
  await view.pressLabel('待接收');
  expect(
    view.tree.root.findAll(
      node => node.props.accessibilityLabel === '返回我的连接',
    ).length,
  ).toBeGreaterThan(0);
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).not.toHaveBeenCalled();
  expect(
    view.tree.root
      .findAllByType(TextInput)
      .some(node => node.props.accessibilityLabel === '搜索应用或用途'),
  ).toBe(true);
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).toHaveBeenCalledTimes(1);
  await view.close();
});

it('hardware Back first clears search or management context without leaving the hub', async () => {
  const view = await setup();
  await act(async () => {
    view.tree.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === '搜索应用或用途')!
      .props.onChangeText('微信');
  });
  expect(await view.hardwareBack()).toBe(true);
  expect(
    view.tree.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === '搜索应用或用途')!.props
      .value,
  ).toBe('');
  expect(view.context.back).not.toHaveBeenCalled();
  await view.pressLabel('管理已添加的连接');
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).not.toHaveBeenCalled();
  expect(await view.hardwareBack()).toBe(true);
  expect(view.context.back).toHaveBeenCalledTimes(1);
  await view.close();
});

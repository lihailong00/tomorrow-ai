import React from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { CloudConnection } from '../src/features/integrations/IntegrationsScreen';
import type { Integration } from '../src/features/integrations/types';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({
  platform: { openUrl: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.clearAllMocks());

const item: Integration = {
  id: 'amap',
  name: '高德地图',
  category: '出行',
  mode: 'map',
  status: 'not_connected',
  detail: '使用自己的 Key 查询地图',
  credential_scope: 'user',
};

async function setup(
  overrides: Partial<Integration> = {},
  request = jest.fn().mockResolvedValue({}),
) {
  const onChanged = jest.fn().mockResolvedValue(undefined);
  const onNotice = jest.fn();
  const context = {
    api: { request },
    user: { id: 'map-user' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <CloudConnection
          item={{ ...item, ...overrides }}
          onChanged={onChanged}
          onNotice={onNotice}
          onImport={jest.fn()}
        />
      </AppProvider>,
    );
  });
  const button = (label: string) =>
    tree.root.findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        node.findAll(child => child.props.children === label).length > 0,
    )[0];
  return {
    tree,
    request,
    onChanged,
    onNotice,
    text: () => JSON.stringify(tree.toJSON()),
    keyField: () =>
      tree.root
        .findAllByType(TextInput)
        .find(
          node => node.props.accessibilityLabel === '我的高德 Web 服务 Key',
        ),
    fillKey: async (value: string) => {
      await act(async () =>
        tree.root
          .findAllByType(TextInput)
          .find(
            node => node.props.accessibilityLabel === '我的高德 Web 服务 Key',
          )!
          .props.onChangeText(value),
      );
    },
    press: async (label: string) => {
      const node = button(label);
      if (!node) throw new Error('Missing ' + label);
      await act(async () => node.props.onPress());
    },
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

it('submits only the current users trimmed Key and clears it after verification', async () => {
  const view = await setup();
  expect(view.keyField()!.props.secureTextEntry).toBe(true);
  await view.fillKey('  user-owned-test-key  ');
  await view.press('验证并连接');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/amap/connect',
    'POST',
    { web_api_key: 'user-owned-test-key' },
    expect.any(AbortSignal),
  );
  expect(view.onChanged).toHaveBeenCalledTimes(1);
  expect(view.keyField()!.props.value).toBe('');
  await view.close();
});

it('links directly to the official Web service Key instructions', async () => {
  const view = await setup();
  const link = view.tree.root.findAll(
    node =>
      node.props.accessibilityRole === 'link' &&
      typeof node.props.onPress === 'function',
  )[0];
  await act(async () => link.props.onPress());
  expect(platform.openUrl).toHaveBeenCalledWith(
    'https://lbs.amap.com/api/mcp-server/create-project-and-key',
  );
  expect(view.text()).toContain('Web 服务');
  expect(view.text()).toContain('不授权读取高德账号');
  await view.close();
});

it('does not claim success for a rejected Key and clears the entered secret', async () => {
  const request = jest
    .fn()
    .mockRejectedValue(new Error('Key 无效，请检查凭据'));
  const view = await setup({}, request);
  await view.fillKey('rejected-test-key');
  await view.press('验证并连接');
  expect(view.onChanged).not.toHaveBeenCalled();
  expect(view.text()).toContain('Key 无效');
  expect(view.keyField()!.props.value).toBe('');
  await view.close();
});

it('supports replacing a saved Key without displaying the saved secret', async () => {
  const view = await setup({ status: 'connected' });
  expect(view.keyField()).toBeUndefined();
  await view.press('替换我的 Key');
  await view.fillKey('replacement-test-key');
  await view.press('验证并替换 Key');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/amap/connect',
    'POST',
    { web_api_key: 'replacement-test-key' },
    expect.any(AbortSignal),
  );
  expect(view.keyField()).toBeUndefined();
  await view.close();
});

it('asks for a server upgrade instead of using an older servers shared Key', async () => {
  const view = await setup({
    status: 'available',
    credential_scope: undefined,
  });
  expect(view.text()).toContain('请升级服务器');
  expect(view.keyField()).toBeUndefined();
  expect(view.text()).not.toContain('查找地点');
  expect(view.request).not.toHaveBeenCalled();
  await view.close();
});

it('queries and renders actual server-returned places after connecting', async () => {
  const request = jest
    .fn()
    .mockResolvedValue({
      items: [{ id: 'station', title: '北京南站', text: '北京市丰台区' }],
    });
  const view = await setup({ status: 'connected' }, request);
  const field = view.tree.root
    .findAllByType(TextInput)
    .find(node => node.props.accessibilityLabel === '想去哪里')!;
  await act(async () => field.props.onChangeText('北京南站'));
  await view.press('查找地点');
  expect(request).toHaveBeenCalledWith(
    '/integrations/amap/read',
    'POST',
    { query: '北京南站', keywords: '北京南站' },
    expect.any(AbortSignal),
  );
  expect(view.text()).toContain('北京市丰台区');
  await view.close();
});

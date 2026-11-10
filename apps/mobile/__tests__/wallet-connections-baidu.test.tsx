import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

const baidu: PersonalMcpConnection = {
  id: 'baidu_netdisk',
  name: '百度网盘',
  description: '个人体验，仅供非商业用途，非正式环境。',
  help_url: 'https://github.com/baidu/mcp',
  credential_label: '个人 AccessToken',
  status: 'not_connected',
  tool_count: 0,
  environment: 'experience',
  transport: 'sse',
};
async function render(initial: PersonalMcpConnection) {
  let current = initial;
  const request = jest.fn(
    async (
      path: string,
      _method?: string,
      _body?: unknown,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      if (path === '/personal-mcp') return { items: [current] };
      if (path === '/personal-mcp/actions') return { items: [] };
      if (path === '/personal-mcp/' + initial.id + '/connect')
        return { ...initial, status: 'connected', tool_count: 1 };
      if (path === '/personal-mcp/' + initial.id && _method === 'DELETE') {
        current = { ...current, has_credentials: false };
        return { ok: true };
      }
      if (path === '/personal-wallet/alipay')
        return {
          id: 'alipay',
          name: '支付宝',
          kind: 'wallet',
          status: 'not_configured',
          description: '',
          help_url: 'https://aipay.alipay.com/wallet-guide',
          reason: '服务尚未开通',
        };
      throw new Error('Unexpected request: ' + path);
    },
  );
  const context = {
    api: { request } as unknown as ApiClient,
    user: { id: 'baidu-user' },
  } as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <PersonalMcpConnections />
      </AppProvider>,
    );
  });
  return {
    tree,
    request,
    setCurrent(value: PersonalMcpConnection) {
      current = value;
    },
    text: () =>
      tree.root
        .findAllByType(Text)
        .flatMap(node => [node.props.children].flat())
        .filter(value => typeof value === 'string')
        .join('\n'),
    async button(label: string) {
      const node = tree.root
        .findAllByType(Button)
        .find(value => value.props.accessibilityLabel === label);
      if (!node) throw new Error('Missing button: ' + label);
      await act(async () => {
        await node.props.onPress();
      });
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

it('labels personal experience before connection and sends the metadata-selected experience environment', async () => {
  const view = await render(baidu);
  expect(view.text()).toContain('非商业用途');
  expect(view.text()).toContain('非正式环境');
  await view.button('连接百度网盘账号');
  expect(
    view.tree.root.findAll(node => node.props.accessibilityRole === 'radio'),
  ).toHaveLength(0);
  await act(async () => {
    view.tree.root.findByType(TextInput).props.onChangeText('my-baidu-token');
  });
  await view.button('校验并连接百度网盘');
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/baidu_netdisk/connect',
    'POST',
    { token: 'my-baidu-token', environment: 'experience' },
    expect.anything(),
  );
  expect(view.text()).toContain('个人体验环境');
  await view.close();
});

it('does not offer personal experience while the administrator has not enabled the restricted service', async () => {
  const view = await render({
    ...baidu,
    status: 'not_configured',
    unavailable_reason: '管理员尚未开启限时个人体验',
  });
  expect(view.text()).not.toContain('百度网盘');
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(value => value.props.accessibilityLabel === '连接百度网盘账号'),
  ).toBe(false);
  expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  await view.close();
});

it('supports the official Yinxiang Skill with personal credentials and preserves its membership notice', async () => {
  const view = await render({
    id: 'yinxiang',
    name: '印象笔记',
    description:
      '需要符合要求的印象笔记会员；使用你本人的 AuthToken 读取授权资料。',
    help_url: 'https://dev.yinxiang.com/',
    credential_label: '个人 AuthToken',
    status: 'not_connected',
    tool_count: 0,
    environment: 'production',
    transport: 'official_skill',
  });
  expect(view.text()).toContain('会员');
  await view.button('连接印象笔记账号');
  expect(view.tree.root.findByType(TextInput).props.secureTextEntry).toBe(true);
  await act(async () => {
    view.tree.root
      .findByType(TextInput)
      .props.onChangeText('own-yinxiang-auth');
  });
  await view.button('校验并连接印象笔记');
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/yinxiang/connect',
    'POST',
    { token: 'own-yinxiang-auth', environment: 'production' },
    expect.anything(),
  );
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(view.text()).not.toContain('own-yinxiang-auth');
  expect(view.text()).toContain('已连接');
  await view.close();
});

it('allows deleting a stored personal token after the administrator disables the experience provider', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await render({
    ...baidu,
    status: 'connected',
    has_credentials: true,
    tool_count: 1,
  });
  view.setCurrent({
    ...baidu,
    status: 'not_configured',
    has_credentials: true,
    unavailable_reason: '管理员已关闭个人体验',
  });
  await act(async () => {
    jest.advanceTimersByTime(15000);
  });
  expect(view.text()).toContain('管理员已关闭个人体验');
  const labels = () =>
    view.tree.root
      .findAllByType(Button)
      .map(button => button.props.accessibilityLabel);
  expect(labels()).toContain('断开百度网盘连接');
  expect(labels()).not.toContain('校验百度网盘连接');
  expect(labels()).not.toContain('查看百度网盘工具');
  await view.button('断开百度网盘连接');
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/baidu_netdisk',
    'DELETE',
    undefined,
    expect.anything(),
  );
  expect(labels()).not.toContain('断开百度网盘连接');
  expect(labels()).not.toContain('连接百度网盘账号');
  expect(view.text()).not.toContain('管理员已关闭个人体验');
  await view.close();
});

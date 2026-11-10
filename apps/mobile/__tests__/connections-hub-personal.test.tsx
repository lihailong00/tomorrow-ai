import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { Button } from '../src/ui/components';
import { McpConnectionRow } from '../src/features/personal-mcp/McpConnectionCard';

jest.mock('../src/platform/ports', () => ({
  platform: { onForeground: () => () => {}, openUrl: jest.fn() },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.mock('../src/features/personal-mcp/AlipayWalletConnection', () => {
  const R = require('react');
  const NativeText = require('react-native').Text;
  return {
    AlipayWalletConnection: () =>
      R.createElement(NativeText, null, '支付宝待开通说明'),
  };
});
const makeItem = (id: string, name: string): PersonalMcpConnection => ({
  id,
  name,
  description: '个人服务',
  help_url: 'https://example.com/help',
  credential_label: '个人凭证',
  transport: 'streamable_http',
  status: 'not_connected',
  tool_count: 0,
  environment: 'production',
});
const items = [makeItem('didi', '滴滴出行'), makeItem('yinxiang', '印象笔记')];
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function setup(provider = 'didi') {
  const request = jest.fn(async (path: string) => {
    if (path === '/personal-mcp') return { items };
    if (path === '/personal-mcp/actions')
      return {
        items: items.map(item => ({
          id: item.id + '-action',
          provider: item.id,
          provider_name: item.name,
          tool: 'write',
          arguments: { text: item.name },
          status: 'pending',
          expires_at: '2099-01-01T00:00:00Z',
        })),
      };
    throw new Error('Unexpected request ' + path);
  });
  const context = {
    api: { request, baseUrl: 'https://example.com' },
    user: { id: 'a' },
  } as unknown as AppContextValue;
  const changed = jest.fn();
  const render = (id: string) => (
    <AppProvider value={context}>
      <PersonalMcpConnections providerId={id} onConnectionChange={changed} />
    </AppProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(provider));
  });
  const click = async (label: string) => {
    const node = tree.root
      .findAllByType(Button)
      .find(
        value =>
          value.props.accessibilityLabel === label ||
          value.props.children === label,
      ) ?? tree.root.findAllByType(McpConnectionRow).find(value => value.props.label === label);
    if (!node) throw new Error(label);
    await act(async () => {
      node.props.onPress();
    });
  };
  return {
    tree,
    request,
    changed,
    click,
    text: () =>
      tree.root
        .findAllByType(Text)
        .flatMap(value => value.props.children)
        .filter(value => typeof value === 'string')
        .join('\n'),
    update: async (id: string) => {
      await act(async () => tree.update(render(id)));
    },
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

it('scopes the visible provider and pending write confirmations to that account', async () => {
  const view = await setup();
  expect(view.text()).toContain('滴滴出行');
  expect(view.text()).not.toContain('印象笔记');
  expect(view.text()).not.toContain('支付宝待开通说明');
  expect(view.changed).toHaveBeenCalledWith(items[0]);
  expect(view.changed).not.toHaveBeenCalledWith(items[1]);
  expect(
    view.tree.root
      .findAllByType(Button)
      .filter(
        value => value.props.accessibilityLabel === '确认执行印象笔记write',
      ),
  ).toHaveLength(0);
  await view.close();
});

it('switching provider destroys a secret draft and aborts the previous provider requests', async () => {
  const view = await setup();
  await view.click('连接滴滴出行账号');
  await act(async () =>
    view.tree.root
      .findByType(TextInput)
      .props.onChangeText('private-didi-draft'),
  );
  const signal = (view.request.mock.calls[0] as unknown[])[3] as AbortSignal;
  await view.update('yinxiang');
  expect(signal.aborted).toBe(true);
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(view.text()).not.toContain('滴滴出行');
  await view.click('连接印象笔记账号');
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  await view.close();
});

it('a write confirmation kept open while switching providers cannot execute', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup();
  expect(view.text()).not.toContain('等待你确认；可能修改资料或产生订单与费用。');
  await view.click('待确认操作');
  await view.click('确认执行滴滴出行write');
  const confirm = alert.mock.calls[0][2]![1].onPress!;
  await view.update('yinxiang');
  await act(async () => confirm());
  expect(
    view.request.mock.calls.filter(call => call[0].endsWith('/confirm')),
  ).toHaveLength(0);
  await view.close();
});

it('the Alipay-only view does not mix personal MCP or another account actions into the wallet placeholder', async () => {
  const view = await setup('alipay');
  expect(view.text()).toContain('支付宝待开通说明');
  expect(view.request).not.toHaveBeenCalled();
  expect(view.text()).not.toContain('滴滴出行');
  expect(view.text()).not.toContain('当前服务器尚未提供个人账号连接');
  await view.close();
});

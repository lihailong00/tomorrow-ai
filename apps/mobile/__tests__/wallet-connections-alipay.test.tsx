import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import {
  AlipayWalletConnection,
  type WalletConnectionStatus,
} from '../src/features/personal-mcp/AlipayWalletConnection';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import { McpConnectionRow } from '../src/features/personal-mcp/McpConnectionCard';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
const metadata: WalletConnectionStatus = {
  id: 'alipay',
  name: '支付宝',
  kind: 'wallet',
  status: 'not_configured',
  description:
    '连接你本人的支付宝账号；本版仅提供个人钱包绑定入口，不执行付款。',
  reason: '支付宝移动端 Agent Pay 需获邀开通；本服务尚未配置正式接入通道。',
  help_url: 'https://aipay.alipay.com/wallet-guide',
  qualification_url: 'https://aipay.alipay.com/products/mobile-agent-pay',
  binding_available: false,
  payment_available: false,
};
const availableMetadata: WalletConnectionStatus = { ...metadata, status: 'not_connected',
  binding_available: true, payment_available: true, protocol_version: 1, runtime_mode: 'dedicated_single_user' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}
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

async function setup(value: unknown = metadata, strict = false) {
  const request = jest.fn(
    async (
      _path: string,
      _method?: string,
      _body?: unknown,
      _signal?: AbortSignal,
    ) => value,
  );
  let api = { request } as unknown as ApiClient;
  let tree!: ReactTestRenderer;
  const render = () =>
    strict ? (
      <React.StrictMode>
        <AlipayWalletConnection api={api} />
      </React.StrictMode>
    ) : (
      <AlipayWalletConnection api={api} />
    );
  await act(async () => {
    tree = create(render());
  });
  return {
    tree,
    request,
    text: () =>
      tree.root
        .findAllByType(Text)
        .flatMap(node => [node.props.children].flat())
        .filter(node => typeof node === 'string')
        .join('\n'),
    async button(label: string) {
      const node = tree.root
        .findAllByType(Button)
        .find(item => item.props.accessibilityLabel === label)
        ?? tree.root.findAllByType(McpConnectionRow).find(item => (item.props.accessibilityLabel ?? item.props.label) === label);
      if (!node) throw new Error('Missing button:' + label);
      await act(async () => {
        await node.props.onPress();
      });
    },
    async switchApi(next: ApiClient) {
      api = next;
      await act(async () => {
        tree.update(render());
      });
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

it('hides an unconfigured wallet and never requests a binding code or payment action', async () => {
  const view = await setup();
  expect(view.text()).not.toContain('支付宝');
  expect(view.text()).not.toContain(metadata.reason);
  expect(view.text()).not.toContain('已连接');
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(button => button.props.accessibilityLabel === '支付宝待配置'),
  ).toBe(false);
  expect(view.request).toHaveBeenCalledWith(
    '/personal-wallet/alipay',
    'GET',
    undefined,
    expect.anything(),
  );
  expect(view.request.mock.calls.some(call => call[1] !== 'GET')).toBe(false);
  await view.close();
});

it('opens only official documentation and qualification pages', async () => {
  const view = await setup(availableMetadata);
  await view.button('授权范围与帮助');
  await view.button('支付宝官方钱包说明');
  await view.button('支付宝开通要求');
  expect(platform.openUrl).toHaveBeenNthCalledWith(1, metadata.help_url);
  expect(platform.openUrl).toHaveBeenNthCalledWith(
    2,
    metadata.qualification_url,
  );
  expect(view.request.mock.calls.some(call => call[1] !== 'GET')).toBe(false);
  await view.close();
});

it('withholds untrusted links returned by a misconfigured server', async () => {
  const view = await setup({
    ...availableMetadata,
    help_url: 'https://evil.example/wallet',
    qualification_url: 'alipays://pay?amount=1',
  });
  await view.button('授权范围与帮助');
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(button => button.props.accessibilityLabel === '支付宝官方钱包说明'),
  ).toBe(false);
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(button => button.props.accessibilityLabel === '支付宝开通要求'),
  ).toBe(false);
  expect(platform.openUrl).not.toHaveBeenCalled();
  await view.close();
});

it('does not treat an unsupported future connected response as verified binding', async () => {
  const view = await setup({
    ...metadata,
    status: 'connected',
    binding_available: true,
  });
  expect(view.text()).not.toContain('支付宝');
  expect(view.text()).not.toContain('已连接');
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  await view.close();
});

it('refreshes the status with GET and aborts an old response when the server changes', async () => {
  const view = await setup(availableMetadata);
  const pending = deferred<unknown>();
  view.request.mockImplementationOnce(() => pending.promise);
  const foreground = (platform.onForeground as jest.Mock).mock.calls[0][0];
  await act(async () => { foreground(); });
  const signal =
    view.request.mock.calls[view.request.mock.calls.length - 1][3]!;
  const next = jest
    .fn()
    .mockRejectedValue(new Error('新服务器尚未开通钱包入口'));
  await view.switchApi({ request: next } as unknown as ApiClient);
  expect(signal.aborted).toBe(true);
  await act(async () => {
    pending.resolve(metadata);
  });
  expect(view.text()).not.toContain('支付宝');
  expect(view.text()).not.toContain(metadata.reason);
  expect(next.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  await view.close();
});

it('restarts GET safely during StrictMode replay without creating an authorization', async () => {
  const view = await setup(metadata, true);
  expect(view.request.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(view.request.mock.calls[0][3]!.aborted).toBe(true);
  expect(view.text()).not.toContain('支付宝');
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  await view.close();
});

it('uses a fresh wallet status request when the authenticated account changes on the same API instance', async () => {
  const request = jest.fn(async (path: string) =>
    path === '/personal-wallet/alipay' ? metadata : { items: [] },
  );
  const api = { request } as unknown as ApiClient;
  let userId = 'user-a';
  let tree!: ReactTestRenderer;
  const render = () => (
    <AppProvider value={{ api, user: { id: userId } } as AppContextValue}>
      <PersonalMcpConnections />
    </AppProvider>
  );
  await act(async () => {
    tree = create(render());
  });
  expect(
    request.mock.calls.filter(call => call[0] === '/personal-wallet/alipay'),
  ).toHaveLength(1);
  userId = 'user-b';
  await act(async () => {
    tree.update(render());
  });
  expect(
    request.mock.calls.filter(call => call[0] === '/personal-wallet/alipay'),
  ).toHaveLength(2);
  await act(async () => tree.unmount());
});

import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import { personalMcpApi } from '../src/features/personal-mcp/api';
import type {
  PersonalMcpAction,
  PersonalMcpConnection,
} from '../src/features/personal-mcp/types';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

const connection = (
  override: Partial<PersonalMcpConnection> = {},
): PersonalMcpConnection => ({
  id: 'didi',
  name: '滴滴出行',
  description: '连接你自己的出行账号',
  help_url: 'https://mcp.didichuxing.com/api',
  credential_label: '个人 MCP Key',
  transport: 'streamable_http',
  status: 'not_connected',
  tool_count: 0,
  environment: 'production',
  supports_sandbox: true,
  ...override,
});
const action = (
  override: Partial<PersonalMcpAction> = {},
): PersonalMcpAction => ({
  id: 'action-a',
  provider: 'didi',
  provider_name: '滴滴出行',
  tool: 'taxi_create_order',
  arguments: { from_name: '国贸', to_name: '三里屯', product_id: '快车' },
  status: 'pending',
  expires_at: '2099-10-29T12:00:00Z',
  ...override,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function setup(
  item = connection(),
  actions: PersonalMcpAction[] = [],
  strict = false,
) {
  let saved = item;
  const request = jest.fn(
    async (
      path: string,
      method = 'GET',
      _body?: unknown,
      _signal?: AbortSignal,
    ): Promise<unknown> => {
      if (path === '/personal-mcp') return { items: [saved] };
      if (path === '/personal-mcp/actions') return { items: actions };
      if (path.endsWith('/connect')) {
        saved = { ...saved, status: 'connected', tool_count: 2 };
        return saved;
      }
      if (path.endsWith('/test'))
        return { ...saved, status: 'connected', tool_count: 3 };
      if (path.endsWith('/tools'))
        return {
          items: [{ name: 'taxi_estimate', description: '查询车型与预估价格' }],
        };
      if (path.endsWith('/confirm'))
        return {
          ...actions[0],
          status: 'completed',
          result: { order_id: 'order-a' },
        };
      if (path.endsWith('/cancel'))
        return { ...actions[0], status: 'cancelled' };
      if (method === 'DELETE') return { ok: true };
      throw new Error('Unexpected request: ' + path);
    },
  );
  const context = {
    api: { request, baseUrl: 'https://server-a.example' },
    user: { id: 'user-a' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  const render = (value: AppContextValue) => {
    const content = (
      <AppProvider value={value}>
        <PersonalMcpConnections />
      </AppProvider>
    );
    return strict ? <React.StrictMode>{content}</React.StrictMode> : content;
  };
  await act(async () => {
    tree = create(render(context));
  });
  return {
    tree,
    request,
    context,
    async update(value: AppContextValue) {
      await act(async () => {
        tree.update(render(value));
      });
    },
    async button(label: string) {
      const node = tree.root
        .findAllByType(Button)
        .find(
          value =>
            value.props.accessibilityLabel === label ||
            value.props.children === label,
        );
      if (!node) throw new Error('Missing button: ' + label);
      await act(async () => {
        await node.props.onPress();
      });
    },
    async type(value: string) {
      await act(async () => {
        tree.root.findByType(TextInput).props.onChangeText(value);
      });
    },
    text() {
      return tree.root
        .findAllByType(Text)
        .map(value =>
          typeof value.props.children === 'string' ? value.props.children : '',
        )
        .join('\n');
    },
    async unmount() {
      await act(async () => {
        tree.unmount();
      });
    },
  };
}

it('keeps a personal credential transient and shows connected only after actual backend validation', async () => {
  const view = await setup();
  await view.button('连接滴滴出行账号');
  const input = view.tree.root.findByType(TextInput);
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.autoCorrect).toBe(false);
  await view.type(' user-personal-secret ');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  const pending = deferred<unknown>();
  view.request.mockImplementationOnce(() => pending.promise);
  await view.button('校验并连接滴滴出行');
  expect(view.text()).not.toContain('已连接');
  expect(view.request).toHaveBeenLastCalledWith(
    '/personal-mcp/didi/connect',
    'POST',
    { token: 'user-personal-secret', environment: 'production' },
    expect.anything(),
  );
  await act(async () => {
    pending.resolve(connection({ status: 'connected', tool_count: 2 }));
  });
  expect(view.text()).toContain('已连接');
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(view.text()).not.toContain('user-personal-secret');
  await view.unmount();
});

it.each([
  {
    id: 'jianguoyun',
    name: '坚果云',
    credential_label: '应用密码',
    requires_account: true,
    extraLabel: '坚果云账号',
    extraKey: 'account',
  },
  {
    id: 'ima',
    name: 'ima',
    credential_label: 'ima API Key',
    requires_client_id: true,
    extraLabel: 'Client ID',
    extraKey: 'client_id',
  },
])(
  'requires and securely submits both credentials for $id',
  async ({ extraLabel, extraKey, ...provider }) => {
    const view = await setup(
      connection({ ...provider, supports_sandbox: false }),
    );
    const input = (label: string) =>
      view.tree.root
        .findAllByType(TextInput)
        .find(node => node.props.accessibilityLabel === label)!;
    const fill = async (label: string, value: string) => {
      await act(async () => input(label).props.onChangeText(value));
    };
    const submit = () =>
      view.tree.root
        .findAllByType(Button)
        .find(
          node =>
            node.props.accessibilityLabel === '校验并连接' + provider.name,
        )!;
    await view.button('连接' + provider.name + '账号');
    expect(input(provider.credential_label).props.secureTextEntry).toBe(true);
    expect(input(extraLabel).props.value).toBe('');
    await fill(provider.credential_label, ' example-private-token ');
    expect(submit().props.disabled).toBe(true);
    expect(view.request.mock.calls.some(call => call[1] === 'POST')).toBe(
      false,
    );
    await fill(extraLabel, ' example-account ');
    expect(submit().props.disabled).toBe(false);
    await view.button('取消填写');
    await view.button('连接' + provider.name + '账号');
    expect(input(extraLabel).props.value).toBe('');
    expect(input(provider.credential_label).props.value).toBe('');
    await fill(provider.credential_label, ' example-private-token ');
    await fill(extraLabel, ' example-account ');
    await view.button('校验并连接' + provider.name);
    expect(view.request).toHaveBeenLastCalledWith(
      '/personal-mcp/' + provider.id + '/connect',
      'POST',
      {
        token: 'example-private-token',
        environment: 'production',
        [extraKey]: 'example-account',
      },
      expect.anything(),
    );
    expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
    await view.unmount();
  },
);

it('retains the current failed draft for correction and clears it when cancelled', async () => {
  const view = await setup();
  await view.button('连接滴滴出行账号');
  await view.type('bad-key');
  view.request.mockRejectedValueOnce(new Error('凭证校验失败'));
  await view.button('校验并连接滴滴出行');
  expect(view.text()).toContain('凭证校验失败');
  expect(view.text()).not.toContain('已连接');
  expect(view.tree.root.findByType(TextInput).props.value).toBe('bad-key');
  await view.button('取消填写');
  await view.button('连接滴滴出行账号');
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  await view.unmount();
});

it('requires a Memos instance and keeps its personal token transient until actual validation', async () => {
  const view = await setup(
    connection({
      id: 'memos',
      name: 'Memos',
      requires_server_url: true,
      supports_sandbox: false,
      credential_label: 'Memos 个人 Token',
    }),
  );
  await view.button('连接Memos账号');
  const inputs = () => view.tree.root.findAllByType(TextInput);
  expect(inputs()).toHaveLength(2);
  await act(async () => {
    inputs()
      .find(node => node.props.secureTextEntry)!
      .props.onChangeText(' memos_pat_test-only ');
  });
  const save = () =>
    view.tree.root
      .findAllByType(Button)
      .find(node => node.props.accessibilityLabel === '校验并连接Memos')!;
  expect(save().props.disabled).toBe(true);
  await act(async () => {
    inputs()
      .find(node => node.props.keyboardType === 'url')!
      .props.onChangeText(' https://notes.example.com ');
  });
  expect(save().props.disabled).toBe(false);
  await view.button('校验并连接Memos');
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/memos/connect',
    'POST',
    {
      token: 'memos_pat_test-only',
      environment: 'production',
      server_url: 'https://notes.example.com',
    },
    expect.anything(),
  );
  expect(inputs()).toHaveLength(0);
  expect(view.text()).toContain('Memos已通过实际连接校验');
  expect(view.text()).not.toContain('memos_pat_test-only');
  await view.unmount();
});

it('retains a rejected Memos address for correction, then clears the token and draft on cancel', async () => {
  const view = await setup(
    connection({
      id: 'memos',
      name: 'Memos',
      requires_server_url: true,
      supports_sandbox: false,
    }),
  );
  await view.button('连接Memos账号');
  const inputs = () => view.tree.root.findAllByType(TextInput);
  await act(async () => {
    inputs()
      .find(node => node.props.secureTextEntry)!
      .props.onChangeText('bad-personal-token');
    inputs()
      .find(node => node.props.keyboardType === 'url')!
      .props.onChangeText('https://wrong.example.com');
  });
  view.request.mockRejectedValueOnce(new Error('Memos 身份校验未通过'));
  await view.button('校验并连接Memos');
  expect(view.text()).toContain('Memos 身份校验未通过');
  expect(
    inputs().find(node => node.props.keyboardType === 'url')!.props.value,
  ).toBe('https://wrong.example.com');
  expect(inputs().find(node => node.props.secureTextEntry)!.props.value).toBe(
    'bad-personal-token',
  );
  await view.button('取消填写');
  await view.button('连接Memos账号');
  expect(inputs().every(node => node.props.value === '')).toBe(true);
  await view.unmount();
});

it('prefills only the saved Memos instance address while Notion needs just its own token', async () => {
  const memos = await setup(
    connection({
      id: 'memos',
      name: 'Memos',
      requires_server_url: true,
      server_url: 'https://mine.example.com/',
      status: 'connected',
      supports_sandbox: false,
    }),
  );
  await memos.button('更换凭证');
  expect(
    memos.tree.root
      .findAllByType(TextInput)
      .find(node => node.props.keyboardType === 'url')!.props.value,
  ).toBe('https://mine.example.com/');
  expect(
    memos.tree.root
      .findAllByType(TextInput)
      .find(node => node.props.secureTextEntry)!.props.value,
  ).toBe('');
  await memos.unmount();
  const notion = await setup(
    connection({
      id: 'notion',
      name: 'Notion',
      credential_label: 'Notion Token',
      supports_sandbox: false,
    }),
  );
  await notion.button('连接Notion账号');
  expect(notion.tree.root.findAllByType(TextInput)).toHaveLength(1);
  await notion.type('ntn_personal-test-only');
  await notion.button('校验并连接Notion');
  expect(notion.request).toHaveBeenCalledWith(
    '/personal-mcp/notion/connect',
    'POST',
    { token: 'ntn_personal-test-only', environment: 'production' },
    expect.anything(),
  );
  await notion.button('校验Notion连接');
  expect(notion.request).toHaveBeenLastCalledWith(
    '/personal-mcp/notion/test',
    'POST',
    {},
    expect.anything(),
  );
  await notion.unmount();
});

it('supports explicit sandbox choice and never sends a credential during saved-connection tests', async () => {
  const view = await setup();
  await view.button('连接滴滴出行账号');
  await view.type('my-key');
  await act(async () => {
    view.tree.root
      .findAll(
        value =>
          value.props.accessibilityRole === 'radio' &&
          value.props.accessibilityLabel === '模拟测试环境',
      )[0]
      .props.onPress();
  });
  expect(view.text()).toContain('仅模拟业务，不会产生真实叫车订单。');
  await view.button('校验并连接滴滴出行');
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/didi/connect',
    'POST',
    { token: 'my-key', environment: 'sandbox' },
    expect.anything(),
  );
  await view.button('校验滴滴出行连接');
  expect(view.request).toHaveBeenLastCalledWith(
    '/personal-mcp/didi/test',
    'POST',
    {},
    expect.anything(),
  );
  expect(view.text()).toContain('校验成功');
  await view.unmount();
});

it('displays tools returned for the current account without inventing capabilities', async () => {
  const view = await setup(connection({ status: 'connected', tool_count: 1 }));
  await view.button('查看滴滴出行工具');
  expect(view.text()).toContain('taxi_estimate');
  expect(view.text()).toContain('查询车型与预估价格');
  expect(view.request).toHaveBeenLastCalledWith(
    '/personal-mcp/didi/tools',
    'GET',
    undefined,
    expect.anything(),
  );
  await view.unmount();
});

it('requires an explicit disconnect confirmation and makes one deletion even on duplicate taps', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup(connection({ status: 'connected' }));
  await view.button('断开滴滴出行连接');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'DELETE'),
  ).toHaveLength(0);
  const destructive = alert.mock.calls[0][2]![1];
  const pending = deferred<unknown>();
  view.request.mockImplementationOnce(() => pending.promise);
  await act(async () => {
    destructive.onPress!();
    destructive.onPress!();
  });
  expect(
    view.request.mock.calls.filter(call => call[1] === 'DELETE'),
  ).toHaveLength(1);
  await act(async () => {
    pending.resolve({ ok: true });
  });
  expect(view.text()).toContain('已断开滴滴出行');
  await view.unmount();
});

it('renders complete immutable action arguments and executes only after the user confirms', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup(connection({ status: 'connected' }), [action()]);
  expect(view.text()).toContain('"from_name": "国贸"');
  expect(view.text()).toContain('"to_name": "三里屯"');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  await view.button('确认执行滴滴出行taxi_create_order');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(view.request).toHaveBeenCalledWith(
    '/personal-mcp/actions/action-a/confirm',
    'POST',
    {},
    expect.anything(),
  );
  expect(view.text()).toContain('order-a');
  expect(
    view.tree.root
      .findAllByType(Button)
      .filter(value => value.props.children === '确认执行'),
  ).toHaveLength(0);
  await view.unmount();
});

it('removes retry controls when a confirmation has an uncertain network outcome', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup(connection({ status: 'connected' }), [action()]);
  await view.button('确认执行滴滴出行taxi_create_order');
  view.request.mockRejectedValueOnce(new Error('网络已断开'));
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(view.text()).toContain('结果不确定');
  expect(
    view.tree.root
      .findAllByType(Button)
      .filter(value => value.props.children === '确认执行'),
  ).toHaveLength(0);
  expect(
    view.request.mock.calls.filter(call => call[0].endsWith('/confirm')),
  ).toHaveLength(1);
  await view.unmount();
});

it('clears the token immediately on API or account change and ignores old in-flight responses', async () => {
  const view = await setup();
  await view.button('连接滴滴出行账号');
  await view.type('belongs-to-old-user');
  const pending = deferred<unknown>();
  view.request.mockImplementationOnce(() => pending.promise);
  await view.button('校验并连接滴滴出行');
  const oldSignal = view.request.mock.calls.find(call =>
    call[0].endsWith('/connect'),
  )![3];
  const newRequest = jest.fn().mockResolvedValue({ items: [] });
  await view.update({
    ...view.context,
    api: {
      request: newRequest,
      baseUrl: 'https://server-b.example',
    } as unknown as ApiClient,
    user: { id: 'user-b' } as AppContextValue['user'],
  });
  expect(oldSignal!.aborted).toBe(true);
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  await act(async () => {
    pending.resolve(connection({ status: 'connected' }));
  });
  expect(view.text()).not.toContain('已连接');
  expect(view.text()).not.toContain('belongs-to-old-user');
  expect(newRequest.mock.calls.some(call => call[1] === 'POST')).toBe(false);
  await view.unmount();
});

it('shows the unsupported reason without offering a misleading connect button', async () => {
  const view = await setup(
    connection({
      status: 'not_configured',
      unavailable_reason: '厂商暂未开放此授权方式',
    }),
  );
  expect(view.text()).toContain('厂商暂未开放此授权方式');
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(value => value.props.accessibilityLabel === '连接滴滴出行账号'),
  ).toBe(false);
  await view.unmount();
});

it('blocks confirmations with expired or incompletely displayable arguments', async () => {
  const view = await setup(connection(), [
    action({ expires_at: '2000-01-01T00:00:00Z' }),
    action({ id: 'long-action', arguments: { text: 'x'.repeat(24001) } }),
  ]);
  const buttons = view.tree.root
    .findAllByType(Button)
    .filter(value => value.props.children === '确认执行');
  expect(buttons).toHaveLength(2);
  expect(buttons.every(value => value.props.disabled)).toBe(true);
  expect(view.text()).toContain('确认已过期');
  expect(view.text()).toContain('操作参数过长');
  await view.unmount();
});

it('only opens the official HTTPS help URL and can cancel pending operations independently', async () => {
  const view = await setup(connection(), [action()]);
  await view.button('滴滴出行官方连接说明');
  expect(platform.openUrl).toHaveBeenCalledWith(
    'https://mcp.didichuxing.com/api',
  );
  await view.button('取消操作action-a');
  expect(view.request).toHaveBeenLastCalledWith(
    '/personal-mcp/actions/action-a/cancel',
    'POST',
    {},
    expect.anything(),
  );
  expect(view.text()).toContain('已取消');
  await view.unmount();
});

it('encodes resource identifiers and applies the live abort signal to every request', async () => {
  const request = jest.fn().mockResolvedValue({ ok: true });
  const controller = new AbortController();
  const client = personalMcpApi(
    { request } as unknown as ApiClient,
    () => controller.signal,
  );
  await client.disconnect('provider/escape');
  expect(request).toHaveBeenCalledWith(
    '/personal-mcp/provider%2Fescape',
    'DELETE',
    undefined,
    controller.signal,
  );
  await client.confirm('action/escape');
  expect(request).toHaveBeenLastCalledWith(
    '/personal-mcp/actions/action%2Fescape/confirm',
    'POST',
    {},
    controller.signal,
  );
});

it('distinguishes a known provider failure from completion and displays its returned detail', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup(connection({ status: 'connected' }), [action()]);
  await view.button('确认执行滴滴出行taxi_create_order');
  view.request.mockResolvedValueOnce(
    action({
      status: 'failed',
      result: { isError: true, content: [{ text: '订单创建失败' }] },
    }),
  );
  await act(async () => {
    alert.mock.calls[0][2]![1].onPress!();
  });
  expect(view.text()).toContain('操作未成功');
  expect(view.text()).toContain('订单创建失败');
  expect(view.text()).not.toContain('已完成');
  expect(view.text()).not.toContain('已过期');
  await view.unmount();
});

it('reports the actual action state when cancellation races with execution', async () => {
  const view = await setup(connection(), [action()]);
  view.request.mockResolvedValueOnce(action({ status: 'executing' }));
  await view.button('取消操作action-a');
  expect(view.text()).toContain('已经开始执行');
  expect(view.text()).not.toContain('已取消');
  await view.unmount();
});

it('reads back authoritative connection state immediately after a failed saved-credential test', async () => {
  const view = await setup(connection({ status: 'connected' }));
  view.request.mockRejectedValueOnce(new Error('凭证已过期'));
  view.request.mockResolvedValueOnce({
    items: [connection({ status: 'needs_reconnect' })],
  });
  await view.button('校验滴滴出行连接');
  expect(view.text()).toContain('需要重新连接');
  expect(view.text()).toContain('凭证已过期');
  expect(view.text()).not.toContain('已连接');
  await view.unmount();
});

it('restarts aborted initial reads during StrictMode effect replay', async () => {
  const view = await setup(connection(), [], true);
  const reads = view.request.mock.calls.filter(
    call => call[0] === '/personal-mcp',
  );
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads[0][3]!.aborted).toBe(true);
  expect(reads[reads.length - 1][3]!.aborted).toBe(false);
  expect(view.text()).toContain('滴滴出行');
  expect(view.text()).not.toContain('正在刷新');
  await view.unmount();
});

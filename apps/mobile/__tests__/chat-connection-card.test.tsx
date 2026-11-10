import React from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatConnectionCard } from '../src/features/integrations/ChatConnectionCard';
import { chatConnectionIntent, matchingConnections } from '../src/features/integrations/chatConnectionIntent';
import { connectionRows, filterConnectionRows, type ConnectionSnapshot } from '../src/features/integrations/connectionsCatalog';
import type { Integration } from '../src/features/integrations/types';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  ...jest.requireActual('../src/platform/ports'),
  platform: {
    ...jest.requireActual('../src/platform/ports').platform,
    onForeground: jest.fn(() => jest.fn()),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

const integration = (id: string, name: string, mode: Integration['mode']): Integration => ({
  id, name, mode, detail: name + '说明', category: '办公', status: 'not_connected',
});
const personal = (id: string, name: string): PersonalMcpConnection => ({
  id, name, description: '访问授权范围内的内容', credential_label: '个人访问令牌',
  help_url: 'https://example.com', status: 'not_connected', environment: 'production',
  tool_count: 0, transport: 'streamable_http',
});

test('uses named services from both catalogs and preserves public GitHub queries', () => {
  expect(chatConnectionIntent('对了，你能不能连接github？')).toBe('connect');
  expect(chatConnectionIntent('帮我读 GitHub 私有仓库的 README')).toBe('private-query');
  expect(chatConnectionIntent('看看 https://github.com/example/public 的 README')).toBeNull();
  expect(chatConnectionIntent('不用连接 GitHub，查公开项目')).toBeNull();
  expect(chatConnectionIntent('1+2等于多少？')).toBeNull();

  const sources = [
    integration('qq', 'QQ', 'import'), integration('qq_mail', 'QQ 邮箱', 'mail'),
    integration('didi', '滴滴出行', 'import'), integration('new', '新上线的服务', 'oauth'),
  ];
  const mcp = [personal('didi', '滴滴出行')];
  expect(matchingConnections('请连接 QQ邮箱、滴滴和新上线的服务', 'connect', mcp, sources)
    .map(item => [item.id, item.kind])).toEqual([
      ['didi', 'mcp'], ['qq_mail', 'cloud'], ['new', 'cloud'],
    ]);
  expect(matchingConnections('可以连接小米运动健康吗', 'connect', [], []))
    .toEqual([expect.objectContaining({ id: 'xiaomi', kind: 'health' })]);
});

test('GitHub stays discoverable if the current server has not added it', () => {
  const snapshot = { mcp: [], native: null, integrations: [], health: null, systemHealth: null, photoEnabled: null } as ConnectionSnapshot;
  expect(filterConnectionRows(connectionRows(snapshot, []), 'cloud', 'github', false)).toEqual([
    expect.objectContaining({ name: 'GitHub', status: '当前服务器尚未提供', added: false, usable: false }),
  ]);
});

async function mountCard(message: string, request: jest.Mock) {
  const onContinue = jest.fn();
  const api = { request, baseUrl: 'https://tada.example' } as unknown as ApiClient;
  const value = {
    api, user: { id: 'reader' }, preferences: { serverUrl: api.baseUrl }, invalidate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={value}>
        <ChatConnectionCard api={api} message={message} intent={chatConnectionIntent(message)!}
          onContinue={onContinue} onClose={() => {}} />
      </AppProvider>,
    );
  });
  const press = (label: string) => tree.root.findAllByType(Button)
    .find(node => node.props.accessibilityLabel === label || node.props.children === label)!.props.onPress();
  return { tree, press, onContinue };
}

test('validates Memos credentials and its instance address inside the card', async () => {
  const item = { ...personal('memos', 'Memos'), requires_server_url: true };
  const request = jest.fn(async (path: string) => {
    if (path === '/personal-mcp') return { items: [item] };
    if (path === '/integrations') return { items: [] };
    return { ...item, status: 'connected' };
  });
  const { tree, press, onContinue } = await mountCard('妥啦能连接 Memos 吗？', request);
  await act(async () => { press('连接Memos账号'); });
  const inputs = tree.root.findAllByType(TextInput);
  expect(inputs.find(field => field.props.accessibilityLabel === '个人访问令牌')!.props.secureTextEntry).toBe(true);
  await act(async () => {
    inputs.find(field => field.props.accessibilityLabel === 'Memos 服务地址')!.props.onChangeText('https://notes.example.com');
    inputs.find(field => field.props.accessibilityLabel === '个人访问令牌')!.props.onChangeText('synthetic-test-token');
  });
  await act(async () => { press('校验并连接Memos'); });
  expect(request).toHaveBeenLastCalledWith('/personal-mcp/memos/connect', 'POST',
    { token: 'synthetic-test-token', environment: 'production', server_url: 'https://notes.example.com' }, expect.anything());
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => { tree.unmount(); });
});

test('opens official web authorization and refreshes the card on return', async () => {
  const wps = integration('wps', 'WPS / 金山文档', 'oauth');
  let connected = false;
  const authorizationUrl = 'https://account.wps.cn/oauth/authorize?state=test';
  const request = jest.fn(async (path: string) => {
    if (path === '/integrations/wps/authorize') return { authorization_url: authorizationUrl };
    if (path === '/personal-mcp') return { items: [] };
    return { items: [{ ...wps, status: connected ? 'connected' : 'not_connected' }] };
  });
  const { tree, press } = await mountCard('我想连一下金山文档', request);
  await act(async () => { press('前往账号授权'); });
  expect(platform.openUrl).toHaveBeenCalledWith(authorizationUrl);
  connected = true;
  const foreground = (platform.onForeground as jest.Mock).mock.calls.at(-1)![0];
  await act(async () => { foreground(); });
  expect(tree.root.findAllByType(Button).some(node => node.props.children === '完成')).toBe(true);
  await act(async () => { tree.unmount(); });
});

test('continues a private GitHub query only after validation succeeds', async () => {
  const item = personal('github', 'GitHub');
  let attempts = 0;
  const request = jest.fn(async (path: string) => {
    if (path === '/personal-mcp') return { items: [item] };
    if (path === '/integrations') return { items: [] };
    if (++attempts === 1) throw new Error('bad credential');
    return { ...item, status: 'connected' };
  });
  const { tree, press, onContinue } = await mountCard('读 GitHub 私有仓库', request);
  await act(async () => { press('连接GitHub账号'); });
  await act(async () => { tree.root.findByType(TextInput).props.onChangeText('synthetic-test-token'); });
  await act(async () => { press('校验并连接GitHub'); });
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => { press('校验并连接GitHub'); });
  expect(onContinue).toHaveBeenCalledTimes(1);
  await act(async () => { tree.unmount(); });
});

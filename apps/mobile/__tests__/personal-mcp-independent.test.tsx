import React from 'react';
import { Alert, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import type { PersonalMcpAction, PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {
  onForeground: jest.fn(() => jest.fn()), openUrl: jest.fn().mockResolvedValue(undefined),
} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

const connection: PersonalMcpConnection = {
  id: 'didi', name: '滴滴出行', description: '个人连接测试', help_url: 'https://mcp.didichuxing.com/api',
  credential_label: '个人 MCP Key', transport: 'streamable_http', status: 'connected', tool_count: 2,
  environment: 'sandbox', supports_sandbox: true,
};
const pending: PersonalMcpAction = { id: 'pending-independent', provider: 'didi', provider_name: '滴滴出行',
  tool: 'taxi_create_order', arguments: { from_name: '起点', to_name: '终点' }, status: 'pending',
  expires_at: '2099-01-01T00:00:00Z' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

async function setup(initialActions: PersonalMcpAction[] = [pending]) {
  let saved = connection;
  let actions = initialActions;
  const polls: ReturnType<typeof deferred<unknown>>[] = [];
  let deferPoll = false;
  const request = jest.fn(async (path: string, method = 'GET') => {
    if (method === 'GET' && deferPoll) { const value = deferred<unknown>(); polls.push(value); return value.promise; }
    if (path === '/personal-mcp') return { items: [saved] };
    if (path === '/personal-mcp/actions') return { items: actions };
    if (method === 'DELETE') { saved = { ...saved, status: 'not_connected', tool_count: 0 }; actions = []; return { ok: true }; }
    if (path.endsWith('/confirm')) { actions = actions.map(item => ({ ...item, status: 'completed' })); return actions[0]; }
    throw new Error('Unexpected request: ' + path);
  });
  let context = { api: { request }, user: { id: 'independent-user-a' } } as unknown as AppContextValue;
  const render = () => <AppProvider value={context}><PersonalMcpConnections /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(render()); });
  return {
    tree, request, polls,
    setDefer(value: boolean) { deferPoll = value; },
    async button(label: string) { const node = tree.root.findAllByType(Button).find(item => item.props.accessibilityLabel === label || item.props.children === label); if (!node) throw new Error('Missing button: ' + label); await act(async () => { await node.props.onPress(); }); },
    async switchUser() { context = { ...context, user: { id: 'independent-user-b' } as AppContextValue['user'] }; await act(async () => { tree.update(render()); }); },
    text() { return tree.root.findAllByType(Text).map(item => typeof item.props.children === 'string' ? item.props.children : '').join('\n'); },
    async close() { await act(async () => { tree.unmount(); }); },
  };
}

it('late polling cannot resurrect a disconnected account or permanently stop later refreshes', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup();
  view.setDefer(true);
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(view.polls).toHaveLength(2);
  await view.button('断开滴滴出行连接');
  await act(async () => { alert.mock.calls[0][2]![1].onPress!(); });
  expect(view.text()).toContain('未连接');
  await act(async () => { view.polls[0].resolve({ items: [connection] }); view.polls[1].resolve({ items: [pending] }); });
  expect(view.text()).toContain('未连接');
  expect(view.text()).not.toContain('等待你确认');
  const previousCalls = view.request.mock.calls.filter(call => call[0] === '/personal-mcp').length;
  view.setDefer(false);
  await act(async () => { jest.advanceTimersByTime(15000); });
  expect(view.request.mock.calls.filter(call => call[0] === '/personal-mcp').length).toBe(previousCalls + 1);
  await view.close();
});

it('a confirmation dialog held across account change cannot authorize the new account', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup();
  await view.button('确认执行滴滴出行taxi_create_order');
  const oldConfirm = alert.mock.calls[0][2]![1].onPress!;
  await view.switchUser();
  await act(async () => { oldConfirm(); });
  expect(view.request.mock.calls.filter(call => call[0].endsWith('/confirm'))).toHaveLength(0);
  await view.close();
});

it('an explicit provider failure is displayed as failed with its result and no retry confirmation', async () => {
  const view = await setup([{ ...pending, status: 'failed', result: { isError: true, content: [{ type: 'text', text: '没有足够积分' }] } }]);
  expect(view.text()).toContain('操作未成功');
  expect(view.text()).toContain('没有足够积分');
  expect(view.text()).not.toContain('已完成');
  expect(view.tree.root.findAllByType(Button).filter(item => item.props.children === '确认执行')).toHaveLength(0);
  await view.close();
});

it('an action expiring while its native dialog is open is not submitted', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const view = await setup([{ ...pending, expires_at: new Date(Date.now() + 2000).toISOString() }]);
  await view.button('确认执行滴滴出行taxi_create_order');
  const confirm = alert.mock.calls[0][2]![1].onPress!;
  jest.setSystemTime(Date.now() + 3000);
  await act(async () => { confirm(); });
  expect(view.request.mock.calls.filter(call => call[0].endsWith('/confirm'))).toHaveLength(0);
  expect(view.text()).toContain('已过期');
  await view.close();
});

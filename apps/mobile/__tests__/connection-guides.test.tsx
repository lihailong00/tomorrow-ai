import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { MailConnectionForm } from '../src/features/integrations/MailConnection';
import { connectionGuide } from '../src/features/integrations/connectionGuides';
import type { Integration } from '../src/features/integrations/types';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({ platform: {
  openUrl: jest.fn().mockResolvedValue(undefined), onForeground: jest.fn(() => jest.fn()),
} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.clearAllMocks(); });

async function mount(element: React.ReactElement, request: jest.Mock) {
  const context = { api: { request, baseUrl: 'https://my-server.example.test' }, user: { id: 'guide-owner' } } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}>{element}</AppProvider>); });
  return { tree, async close() { await act(async () => { tree.unmount(); }); } };
}
function press(tree: ReactTestRenderer, label: string) {
  const button = tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
  if (!button) throw new Error('Missing guide control: ' + label);
  return act(async () => { button.props.onPress(); });
}

it.each([
  ['qq_mail', 'QQ 邮箱', 'https://help.mail.qq.com/'],
  ['netease163', '163 邮箱', 'https://help.mail.126.com/'],
  ['netease126', '126 邮箱', 'https://help.mail.126.com/'],
])('opens the %s official IMAP guide without submitting credentials', async (id, name, origin) => {
  const request = jest.fn();
  const item = { id, name, category: '邮件', mode: 'mail', status: 'not_connected', detail: '连接邮箱' } as Integration;
  const view = await mount(<MailConnectionForm item={item} onConnected={jest.fn()} />, request);
  const guide = connectionGuide(id)!;
  expect(guide.url.startsWith(origin)).toBe(true);
  const link = view.tree.root.findAll(node => node.props.accessibilityRole === 'link' && typeof node.props.onPress === 'function')[0];
  await act(async () => { link.props.onPress(); });
  expect(platform.openUrl).toHaveBeenCalledWith(guide.url);
  expect(request).not.toHaveBeenCalled();
  const held = link.props.onPress;
  await view.close();
  await act(async () => { held(); });
  expect(platform.openUrl).toHaveBeenCalledTimes(1);
});

it.each([
  ['tencent_docs', '腾讯文档', 'https://docs.qq.com/'],
  ['tencent_meeting', '腾讯会议', 'https://meeting.tencent.com/'],
  ['didi', '滴滴出行', 'https://mcp.didichuxing.com/'],
  ['mcdonalds', '麦当劳', 'https://open.mcd.cn/'],
  ['notion', 'Notion', 'https://www.notion.com/'],
  ['memos', 'Memos', 'https://usememos.com/'],
])('renders the %s provider guide and opens it without a connection mutation', async (id, name, origin) => {
  const item: PersonalMcpConnection = { id, name, description: '获取本人的授权', help_url: 'https://provider.example.test/help',
    credential_label: '个人 Token', transport: 'streamable_http', status: 'not_connected', tool_count: 0, environment: 'production' };
  const request = jest.fn(async (path: string) => path === '/personal-mcp' ? { items: [item] } : { items: [] });
  const view = await mount(<PersonalMcpConnections providerId={id} />, request);
  await press(view.tree, '连接' + name + '账号');
  const guide = connectionGuide(id)!;
  expect(guide.url.startsWith(origin)).toBe(true);
  expect(JSON.stringify(view.tree.toJSON())).toContain(guide.linkText);
  await press(view.tree, name + '授权获取教程');
  expect(platform.openUrl).toHaveBeenCalledWith(guide.url);
  expect(request.mock.calls.every(call => call[0] === '/personal-mcp' || call[0] === '/personal-mcp/actions')).toBe(true);
  await view.close();
});

it('has no implicit guide for arbitrary or inherited object keys', () => {
  expect(connectionGuide('unknown-service')).toBeUndefined();
  expect(connectionGuide('__proto__')).toBeUndefined();
  expect(connectionGuide('constructor')).toBeUndefined();
});

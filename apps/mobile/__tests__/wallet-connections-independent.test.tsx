import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PersonalMcpConnections } from '../src/features/personal-mcp/PersonalMcpConnections';
import { McpConnectionRow } from '../src/features/personal-mcp/McpConnectionCard';
import type { ApiClient } from '../src/api/client';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';
import { Button } from '../src/ui/components';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({ platform: { onForeground: jest.fn(() => jest.fn()), openUrl: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
const wallet = { id:'alipay', name:'支付宝', kind:'wallet', status:'not_configured', description:'个人钱包入口', reason:'尚未获邀开通',
  help_url:'https://aipay.alipay.com/wallet-guide', qualification_url:'https://aipay.alipay.com/products/mobile-agent-pay', binding_available:false, payment_available:false };
const baidu: PersonalMcpConnection = { id:'baidu_netdisk', name:'百度网盘（个人体验）', description:'限时个人体验', help_url:'https://github.com/baidu-netdisk/mcp',
  credential_label:'个人体验 Access Token', transport:'sse', status:'not_connected', tool_count:0, environment:'experience' };
const yinxiang: PersonalMcpConnection = { id:'yinxiang', name:'印象笔记', description:'个人会员授权', help_url:'https://app.yinxiang.com/third/skills-oauth/',
  credential_label:'个人 AuthToken', transport:'official_skill', status:'not_connected', tool_count:0, environment:'production' };

async function setup(walletResult: unknown = wallet) {
  let currentBaidu = baidu;
  let context: AppContextValue;
  const request = jest.fn(async (path:string, method='GET') => {
    if (path === '/personal-wallet/alipay') { if (walletResult instanceof Error) throw walletResult; return walletResult; }
    if (path === '/personal-mcp') return { items:[currentBaidu,yinxiang] };
    if (path === '/personal-mcp/actions') return { items:[] };
    throw new Error('Unexpected request:' + method + ' ' + path);
  });
  context = { api:{request} as unknown as ApiClient, user:{id:'wallet-independent-a'} } as AppContextValue;
  const render = () => <AppProvider value={context}><PersonalMcpConnections /></AppProvider>;
  let tree!: ReactTestRenderer;
  await act(async()=>{tree=create(render());});
  return {tree, request,
    setBaidu(item:PersonalMcpConnection){currentBaidu=item;},
    text(){return tree.root.findAllByType(Text).flatMap(item=>[item.props.children].flat()).filter(item=>typeof item==='string').join('\n');},
    async button(label:string){const button=tree.root.findAllByType(Button).find(item=>item.props.accessibilityLabel===label||item.props.children===label); if(!button)throw new Error('Missingbutton:'+label); await act(async()=>{button.props.onPress();});},
    async switchAccount(){context={...context,user:{id:'wallet-independent-b'} as AppContextValue['user']}; await act(async()=>{tree.update(render());});},
    async close(){await act(async()=>{tree.unmount();});},
  };
}

it('an old server wallet404 is not advertised while independent note connections remain usable', async()=>{
  const view=await setup(new Error('接口不存在（404）'));
  expect(view.text()).not.toContain('支付宝');
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(view.tree.root.findAllByType(Button).some(item=>item.props.accessibilityLabel==='连接印象笔记账号')).toBe(true);
  expect(view.request.mock.calls.every(call=>call[1]===undefined||call[1]==='GET')).toBe(true);
  await view.close();
});

it('administrator disabling Baidu closes an open credential form and clears its draft', async()=>{
  const view=await setup();
  await view.button('连接百度网盘（个人体验）账号');
  await act(async()=>{view.tree.root.findByType(TextInput).props.onChangeText('fixture-personal-baidu-token');});
  view.setBaidu({...baidu,status:'not_configured',unavailable_reason:'管理员已关闭个人体验'});
  await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(view.text()).not.toContain('百度网盘');
  expect(view.tree.root.findAllByType(TextInput)).toHaveLength(0);
  expect(view.tree.root.findAllByType(Button).some(item=>item.props.accessibilityLabel==='校验并连接百度网盘（个人体验）')).toBe(false);
  expect(view.request.mock.calls.some(call=>call[1]==='POST')).toBe(false);
  view.setBaidu(baidu);
  await act(async()=>{jest.advanceTimersByTime(15000);});
  await view.button('连接百度网盘（个人体验）账号');
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  await view.close();
});

it('a held wallet help callback cannot act after the authenticated owner changes', async()=>{
  const view=await setup({...wallet,status:'needs_reconnect',binding_available:true,payment_available:true,
    protocol_version:1,runtime_mode:'dedicated_single_user'});
  await act(async () => {
    view.tree.root.findAllByType(McpConnectionRow).find(item => item.props.label === '授权范围与帮助')!.props.onPress();
  });
  const oldButton=view.tree.root.findAllByType(Button).find(item=>item.props.accessibilityLabel==='支付宝官方钱包说明')!;
  const oldOnPress=oldButton.props.onPress;
  await view.switchAccount();
  await act(async()=>{oldOnPress();});
  expect(platform.openUrl).not.toHaveBeenCalled();
  expect(view.request.mock.calls.every(call=>call[1]===undefined||call[1]==='GET')).toBe(true);
  await view.close();
});

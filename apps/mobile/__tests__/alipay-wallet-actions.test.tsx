import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ApiClient } from '../src/api/client';
import { AlipayWalletActions } from '../src/features/personal-mcp/AlipayWalletActions';
import { alipayOfficialUrl, parseWalletTransactions, unavailableWallet, type WalletConnectionStatus, type WalletPayment } from '../src/features/personal-mcp/walletModel';
import { buildHubEntries, splitHubEntries } from '../src/features/capabilities/model';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: { onForeground: jest.fn(() => jest.fn()), openUrl: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
const metadata: WalletConnectionStatus = { ...unavailableWallet, status: 'connected', binding_available: true, payment_available: true, protocol_version: 1, runtime_mode: 'dedicated_single_user' };
const payment: WalletPayment = { id: 'fixture-payment', title: '测试咖啡', merchant: '测试商家', amount: '12.30', currency: 'CNY', status: 'pending', created_at: '2026-11-03T01:00:00Z', expires_at: '2026-11-03T01:10:00Z', confirmation_token: 'a'.repeat(43) };
const ledger = (items: WalletPayment[]) => ({ items, has_more: false, next_offset: null, summary: { paid_count: 0, paid_amount: '0.00', currency: 'CNY', totals_complete: true }, history_scope: 'tada_transactions_only' });
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => jest.clearAllMocks());
async function setup(status = metadata, initial: WalletPayment[] = [payment]) {
  let items = initial;
  let reply: (path: string) => Promise<unknown> = async path => path.endsWith('/authorize')
    ? { ...status, status: 'awaiting_authorization', authorization_url: 'https://render.alipay.com/wallet?fixture=auth' }
    : status;
  const request = jest.fn(async (path: string, method = 'GET', _body?: unknown, _signal?: AbortSignal) => {
    if (method === 'GET' && path.includes('/transactions?')) return ledger(items);
    if (path.endsWith('/confirm')) { items = [{ ...payment, status: 'unknown_outcome', confirmation_token: undefined }]; return items[0]; }
    if (path.endsWith('/refresh')) return items[0];
    return reply(path);
  });
  let api = { request } as unknown as ApiClient;
  let tree!: ReactTestRenderer;
  const onStatus = jest.fn();
  const render = () => <AlipayWalletActions api={api} metadata={status} onStatus={onStatus} />;
  await act(async () => { tree = create(render()); });
  return { tree, request, onStatus,
    text: () => tree.root.findAllByType(Text).flatMap(node => [node.props.children].flat()).filter(x => typeof x === 'string').join('\n'),
    setReply: (fn: typeof reply) => { reply = fn; },
    async press(label: string, twice = false) {
      const button = tree.root.findAllByType(Button).find(node => node.props.accessibilityLabel === label);
      if (!button) throw new Error('Missing button: ' + label);
      await act(async () => { button.props.onPress(); if (twice) button.props.onPress(); });
    },
    async switchApi(next: ApiClient) { api = next; await act(async () => tree.update(render())); },
    async close() { await act(async () => tree.unmount()); },
  };
}
it('does not pay on opening or selecting a record; double confirmation sends once and recovery only queries', async () => {
  const view = await setup();
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  await view.press('核对付款 fixture-payment');
  expect(view.request.mock.calls.every(call => call[1] === 'GET')).toBe(true);
  await view.press('确认提交支付宝付款', true);
  expect(view.request.mock.calls.filter(call => call[0].endsWith('/confirm'))).toHaveLength(1);
  expect(view.request.mock.calls.find(call => call[0].endsWith('/confirm'))?.[2]).toEqual({ confirmation_token: payment.confirmation_token });
  expect(view.text()).toContain('结果待核实');
  await view.press('查询付款 fixture-payment');
  expect(view.request.mock.calls.filter(call => call[0].endsWith('/confirm'))).toHaveLength(1);
  expect(view.request.mock.calls.filter(call => call[0].endsWith('/refresh'))).toHaveLength(1);
  await view.close();
});
it('clears binding codes on submit and opens only the real official authorization URL on a separate tap', async () => {
  const view = await setup({ ...metadata, status: 'awaiting_authorization' }, []);
  await view.press('连接本人支付宝');
  expect(platform.openUrl).not.toHaveBeenCalled();
  await view.press('打开支付宝官方授权页面');
  expect(platform.openUrl).toHaveBeenCalledWith('https://render.alipay.com/wallet?fixture=auth');
  await act(async () => view.tree.root.findByType(TextInput).props.onChangeText('654321'));
  await view.press('提交支付宝绑定指令');
  expect(view.tree.root.findByType(TextInput).props.value).toBe('');
  expect(view.request.mock.calls.find(call => call[0].endsWith('/bind'))?.[2]).toEqual({ code: '654321' });
  expect(view.text()).not.toContain('654321');
  await view.close();
});
it('hides an old confirmation and cancels old requests when switching server or account API', async () => {
  const view = await setup();
  await view.press('核对付款 fixture-payment');
  const oldSignal = view.request.mock.calls[0][3]!;
  const next = jest.fn(async () => ledger([]));
  await view.switchApi({ request: next } as unknown as ApiClient);
  expect(oldSignal.aborted).toBe(true);
  expect(view.text()).not.toContain(payment.merchant);
  expect(view.request.mock.calls.some(call => call[0].endsWith('/confirm'))).toBe(false);
  await view.close();
});
it('does not turn unsafe provider URLs into tappable payment links', async () => {
  const view = await setup({ ...metadata, status: 'not_connected' }, []);
  view.setReply(async () => ({ ...metadata, authorization_url: 'https://alipay.com.evil.test/steal' }));
  await view.press('连接本人支付宝');
  expect(view.tree.root.findAllByType(Button).some(node => node.props.accessibilityLabel === '打开支付宝官方授权页面')).toBe(false);
  expect(platform.openUrl).not.toHaveBeenCalled();
  await view.close();
});
it('rejects malformed records instead of crashing the rendering or corrupting totals', () => {
  expect(parseWalletTransactions(ledger([payment])).items).toHaveLength(1);
  for (const change of [{ created_at: null }, { amount: 12.3 }, { status: 'success' }, { confirmation_token: 'invalid' }]) {
    expect(() => parseWalletTransactions(ledger([{ ...payment, ...change } as WalletPayment]))).toThrow();
  }
  expect(() => parseWalletTransactions({ ...ledger([]), summary: { paid_count: -1, paid_amount: '0.00', currency: 'CNY', totals_complete: true } })).toThrow();
  for (const value of ['https://alipay.com.evil.test', 'https://user@alipay.com', 'http://alipay.com', 'https://alipay.com:444/x']) expect(alipayOfficialUrl(value)).toBeNull();
  expect(alipayOfficialUrl('https://u.alipay.cn/fixture?x=a%2Bb')).toBe('https://u.alipay.cn/fixture?x=a%2Bb');
});
it('finds Alipay even on an old server and only marks a wallet connected from its dedicated status', () => {
  const unavailable = splitHubEntries(buildHubEntries({}), 'Alipay');
  expect(unavailable.available.map(entry => entry.key)).toEqual(['wallet:alipay']);
  expect(unavailable.available[0].state).toBe('unavailable');
  const connected = splitHubEntries(buildHubEntries({ wallet: metadata }), '支付宝');
  expect(connected.connected.map(entry => entry.key)).toEqual(['wallet:alipay']);
});

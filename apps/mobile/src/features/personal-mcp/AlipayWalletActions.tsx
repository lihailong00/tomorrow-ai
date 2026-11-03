import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import { platform } from '../../platform/ports';
import { Button, Card, ErrorNotice, Field, Pill } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';
import { alipayOfficialUrl, parseWalletTransactions, readWalletMetadata, walletPaymentLabel, type WalletPayment, type WalletTransactions } from './walletModel';
import type { WalletConnectionStatus } from './AlipayWalletConnection';

const base = '/personal-wallet/alipay';
type PageState = { metadata?: WalletConnectionStatus; transactions?: WalletTransactions; error: string; busy: boolean; url: string | null };

/** Codes/links and confirmation secrets live only in this account-scoped mount. */
export function AlipayWalletActions({ api, metadata, onStatus }: {
  api: ApiClient; metadata: WalletConnectionStatus; onStatus: (value: WalletConnectionStatus) => void;
}) {
  const scope = useMemo(() => ({ active: false, busy: false, controller: new AbortController(), sequence: 0 }), [api]);
  const [state, setState] = useState<PageState & { scope: typeof scope }>({ scope, error: '', busy: false, url: null });
  const current = state.scope === scope ? state : { scope, error: '', busy: false, url: null, transactions: undefined };
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState<WalletPayment | null>(null);
  const [period, setPeriod] = useState<'month' | 'all'>('month');
  const [notice, setNotice] = useState('');
  const visibleConfirm = state.scope === scope ? confirm : null;
  const from = useMemo(() => period === 'all' ? 0 : Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000), [period]);
  const load = useCallback(async (offset = 0) => {
    const sequence = ++scope.sequence;
    try {
      const value = parseWalletTransactions(await api.request<unknown>(`${base}/transactions?from=${from}&offset=${offset}&limit=20`, 'GET', undefined, scope.controller.signal));
      if (!scope.active || sequence !== scope.sequence) return;
      setState(previous => ({ ...previous, scope, error: '', transactions: offset && previous.scope === scope && previous.transactions
        ? { ...value, items: [...previous.transactions.items, ...value.items].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) }
        : value }));
    } catch (failure) {
      if (scope.active && sequence === scope.sequence) setState(previous => ({ ...previous, scope, error: errorMessage(failure) }));
    }
  }, [api, from, scope]);
  useEffect(() => {
    if (scope.controller.signal.aborted) scope.controller = new AbortController();
    scope.active = true; setCode(''); setConfirm(null); setNotice('');
    setState({ scope, error: '', busy: scope.busy, url: null });
    void load();
    const unsubscribe = platform.onForeground(() => { if (!scope.busy) void load(); });
    return () => { scope.active = false; ++scope.sequence; scope.controller.abort(); unsubscribe(); };
  }, [load, scope]);

  const action = async (path: string, body: unknown = {}, method = 'POST') => {
    if (!scope.active || scope.busy) return;
    scope.busy = true;
    setState(previous => ({ ...previous, scope, error: '', busy: true, url: null }));
    try {
      const value = await api.request<WalletConnectionStatus & { management_url?: string; authorization_url?: string; message?: string }>(base + path, method, body, scope.controller.signal);
      if (!scope.active) return;
      if (!path.includes('/payments/')) onStatus(readWalletMetadata(value));
      const url = alipayOfficialUrl(value.authorization_url ?? value.management_url);
      setState(previous => ({ ...previous, scope, url }));
      setNotice(value.message ?? (path === '/authorize' ? '请打开支付宝官方页面完成授权。' : '已取得服务器返回的真实状态。'));
      await load();
    } catch (failure) {
      if (scope.active) setState(previous => ({ ...previous, scope, error: errorMessage(failure) }));
    } finally {
      scope.busy = false;
      if (scope.active) setState(previous => ({ ...previous, scope, busy: false }));
    }
  };
  const open = async (value: unknown) => {
    const url = alipayOfficialUrl(value);
    if (!scope.active || !url) return;
    try { await platform.openUrl(url); }
    catch (failure) { if (scope.active) setState(previous => ({ ...previous, scope, error: errorMessage(failure) })); }
  };
  return <View testID="alipay-wallet-actions">
    <Text style={s.small}>每笔付款都需你核对确认。这里不会读取支付宝全部历史账单。</Text>
    {metadata.status !== 'connected' ? <Button accessibilityLabel="连接本人支付宝" disabled={current.busy} onPress={() => { void action('/authorize'); }}>连接本人支付宝</Button> : null}
    {current.url ? <Button accessibilityLabel="打开支付宝官方授权页面" variant="secondary" onPress={() => { void open(current.url); }}>前往支付宝处理授权 ↗</Button> : null}
    {metadata.status === 'awaiting_authorization' ? <>
      <Field label="支付宝授权绑定指令" value={state.scope === scope ? code : ''} secureTextEntry autoCorrect={false} autoCapitalize="none" maxLength={200} onChangeText={setCode} placeholder="仅在官方页面要求时填写" />
      <Button accessibilityLabel="提交支付宝绑定指令" disabled={current.busy || !code.trim()} onPress={() => { const value = code; setCode(''); void action('/bind', { code: value }); }}>完成绑定</Button>
    </> : null}
    <Button variant="ghost" accessibilityLabel="校验支付宝钱包" disabled={current.busy} onPress={() => { setCode(''); void action('/test'); }}>检查授权状态</Button>
    {metadata.status === 'connected' ? <Button variant="ghost" accessibilityLabel="管理支付宝授权" disabled={current.busy} onPress={() => { void action('', {}, 'DELETE'); }}>管理／解除授权 ↗</Button> : null}
    {notice && state.scope === scope ? <Text accessibilityLiveRegion="polite" style={s.small}>{notice}</Text> : null}
    <ErrorNotice message={current.error} />
    <View style={[s.between, { flexWrap: 'wrap' }]}><Text style={s.sectionTitle}>妥啦交易记录</Text><View style={{ flexDirection: 'row', gap: 8 }}>
      <Button variant="ghost" accessibilityLabel="查看本月支付宝交易" disabled={current.busy} onPress={() => setPeriod('month')}>本月</Button>
      <Button variant="ghost" accessibilityLabel="查看全部支付宝交易" disabled={current.busy} onPress={() => setPeriod('all')}>全部</Button>
    </View></View>
    <Button variant="ghost" accessibilityLabel="刷新支付宝交易记录" disabled={current.busy} onPress={() => { void load(); }}>刷新交易记录</Button>
    {current.transactions ? <>
      <Text style={s.body}>已核实付款 ¥{current.transactions.summary.paid_amount} · {current.transactions.summary.paid_count} 笔</Text>
      {!current.transactions.summary.totals_complete ? <Text style={s.small}>记录较多，合计尚不完整，请缩小查询时间范围。</Text> : null}
      {current.transactions.items.length === 0 ? <Text style={s.small}>还没有通过妥啦发起的付款。</Text> : null}
      {current.transactions.items.map(item => <Card key={item.id} testID={`alipay-payment-${item.id}`}>
        <View style={s.between}><Text style={s.cardTitle}>{item.title}</Text><Pill tone={item.status === 'paid' ? 'green' : 'neutral'}>{walletPaymentLabel[item.status]}</Pill></View>
        <Text style={s.body}>{item.merchant} · ¥{item.amount}</Text>
        <Text style={s.small}>{item.created_at.replace('T', ' ').slice(0, 16)}</Text>
        {item.message ? <Text style={s.small}>{item.message}</Text> : null}
        {item.status === 'pending' ? <>
          <Button accessibilityLabel={`核对付款 ${item.id}`} disabled={current.busy || !item.confirmation_token} onPress={() => setConfirm(item)}>核对并付款</Button>
          <Button accessibilityLabel={`取消付款 ${item.id}`} variant="ghost" disabled={current.busy} onPress={() => { void action(`/payments/${encodeURIComponent(item.id)}/cancel`); }}>取消这笔请求</Button>
        </> : null}
        {alipayOfficialUrl(item.payment_url) && ['awaiting_payment', 'unknown_outcome'].includes(item.status) ? <Button accessibilityLabel={`打开支付宝确认 ${item.id}`} variant="secondary" onPress={() => { void open(item.payment_url); }}>前往支付宝确认 ↗</Button> : null}
        {['awaiting_payment', 'unknown_outcome', 'executing'].includes(item.status) ? <Button accessibilityLabel={`查询付款 ${item.id}`} variant="ghost" disabled={current.busy} onPress={() => { void action(`/payments/${encodeURIComponent(item.id)}/refresh`); }}>核实付款结果</Button> : null}
      </Card>)}
      {current.transactions.has_more && current.transactions.next_offset !== null ? <Button variant="ghost" accessibilityLabel="更多支付宝交易" onPress={() => { void load(current.transactions!.next_offset!); }}>查看更多</Button> : null}
    </> : <Text style={s.small}>正在读取本人的交易记录…</Text>}
    <Modal transparent visible={Boolean(visibleConfirm)} animationType="fade" onRequestClose={() => setConfirm(null)}>
      {visibleConfirm ?
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#20263B70' }}><Card>
        <Text style={s.cardTitle}>确认这笔支付宝付款</Text>
        <Text style={s.body}>{visibleConfirm.title}</Text><Text style={s.body}>收款商家：{visibleConfirm.merchant}</Text>
        <Text style={s.title}>¥{visibleConfirm.amount}</Text>
        <Text style={s.small}>确认后会提交官方支付组件。若结果暂不明确，请先核对支付宝账单，再决定下一步。</Text>
        <Button accessibilityLabel="确认提交支付宝付款" disabled={current.busy || !confirm?.confirmation_token} onPress={() => {
          const item = confirm; setConfirm(null);
          if (item?.confirmation_token) void action(`/payments/${encodeURIComponent(item.id)}/confirm`, { confirmation_token: item.confirmation_token });
        }}>确认付款</Button>
        <Button variant="ghost" accessibilityLabel="暂不付款" onPress={() => setConfirm(null)}>暂不付款</Button>
      </Card></View> : null}
    </Modal>
  </View>;
}

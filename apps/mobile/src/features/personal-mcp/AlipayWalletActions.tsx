import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import { platform } from '../../platform/ports';
import { Button, Card, ErrorNotice, Field, Pill } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';
import { alipayOfficialUrl, parseWalletTransactions, readWalletMetadata, walletPaymentLabel, type WalletPayment, type WalletTransactions } from './walletModel';
import { McpConnectionCard, McpConnectionRow } from './McpConnectionCard';
import type { WalletConnectionStatus } from './walletModel';

const base = '/personal-wallet/alipay';
type PageState = {
  transactions?: WalletTransactions;
  error: string;
  busy: boolean;
  authorizationUrl: string | null;
  managementUrl: string | null;
  ledgerOpen: boolean;
};
const initialPage: PageState = { error: '', busy: false, authorizationUrl: null, managementUrl: null, ledgerOpen: false };
const connectionCopy: Record<WalletConnectionStatus['status'], [status: string, description: string]> = {
  not_configured: ['暂未开通', '当前服务器尚未开通支付宝。'],
  not_connected: ['未连接', '授权后，可以在妥啦核对订单并付款。'],
  awaiting_authorization: ['等待授权', '在支付宝完成授权后，返回妥啦会自动核实。'],
  binding: ['确认中', '正在确认支付宝授权状态。'],
  connected: ['已连接', '可以在妥啦核对订单并付款。'],
  needs_reconnect: ['待核实', '检查之前的授权是否仍然有效。'],
};

/** Codes/links and confirmation secrets live only in this account-scoped mount. */
export function AlipayWalletActions({ api, metadata, onStatus, title, details, statusError }: {
  api: ApiClient; metadata: WalletConnectionStatus; onStatus: (value: WalletConnectionStatus) => void;
  title?: string; details?: React.ReactNode; statusError?: string;
}) {
  const scope = useMemo(() => ({
    active: false, busy: false, recheckOnReturn: false, controller: new AbortController(), sequence: 0,
  }), [api]);
  const [state, setState] = useState<PageState & { scope: typeof scope }>({ scope, ...initialPage });
  const current = state.scope === scope ? state : initialPage;
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const foreground = useRef<() => void>(() => undefined);
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
    scope.active = true;
    setCode(''); setShowCode(false); setShowDetails(false); setConfirm(null); setNotice('');
    setPeriod('month');
    setState({ scope, ...initialPage });
    const unsubscribe = platform.onForeground(() => { if (scope.active) foreground.current(); });
    return () => { scope.active = false; ++scope.sequence; scope.controller.abort(); unsubscribe(); };
  }, [scope]);
  useEffect(() => {
    if (!current.ledgerOpen) return;
    void load();
    return () => { ++scope.sequence; };
  }, [current.ledgerOpen, load, scope]);

  const action = async (path: string, body: unknown = {}, method = 'POST') => {
    if (!scope.active || scope.busy) return;
    scope.busy = true;
    setState(previous => ({ ...previous, scope, error: '', busy: true }));
    try {
      const value = await api.request<WalletConnectionStatus & { management_url?: string; authorization_url?: string; message?: string }>(base + path, method, body, scope.controller.signal);
      if (!scope.active) return;
      if (!path.includes('/payments/')) onStatus(readWalletMetadata(value));
      if (value.status === 'connected') { setCode(''); setShowCode(false); }
      if (!path.includes('/payments/')) {
        setState(previous => ({
          ...previous, scope,
          authorizationUrl: value.status === 'connected' ? null : alipayOfficialUrl(value.authorization_url),
          managementUrl: alipayOfficialUrl(value.management_url),
        }));
        setNotice(path === '/test' && value.status === 'needs_reconnect' && !alipayOfficialUrl(value.authorization_url)
          ? '暂时未能确认授权有效。可以重试，或在帮助中重新授权。'
          : value.status === 'connected' && method !== 'DELETE' ? '已核实支付宝授权。' : '');
      } else if (current.ledgerOpen) await load();
    } catch (failure) {
      if (scope.active) setState(previous => ({ ...previous, scope, error: errorMessage(failure) }));
    } finally {
      scope.busy = false;
      if (scope.active) setState(previous => ({ ...previous, scope, busy: false }));
    }
  };
  const open = async (value: unknown, recheckOnReturn = false) => {
    const url = alipayOfficialUrl(value);
    if (!scope.active || !url) return;
    if (recheckOnReturn) scope.recheckOnReturn = true;
    try { await platform.openUrl(url); }
    catch (failure) {
      if (recheckOnReturn) scope.recheckOnReturn = false;
      if (scope.active) setState(previous => ({ ...previous, scope, error: errorMessage(failure) }));
    }
  };
  foreground.current = () => {
    if (!scope.active || scope.busy) return;
    if (metadata.status === 'awaiting_authorization' || scope.recheckOnReturn) {
      scope.recheckOnReturn = false;
      setCode('');
      void action('/test');
    } else if (current.ledgerOpen) void load();
  };
  const check = () => { setCode(''); void action('/test'); };
  const authorize = () => { void action('/authorize'); };
  const [status, description] = connectionCopy[metadata.status];
  const connected = metadata.status === 'connected';
  const openLedger = () => setState(previous => ({ ...previous, ledgerOpen: true, error: '' }));
  const changePeriod = (next: typeof period) => {
    if (next === period || scope.busy) return;
    ++scope.sequence;
    setState(previous => ({ ...previous, transactions: undefined, error: '' }));
    setPeriod(next);
  };
  const primary = current.authorizationUrl ? (
    <Button accessibilityLabel="打开支付宝官方授权页面" disabled={current.busy}
      onPress={() => { void open(current.authorizationUrl, true); }}>去支付宝授权 ↗</Button>
  ) : metadata.status === 'not_connected' || metadata.status === 'awaiting_authorization' ? (
    <Button accessibilityLabel="连接本人支付宝" loading={current.busy} onPress={authorize}>
      {metadata.status === 'awaiting_authorization' ? '继续授权' : '连接支付宝'}
    </Button>
  ) : !connected ? (
    <Button accessibilityLabel="校验支付宝钱包" loading={current.busy} onPress={check}>
      {current.error ? '重新核实' : '核实授权'}
    </Button>
  ) : null;
  return <View testID="alipay-wallet-actions">
    {!current.ledgerOpen ? <McpConnectionCard title={title} status={current.busy ? '处理中' : status}
      description={description} tone={connected ? 'green' : metadata.status === 'needs_reconnect' ? 'amber' : 'neutral'}
      action={primary}>
    <Text style={s.small}>每笔付款都需要你确认。</Text>
    <ErrorNotice message={current.error || statusError} />
    {notice && state.scope === scope ? <Text accessibilityLiveRegion="polite" style={s.small}>{notice}</Text> : null}
    {connected ? <McpConnectionRow label="妥啦交易记录" disabled={current.busy}
      onPress={openLedger} /> : null}
    <McpConnectionRow label="授权范围与帮助" expanded={showDetails} disabled={current.busy} onPress={() => {
      setShowDetails(!showDetails);
      if (showDetails) { setCode(''); setShowCode(false); }
    }} />
    {showDetails ? <>
    <Text style={s.small}>交易记录只包含通过妥啦发起的付款。</Text>
    {!connected ? <McpConnectionRow label="妥啦交易记录"
      disabled={current.busy} onPress={openLedger} /> : null}
    {metadata.status === 'needs_reconnect' && !current.authorizationUrl
      ? <Button variant="ghost" accessibilityLabel="连接本人支付宝" disabled={current.busy} onPress={authorize}>
          在支付宝重新授权
        </Button> : null}
    {metadata.status === 'awaiting_authorization' ? <>
      <Button variant="ghost" accessibilityLabel="使用支付宝绑定指令" disabled={current.busy} onPress={() => { setShowCode(value => !value); setCode(''); }}>官方页面要求填写绑定指令？</Button>
      {showCode ? <>
      <Field label="支付宝授权绑定指令" value={state.scope === scope ? code : ''} secureTextEntry autoCorrect={false} autoCapitalize="none" maxLength={200} onChangeText={setCode} placeholder="仅在官方页面要求时填写" />
      <Button accessibilityLabel="提交支付宝绑定指令" disabled={current.busy || !code.trim()} onPress={() => { const value = code; setCode(''); void action('/bind', { code: value }); }}>完成绑定</Button>
      </> : null}
    </> : null}
    {connected ? <>
    <Button variant="ghost" accessibilityLabel="校验支付宝钱包" disabled={current.busy} onPress={check}>核实授权</Button>
    <Button variant="ghost" accessibilityLabel="管理支付宝授权" disabled={current.busy}
      onPress={() => {
        if (current.managementUrl) {
          void open(current.managementUrl, true);
        } else {
          Alert.alert('管理支付宝授权', '继续会取消妥啦中尚未确认的付款请求。授权可在支付宝中管理。', [
            { text: '返回', style: 'cancel' },
            { text: '继续', onPress: () => { void action('', {}, 'DELETE'); } },
          ]);
        }
      }}>
      {current.managementUrl ? '在支付宝管理授权 ↗' : '管理或解除授权'}
    </Button>
    </> : null}
    {details}
    </> : null}
    </McpConnectionCard> : <>
    <McpConnectionRow label="返回支付宝连接" disabled={current.busy}
      onPress={() => setState(previous => ({ ...previous, ledgerOpen: false, transactions: undefined, error: '' }))} />
    <Text style={s.small}>仅展示通过妥啦发起的交易。</Text>
    <ErrorNotice message={current.error} />
    <View style={[s.between, { flexWrap: 'wrap' }]}><Text style={s.sectionTitle}>妥啦交易记录</Text><View style={{ flexDirection: 'row', gap: 8 }}>
      <Button variant={period === 'month' ? 'secondary' : 'ghost'} accessibilityLabel="查看本月支付宝交易"
        disabled={current.busy} onPress={() => changePeriod('month')}>本月</Button>
      <Button variant={period === 'all' ? 'secondary' : 'ghost'} accessibilityLabel="查看全部支付宝交易"
        disabled={current.busy} onPress={() => changePeriod('all')}>全部</Button>
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
    </> : current.error ? null : <Text style={s.small}>正在读取本人的交易记录…</Text>}
    </>}
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

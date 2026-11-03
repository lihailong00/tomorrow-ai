export type WalletStatus = 'not_configured' | 'not_connected' | 'awaiting_authorization' | 'binding' | 'connected' | 'needs_reconnect';
export interface WalletConnectionStatus {
  id: 'alipay'; name: string; kind: 'wallet'; status: WalletStatus;
  description: string; reason: string; help_url: string; qualification_url: string;
  binding_available: boolean; payment_available: boolean;
  protocol_version?: number; runtime_mode?: string;
}
export const unavailableWallet: WalletConnectionStatus = {
  id: 'alipay', name: '支付宝', kind: 'wallet', status: 'not_configured',
  description: '本人支付宝授权、逐笔确认付款，以及妥啦交易记录。',
  reason: '接入状态待确认，打开后以当前服务器的配置为准。',
  help_url: 'https://aipay.alipay.com/wallet-guide',
  qualification_url: 'https://aipay.alipay.com/products/mobile-agent-pay',
  binding_available: false, payment_available: false,
};
export type WalletPaymentStatus = 'pending' | 'executing' | 'awaiting_payment' | 'paid' | 'closed' | 'cancelled' | 'expired' | 'unknown_outcome';
export interface WalletPayment {
  id: string;
  title: string;
  merchant: string;
  amount: string;
  currency: 'CNY';
  status: WalletPaymentStatus;
  created_at: string;
  expires_at: string;
  confirmation_token?: string;
  payment_url?: string | null;
  message?: string;
}
export interface WalletTransactions {
  items: WalletPayment[];
  has_more: boolean;
  next_offset: number | null;
  summary: { paid_count: number; paid_amount: string; currency: 'CNY'; totals_complete: boolean };
  history_scope: 'tada_transactions_only';
}
export function alipayOfficialUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f#]/u.test(value)) return null;
  return /^https:\/\/(?:[a-z0-9-]+\.)*alipay\.(?:com|cn)(?::443)?(?:[/?][^#]*)?$/i.test(value) ? value : null;
}
export const walletStatusLabel: Record<WalletStatus, string> = {
  not_configured: '待配置', not_connected: '未连接', awaiting_authorization: '待授权',
  binding: '确认中', connected: '已连接', needs_reconnect: '待重新核实',
};
export function readWalletMetadata(value: unknown): WalletConnectionStatus {
  const data = value as WalletConnectionStatus | null;
  if (!data || data.id !== 'alipay' || data.kind !== 'wallet' || typeof data.description !== 'string' ||
      typeof data.reason !== 'string' || typeof data.help_url !== 'string' || typeof data.qualification_url !== 'string') {
    throw new Error('暂时无法识别支付宝接入状态，请确认服务器已升级。');
  }
  const disabled = data.status === 'not_configured' && data.binding_available === false && data.payment_available === false;
  const supported = data.status !== 'not_configured' && Object.hasOwn(walletStatusLabel, data.status) &&
    data.binding_available === true && data.payment_available === true && data.protocol_version === 1 && data.runtime_mode === 'dedicated_single_user';
  if (!disabled && !supported) throw new Error('当前版本尚未支持此服务器提供的钱包绑定流程，请更新客户端后重试。');
  return data;
}
export const walletPaymentLabel: Record<WalletPaymentStatus, string> = {
  pending: '待你确认', executing: '正在处理', awaiting_payment: '待支付宝确认', paid: '已核实付款',
  closed: '已关闭', cancelled: '已取消', expired: '已过期', unknown_outcome: '结果待核实',
};
export function parseWalletTransactions(value: unknown): WalletTransactions {
  const data = value as WalletTransactions | null;
  if (!data || !Array.isArray(data.items) || data.items.length > 50 || data.history_scope !== 'tada_transactions_only' ||
      !data.summary || data.summary.currency !== 'CNY' || typeof data.summary.paid_amount !== 'string' || !/^\d{1,14}\.\d{2}$/.test(data.summary.paid_amount) ||
      !Number.isInteger(data.summary.paid_count) || data.summary.paid_count < 0 || data.summary.paid_count > 10000 ||
      typeof data.summary.totals_complete !== 'boolean' || typeof data.has_more !== 'boolean' ||
      (data.next_offset !== null && (!Number.isInteger(data.next_offset) || data.next_offset < 0 || data.next_offset > 10000)) ||
      data.items.some(item => !item || typeof item.id !== 'string' || !item.id.length || item.id.length > 80 || typeof item.title !== 'string' || item.title.length > 400 ||
        typeof item.merchant !== 'string' || item.merchant.length > 200 || item.currency !== 'CNY' || typeof item.amount !== 'string' || !/^\d{1,7}\.\d{2}$/.test(item.amount) ||
        typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at)) ||
        typeof item.expires_at !== 'string' || !Number.isFinite(Date.parse(item.expires_at)) ||
        (item.message !== undefined && (typeof item.message !== 'string' || item.message.length > 1000)) ||
        (item.confirmation_token !== undefined && (typeof item.confirmation_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.confirmation_token))) ||
        !Object.hasOwn(walletPaymentLabel, item.status))) {
    throw new Error('暂时无法识别支付宝交易记录，请刷新或更新服务器。');
  }
  return data;
}

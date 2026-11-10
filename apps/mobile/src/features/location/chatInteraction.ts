import { readPersonalDetails, type PersonalDetails } from './personalDetails';
import { permissionLabels, settingsLabels, type DeviceAction } from '../app-permissions/inspection';
import { alipayOfficialUrl } from '../personal-mcp/walletModel';
type Identity = { id: string; run_id: string; expires_at: number };
type DidiOrder = { kind: 'didi_order'; from: string; to: string; products: { name: string; price: string }[];
  sandbox: boolean; phone_suffix?: string };
type ActionConfirmation = { kind: 'action_confirmation'; title: string; details: string;
  button: '确认执行' | '确认取消' | '确认付款' };

export type ChatInteraction = Identity & (
  { kind: 'location' } | DeviceAction |
  { kind: 'choice'; question: string; options: string[] } | PersonalDetails | DidiOrder |
  ActionConfirmation | { kind: 'alipay_checkout'; payment_url: string }
);

export function readChatInteraction(value: unknown): ChatInteraction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const card = value as Partial<Identity> & { kind?: unknown; question?: unknown; options?: unknown };
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,120}$/.test(id);
  if (!validId(card.id) || !validId(card.run_id) || typeof card.expires_at !== 'number' ||
      !Number.isSafeInteger(card.expires_at)) return undefined;
  const identity = { id: card.id, run_id: card.run_id, expires_at: card.expires_at };
  if (card.kind === 'location') return { ...identity, kind: 'location' };
  if (card.kind === 'app_permission_inspection') {
    const { inspection, permission, scope, mode } = value as Partial<Extract<DeviceAction, { kind: 'app_permission_inspection' }>>;
    if ((inspection !== 'permissions' && inspection !== 'access_history') ||
        (permission !== undefined && (typeof permission !== 'string' || !Object.prototype.hasOwnProperty.call(permissionLabels, permission))) ||
        (scope !== undefined && scope !== 'visible_apps' && scope !== 'selected_app') ||
        (mode !== undefined && mode !== 'check' && mode !== 'reuse' && mode !== 'refresh')) return;
    return { ...identity, kind: card.kind, inspection, permission, scope, mode };
  }
  if (card.kind === 'system_settings') {
    const { destination } = value as Partial<Extract<DeviceAction, { kind: 'system_settings' }>>;
    if (typeof destination === 'string' && Object.prototype.hasOwnProperty.call(settingsLabels, destination)) return { ...identity, kind: card.kind, destination };
    return;
  }
  if (card.kind === 'didi_order') {
    const { from, to, products, sandbox, phone_suffix } = value as Partial<DidiOrder>;
    const label = (text: unknown, max: number): text is string =>
      typeof text === 'string' && text.trim().length > 0 && Array.from(text).length <= max;
    if (!label(from, 200) || !label(to, 200) || typeof sandbox !== 'boolean' ||
        !Array.isArray(products) || products.length < 1 || products.length > 6 ||
        products.some(product => !product || !label(product.name, 80) || !label(product.price, 80))) return undefined;
    return { ...identity, kind: 'didi_order', from, to, sandbox,
      products: products.map(({ name, price }) => ({ name, price })),
      phone_suffix: typeof phone_suffix === 'string' && /^\d{4}$/.test(phone_suffix) ? phone_suffix : undefined };
  }
  if (card.kind === 'action_confirmation') {
    const { title, details, button } = value as Partial<ActionConfirmation>;
    if (typeof title !== 'string' || !title.trim() || title.length > 200 ||
        typeof details !== 'string' || !details.trim() || details.length > 12_200 ||
        (button !== '确认执行' && button !== '确认取消' && button !== '确认付款')) return;
    return { ...identity, kind: card.kind, title, details, button };
  }
  if (card.kind === 'alipay_checkout') {
    const payment_url = alipayOfficialUrl((value as { payment_url?: unknown }).payment_url);
    if (payment_url) return { ...identity, kind: card.kind, payment_url };
    return;
  }
  const personal = readPersonalDetails(value as Record<string, unknown>);
  if (personal) return { ...identity, ...personal };
  if (card.kind === 'choice' && typeof card.question === 'string' && card.question.length <= 280 &&
      Array.isArray(card.options) && card.options.length >= 2 && card.options.length <= 6 &&
      card.options.every(option => typeof option === 'string' && option.length <= 120)) {
    return { ...identity, kind: 'choice', question: card.question, options: card.options };
  }
  return undefined;
}

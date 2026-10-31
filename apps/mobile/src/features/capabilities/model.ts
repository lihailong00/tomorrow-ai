import type { Connector } from '../../domain/types';
import type { Integration } from '../integrations/types';
import type { HealthConnection } from '../health/types';
import type { PersonalMcpConnection } from '../personal-mcp/types';
import type { AppInputStatus } from '../../platform/appInputs';

export const capabilityAppearance = {
  background: '#F6F7FB',
  surface: '#FFFFFF',
  ink: '#272C3B',
  secondary: '#697286',
  line: '#E9EBF2',
  accent: '#5967BD',
  tint: '#EEF0FC',
  green: '#337B65',
  amber: '#976B24',
};
export type HubCategory = '邮箱' | '日程' | '文件' | '健康' | '手机';
export type HubState = 'connected' | 'reconnect' | 'available' | 'unavailable';
type Base = {
  key: string;
  name: string;
  detail: string;
  category: HubCategory;
  state: HubState;
};
export type HubEntry = Base &
  (
    | { kind: 'connector'; source: Connector }
    | { kind: 'integration'; source: Integration }
    | { kind: 'health'; source: HealthConnection }
    | { kind: 'mcp'; source: PersonalMcpConnection }
    | { kind: 'phone' }
    | { kind: 'notifications' }
  );
export type PhoneConnectionStatus = {
  supported: boolean;
  selected: number;
  readable: number;
};

function category(id: string, mode?: string): HubCategory {
  if (mode === 'mail' || /mail|netease/.test(id)) return '邮箱';
  if (/calendar|dingtalk/.test(id)) return '日程';
  return '文件';
}

/** Only provider-confirmed connections and explicitly selected phone sources belong above. */
export function buildHubEntries(input: {
  connectors?: Connector[];
  integrations?: Integration[];
  health?: HealthConnection[];
  mcp?: PersonalMcpConnection[];
  notifications?: AppInputStatus | null;
  phone?: PhoneConnectionStatus | null;
}): HubEntry[] {
  const entries: HubEntry[] = [];
  if (input.phone) {
    const phone = input.phone;
    entries.push({
      key: 'phone',
      name: '手机资料',
      kind: 'phone',
      category: '手机',
      state: !phone.supported
        ? 'unavailable'
        : phone.selected
        ? phone.readable === phone.selected
          ? 'connected'
          : 'reconnect'
        : 'available',
      detail: phone.selected
        ? `${phone.readable} / ${phone.selected} 项来源已授权 · 先在本机预览`
        : '短信、日历、联系人与照片，由你选择范围',
    });
  }
  if (input.notifications) {
    const status = input.notifications;
    entries.push({
      key: 'notifications',
      name: '通知摘要',
      kind: 'notifications',
      category: '手机',
      state: !status.supported
        ? 'unavailable'
        : status.selected_apps.length
        ? status.notification_access
          ? 'connected'
          : 'reconnect'
        : 'available',
      detail: status.selected_apps.length
        ? `${status.selected_apps.length} 个应用 · ${
            status.notification_access ? '待你确认导入' : '需要开启通知使用权'
          }`
        : '只接收你选定应用后续出现的通知',
    });
  }
  for (const source of input.connectors ?? [])
    entries.push({
      key: 'connector:' + source.id,
      kind: 'connector',
      source,
      name: source.name,
      detail: source.detail,
      category: category(source.id),
      state:
        source.status === 'connected'
          ? 'connected'
          : source.status === 'not_configured'
          ? 'unavailable'
          : 'available',
    });
  for (const source of input.integrations ?? [])
    entries.push({
      key: 'integration:' + source.id,
      kind: 'integration',
      source,
      name: source.name,
      detail: source.detail,
      category: category(source.id, source.mode),
      state:
        source.status === 'connected'
          ? 'connected'
          : source.status === 'not_configured'
          ? 'unavailable'
          : 'available',
    });
  for (const source of input.health ?? [])
    entries.push({
      key: 'health:' + source.id,
      kind: 'health',
      source,
      name: source.name,
      detail: source.detail,
      category: '健康',
      state:
        source.status === 'connected'
          ? 'connected'
          : source.status === 'reconnect_required'
          ? 'reconnect'
          : source.status === 'not_configured'
          ? 'unavailable'
          : 'available',
    });
  for (const source of input.mcp ?? [])
    entries.push({
      key: 'mcp:' + source.id,
      kind: 'mcp',
      source,
      name: source.name,
      detail: source.description,
      category: '文件',
      state:
        source.status === 'connected'
          ? 'connected'
          : source.status === 'needs_reconnect'
          ? 'reconnect'
          : source.status === 'not_configured'
          ? 'unavailable'
          : 'available',
    });
  return entries;
}

export function splitHubEntries(
  entries: HubEntry[],
  query = '',
  selected: '全部' | HubCategory = '全部',
) {
  const matches = query.trim().toLocaleLowerCase();
  const unique = [
    ...new Map(entries.map(entry => [entry.key, entry])).values(),
  ];
  return {
    connected: unique.filter(
      entry => entry.state === 'connected' || entry.state === 'reconnect',
    ),
    available: unique
      .filter(
        entry => entry.state !== 'connected' && entry.state !== 'reconnect',
      )
      .filter(
        entry =>
          (selected === '全部' || entry.category === selected) &&
          (!matches ||
            `${entry.name} ${entry.detail} ${entry.category}`
              .toLocaleLowerCase()
              .includes(matches)),
      )
      .sort(
        (a, b) =>
          Number(a.state === 'unavailable') - Number(b.state === 'unavailable'),
      ),
  };
}

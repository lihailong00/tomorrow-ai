import type { Connector } from '../../domain/types';
import type { Integration } from '../integrations/types';
import type { HealthConnection } from '../health/types';
import type { PersonalMcpConnection } from '../personal-mcp/types';
import { unavailableWallet, type WalletConnectionStatus } from '../personal-mcp/walletModel';
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
    | { kind: 'wallet'; source: WalletConnectionStatus }
    | { kind: 'phone' }
    | { kind: 'notifications' }
  );
export type PhoneConnectionStatus = {
  supported: boolean;
  selected: number;
  readable: number;
};

// Public service names only. Availability and credentials always come from the
// current authenticated server; these entries keep older/offline catalogs searchable.
const providerChoices: ReadonlyArray<
  readonly [string, string, 'integration' | 'mcp', readonly string[]]
> = [
  ['dida365', '滴答清单', 'mcp', ['Dida365', 'TickTick', '滴答']],
  ['fliggy', '飞猪', 'mcp', ['Fliggy', '飞猪旅行']],
  ['jianguoyun', '坚果云', 'mcp', ['Jianguoyun', 'Nutstore']],
  ['amap', '高德地图', 'integration', ['AMap', 'Gaode', '高德']],
  ['baidu_maps', '百度地图', 'mcp', ['Baidu Maps']],
  ['qq_mail', 'QQ 邮箱', 'integration', ['QQ Mail', 'QQ邮箱', 'Foxmail']],
  [
    'netease163',
    '163 邮箱',
    'integration',
    ['NetEase 163', '163 Mail', '网易163', '网易邮箱'],
  ],
  [
    'netease126',
    '126 邮箱',
    'integration',
    ['NetEase 126', '126 Mail', '网易126', '网易邮箱'],
  ],
  ['tencent_docs', '腾讯文档', 'mcp', ['Tencent Docs']],
  ['tencent_meeting', '腾讯会议', 'mcp', ['Tencent Meeting']],
  ['didi', '滴滴出行', 'mcp', ['DiDi', '滴滴']],
  ['mcdonalds', '麦当劳', 'mcp', ['McDonalds', "McDonald's"]],
  ['notion', 'Notion', 'mcp', ['Notion']],
  ['memos', 'Memos', 'mcp', ['Memos']],
  ['weread', '微信读书', 'mcp', ['WeRead']],
  ['weiyun', '腾讯微云', 'mcp', ['Weiyun', 'Tencent Drive', '微云']],
  ['luckin', '瑞幸咖啡', 'mcp', ['Luckin', 'Luckin Coffee', '瑞幸']],
  ['qq_music', 'QQ 音乐', 'mcp', ['QQ Music', 'QQ音乐']],
  ['ima', 'ima', 'mcp', ['IMA', 'ima.copilot']],
];

function category(id: string, mode?: string): HubCategory {
  if (mode === 'mail' || /mail|netease/.test(id)) return '邮箱';
  if (/calendar|dingtalk|dida365|tencent_meeting/.test(id)) return '日程';
  return '文件';
}

/** Only provider-confirmed connections and explicitly selected phone sources belong above. */
export function buildHubEntries(input: {
  connectors?: Connector[];
  integrations?: Integration[];
  health?: HealthConnection[];
  mcp?: PersonalMcpConnection[];
  wallet?: WalletConnectionStatus | null;
  notifications?: AppInputStatus | null;
  phone?: PhoneConnectionStatus | null;
}): HubEntry[] {
  const entries: HubEntry[] = [];
  const wallet = input.wallet ?? unavailableWallet;
  entries.push({
    key: 'wallet:alipay', kind: 'wallet', source: wallet, name: '支付宝', category: '手机',
    detail: `${wallet.description} Alipay · 付款 · 账单`,
    state: wallet.status === 'connected' ? 'connected' : wallet.status === 'needs_reconnect' ? 'reconnect'
      : wallet.binding_available ? 'available' : 'unavailable',
  });
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
  for (const source of (input.mcp ?? []).filter(item => item.id !== 'alipay'))
    entries.push({
      key: 'mcp:' + source.id,
      kind: 'mcp',
      source,
      name: source.name,
      detail: source.description,
      category: category(source.id),
      state:
        source.status === 'connected'
          ? 'connected'
          : source.status === 'needs_reconnect'
          ? 'reconnect'
          : source.status === 'not_configured'
          ? 'unavailable'
          : 'available',
    });
  for (const [id, name, kind] of providerChoices) {
    if (entries.some(entry => 'source' in entry && entry.source.id === id))
      continue;
    const detail =
      '当前服务器尚未提供此连接，请升级服务后使用你本人的凭证授权。';
    if (kind === 'integration') {
      const source: Integration = {
        id,
        name,
        category: id === 'amap' ? '出行' : '邮件',
        mode: id === 'amap' ? 'map' : 'mail',
        status: 'not_configured',
        detail,
        ...(id === 'amap' ? { credential_scope: 'user' } : {}),
      };
      entries.push({
        key: 'integration:' + id,
        kind,
        source,
        name,
        detail,
        category: category(id, source.mode),
        state: 'unavailable',
      });
    } else {
      const source: PersonalMcpConnection = {
        id,
        name,
        description: detail,
        help_url: '',
        credential_label: '个人凭证',
        transport: 'unavailable',
        status: 'not_configured',
        environment: 'production',
        tool_count: 0,
        has_credentials: false,
      };
      entries.push({
        key: 'mcp:' + id,
        kind,
        source,
        name,
        detail,
        category: category(id),
        state: 'unavailable',
      });
    }
  }
  return entries;
}

export function splitHubEntries(
  entries: HubEntry[],
  query = '',
  selected: '全部' | HubCategory = '全部',
) {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[\s_-]+/g, '');
  const matches = normalize(query.trim());
  const matchesQuery = (entry: HubEntry) => {
    const id = 'source' in entry ? entry.source.id : entry.key;
    const choice = providerChoices.find(([providerId]) => providerId === id);
    return (
      !matches ||
      normalize(
        `${entry.key} ${entry.name} ${entry.detail} ${entry.category} ${
          choice?.[1] || ''
        } ${choice?.[3].join(' ') || ''}`,
      ).includes(matches)
    );
  };
  const unique = [
    ...new Map(entries.map(entry => [entry.key, entry])).values(),
  ];
  return {
    connected: unique.filter(
      entry =>
        (entry.state === 'connected' || entry.state === 'reconnect') &&
        matchesQuery(entry),
    ),
    available: unique
      .filter(
        entry => entry.state !== 'connected' && entry.state !== 'reconnect',
      )
      .filter(
        entry =>
          (Boolean(matches) ||
            selected === '全部' ||
            entry.category === selected) &&
          matchesQuery(entry),
      )
      .sort(
        (a, b) =>
          Number(a.state === 'unavailable') - Number(b.state === 'unavailable'),
      ),
  };
}

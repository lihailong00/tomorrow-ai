import type { AppInputStatus } from '../../platform/appInputs';
import type { HealthAvailability } from '../health/native';
import type { HealthConnection } from '../health/types';
import type { PersonalMcpConnection } from '../personal-mcp/types';
import { walletStatusLabel, type WalletConnectionStatus } from '../personal-mcp/walletModel';
import { slackIntegration } from './slackModel';
import type { Integration } from './types';

export type ConnectionCategory = 'local' | 'cloud' | 'devices';
export type ConnectionTarget =
  | { kind: 'app'; id: string }
  | { kind: 'notifications' }
  | { kind: 'share' }
  | { kind: 'files' }
  | { kind: 'photos' }
  | { kind: 'mcp'; id: string }
  | { kind: 'integration'; id: string }
  | { kind: 'health'; id: string };
export type ConnectionRow = {
  key: string;
  name: string;
  category: ConnectionCategory;
  purpose: string;
  method: string;
  status: string;
  action: string;
  added: boolean;
  usable: boolean;
  attention: boolean;
  unavailable?: boolean;
  target: ConnectionTarget;
};

export type ConnectionSnapshot = {
  native: AppInputStatus | null;
  integrations: Integration[] | null;
  mcp: PersonalMcpConnection[] | null;
  wallet?: WalletConnectionStatus | null;
  mcpUpdates?: PersonalMcpConnection[];
  health: HealthConnection[] | null;
  systemHealth: HealthAvailability | null;
  photoEnabled: boolean | null;
  photoState?: string;
};

const fallbackMcp = [
  ['github', 'GitHub', '只读查找你授权的仓库、代码和拉取请求'],
  ['dida365', '滴答清单', '查看本人清单、待办与日程'],
  ['fliggy', '飞猪', '查询旅行信息与个人授权的出行服务'],
  ['jianguoyun', '坚果云', '读取本人授权的云端文件'],
  ['baidu_maps', '百度地图', '查询地点、路线与地图服务'],
  ['weread', '微信读书', '读取本人授权的书籍和阅读资料'],
  ['weiyun', '腾讯微云', '查找本人授权的云端文件'],
  ['luckin', '瑞幸咖啡', '使用本人授权的咖啡服务'],
  ['qq_music', 'QQ 音乐', '查询本人授权的音乐服务'],
  ['ima', 'ima', '查找本人授权的知识库与资料'],
  ['mcdonalds', '麦当劳', '查看账号授权范围内的服务'],
  ['didi', '滴滴出行', '使用本人授权的出行服务'],
  ['liepin', '猎聘', '搜索职位、筛选城市和薪资'],
  ['tencent_docs', '腾讯文档', '查找和读取自己的文档'],
  ['yuque', '语雀', '查找知识库和文档'],
  ['notion', 'Notion', '查找、阅读和保存自己的笔记'],
  ['memos', 'Memos', '连接自建笔记，查找和记录日记'],
  ['tencent_meeting', '腾讯会议', '使用账号授权的会议能力'],
  ['feishu', '飞书', '查找工作资料'],
  ['baidu_netdisk', '百度网盘（个人体验）', '查找自己的网盘文件'],
  ['yinxiang', '印象笔记', '查找笔记与笔记本'],
];

export function connectionRows(
  snapshot: ConnectionSnapshot,
  apps: readonly { id: string; name: string }[],
): ConnectionRow[] {
  const native = snapshot.native;
  const local: ConnectionRow[] = [
    {
      key: 'local:notifications',
      name: '通知摘要',
      category: 'local',
      purpose: '只接收你选中应用的新通知，确认后再导入',
      method: 'Android 通知访问',
      status: native
        ? native.notification_access
          ? '权限已开启'
          : '未开启权限'
        : '状态待确认',
      action: '管理权限',
      added: false,
      usable: false,
      attention: false,
      target: { kind: 'notifications' },
    },
    {
      key: 'local:share',
      name: '分享至妥啦',
      category: 'local',
      purpose: '把选中的文字、链接或文件交给妥啦',
      method: '系统分享 / 复制粘贴 · 无需绑定',
      status: '主动导入',
      action: '查看用法',
      added: false,
      usable: false,
      attention: false,
      target: { kind: 'share' },
    },
    {
      key: 'local:files',
      name: '手机文件',
      category: 'local',
      purpose: '只上传你主动选择的资料',
      method: '系统文件选择器',
      status: '按需选择',
      action: '选取文件',
      added: false,
      usable: false,
      attention: false,
      target: { kind: 'files' },
    },
    {
      key: 'local:photos',
      name: '相册与截图',
      category: 'local',
      purpose: '确认云端处理范围后，整理照片并查找内容',
      method: '相册权限 · 云端图片分析与向量索引',
      status:
        snapshot.photoEnabled === true
          ? '索引已开启 · 查看处理状态'
          : snapshot.photoEnabled === false
          ? '索引未开启'
          : '查看权限与状态',
      action: '管理',
      added: snapshot.photoEnabled === true,
      usable:
        snapshot.photoEnabled === true &&
        ['queued', 'scanning', 'analyzing', 'idle'].includes(
          snapshot.photoState || '',
        ),
      attention:
        snapshot.photoEnabled === true &&
        !['queued', 'scanning', 'analyzing', 'idle'].includes(
          snapshot.photoState || '',
        ),
      target: { kind: 'photos' },
    },
    ...apps.map(app => {
      const installed = native?.installed_apps.includes(app.id) ?? false;
      const selected = native?.selected_apps.includes(app.id) ?? false;
      const usable =
        selected &&
        installed &&
        native?.notification_access === true &&
        native.supported;
      return {
        key: 'app:' + app.id,
        name: app.name,
        category: 'local' as const,
        purpose: '接收新通知，或主动分享需要整理的内容',
        method: '通知 / 分享 / 复制导入',
        status: !native
          ? '状态待确认'
          : selected
          ? usable
            ? '通知已开启'
            : !installed
            ? '已选中 · 应用未安装'
            : '待开启通知权限'
          : installed
          ? '手机已安装'
          : '可分享或粘贴导入',
        action: selected ? '管理' : '查看',
        added: selected,
        usable,
        attention: selected && !usable,
        target: { kind: 'app' as const, id: app.id },
      };
    }),
  ];
  // Built-in names enrich server entries; missing/disabled choices are hidden below.
  const providerChoices = [
    ...fallbackMcp,
    ...(snapshot.mcp || [])
      .filter(item => !fallbackMcp.some(([id]) => id === item.id))
      .map(item => [item.id, item.name, item.description]),
  ];
  const providers = providerChoices.map(([id, name, purpose]) => {
    const advertised = snapshot.mcp?.find(item => item.id === id);
    const item =
      snapshot.mcp === null || advertised
        ? snapshot.mcpUpdates?.find(value => value.id === id) || advertised
        : undefined;
    return {
      id,
      name: item?.name || name,
      purpose: item?.description || purpose,
      item,
    };
  });
  const cloud: ConnectionRow[] = providers.map(
    ({ id, name, purpose, item }) => ({
      key: 'mcp:' + id,
      name,
      category: 'cloud',
      purpose,
      method: '个人账号凭证 · 当前服务器加密保存',
      status: !item
        ? snapshot.mcp === null
          ? '服务状态待确认'
          : '当前服务器尚未提供'
        : item.status === 'connected'
        ? '已连接'
        : item.status === 'needs_reconnect'
        ? '需要重新连接'
        : item.status === 'not_configured'
        ? '服务待开通'
        : '未连接',
      action:
        item?.status === 'connected' || item?.status === 'needs_reconnect'
          ? '管理'
          : '查看',
      added: Boolean(
        item?.has_credentials ||
          item?.status === 'connected' ||
          item?.status === 'needs_reconnect',
      ),
      usable: item?.status === 'connected',
      attention: item?.status === 'needs_reconnect',
      unavailable:
        id !== 'github' && (!item || item.status === 'not_configured'),
      target: { kind: 'mcp', id },
    }),
  );
  cloud.push({
    key: 'mcp:alipay',
    name: '支付宝',
    category: 'cloud',
    purpose: snapshot.wallet?.description ?? '正式通道尚未开通，保留个人账号接入入口',
    method: snapshot.wallet?.binding_available ? '本人钱包 · 逐笔确认 · 仅妥啦交易记录' : '服务待开通 · 不读取账单或发起支付',
    status: snapshot.wallet ? walletStatusLabel[snapshot.wallet.status] : '服务待开通',
    action: snapshot.wallet?.binding_available ? '管理钱包' : '查看说明',
    added: snapshot.wallet?.status === 'connected' || snapshot.wallet?.status === 'needs_reconnect',
    usable: snapshot.wallet?.status === 'connected',
    attention: snapshot.wallet?.status === 'needs_reconnect',
    unavailable: !snapshot.wallet?.binding_available,
    target: { kind: 'mcp', id: 'alipay' },
  });
  cloud.push({
    key: 'cloud:more',
    name: '邮箱与更多服务',
    category: 'cloud',
    purpose: '个人邮箱、文档和已开通的公共服务',
    method: '按服务选择实际连接方式',
    status: '查看服务目录',
    action: '查看',
    added: false,
    usable: false,
    attention: false,
    target: { kind: 'integration', id: '*' },
  });
  const integrationChoices: Integration[] = [
    ...(snapshot.integrations || []),
    ...(snapshot.integrations?.some(item => item.id === 'slack') ? [] : [slackIntegration]),
    ...(
      [
        ['qq_mail', 'QQ 邮箱', 'mail', '查找邮件并确认后发送'],
        ['netease163', '163 邮箱', 'mail', '查找邮件并确认后发送'],
        ['netease126', '126 邮箱', 'mail', '查找邮件并确认后发送'],
        ['amap', '高德地图', 'map', '查询地点、路线和天气'],
      ] as const
    )
      .filter(([id]) => !snapshot.integrations?.some(item => item.id === id))
      .map(([id, name, mode, detail]) => ({
        id,
        name,
        mode,
        detail,
        category: mode === 'mail' ? '邮件' : '出行',
        status: 'not_configured' as const,
        ...(mode === 'map' ? { credential_scope: 'user' as const } : {}),
      })),
  ];
  for (const item of integrationChoices) {
    if (item.mode === 'import') continue;
    const userMapSupported =
      item.mode !== 'map' || item.credential_scope === 'user';
    cloud.push({
      key: 'integration:' + item.id,
      name: item.name,
      category: 'cloud',
      purpose: item.detail,
      method:
        item.mode === 'mail'
          ? '本人邮箱 · 客户端授权码'
          : item.mode === 'map'
          ? '自己的开发者 Key · 地图查询'
          : item.mode === 'oauth'
          ? '平台账号授权'
          : '企业应用连接 · 需管理员配置',
      status: !userMapSupported
        ? '服务器需升级'
        : item.status === 'connected'
        ? '已连接'
        : item.status === 'not_configured'
        ? '服务待开通'
        : item.status === 'available'
        ? '可使用'
        : '未连接',
      action: item.status === 'connected' ? '管理' : '查看',
      added: userMapSupported && item.status === 'connected',
      usable: userMapSupported && item.status === 'connected',
      attention: !userMapSupported,
      unavailable: item.status === 'not_configured' || !userMapSupported,
      target: { kind: 'integration', id: item.id },
    });
  }
  const devices: ConnectionRow[] = (['huawei', 'xiaomi'] as const).map(id => {
    const item = snapshot.health?.find(provider => provider.id === id);
    return {
      key: 'health:' + id,
      name: id === 'huawei' ? '华为运动健康' : '小米运动健康',
      category: 'devices',
      purpose:
        id === 'huawei'
          ? '从配对手表的华为账号按需读取步数'
          : '按授权范围读取步数、心率、睡眠等记录',
      method: '厂商健康云 · 个人账号授权',
      status: !item
        ? '服务状态待确认'
        : item.status === 'connected'
        ? '已连接'
        : item.status === 'reconnect_required'
        ? '需要重新授权'
        : item.status === 'not_configured'
        ? '服务待配置'
        : '可连接',
      action: '查看',
      added: Boolean(item?.has_credentials),
      usable: item?.status === 'connected',
      attention: item?.status === 'reconnect_required',
      unavailable: !item || item.status === 'not_configured',
      target: { kind: 'health', id },
    };
  });
  const nativeHealth = snapshot.systemHealth;
  devices.push({
    key: 'health:system',
    name:
      nativeHealth?.provider === 'apple_health'
        ? 'Apple 健康'
        : 'Android 健康连接',
    category: 'devices',
    purpose: '前台按需读取系统中已有的健康记录',
    method: '系统健康只读权限',
    status: !nativeHealth
      ? '兼容性待确认'
      : nativeHealth.status === 'available'
      ? '系统支持 · 查看授权范围'
      : nativeHealth.status === 'requires_update'
      ? '需要更新系统健康服务'
      : '当前设备暂不支持',
    action: '查看',
    added: false,
    usable: false,
    attention: false,
    unavailable: nativeHealth?.status !== 'available',
    target: { kind: 'health', id: 'system' },
  });
  if (nativeHealth?.provider !== 'apple_health')
    devices.push({
      key: 'health:apple',
      name: 'Apple 健康',
      category: 'devices',
      purpose: '通过与 Apple Watch 配对的 iPhone 读取',
      method: '需 iPhone · iOS 版尚待构建验证',
      status: 'Android 不支持直接连接',
      action: '了解接入',
      added: false,
      usable: false,
      attention: false,
      unavailable: true,
      target: { kind: 'health', id: 'apple' },
    });
  return [...local, ...cloud, ...devices].filter(row => !row.unavailable || row.added);
}

export function filterConnectionRows(
  rows: ConnectionRow[],
  category: ConnectionCategory,
  query: string,
  managing: boolean,
) {
  const text = query.trim().toLocaleLowerCase();
  return rows.filter(
    row =>
      (!row.unavailable || row.added) &&
      (!managing || row.added) &&
      (text
        ? [row.name, row.purpose, row.method, row.status]
            .join(' ')
            .toLocaleLowerCase()
            .includes(text)
        : managing || row.category === category),
  );
}

import { NativeModules, Platform } from 'react-native';

export type PermissionFinding = {
  name: string;
  packageName: string;
  grants: string[];
  reasons: string[];
};

type ScanReport = {
  scanned: number;
  flagged: number;
  matched?: number;
  findings: PermissionFinding[];
  unavailable: string[];
};

export const permissionLabels = { microphone: '麦克风', camera: '相机', location: '定位', contacts: '通讯录', sms: '短信',
  accessibility: '无障碍服务', notification_access: '通知使用权' } as const;
export const settingsLabels = { selected_app: '所选应用的详情', privacy: '隐私设置', accessibility: '无障碍设置',
  notification_access: '通知使用权设置' } as const;
export type PermissionFilter = keyof typeof permissionLabels;
export type SettingsDestination = keyof typeof settingsLabels;
export type PermissionQuery = { inspection: 'permissions' | 'access_history'; permission?: PermissionFilter;
  scope?: 'visible_apps' | 'selected_app'; mode?: 'check' | 'reuse' | 'refresh' };
export type DeviceAction = ({ kind: 'app_permission_inspection' } & PermissionQuery) |
  { kind: 'system_settings'; destination: SettingsDestination };
export type PermissionReport = ScanReport & PermissionQuery & { checkedAt?: number; removed?: string[]; added?: string[] };

type InspectionBridge = {
  scan(): Promise<ScanReport>;
  scanPermissions?(permission: PermissionFilter | null, packageName: string | null): Promise<ScanReport>;
  openDeviceSettings?(destination: SettingsDestination, packageName: string | null): Promise<'requested' | 'system_settings'>;
};

function bridge(): InspectionBridge | undefined {
  if (Platform.OS !== 'android') return undefined;
  try {
    return NativeModules.TadaAppPermissionInspection;
  } catch {
    // NativeModules resolves the optional bridge lazily and may throw on lookup.
    return undefined;
  }
}

export function supportsPermissionInspection() {
  return typeof bridge()?.scan === 'function';
}
export function supportsDeviceSettings() {
  return typeof bridge()?.openDeviceSettings === 'function';
}

// Independent local authorization: only the text the user actually sends can
// arm this turn. A request from a server or quoted content cannot arm a scan.
export function detectPermissionInspection(message: string): PermissionReport['inspection'] | undefined {
  const action = detectDeviceAction(message);
  return action?.kind === 'app_permission_inspection' ? action.inspection : action?.destination === 'privacy' ? 'access_history' : undefined;
}

export function detectDeviceAction(message: string, continuing = false, selected = false): DeviceAction | undefined {
  const text = message.normalize('NFKC').trim().toLowerCase().replace(/\ba\s*p\s*p\b/g, 'app');
  if (Array.from(text).length > 120 || /[\r\n「」“”]|不要|不用|别扫描|别检查|不检查|只讲|只告诉|怎么|如何|为什么|这句话|翻译/.test(text)) return;
  const permission = (/麦克风|话筒/.test(text) ? 'microphone' : /相机|摄像头/.test(text) ? 'camera' : /定位|位置权限/.test(text) ? 'location'
    : /通讯录/.test(text) ? 'contacts' : /短信/.test(text) ? 'sms' : /无障碍/.test(text) ? 'accessibility'
    : /通知使用权|通知读取/.test(text) ? 'notification_access' : undefined);
  const localDevice = /我的手机|我手机|本机|这台手机|我这台手机|这个设备|这部手机|这台设备|^手机|看看手机|检查手机/.test(text);
  const prefix = /^(?:那(?:就)?[，, ]*)?(?:请\s*)?(?:你(?:能不能|可以|能)?\s*)?(?:帮我\s*)?/;
  const request = text.replace(prefix, '');
  const asksToInspect = /^(看看|看一下|看下|查查|查一下|检查|扫描|复查|重新|再查|再看)/.test(request);
  if (/^打开/.test(request)) {
    if (/无障碍/.test(request)) return { kind: 'system_settings', destination: 'accessibility' };
    if (/通知使用权|通知读取/.test(request)) return { kind: 'system_settings', destination: 'notification_access' };
    if (/隐私设置|隐私中心|隐私记录/.test(request)) return { kind: 'system_settings', destination: 'privacy' };
    if (selected && /这个|该|它|所选/.test(request) && /设置|权限/.test(request)) return { kind: 'system_settings', destination: 'selected_app' };
  }
  if (selected && /^(关闭|关掉|撤销|取消)/.test(request) && /权限/.test(request) && /这个|该|它/.test(request)) {
    return { kind: 'system_settings', destination: 'selected_app' };
  }
  if ((permission === 'microphone' || permission === 'camera' || permission === 'location') &&
      /谁用|哪些(?:软件|app|应用)用|有没有用|是否用|访问记录|访问历史/.test(text) &&
      (asksToInspect || continuing || /^(昨晚|昨天|今天|刚才|刚刚|最近|后台|它昨晚)/.test(request))) {
    return { kind: 'system_settings', destination: 'privacy' };
  }
  if (continuing && asksToInspect && /^(重新|再查|再看|复查)|现在还有|改好了/.test(request)) {
    return { kind: 'app_permission_inspection', inspection: 'permissions', mode: 'refresh', permission,
      scope: selected ? 'selected_app' : undefined };
  }
  if ((localDevice || continuing) && (asksToInspect || /^哪些|^谁有/.test(request)) &&
      /app|应用|软件|权限/.test(request) && /权限|监控|监视|监听|间谍|窃听/.test(request)) {
    return { kind: 'app_permission_inspection', inspection: 'permissions', permission };
  }
}

export async function inspectAppPermissions(permission?: PermissionFilter, packageName?: string): Promise<ScanReport | undefined> {
  const native = bridge();
  if (!native) return;
  try {
    const report = permission || packageName
      ? await native.scanPermissions?.(permission ?? null, packageName ?? null) : await native.scan();
    if (!report) return;
    if (Number.isInteger(report.scanned) && report.scanned >= 0 && report.scanned <= 50_000 &&
        Number.isInteger(report.flagged) && report.flagged >= 0 && report.flagged <= report.scanned &&
        Array.isArray(report.findings) && Array.isArray(report.unavailable)) return report;
  } catch {
    return undefined;
  }
}

export async function openDeviceSettings(destination: SettingsDestination, packageName?: string) {
  try { return await bridge()?.openDeviceSettings?.(destination, packageName ?? null); }
  catch { return undefined; }
}

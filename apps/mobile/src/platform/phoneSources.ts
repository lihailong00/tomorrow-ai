/** Replace this adapter for iOS/HarmonyOS. A system permission is separate from the user's source selection. */
import {
  DeviceEventEmitter,
  Linking,
  NativeModules,
  Platform,
} from 'react-native';

export const phoneSourceIds = [
  'contacts',
  'calendar',
  'sms',
  'photos',
] as const;
export type PhoneSource = (typeof phoneSourceIds)[number];
export type PhonePermission =
  | 'granted'
  | 'limited'
  | 'requestable'
  | 'blocked'
  | 'unavailable';
export type PhoneRecord = {
  id: string;
  title: string;
  text: string;
  timestamp?: number;
  end?: number;
  allDay?: boolean;
  truncated?: boolean;
  eligibleForTodo?: boolean;
  calendarStatus?:
    | 'unspecified'
    | 'tentative'
    | 'confirmed'
    | 'cancelled'
    | 'deleted'
    | 'unknown';
  uri?: string;
  raw?: Record<string, unknown>;
  data?: Record<string, unknown>[];
};
export type PhoneSnapshot = {
  source: PhoneSource;
  readAt: number;
  permission: PhonePermission;
  limited: boolean;
  items: PhoneRecord[];
  /** All counts describe the full local import, never just the displayed page. */
  total?: number;
  processed?: number;
  cached?: number;
  syncState?: 'queued' | 'running' | 'complete' | 'error';
  syncMode?: 'full' | 'incremental';
  syncError?: string;
  generation?: string;
  cursor?: string;
  nextCursor?: string | null;
};
export type PhoneStatus = {
  permissions: Record<PhoneSource, PhonePermission>;
  timezone: string;
  locale: string;
};
interface PhoneSourcesPort {
  status(): Promise<PhoneStatus>;
  request(source: PhoneSource): Promise<PhonePermission>;
  read(
    source: PhoneSource,
    withContactNames: boolean,
    owner: string,
    force: boolean,
  ): Promise<string>;
  page(
    source: PhoneSource,
    owner: string,
    cursor: string,
    withContactNames: boolean,
  ): Promise<string>;
  record(source: PhoneSource, owner: string, id: string): Promise<string>;
  stop(source: PhoneSource, owner: string): Promise<boolean>;
  suspend(): Promise<boolean>;
  fingerprint(text: string): Promise<string>;
}
const native = NativeModules.TadaPhoneSources as PhoneSourcesPort | undefined;
const supported = Platform.OS === 'android' && Boolean(native);
const permissionValues = new Set<PhonePermission>([
  'granted',
  'limited',
  'requestable',
  'blocked',
  'unavailable',
]);
const calendarStatuses = new Set([
  'unspecified',
  'tentative',
  'confirmed',
  'cancelled',
  'deleted',
  'unknown',
]);
function validRecord(item: PhoneRecord) {
  return (
    Boolean(item) &&
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.text === 'string' &&
    (item.eligibleForTodo === undefined ||
      typeof item.eligibleForTodo === 'boolean') &&
    (item.calendarStatus === undefined ||
      calendarStatuses.has(item.calendarStatus))
  );
}
function port() {
  if (!supported || !native)
    throw new Error('当前系统尚未接入本机资料，你仍可选择文件或分享内容。');
  return native;
}
function validateSource(source: PhoneSource) {
  if (!phoneSourceIds.includes(source)) throw new Error('未知手机资料来源。');
}
function snapshot(raw: string, source: PhoneSource): PhoneSnapshot {
  const result: PhoneSnapshot = JSON.parse(raw);
  if (
    result?.source !== source ||
    !Array.isArray(result.items) ||
    result.items.some(item => !validRecord(item)) ||
    !permissionValues.has(result.permission) ||
    [result.total, result.processed, result.cached].some(
      count =>
        count !== undefined && (!Number.isSafeInteger(count) || count < 0),
    ) ||
    (result.nextCursor != null && !/^\d+$/.test(result.nextCursor))
  )
    throw new Error('手机资料格式异常，请更新 App 后重试。');
  return result;
}
export const canReadPhoneSource = (value: PhonePermission) =>
  value === 'granted' || value === 'limited';
export const phoneSources = {
  supported,
  onChange(listener: () => void): () => void {
    if (!supported) return () => {};
    const subscription = DeviceEventEmitter.addListener(
      'TadaPhoneSourcesChanged',
      listener,
    );
    return () => subscription.remove();
  },
  openSettings: () => Linking.openSettings(),
  async status(): Promise<PhoneStatus> {
    if (!supported)
      return {
        permissions: {
          contacts: 'unavailable',
          calendar: 'unavailable',
          sms: 'unavailable',
          photos: 'unavailable',
        },
        timezone: '',
        locale: '',
      };
    const result = await port().status();
    if (
      !result ||
      phoneSourceIds.some(id => !permissionValues.has(result.permissions?.[id]))
    )
      throw new Error('无法识别系统权限状态。');
    return result;
  },
  async request(source: PhoneSource): Promise<PhonePermission> {
    validateSource(source);
    const result = await port().request(source);
    if (!permissionValues.has(result))
      throw new Error('无法识别系统授权结果。');
    return result;
  },
  async read(
    source: PhoneSource,
    withContactNames = false,
    owner: string,
    force = false,
  ): Promise<PhoneSnapshot> {
    validateSource(source);
    return snapshot(
      await port().read(
        source,
        source === 'sms' && withContactNames,
        owner,
        force,
      ),
      source,
    );
  },
  async page(
    source: PhoneSource,
    owner: string,
    cursor = '0',
    withContactNames = false,
  ): Promise<PhoneSnapshot> {
    validateSource(source);
    if (!/^\d+$/.test(cursor)) throw new Error('资料游标无效，请刷新。');
    return snapshot(
      await port().page(
        source,
        owner,
        cursor,
        source === 'sms' && withContactNames,
      ),
      source,
    );
  },
  async record(
    source: PhoneSource,
    owner: string,
    id: string,
  ): Promise<PhoneRecord> {
    validateSource(source);
    const result: PhoneRecord = JSON.parse(
      await port().record(source, owner, id),
    );
    if (result?.id !== id || !validRecord(result))
      throw new Error('记录格式异常，请刷新。');
    return result;
  },
  async stop(source: PhoneSource, owner: string) {
    validateSource(source);
    await port().stop(source, owner);
  },
  async suspend() {
    if (supported) await port().suspend();
  },
  async fingerprint(text: string): Promise<string> {
    if (text.length > 20000) throw new Error('所选资料过长，请减少选择。');
    const result = await port().fingerprint(text);
    if (!/^[a-f0-9]{64}$/.test(result))
      throw new Error('无法确认资料标识，请重试。');
    return result;
  },
};

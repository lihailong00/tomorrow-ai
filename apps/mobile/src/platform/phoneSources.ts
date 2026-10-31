/** Replace this adapter for iOS/HarmonyOS. A system permission is separate from the user's source selection. */
import { Linking, NativeModules, Platform } from 'react-native';

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
};
export type PhoneSnapshot = {
  source: PhoneSource;
  readAt: number;
  permission: PhonePermission;
  limited: boolean;
  items: PhoneRecord[];
};
export type PhoneStatus = {
  permissions: Record<PhoneSource, PhonePermission>;
  timezone: string;
  locale: string;
};
interface PhoneSourcesPort {
  status(): Promise<PhoneStatus>;
  request(source: PhoneSource): Promise<PhonePermission>;
  read(source: PhoneSource, withContactNames: boolean): Promise<PhoneSnapshot>;
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
function port() {
  if (!supported || !native)
    throw new Error('当前系统尚未接入本机资料，你仍可选择文件或分享内容。');
  return native;
}
function validateSource(source: PhoneSource) {
  if (!phoneSourceIds.includes(source)) throw new Error('未知手机资料来源。');
}
export const canReadPhoneSource = (value: PhonePermission) =>
  value === 'granted' || value === 'limited';
export const phoneSources = {
  supported,
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
  ): Promise<PhoneSnapshot> {
    validateSource(source);
    const result = await port().read(
      source,
      source === 'sms' && withContactNames,
    );
    if (
      result?.source !== source ||
      !Array.isArray(result.items) ||
      result.items.length > (source === 'contacts' ? 200 : 100) ||
      result.items.some(
        item =>
          typeof item.id !== 'string' ||
          typeof item.title !== 'string' ||
          typeof item.text !== 'string',
      )
    ) {
      throw new Error('手机资料格式异常，请更新 App 后重试。');
    }
    return result;
  },
  async fingerprint(text: string): Promise<string> {
    if (text.length > 20000) throw new Error('所选资料过长，请减少选择。');
    const result = await port().fingerprint(text);
    if (!/^[a-f0-9]{64}$/.test(result))
      throw new Error('无法确认资料标识，请重试。');
    return result;
  },
};

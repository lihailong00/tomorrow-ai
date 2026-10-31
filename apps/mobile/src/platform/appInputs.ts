import {NativeModules, Platform} from 'react-native';
import type {LocalFile} from './ports';

/** Platform port: Android currently supports notifications and incoming shares.
 * iOS / HarmonyOS may supply a different native adapter without changing screens.
 * Nothing is uploaded or sent to another app by reading this review inbox.
 */
export const appInputSources = [
  {id: 'wechat', name: '微信'},
  {id: 'qq', name: 'QQ'},
  {id: 'xiaohongshu', name: '小红书'},
  {id: 'bilibili', name: '哔哩哔哩'},
  {id: 'douyin', name: '抖音'},
  {id: 'zhihu', name: '知乎'},
  {id: 'taobao', name: '淘宝'},
  {id: 'jd', name: '京东'},
  {id: 'meituan', name: '美团'},
  {id: 'alipay', name: '支付宝'},
  {id: 'didi', name: '滴滴'},
  {id: 'feishu', name: '飞书'},
  {id: 'dingtalk', name: '钉钉'},
  {id: 'wecom', name: '企业微信'},
  {id: 'wps', name: 'WPS / 金山文档'},
  {id: 'tencent_docs', name: '腾讯文档'},
  {id: 'amap', name: '高德地图'},
] as const;

export type AppInputSourceId = (typeof appInputSources)[number]['id'];
export interface AppInputStatus {
  supported: boolean;
  notification_access: boolean;
  selected_apps: string[];
  installed_apps: string[];
  pending_count: number;
}
export interface AppInputItem {
  id: string;
  source_app: string;
  kind: 'notification' | 'share';
  title: string;
  text: string;
  url?: string;
  file?: LocalFile;
  created_at: string;
}
interface NativeAppInputs {
  getStatus(): Promise<AppInputStatus>;
  setApps(ids: string[]): Promise<void>;
  openNotificationSettings(): Promise<void>;
  listPending(): Promise<AppInputItem[]>;
  dismiss(ids: string[]): Promise<void>;
  clear(): Promise<void>;
  openApp(id: string): Promise<boolean>;
  extractImageText?(uri: string): Promise<string>;
}
const native = NativeModules.TadaAppInputs as NativeAppInputs | undefined;
const supported = Platform.OS === 'android' && Boolean(native);
const sourceIds = new Set<string>(appInputSources.map(app => app.id));
function adapter(): NativeAppInputs {
  if (!supported || !native) {
    throw new Error('此系统尚未接入通知和系统分享。你仍可粘贴文字、链接或选择文件。');
  }
  return native;
}

export const appInputs = {
  supported,
  hasImageTextRecognition: supported && typeof native?.extractImageText === 'function',
  async getStatus(): Promise<AppInputStatus> {
    return supported
      ? adapter().getStatus()
      : {supported: false, notification_access: false, selected_apps: [], installed_apps: [], pending_count: 0};
  },
  async setApps(ids: string[]): Promise<void> {
    if (ids.some(id => !sourceIds.has(id))) {
      throw new Error('不支持的应用。');
    }
    await adapter().setApps([...new Set(ids)]);
  },
  async openNotificationSettings(): Promise<void> {
    await adapter().openNotificationSettings();
  },
  async listPending(): Promise<AppInputItem[]> {
    return supported ? adapter().listPending() : [];
  },
  async dismiss(ids: string[]): Promise<void> {
    if (ids.length > 100) {
      throw new Error('一次最多处理 100 条资料。');
    }
    if (supported) {
      await adapter().dismiss([...new Set(ids)]);
    }
  },
  async clear(): Promise<void> {
    if (supported) {
      await adapter().clear();
    }
  },
  async extractImageText(uri: string): Promise<string> {
    const extract = adapter().extractImageText;
    if (!extract) {
      throw new Error('此设备暂不支持图片文字识别。');
    }
    return extract.call(native, uri);
  },
  async openApp(id: string): Promise<boolean> {
    if (!sourceIds.has(id)) {
      throw new Error('不支持的应用。');
    }
    return supported ? adapter().openApp(id) : false;
  },
};

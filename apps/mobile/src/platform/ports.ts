/** Platform boundary: replace this adapter for iOS / native HarmonyOS.
 * Domain models and screens must not import native modules or platform SDKs.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { InstanceManifest, readInstanceManifest } from '../domain/instance';
import {
  AppState,
  Linking,
  NativeModules,
  Platform,
  Share,
} from 'react-native';

export interface LocalFile {
  uri: string;
  name: string;
  mime_type: string;
  size?: number;
  duration_ms?: number;
}
export type NotificationPermissionStatus = 'granted' | 'requestable' | 'blocked';
interface NativePort {
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureRemove(key: string): Promise<void>;
  getSecureItem(key: string): Promise<string | null>;
  setSecureItem(key: string, value: string): Promise<void>;
  removeSecureItem(key: string): Promise<void>;
  pickDocument(): Promise<LocalFile | null>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<LocalFile | null>;
  requestNotifications(): Promise<boolean>;
  notificationPermissionStatus(): Promise<NotificationPermissionStatus>;
  openNotificationSettings(): Promise<void>;
  clearCache(): Promise<void>;
  showNotification(title: string, body: string): Promise<void>;
}
const native = NativeModules.TomorrowPlatform as
  | Partial<NativePort>
  | undefined;
const volatileSecrets = new Map<string, string>();
let sessionUpdates: Promise<void> = Promise.resolve();
function updateSessionStorage(operation: () => Promise<void>): Promise<void> {
  const next = sessionUpdates.catch(() => {}).then(operation);
  sessionUpdates = next;
  return next;
}
const missing = () =>
  new Error('此设备尚未接入这项系统能力。你仍可使用文字输入。');
const SESSION_KEY = 'tomorrow.session.v1';
const PREFS_KEY = 'tomorrow.preferences.v1';
export interface Preferences {
  serverUrl: string;
  onboarded: boolean;
  serverUrlCustomized?: boolean;
  instance?: InstanceManifest;
  allowInsecureLan?: boolean;
  connectionError?: string;
  pendingConnection?: { url: string; instanceId: string };
}
export const defaultServerUrl =
  'https://api.example.invalid';
const legacyDefaultServer = /^http:\/\/10\.0\.2\.2:8080(?:\/v1)?\/*$/i;

export const platform = {
  // Android resizes its native host from IME insets; iOS uses the avoiding view.
  keyboardBehavior: Platform.OS === 'ios' ? ('padding' as const) : undefined,
  hasSecureStorage: Boolean(
    (native?.getSecureItem &&
      native?.setSecureItem &&
      native?.removeSecureItem) ||
      (native?.secureGet && native?.secureSet && native?.secureRemove),
  ),
  hasDocumentPicker: Boolean(native?.pickDocument),
  hasRecorder: Boolean(native?.startRecording && native?.stopRecording),
  async loadPreferences(): Promise<Preferences> {
    const value = await AsyncStorage.getItem(PREFS_KEY);
    let saved: Partial<Preferences> = {};
    try {
      const parsed: unknown = JSON.parse(value ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        saved = parsed;
      }
    } catch {
      // Losing a self-host preference must never start sending to the official host.
      return { serverUrl: '', onboarded: true, serverUrlCustomized: true,
        connectionError: '本机服务设置已损坏，请重新选择服务器。' };
    }
    if (value !== null && typeof saved.serverUrl !== 'string') {
      return { serverUrl: '', onboarded: true, serverUrlCustomized: true,
        connectionError: '本机服务设置不完整，请重新选择服务器。' };
    }
    const preferences: Preferences = {
      serverUrl:
        typeof saved.serverUrl === 'string'
          ? saved.serverUrl
          : defaultServerUrl,
      onboarded: saved.onboarded === true,
      ...(saved.serverUrlCustomized === true
        ? { serverUrlCustomized: true }
        : {}),
      ...(saved.allowInsecureLan === true ? { allowInsecureLan: true } : {}),
      ...(typeof saved.connectionError === 'string' ? { connectionError: saved.connectionError } : {}),
    };
    if (saved.instance) {
      try { preferences.instance = readInstanceManifest(saved.instance); }
      catch { preferences.connectionError = '保存的服务器身份不兼容，请重新检查连接。'; }
    }
    if (
      !preferences.serverUrlCustomized &&
      legacyDefaultServer.test(preferences.serverUrl.trim())
    ) {
      // The local server's credentials must never follow a service migration.
      await platform.removeSession();
      preferences.serverUrl = defaultServerUrl;
      await platform.savePreferences(preferences);
    }
    return preferences;
  },
  async savePreferences(value: Preferences) {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(value));
  },
  async readSession(): Promise<string | null> {
    await sessionUpdates.catch(() => {});
    if (native?.getSecureItem) {
      return native.getSecureItem(SESSION_KEY);
    }
    return native?.secureGet
      ? native.secureGet(SESSION_KEY)
      : volatileSecrets.get(SESSION_KEY) ?? null;
  },
  async writeSession(value: string) {
    await updateSessionStorage(async () => {
      if (native?.setSecureItem) {
        await native.setSecureItem(SESSION_KEY, value);
      } else if (native?.secureSet) {
        await native.secureSet(SESSION_KEY, value);
      } else {
        volatileSecrets.set(SESSION_KEY, value);
      }
    });
  },
  async removeSession() {
    await updateSessionStorage(async () => {
      volatileSecrets.delete(SESSION_KEY);
      if (native?.removeSecureItem) {
        await native.removeSecureItem(SESSION_KEY);
      } else if (native?.secureRemove) {
        await native.secureRemove(SESSION_KEY);
      }
    });
  },
  async pickDocument(): Promise<LocalFile | null> {
    if (!native?.pickDocument) {
      throw missing();
    }
    return native.pickDocument();
  },
  async startRecording() {
    if (!native?.startRecording) {
      throw missing();
    }
    await native.startRecording();
  },
  async stopRecording(): Promise<LocalFile | null> {
    if (!native?.stopRecording) {
      throw missing();
    }
    return native.stopRecording();
  },
  async requestNotifications(): Promise<boolean> {
    if (!native?.requestNotifications) {
      throw missing();
    }
    return native.requestNotifications();
  },
  async manageNotificationPermission(): Promise<'granted' | 'denied' | 'blocked' | 'settings'> {
    const status = await native?.notificationPermissionStatus?.();
    if (status === 'blocked') {
      await platform.openNotificationSettings();
      return 'settings';
    }
    if (await platform.requestNotifications()) return 'granted';
    return (await native?.notificationPermissionStatus?.()) === 'blocked' ? 'blocked' : 'denied';
  },
  async openNotificationSettings(): Promise<void> {
    if (native?.openNotificationSettings) {
      await native.openNotificationSettings();
    } else {
      await Linking.openSettings();
    }
  },
  async showNotification(title: string, body: string) {
    if (!native?.showNotification) {
      throw missing();
    }
    await native.showNotification(title, body);
  },
  isForeground: () => AppState.currentState === 'active',
  onForeground(listener: () => void): () => void {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        listener();
      }
    });
    return () => subscription.remove();
  },
  async clearCache() {
    if (native?.clearCache) {
      await native.clearCache();
    }
  },
  async share(text: string, title?: string) {
    await Share.share({ message: text, title });
  },
  async openUrl(url: string) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('只允许打开网页链接。');
    }
    await Linking.openURL(url);
  },
  initialConnectionLink: () => Linking.getInitialURL(),
  onConnectionLink(listener: (url: string) => void): () => void {
    const subscription = Linking.addEventListener('url', event => listener(event.url));
    return () => subscription.remove();
  },
};

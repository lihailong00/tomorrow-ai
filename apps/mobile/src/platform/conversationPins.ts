import { NativeModules } from 'react-native';

type SecureStorage = {
  getSecureItem?(key: string): Promise<string | null>;
  setSecureItem?(key: string, value: string): Promise<void>;
  secureGet?(key: string): Promise<string | null>;
  secureSet?(key: string, value: string): Promise<void>;
};

/** Conversation titles stay in the same encrypted native vault as other private data. */
export const conversationPinStorage = {
  async load(key: string): Promise<string | null> {
    const native = NativeModules.TomorrowPlatform as SecureStorage | undefined;
    const get = native?.getSecureItem ?? native?.secureGet;
    if (!native || !get) return null;
    return get.call(native, key);
  },
  async save(key: string, value: string): Promise<void> {
    const native = NativeModules.TomorrowPlatform as SecureStorage | undefined;
    const set = native?.setSecureItem ?? native?.secureSet;
    if (!native || !set) throw new Error('此设备暂时无法安全保存置顶记录。');
    await set.call(native, key, value);
  },
};

import { NativeModules } from 'react-native';
import {
  parseHealthRead,
  type HealthBucket,
  type HealthProvider,
} from './types';

type SecurePort = {
  getSecureItem?(key: string): Promise<string | null>;
  setSecureItem?(key: string, value: string): Promise<void>;
  removeSecureItem?(key: string): Promise<void>;
  secureGet?(key: string): Promise<string | null>;
  secureSet?(key: string, value: string): Promise<void>;
  secureRemove?(key: string): Promise<void>;
};
const port = () => NativeModules.TomorrowPlatform as SecurePort | undefined;
function methods() {
  const native = port();
  const get = native?.getSecureItem ?? native?.secureGet;
  const set = native?.setSecureItem ?? native?.secureSet;
  const remove = native?.removeSecureItem ?? native?.secureRemove;
  return native && get && set && remove
    ? {
        get: (key: string) => get.call(native, key),
        set: (key: string, value: string) => set.call(native, key, value),
        remove: (key: string) => remove.call(native, key),
      }
    : null;
}
export function healthStorageKey(
  userId: string,
  serverUrl: string,
  instanceId: string,
): string {
  return (
    'tada.health.v1.' +
    encodeURIComponent(
      JSON.stringify([serverUrl.replace(/\/+$/, ''), instanceId, userId]),
    )
  );
}
export const healthStorageAvailable = () => Boolean(methods());
const providers: HealthProvider[] = [
  'huawei',
  'xiaomi',
  'health_connect',
  'apple_health',
];
export async function loadHealthBuckets(key: string): Promise<HealthBucket[]> {
  const raw = await methods()?.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.buckets) ||
      parsed.buckets.length > 4
    )
      throw new Error();
    const seen = new Set<string>();
    return parsed.buckets.map((bucket: HealthBucket) => {
      if (!providers.includes(bucket.provider) || seen.has(bucket.provider))
        throw new Error();
      seen.add(bucket.provider);
      return { ...parseHealthRead(bucket), provider: bucket.provider };
    });
  } catch {
    throw new Error('本机健康记录无法读取，可清除本机记录后重新同步。');
  }
}
export async function saveHealthBuckets(
  key: string,
  buckets: HealthBucket[],
): Promise<boolean> {
  const secure = methods();
  if (!secure) return false;
  // Bounded encrypted storage only. Never fall back to plaintext AsyncStorage.
  const normalized = buckets
    .slice(0, 4)
    .map(bucket => ({ ...parseHealthRead(bucket), provider: bucket.provider }));
  if (!normalized.length) await secure.remove(key);
  else
    await secure.set(key, JSON.stringify({ version: 1, buckets: normalized }));
  return true;
}
export async function clearHealthBuckets(key: string) {
  await methods()?.remove(key);
}

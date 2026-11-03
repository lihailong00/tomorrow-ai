import { NativeModules } from 'react-native';

export type DeviceLocationErrorCode = 'unsupported' | 'permission_denied' | 'permission_blocked' |
  'services_disabled' | 'no_activity' | 'busy' | 'timeout' | 'cancelled' | 'unavailable' | 'invalid_result';
export class DeviceLocationError extends Error {
  constructor(public code: DeviceLocationErrorCode, message: string) { super(message); this.name = 'DeviceLocationError'; }
}
export interface DeviceLocationStatus {
  supported: boolean;
  permission: 'granted' | 'denied' | 'blocked';
  accuracy: 'precise' | 'approximate' | 'none';
  services_enabled: boolean;
}
export interface DeviceCoordinates {
  latitude: number;
  longitude: number;
  accuracy_m: number;
  observed_at: string;
  coordinate_system: 'wgs84';
  source: 'current' | 'last_known';
  age_ms: number;
  stale: boolean;
}
interface DeviceLocationPort {
  status(): Promise<DeviceLocationStatus>;
  requestCurrentLocation(requestId: string): Promise<DeviceCoordinates>;
  cancelCurrentLocation(requestId: string): Promise<void>;
  openAppSettings(): Promise<void>;
  openLocationSettings(): Promise<void>;
}
const messages: Record<DeviceLocationErrorCode, string> = {
  unsupported: '此设备暂不支持系统定位，请手动选择地点。', permission_denied: '未允许定位，可重试或手动选择地点。',
  permission_blocked: '定位权限未开放，请在系统设置中允许或手动选择地点。', services_disabled: '系统定位服务已关闭，请开启后重试。',
  no_activity: '请在应用前台获取位置。', busy: '请先完成当前定位或权限选择。', timeout: '暂时未能取得有效位置，请重试或手动选择地点。',
  cancelled: '定位已取消。', unavailable: '暂时无法取得系统位置，请手动选择地点。', invalid_result: '系统返回的位置无效或过期，请重试。',
};
function failure(code: DeviceLocationErrorCode) { return new DeviceLocationError(code, messages[code]); }
function port(): DeviceLocationPort {
  const native = NativeModules.TadaDeviceLocation as DeviceLocationPort | undefined;
  if (!native) throw failure('unsupported');
  return native;
}
function mappedError(error: unknown): DeviceLocationError {
  if (error instanceof DeviceLocationError) return error;
  const code = String((error as { code?: unknown } | null)?.code ?? '').replace(/^E_LOCATION_/, '').toLowerCase();
  const normalized = code === 'invalid' ? 'invalid_result' : code;
  return failure(Object.prototype.hasOwnProperty.call(messages, normalized) ? normalized as DeviceLocationErrorCode : 'unavailable');
}
export function readDeviceCoordinates(value: unknown): DeviceCoordinates {
  const row = value as Partial<DeviceCoordinates> | null;
  if (!row || typeof row !== 'object' ||
      typeof row.latitude !== 'number' || !Number.isFinite(row.latitude) || row.latitude < -90 || row.latitude > 90 ||
      typeof row.longitude !== 'number' || !Number.isFinite(row.longitude) || row.longitude < -180 || row.longitude > 180 ||
      typeof row.accuracy_m !== 'number' || !Number.isFinite(row.accuracy_m) || row.accuracy_m < 0 ||
      row.coordinate_system !== 'wgs84' || !['current', 'last_known'].includes(row.source ?? '') ||
      typeof row.age_ms !== 'number' || !Number.isSafeInteger(row.age_ms) || row.age_ms < 0 || row.age_ms > 300000 ||
      typeof row.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observed_at) ||
      !Number.isFinite(Date.parse(row.observed_at)) || Date.parse(row.observed_at) <= 0 || new Date(row.observed_at).toISOString() !== row.observed_at ||
      typeof row.stale !== 'boolean' || row.stale !== (row.source === 'last_known' || row.age_ms > 30000)) throw failure('invalid_result');
  return { latitude: row.latitude, longitude: row.longitude, accuracy_m: row.accuracy_m,
    observed_at: row.observed_at, coordinate_system: 'wgs84', source: row.source as DeviceCoordinates['source'], age_ms: row.age_ms, stale: row.stale };
}
let nextRequest = 0;
export const deviceLocation = {
  async status(): Promise<DeviceLocationStatus> {
    if (!NativeModules.TadaDeviceLocation) return { supported: false, permission: 'denied', accuracy: 'none', services_enabled: false };
    try {
      const value = await port().status();
      if (typeof value?.supported !== 'boolean' || typeof value.services_enabled !== 'boolean' ||
          !['granted', 'denied', 'blocked'].includes(value.permission) || !['precise', 'approximate', 'none'].includes(value.accuracy) ||
          (value.permission === 'granted') !== (value.accuracy !== 'none')) throw failure('invalid_result');
      return value;
    } catch (error) { throw mappedError(error); }
  },
  async requestCurrentLocation(signal?: AbortSignal): Promise<DeviceCoordinates> {
    if (signal?.aborted) throw failure('cancelled');
    const native = port();
    const id = `location-${Date.now()}-${++nextRequest}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      const finish = (action: () => void) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); action(); };
      const abort = () => {
        if (settled) return;
        if (started) { try { Promise.resolve(native.cancelCurrentLocation(id)).catch(() => {}); } catch { /* Late results stay hidden even if native cancellation fails. */ } }
        finish(() => reject(failure('cancelled')));
      };
      signal?.addEventListener('abort', abort);
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        if (settled) return;
        started = true;
        return native.requestCurrentLocation(id);
      }).then(value => {
        if (settled) return;
        try { const coordinates = readDeviceCoordinates(value); finish(() => resolve(coordinates)); }
        catch (error) { finish(() => reject(mappedError(error))); }
      }).catch(error => finish(() => reject(mappedError(error))));
    });
  },
  async openAppSettings(): Promise<void> { try { await port().openAppSettings(); } catch (error) { throw mappedError(error); } },
  async openLocationSettings(): Promise<void> { try { await port().openLocationSettings(); } catch (error) { throw mappedError(error); } },
  async openSettings(reason: 'permission' | 'services' = 'permission'): Promise<void> {
    return reason === 'services' ? deviceLocation.openLocationSettings() : deviceLocation.openAppSettings();
  },
};

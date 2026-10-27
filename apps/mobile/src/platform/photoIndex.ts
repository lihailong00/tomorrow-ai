/** Platform boundary for Android; iOS/HarmonyOS implement this same contract. */
import { NativeModules } from 'react-native';
import type { ApiClient } from '../api/client';

export type PhotoIndexStatus = {
  deviceId: string;
  enabled: boolean;
  state: string;
  lastSyncAt: number;
};
export type PhotoAsset = {
  asset_id: string;
  revision: string;
  metadata: {
    width: number | null;
    height: number | null;
    taken_at: number | null;
    mime_type: string;
  };
  results: {
    kind: 'ocr' | 'labels' | 'description';
    processor: string;
    content: string;
  }[];
  facts?: {
    kind: string;
    value: string;
    evidence: string;
    source_kind: string;
    confidence: number;
    needs_confirmation: boolean;
  }[];
  facts_processor?: string;
};
interface PhotoIndexPort {
  status(server: string, user: string): Promise<PhotoIndexStatus>;
  requestAccess(): Promise<boolean>;
  manageAccess(): Promise<unknown>;
  enable(server: string, user: string, epoch: number): Promise<unknown>;
  disable(): Promise<unknown>;
  scanNow(): Promise<unknown>;
  clearLocal(server: string, user: string): Promise<unknown>;
  openAsset(server: string, user: string, asset: string): Promise<unknown>;
}
const native = NativeModules.TomorrowPhotoIndex as PhotoIndexPort | undefined;
export const photoIndexAvailable = Boolean(native);
function port(): PhotoIndexPort {
  if (!native) throw new Error('当前设备暂不支持相册索引。');
  return native;
}
export const photoIndexPath = (device: string) =>
  `/photo-index/devices/${encodeURIComponent(device)}`;
export const photoIndex = {
  // No network request: terminate background access before changing an owner/server.
  suspend: () => native ? native.disable() : Promise.resolve(),
  status: (server: string, user: string) => port().status(server, user),
  async enable(api: ApiClient, user: string) {
    const device = await port().status(api.baseUrl, user);
    if (!(await port().requestAccess()))
      throw new Error('未获得相册访问权限，索引保持关闭。');
    const path = photoIndexPath(device.deviceId);
    const consent = await api.request<{ enabled: boolean; epoch: number }>(
      path,
      'PUT',
      { enabled: true, cloud_processing: true },
    );
    try {
      await port().enable(api.baseUrl, user, consent.epoch);
    } catch (error) {
      await port()
        .disable()
        .catch(() => {});
      await api.request(path, 'PUT', { enabled: false }).catch(() => {});
      throw error;
    }
  },
  async disable(api: ApiClient, user: string) {
    const device = await port().status(api.baseUrl, user);
    await port().disable(); // Stop local access even when the phone is offline.
    try {
      await api.request(photoIndexPath(device.deviceId), 'PUT', {
        enabled: false,
      });
    } catch {
      throw new Error(
        '本机已停止扫描；云端关闭状态尚未确认，请联网后再次点击“关闭索引”。',
      );
    }
  },
  async clear(api: ApiClient, user: string) {
    const device = await port().status(api.baseUrl, user);
    await port().disable();
    await api.request(photoIndexPath(device.deviceId), 'DELETE');
    await port().clearLocal(api.baseUrl, user);
  },
  scanNow: () => port().scanNow(),
  manageAccess: () => port().manageAccess(),
  openAsset: (server: string, user: string, asset: string) =>
    port().openAsset(server, user, asset),
};

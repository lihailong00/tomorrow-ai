import { NativeModules, Platform } from 'react-native';
import {
  parseHealthRead,
  type HealthMetric,
  type HealthReadResult,
} from './types';

export type HealthAvailability = {
  provider: 'health_connect' | 'apple_health';
  status: 'available' | 'unavailable' | 'requires_update';
  detail: string;
};
type HealthBridge = {
  availability(): Promise<HealthAvailability>;
  requestReadPermissions(
    metrics: HealthMetric[],
  ): Promise<{ requested: string[]; granted?: string[] }>;
  readRecords(options: {
    metrics: HealthMetric[];
    days: number;
  }): Promise<HealthReadResult>;
  openSettings(): Promise<void>;
};
const bridge = () => NativeModules.TadaHealth as HealthBridge | undefined;
export const nativeHealth = {
  async availability(): Promise<HealthAvailability> {
    const native = bridge();
    const provider = Platform.OS === 'ios' ? 'apple_health' : 'health_connect';
    if (
      !native?.availability ||
      !native?.requestReadPermissions ||
      !native?.readRecords
    )
      return {
        provider,
        status: 'unavailable',
        detail:
          '此版本或设备尚未提供系统健康数据读取能力。厂商账号连接可单独配置。',
      };
    const result = await native.availability();
    if (
      !result ||
      !['health_connect', 'apple_health'].includes(result.provider) ||
      !['available', 'unavailable', 'requires_update'].includes(
        result.status,
      ) ||
      typeof result.detail !== 'string'
    )
      throw new Error('无法确认系统健康能力，请更新客户端。');
    return result;
  },
  async read(metrics: HealthMetric[]) {
    const native = bridge();
    if (!native) throw new Error('此设备暂不支持系统健康读取。');
    await native.requestReadPermissions(metrics);
    return parseHealthRead(await native.readRecords({ metrics, days: 7 }));
  },
  async settings() {
    const native = bridge();
    if (!native?.openSettings)
      throw new Error('请在系统设置的健康数据权限中管理授权。');
    await native.openSettings();
  },
};

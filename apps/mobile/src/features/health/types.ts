export const healthMetrics = [
  'steps',
  'heart_rate',
  'sleep',
  'workout',
  'weight',
  'active_energy',
] as const;
export type HealthMetric = (typeof healthMetrics)[number];
export type HealthProvider =
  | 'huawei'
  | 'xiaomi'
  | 'health_connect'
  | 'apple_health';
export type HealthRecord = {
  id: string;
  source: string;
  metric: HealthMetric;
  start_at: string;
  end_at: string;
  value: number;
  unit: string;
  source_app?: string;
  source_device?: string;
  source_id?: string;
  sleep_basis?: 'asleep_stages' | 'session_duration';
};
export type HealthReadResult = {
  records: HealthRecord[];
  synced_at: string;
  truncated?: boolean;
  granted?: HealthMetric[];
  unavailable_metrics?: HealthMetric[];
};
export type HealthConnection = {
  id: 'huawei' | 'xiaomi';
  name: string;
  status: 'not_configured' | 'available' | 'connected' | 'reconnect_required';
  detail: string;
  metrics: HealthMetric[];
  granted_metrics?: HealthMetric[];
  has_credentials: boolean;
  last_sync_at?: string | null;
};
export type HealthReceipt = {
  provider: HealthConnection['id'];
  receipt: string;
};
export type HealthBucket = HealthReadResult & { provider: HealthProvider };
export const metricLabels: Record<HealthMetric, string> = {
  steps: '步数',
  heart_rate: '心率',
  sleep: '睡眠',
  workout: '运动',
  weight: '体重',
  active_energy: '活动消耗',
};
export const providerLabels: Record<HealthProvider, string> = {
  huawei: '华为运动健康',
  xiaomi: '小米运动健康',
  health_connect: 'Health Connect',
  apple_health: 'Apple 健康',
};

const validTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value));

/** Treat provider and native replies as untrusted; never persist arbitrary payloads. */
export function parseHealthRead(value: unknown): HealthReadResult {
  const data = value as Partial<HealthReadResult> | null;
  if (
    !data ||
    !Array.isArray(data.records) ||
    data.records.length > 2000 ||
    !validTime(data.synced_at)
  )
    throw new Error('健康数据格式无法识别，请更新客户端或联系服务管理员。');
  const unique = new Map<string, HealthRecord>();
  for (const raw of data.records) {
    if (
      !raw ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      raw.id.length > 300 ||
      typeof raw.source !== 'string' ||
      !raw.source ||
      raw.source.length > 300 ||
      !healthMetrics.includes(raw.metric) ||
      !validTime(raw.start_at) ||
      !validTime(raw.end_at) ||
      Date.parse(raw.end_at) < Date.parse(raw.start_at) ||
      typeof raw.value !== 'number' ||
      !Number.isFinite(raw.value) ||
      raw.value < 0 ||
      typeof raw.unit !== 'string' ||
      !raw.unit ||
      raw.unit.length > 40
    )
      throw new Error('健康记录包含无效字段，本次数据未保存。');
    const record: HealthRecord = {
      id: raw.id,
      source: raw.source,
      metric: raw.metric,
      start_at: raw.start_at,
      end_at: raw.end_at,
      value: raw.value,
      unit: raw.unit,
    };
    if (typeof raw.source_app === 'string' && raw.source_app.length <= 300)
      record.source_app = raw.source_app;
    if (typeof raw.source_id === 'string' && raw.source_id.length <= 300)
      record.source_id = raw.source_id;
    if (
      typeof raw.source_device === 'string' &&
      raw.source_device.length <= 300
    )
      record.source_device = raw.source_device;
    if (['asleep_stages', 'session_duration'].includes(raw.sleep_basis ?? ''))
      record.sleep_basis = raw.sleep_basis;
    unique.set(
      JSON.stringify([
        record.source,
        record.source_app,
        record.source_id,
        record.metric,
        record.id,
      ]),
      record,
    );
  }
  const result: HealthReadResult = {
    records: [...unique.values()].sort(
      (a, b) => Date.parse(b.end_at) - Date.parse(a.end_at),
    ),
    synced_at: data.synced_at,
  };
  if (typeof data.truncated === 'boolean') result.truncated = data.truncated;
  for (const key of ['granted', 'unavailable_metrics'] as const) {
    if (Array.isArray(data[key]))
      result[key] = [
        ...new Set(data[key]!.filter(metric => healthMetrics.includes(metric))),
      ];
  }
  return result;
}

export function parseHealthConnections(value: unknown): HealthConnection[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length > 2)
    throw new Error('健康连接状态无法识别，请确认服务器已升级。');
  const seen = new Set<string>();
  return items.map(raw => {
    if (
      !raw ||
      !['huawei', 'xiaomi'].includes(raw.id) ||
      seen.has(raw.id) ||
      ![
        'not_configured',
        'available',
        'connected',
        'reconnect_required',
      ].includes(raw.status) ||
      typeof raw.name !== 'string' ||
      typeof raw.detail !== 'string' ||
      typeof raw.has_credentials !== 'boolean' ||
      !Array.isArray(raw.metrics) ||
      raw.metrics.some(
        (metric: unknown) => !healthMetrics.includes(metric as HealthMetric),
      ) ||
      (raw.granted_metrics !== undefined &&
        (!Array.isArray(raw.granted_metrics) ||
          raw.granted_metrics.some(
            (metric: unknown) => !raw.metrics.includes(metric),
          )))
    )
      throw new Error('健康连接状态无法识别，请确认服务器已升级。');
    seen.add(raw.id);
    return raw as HealthConnection;
  });
}

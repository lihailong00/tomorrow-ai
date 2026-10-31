import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { errorMessage, type ApiClient } from '../../api/client';
import { useApp } from '../../app/context';
import { platform } from '../../platform/ports';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  IconButton,
  Notice,
  Pill,
} from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { healthApi, healthAuthorizationUrl } from './api';
import { nativeHealth, type HealthAvailability } from './native';
import {
  clearHealthBuckets,
  healthStorageAvailable,
  healthStorageKey,
  loadHealthBuckets,
  saveHealthBuckets,
} from './storage';
import {
  metricLabels,
  providerLabels,
  type HealthBucket,
  type HealthConnection,
  type HealthMetric,
  type HealthProvider,
  type HealthReadResult,
  type HealthReceipt,
} from './types';

let nextHealthSession = 0;
export function HealthScreen({
  initialReceipt,
}: { initialReceipt?: HealthReceipt } = {}) {
  const { api, user, preferences, back } = useApp();
  // A deep-link offer belongs to the account and instance that received it.
  // Re-rendering it after an identity switch must not offer it to the new owner.
  const offer = useMemo(
    () => ({
      value:
        initialReceipt &&
        ['huawei', 'xiaomi'].includes(initialReceipt.provider) &&
        /^[A-Za-z0-9_-]{43}$/.test(initialReceipt.receipt)
          ? initialReceipt
          : undefined,
      api,
      userId: user?.id,
      server: preferences.serverUrl,
      instance: preferences.instance?.id,
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }),
    [initialReceipt?.provider, initialReceipt?.receipt],
  );
  const initial =
    offer.api === api &&
    offer.userId === user?.id &&
    offer.server === preferences.serverUrl &&
    offer.instance === preferences.instance?.id
      ? offer.value
      : undefined;
  const session = useMemo(
    () => ({ id: ++nextHealthSession }),
    [
      api,
      user?.id,
      preferences.serverUrl,
      preferences.instance?.id,
      initialReceipt?.provider,
      initialReceipt?.receipt,
    ],
  );
  return user ? (
    <HealthSession
      key={session.id}
      api={api}
      back={back}
      initialReceipt={initial}
      storageKey={healthStorageKey(
        user.id,
        api.baseUrl,
        preferences.instance?.id ?? '',
      )}
    />
  ) : null;
}

const statuses: Record<HealthConnection['status'], string> = {
  not_configured: '待配置',
  available: '未连接',
  connected: '已连接',
  reconnect_required: '需要重新连接',
};
const nativeMetrics: HealthMetric[] = [
  'steps',
  'heart_rate',
  'sleep',
  'workout',
  'weight',
];
function dateLabel(value: string) {
  return new Date(value).toLocaleString();
}
function MetricSelection({
  values,
  selected,
  disabled,
  onChange,
}: {
  values: HealthMetric[];
  selected: HealthMetric[];
  disabled: boolean;
  onChange: (metric: HealthMetric) => void;
}) {
  return (
    <View style={v.wrap}>
      {values.map(metric => (
        <Pressable
          key={metric}
          accessibilityRole="checkbox"
          accessibilityLabel={'读取' + metricLabels[metric]}
          accessibilityState={{ checked: selected.includes(metric), disabled }}
          disabled={disabled}
          onPress={() => onChange(metric)}
          style={[v.chip, selected.includes(metric) && v.selected]}
        >
          <Text style={[s.small, selected.includes(metric) && v.selectedText]}>
            {selected.includes(metric) ? '✓ ' : ''}
            {metricLabels[metric]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function HealthSession({
  api,
  storageKey,
  back,
  initialReceipt,
}: {
  api: ApiClient;
  storageKey: string;
  back: () => void;
  initialReceipt?: HealthReceipt;
}) {
  const scope = useMemo(
    () => ({
      active: false,
      controller: new AbortController(),
      refresh: 0,
      revision: 0,
      refreshing: false,
    }),
    [],
  );
  const client = useMemo(
    () => healthApi(api, () => scope.controller.signal),
    [api, scope],
  );
  const locked = useRef(false);
  const [connections, setConnections] = useState<HealthConnection[]>([]);
  const catalog = useRef(connections);
  catalog.current = connections;
  const [receiptProvider, setReceiptProvider] = useState<
    HealthConnection['id']
  >(initialReceipt?.provider ?? 'huawei');
  const [receipt, setReceipt] = useState(initialReceipt?.receipt ?? '');
  const form = useRef({ receipt, provider: receiptProvider });
  form.current = { receipt, provider: receiptProvider };
  const [availability, setAvailability] = useState<HealthAvailability | null>(
    null,
  );
  const [buckets, setBuckets] = useState<HealthBucket[]>([]);
  const bucketRef = useRef<HealthBucket[]>([]);
  const [selection, setSelection] = useState<HealthMetric[]>(['steps']);
  const [source, setSource] = useState<HealthProvider | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [durable, setDurable] = useState(healthStorageAvailable());

  const refresh = useCallback(async () => {
    if (!scope.active || scope.refreshing || locked.current) return;
    scope.refreshing = true;
    const sequence = ++scope.refresh;
    setRefreshing(true);
    const result = await Promise.allSettled([
      client.list(),
      nativeHealth.availability(),
    ]);
    if (!scope.active || sequence !== scope.refresh) return;
    scope.refreshing = false;
    setRefreshing(false);
    if (result[0].status === 'fulfilled') setConnections(result[0].value);
    else {
      setConnections([]);
      setError('厂商连接状态读取失败：' + errorMessage(result[0].reason));
    }
    if (result[1].status === 'fulfilled') setAvailability(result[1].value);
    else {
      setAvailability(null);
      setError('系统健康能力检查失败，请重试。');
    }
  }, [client, scope]);

  useEffect(() => {
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    scope.active = true;
    const revision = scope.revision;
    void loadHealthBuckets(storageKey)
      .then(saved => {
        if (scope.active && scope.revision === revision) {
          bucketRef.current = saved;
          setBuckets(saved);
          setSource(saved[0]?.provider ?? null);
        }
      })
      .catch(failure => {
        if (scope.active) setError(errorMessage(failure));
      });
    void refresh();
    const unsubscribe = platform.onForeground(() => {
      void refresh();
    });
    return () => {
      scope.active = false;
      ++scope.refresh;
      scope.refreshing = false;
      scope.controller.abort();
      unsubscribe();
    };
  }, [scope, refresh, storageKey]);

  const run = async (operation: string, action: () => Promise<void>) => {
    if (!scope.active || locked.current) return;
    locked.current = true;
    ++scope.revision;
    ++scope.refresh;
    scope.refreshing = false;
    setRefreshing(false);
    setBusy(operation);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (scope.active) setError(errorMessage(failure));
    } finally {
      locked.current = false;
      if (scope.active) setBusy(null);
    }
  };

  const remember = async (
    provider: HealthProvider,
    result: HealthReadResult,
    requested: HealthMetric[],
  ) => {
    if (!scope.active) return;
    // A partial grant is valid; never retain fields outside the requested types.
    const filtered = {
      ...result,
      records: result.records.filter(record =>
        requested.includes(record.metric),
      ),
    };
    const next = [
      ...bucketRef.current.filter(bucket => bucket.provider !== provider),
      { ...filtered, provider },
    ];
    bucketRef.current = next;
    setBuckets(next);
    setSource(provider);
    try {
      const saved = await saveHealthBuckets(storageKey, next);
      if (scope.active) {
        setDurable(saved);
        setNotice(
          filtered.records.length
            ? `读取到 ${filtered.records.length} 条记录。${
                saved ? '已加密保存在本机。' : '仅在当前页面内存保留。'
              }`
            : '没有读取到所选项目的记录。可能尚未同步、未授权，或设备没有这些数据；不会将空记录视为零。',
        );
      }
    } catch {
      if (scope.active) {
        setDurable(false);
        setNotice('已读取记录，但本机加密保存失败，仅在当前页面内存保留。');
      }
    }
  };

  const confirmCloud = (title: string, action: () => void) => {
    if (!scope.active || locked.current) return;
    Alert.alert(
      title,
      `厂商授权凭据由当前服务器保存。读取的健康记录会经过当前服务器，再返回本机；本版不会自动发送给 AI。\n\n当前服务器：${api.baseUrl}\n\n自建用户请确认这是自己的服务器。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '同意并继续',
          onPress: () => {
            if (scope.active) action();
          },
        },
      ],
    );
  };
  const requested = (connection: HealthConnection) =>
    selection.filter(metric => connection.metrics.includes(metric));
  const readable = (connection: HealthConnection) =>
    requested(connection).filter(
      metric =>
        connection.granted_metrics === undefined ||
        connection.granted_metrics.includes(metric),
    );
  const authorize = (connection: HealthConnection) =>
    confirmCloud('连接' + connection.name, () => {
      void run(connection.id, async () => {
        setReceipt('');
        setReceiptProvider(connection.id);
        const metrics = requested(connection);
        if (!metrics.length) throw new Error('请先选择该来源支持的读取项目。');
        const result = await client.authorize(connection.id, metrics);
        if (!scope.active) return;
        const url = healthAuthorizationUrl(
          connection.id,
          result.authorization_url,
        );
        await platform.openUrl(url);
        if (scope.active)
          setNotice(
            '完成厂商授权后，请返回妥啦输入一次性确认码并确认连接。连接完成后仍需单独点击读取记录。',
          );
      });
    });
  const finalize = () => {
    if (!scope.active || locked.current) return;
    const code = receipt.trim();
    const provider = receiptProvider;
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      setError('请输入厂商授权完成页面提供的43位一次性确认码。');
      return;
    }
    const configured = () =>
      catalog.current.some(
        item => item.id === provider && item.status !== 'not_configured',
      );
    if (!configured()) {
      setError('此厂商通道尚未配置，请先联系服务管理员。');
      return;
    }
    Alert.alert(
      '完成健康账号连接',
      `将刚才授权的${providerLabels[provider]}连接到当前已登录的妥啦账号。请确认授权是你本人刚刚发起的；确认码只保留在当前页面，不会存入本机记录。当前服务器会读取少量已授权数据验证接口，不保存这些探测记录；完整记录需要你另行点击读取。\n\n当前服务器：${api.baseUrl}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '确认连接',
          onPress: () => {
            if (
              !scope.active ||
              !configured() ||
              form.current.receipt.trim() !== code ||
              form.current.provider !== provider
            )
              return;
            void run('finalize', async () => {
              const result = await client.finalize(provider, code);
              if (!scope.active) return;
              if (result.connected !== true || result.provider !== provider)
                throw new Error('服务器未确认连接结果，请重新发起授权。');
              form.current.receipt = '';
              setReceipt('');
              const list = await client.list();
              if (scope.active) {
                setConnections(list);
                setNotice('健康账号连接已确认。你可以再选择需要读取的记录。');
              }
            });
          },
        },
      ],
    );
  };
  const sync = (connection: HealthConnection) =>
    confirmCloud('读取最近七天健康记录', () => {
      void run(connection.id, async () => {
        const metrics = readable(connection);
        if (!metrics.length)
          throw new Error('所选项目尚未授权，请点击“调整授权项目”后重试。');
        const result = await client.sync(connection.id, metrics);
        if (scope.active) {
          await remember(connection.id, result, metrics);
          const list = await client.list();
          if (scope.active) setConnections(list);
        }
      });
    });
  const disconnect = (connection: HealthConnection) =>
    Alert.alert(
      '断开' + connection.name,
      '将删除当前服务器保存的连接凭据及本机该来源记录。厂商侧授权可能仍存在，请同时在厂商账号设置中撤销。不会删除厂商原始健康记录。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '断开并清除',
          style: 'destructive',
          onPress: () => {
            void run(connection.id, async () => {
              const result = await client.disconnect(connection.id);
              if (!scope.active) return;
              if (result.local_credentials_removed !== true)
                throw new Error('服务器未确认移除连接凭据，请重试。');
              const next = bucketRef.current.filter(
                bucket => bucket.provider !== connection.id,
              );
              bucketRef.current = next;
              setBuckets(next);
              await saveHealthBuckets(storageKey, next);
              const list = await client.list();
              if (scope.active) {
                setConnections(list);
                setNotice(
                  '当前服务器连接凭据已移除。请在厂商账号中检查并撤销授权。',
                );
              }
            });
          },
        },
      ],
    );
  const readNative = () => {
    void run('native', async () => {
      if (!availability || availability.status !== 'available')
        throw new Error('此设备暂不支持系统健康读取。');
      const metrics = selection.filter(metric =>
        nativeMetrics.includes(metric),
      );
      if (!metrics.length) throw new Error('请先选择要读取的健康项目。');
      const result = await nativeHealth.read(metrics);
      if (scope.active) await remember(availability.provider, result, metrics);
    });
  };
  const removeLocal = () =>
    Alert.alert(
      '清除本机健康记录',
      '清除当前账号在本机保存的健康记录，不删除厂商记录，也不会断开厂商账号连接。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: () => {
            void run('clear', async () => {
              await clearHealthBuckets(storageKey);
              if (scope.active) {
                bucketRef.current = [];
                setBuckets([]);
                setSource(null);
                setNotice('当前账号的本机健康记录已清除。');
              }
            });
          },
        },
      ],
    );
  const bucket = buckets.find(item => item.provider === source);

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <View style={v.header}>
        <IconButton icon="back" label="返回" onPress={back} />
        <Text style={s.wordmark}>我的健康</Text>
        <View style={v.spacer} />
      </View>
      <Text style={s.title}>把身体的日常，记下来</Text>
      <Text style={s.subtitle}>
        在你的授权下读取穿戴设备已记录的数据。连接方式和可读项目取决于手机、设备与厂商开放能力。
      </Text>
      <View style={s.topGap}>
        <Notice>
          只读记录，不修改厂商数据。本版没有自动上传、后台持续采集或向 AI
          发送健康记录。系统健康读取留在本机；厂商账号读取会经过当前服务器。
        </Notice>
      </View>
      {!durable && (
        <Notice>
          此设备未提供可用的本机加密保存能力。读取结果仅在当前页面内存保留，退出页面后不保证保留。
        </Notice>
      )}
      <ErrorNotice message={error} />
      {notice ? <Notice>{notice}</Notice> : null}
      <Card>
        <Text style={s.cardTitle}>选择读取项目</Text>
        <Text style={s.small}>
          默认只选择步数。可分别授权，未提供的项目不会显示为零。
        </Text>
        <MetricSelection
          values={[
            'steps',
            'heart_rate',
            'sleep',
            'workout',
            'weight',
            'active_energy',
          ]}
          selected={selection}
          disabled={busy !== null}
          onChange={metric =>
            setSelection(value =>
              value.includes(metric)
                ? value.filter(item => item !== metric)
                : [...value, metric],
            )
          }
        />
      </Card>
      <Text style={v.section}>系统健康 · 本机读取</Text>
      <Card>
        <View style={v.row}>
          <Text style={[s.cardTitle, v.flex]}>
            {availability
              ? providerLabels[availability.provider]
              : '系统健康能力'}
          </Text>
          <Pill
            tone={availability?.status === 'available' ? 'green' : 'neutral'}
          >
            {availability?.status === 'available'
              ? '可读取'
              : availability?.status === 'requires_update'
              ? '需要更新'
              : '暂不可用'}
          </Pill>
        </View>
        <Text style={[s.body, s.topGap]}>
          {availability?.detail ?? '正在检查此设备的健康数据能力。'}
        </Text>
        <Text style={[s.small, s.topGap]}>
          Apple Watch 需在支持 HealthKit 的 iPhone 上读取。华为手机不一定支持
          Health Connect，可使用下方华为运动健康通道。
        </Text>
        <View style={s.topGap}>
          <Button
            accessibilityLabel="授权并读取本机健康记录"
            loading={busy === 'native'}
            disabled={
              busy !== null ||
              availability?.status !== 'available' ||
              !selection.some(metric => nativeMetrics.includes(metric))
            }
            onPress={readNative}
          >
            授权并读取最近七天
          </Button>
        </View>
        <Button
          variant="ghost"
          accessibilityLabel="管理系统健康权限"
          disabled={busy !== null || !availability}
          onPress={() => {
            void run('settings', () => nativeHealth.settings());
          }}
        >
          管理系统健康权限
        </Button>
      </Card>
      <Text style={v.section}>厂商账号 · 经当前服务器读取</Text>
      <Text selectable style={[s.small, v.server]}>
        {api.baseUrl}
      </Text>
      <Card>
        <Text style={s.cardTitle}>完成健康账号连接</Text>
        <Text style={[s.small, s.topGap]}>
          厂商授权完成后，返回妥啦确认连接。也可粘贴授权完成页面提供的一次性确认码，有效期五分钟。请仅确认你本人刚刚发起的授权。
        </Text>
        <View style={v.wrap}>
          {(['huawei', 'xiaomi'] as const).map(provider => {
            const configured = connections.some(
              item => item.id === provider && item.status !== 'not_configured',
            );
            return (
              <Pressable
                key={provider}
                accessibilityRole="radio"
                accessibilityLabel={'确认码来源' + provider}
                accessibilityState={{
                  selected: receiptProvider === provider,
                  disabled: busy !== null || !configured,
                }}
                disabled={busy !== null || !configured}
                onPress={() => setReceiptProvider(provider)}
                style={[
                  v.chip,
                  receiptProvider === provider && v.selected,
                  !configured && { opacity: 0.45 },
                ]}
              >
                <Text style={s.small}>
                  {providerLabels[provider]}
                  {!configured ? ' · 待配置' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Field
          label="一次性连接确认码"
          placeholder="粘贴43位确认码"
          value={receipt}
          onChangeText={setReceipt}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={43}
          editable={busy === null}
        />
        <View style={s.topGap}>
          <Button
            accessibilityLabel="完成健康账号连接"
            loading={busy === 'finalize'}
            disabled={
              busy !== null ||
              !/^[A-Za-z0-9_-]{43}$/.test(receipt.trim()) ||
              !connections.some(
                item =>
                  item.id === receiptProvider &&
                  item.status !== 'not_configured',
              )
            }
            onPress={finalize}
          >
            确认连接当前账号
          </Button>
        </View>
        <Text style={[s.small, s.topGap]}>
          确认码仅在当前页面内存保留，不会自动提交、保存到本机记录或发送给 AI。
        </Text>
      </Card>
      {connections.map(connection => (
        <Card key={connection.id}>
          <View style={v.row}>
            <Text style={[s.cardTitle, v.flex]}>{connection.name}</Text>
            <Pill
              tone={connection.status === 'connected' ? 'green' : 'neutral'}
            >
              {statuses[connection.status]}
            </Pill>
          </View>
          <Text style={[s.body, s.topGap]}>{connection.detail}</Text>
          <Text style={[s.small, s.topGap]}>
            支持项目：
            {connection.metrics
              .map(metric => metricLabels[metric])
              .join('、') || '尚未开放'}
          </Text>
          {connection.status === 'connected' &&
            connection.granted_metrics !== undefined && (
              <Text style={[s.small, s.topGap]}>
                当前授权：
                {connection.granted_metrics
                  .map(metric => metricLabels[metric])
                  .join('、') || '暂无读取权限'}
                。读取仅包含已授权的所选项目；增加项目请调整授权。
              </Text>
            )}
          {connection.last_sync_at ? (
            <Text style={s.small}>
              最近读取：{dateLabel(connection.last_sync_at)}
            </Text>
          ) : null}
          <View style={s.topGap}>
            <Button
              accessibilityLabel={'连接' + connection.id}
              loading={busy === connection.id}
              disabled={
                busy !== null ||
                connection.status === 'not_configured' ||
                !(
                  connection.status === 'connected'
                    ? readable(connection)
                    : requested(connection)
                ).length
              }
              onPress={() =>
                connection.status === 'connected'
                  ? sync(connection)
                  : authorize(connection)
              }
            >
              {connection.status === 'not_configured'
                ? '等待管理员配置'
                : connection.status === 'connected'
                ? '读取最近七天'
                : connection.status === 'reconnect_required'
                ? '重新授权'
                : '连接并授权'}
            </Button>
          </View>
          {connection.status === 'connected' && (
            <Button
              accessibilityLabel={'调整' + connection.id + '授权'}
              variant="ghost"
              disabled={busy !== null || !requested(connection).length}
              onPress={() => authorize(connection)}
            >
              调整授权项目
            </Button>
          )}
          {connection.has_credentials && (
            <Button
              accessibilityLabel={'断开' + connection.id}
              variant="ghost"
              disabled={busy !== null}
              onPress={() => disconnect(connection)}
            >
              断开连接并清除本机记录
            </Button>
          )}
        </Card>
      ))}
      <Button
        accessibilityLabel="刷新健康连接"
        variant="secondary"
        loading={refreshing}
        disabled={busy !== null}
        onPress={() => {
          setError('');
          void refresh();
        }}
      >
        刷新连接状态
      </Button>
      <Text style={v.section}>本机健康记录</Text>
      <View style={v.wrap}>
        {buckets.map(item => (
          <Pressable
            key={item.provider}
            accessibilityRole="button"
            accessibilityLabel={'查看' + providerLabels[item.provider] + '记录'}
            onPress={() => setSource(item.provider)}
            style={[v.chip, source === item.provider && v.selected]}
          >
            <Text style={s.small}>{providerLabels[item.provider]}</Text>
          </Pressable>
        ))}
      </View>
      <Card>
        {!bucket || !bucket.records.length ? (
          <Text style={s.body}>
            暂无健康记录。选择来源并授权读取后，真实记录会显示在这里。
          </Text>
        ) : (
          <>
            <Text style={s.cardTitle}>{providerLabels[bucket.provider]}</Text>
            <Text style={s.small}>
              读取于 {dateLabel(bucket.synced_at)} · {bucket.records.length}{' '}
              条记录
            </Text>
            {bucket.truncated && (
              <Notice>
                记录数量达到读取上限，本次仅包含部分数据。请在厂商健康 App
                查看完整记录。
              </Notice>
            )}
            {bucket.unavailable_metrics?.length ? (
              <Notice>
                本次未能读取：
                {bucket.unavailable_metrics
                  .map(metric => metricLabels[metric])
                  .join('、')}
                。可能尚未授权或此设备不提供这些项目。
              </Notice>
            ) : null}
            <Text style={[s.small, s.topGap]}>
              以下为最近的原始记录，最多显示二十条。不同来源不相加，单条步数／睡眠记录不代表全天总量。
            </Text>
            {bucket.records.slice(0, 20).map(record => (
              <View
                key={JSON.stringify([
                  record.source,
                  record.source_app,
                  record.source_id,
                  record.metric,
                  record.id,
                ])}
                style={v.record}
              >
                <View style={v.row}>
                  <Text style={[s.body, v.flex]}>
                    {metricLabels[record.metric]}
                  </Text>
                  <Text style={s.cardTitle}>
                    {Math.round(record.value * 100) / 100} {record.unit}
                  </Text>
                </View>
                <Text style={s.small}>
                  {dateLabel(record.start_at)} — {dateLabel(record.end_at)}
                </Text>
                <Text style={s.small}>
                  来源：{record.source_app || record.source}
                  {record.source_device ? ' · ' + record.source_device : ''}
                  {record.source_id ? ' · 设备来源 ' + record.source_id : ''}
                </Text>
                {record.sleep_basis === 'session_duration' && (
                  <Text style={s.small}>
                    此项为睡眠记录起止跨度，包含清醒时间，不代表精确入睡时长。
                  </Text>
                )}
              </View>
            ))}
          </>
        )}
        <Button
          accessibilityLabel="清除本机健康记录"
          variant="ghost"
          disabled={busy !== null}
          onPress={removeLocal}
        >
          清除本机健康记录
        </Button>
      </Card>
      <Text style={[s.small, v.footer]}>
        数据可能延迟或不完整，用于个人生活记录与趋势参考，不用于诊断或紧急监护。
      </Text>
    </ScrollView>
  );
}

const v = StyleSheet.create({
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  spacer: { width: 44 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 14 },
  chip: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.blueLight },
  selectedText: { color: colors.action },
  section: {
    fontSize: 17,
    fontWeight: '500',
    color: colors.ink,
    marginTop: 24,
    marginBottom: 14,
  },
  server: { marginBottom: 14 },
  record: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  footer: { textAlign: 'center', marginTop: 12, marginBottom: 20 },
});

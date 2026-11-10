import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
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
import {
  healthDate,
  HealthOverview,
  HealthRecordDetails,
  HealthSheet,
  HealthSourceList,
  type HealthSourceOption,
} from './HealthOverview';
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
  connectionOnlyProvider,
}: {
  initialReceipt?: HealthReceipt;
  connectionOnlyProvider?: HealthConnection['id'];
} = {}) {
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
      connectionOnlyProvider,
    ],
  );
  return user ? (
    <HealthSession
      key={session.id}
      api={api}
      back={back}
      initialReceipt={initial}
      connectionOnlyProvider={connectionOnlyProvider}
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
const vendorIds = ['huawei', 'xiaomi'] as const;
const defaultSelection: HealthMetric[] = ['steps'];
type HealthPanel = 'sources' | 'records' | HealthProvider;
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
  connectionOnlyProvider,
}: {
  api: ApiClient;
  storageKey: string;
  back: () => void;
  initialReceipt?: HealthReceipt;
  connectionOnlyProvider?: HealthConnection['id'];
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
  >(connectionOnlyProvider ?? initialReceipt?.provider ?? 'huawei');
  const [receipt, setReceipt] = useState(initialReceipt?.receipt ?? '');
  const form = useRef({ receipt, provider: receiptProvider });
  form.current = { receipt, provider: receiptProvider };
  const [availability, setAvailability] = useState<HealthAvailability | null>(
    null,
  );
  const [buckets, setBuckets] = useState<HealthBucket[]>([]);
  const bucketRef = useRef<HealthBucket[]>([]);
  const [selection, setSelection] = useState<
    Partial<Record<HealthProvider, HealthMetric[]>>
  >({});
  const [source, setSource] = useState<HealthProvider | null>(null);
  const [panel, setPanel] = useState<HealthPanel | null>(
    initialReceipt?.provider ?? null,
  );
  const [busy, setBusy] = useState<string | null>(
    connectionOnlyProvider ? null : 'loading',
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [durable, setDurable] = useState(healthStorageAvailable());
  const [privacyExpanded, setPrivacyExpanded] = useState(false);
  const [receiptExpanded, setReceiptExpanded] = useState(
    Boolean(initialReceipt),
  );

  const refresh = useCallback(async () => {
    if (!scope.active || scope.refreshing || locked.current) return;
    scope.refreshing = true;
    const sequence = ++scope.refresh;
    setRefreshing(true);
    const result = await Promise.allSettled([
      client.list(),
      connectionOnlyProvider
        ? Promise.resolve(null)
        : nativeHealth.availability(),
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
  }, [client, scope, connectionOnlyProvider]);

  useEffect(() => {
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    scope.active = true;
    const revision = scope.revision;
    if (!connectionOnlyProvider)
      void loadHealthBuckets(storageKey)
        .then(saved => {
          if (scope.active && scope.revision === revision) {
            bucketRef.current = saved;
            setBuckets(saved);
          }
        })
        .catch(failure => {
          if (scope.active) setError(errorMessage(failure));
        })
        .finally(() => {
          if (scope.active && scope.revision === revision) setBusy(null);
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
  }, [scope, refresh, storageKey, connectionOnlyProvider]);

  const run = async (operation: string, action: () => Promise<void>) => {
    if (!scope.active || locked.current || busy === 'loading') return;
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
    setPanel(null);
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
  const selectedMetrics = (provider: HealthProvider) =>
    selection[provider] ?? defaultSelection;
  const requested = (connection: HealthConnection) =>
    selectedMetrics(connection.id).filter(metric =>
      connection.metrics.includes(metric),
    );
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
        if (scope.active) {
          setReceiptExpanded(true);
          setNotice(
            '完成厂商授权后，请返回妥啦输入一次性确认码并确认连接。连接完成后仍需单独点击读取记录。',
          );
        }
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
              setSource(current =>
                current === connection.id ? null : current,
              );
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
      const metrics = selectedMetrics(availability.provider).filter(metric =>
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
  const systemProvider =
    availability?.provider ??
    (Platform.OS === 'ios' ? 'apple_health' : 'health_connect');
  const providerIds = new Set<HealthProvider>([
    ...vendorIds,
    systemProvider,
    ...buckets.map(item => item.provider),
  ]);
  const sources: HealthSourceOption[] = [...providerIds].map(id => {
    const saved = buckets.some(
      item => item.provider === id && item.records.length > 0,
    );
    const connection = connections.find(item => item.id === id);
    if (id === 'huawei' || id === 'xiaomi') {
      return {
        id,
        name: providerLabels[id],
        status: connection
          ? statuses[connection.status]
          : refreshing
          ? '检查中'
          : '未开通',
        channel: '厂商账号',
        canView: saved || connection?.status === 'connected',
      };
    }
    const status =
      availability?.provider === id ? availability.status : undefined;
    return {
      id,
      name: providerLabels[id],
      status:
        status === 'available'
          ? '可读取'
          : status === 'requires_update'
          ? '需要更新'
          : refreshing
          ? '检查中'
          : '暂不可用',
      channel: '本机读取',
      canView: saved || status === 'available',
    };
  });
  const lastRead = buckets.reduce<HealthBucket | undefined>(
    (latest, item) =>
      item.records.length &&
      (!latest || Date.parse(item.synced_at) > Date.parse(latest.synced_at))
        ? item
        : latest,
    undefined,
  );
  const active =
    sources.find(item => item.id === source && item.canView) ??
    sources.find(item => item.id === lastRead?.provider) ??
    sources.find(item =>
      connections.some(
        connection =>
          connection.id === item.id && connection.status === 'connected',
      ),
    );
  const bucket = buckets.find(item => item.provider === active?.id);

  const changePanel = (next: HealthPanel | null) => {
    if (locked.current) return;
    setPanel(next);
    setPrivacyExpanded(false);
  };
  const chooseSource = (option: HealthSourceOption) => {
    if (locked.current) return;
    if (option.canView) {
      if (option.id !== active?.id) setNotice('');
      setSource(option.id);
      changePanel(null);
    } else changePanel(option.id);
  };
  const feedback = (
    <>
      <ErrorNotice message={error} />
      {notice ? <Notice>{notice}</Notice> : null}
    </>
  );
  const refreshButton = (
    <Button
      accessibilityLabel="刷新健康连接"
      variant="ghost"
      loading={refreshing}
      disabled={busy !== null}
      onPress={() => {
        setError('');
        void refresh();
      }}
    >
      刷新连接状态
    </Button>
  );
  const metricsPicker = (provider: HealthProvider, values: HealthMetric[]) =>
    values.length ? (
      <View style={v.metricSection}>
        <Text style={s.cardTitle}>选择读取项目</Text>
        <MetricSelection
          values={values}
          selected={selectedMetrics(provider)}
          disabled={busy !== null}
          onChange={metric =>
            setSelection(current => {
              const selected = current[provider] ?? defaultSelection;
              return {
                ...current,
                [provider]: selected.includes(metric)
                  ? selected.filter(item => item !== metric)
                  : [...selected, metric],
              };
            })
          }
        />
      </View>
    ) : null;

  const receiptForm = (
    <Card style={v.receipt}>
      <Text style={s.cardTitle}>完成健康账号连接</Text>
      <Text style={s.small}>
        粘贴厂商授权页面提供的一次性确认码，有效期五分钟。请仅确认你本人刚刚发起的授权。
      </Text>
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
                item.id === receiptProvider && item.status !== 'not_configured',
            )
          }
          onPress={finalize}
        >
          确认连接当前账号
        </Button>
      </View>
      <Text style={[s.small, s.topGap]}>确认码仅在当前页面内存保留。</Text>
    </Card>
  );
  const vendorDetails = (id: HealthConnection['id'], embedded = false) => {
    const connection = connections.find(item => item.id === id);
    const configured = connection && connection.status !== 'not_configured';
    const receiptOpen = receiptExpanded && receiptProvider === id;
    return (
      <View style={v.details}>
        {connection ? (
          <>
            <View style={v.row}>
              <Pill
                tone={connection.status === 'connected' ? 'green' : 'neutral'}
              >
                {statuses[connection.status]}
              </Pill>
              <Text style={s.small}>经当前服务器读取</Text>
            </View>
            {configured ? (
              <>
                {connection.status === 'connected' &&
                  connection.granted_metrics !== undefined && (
                    <Text style={s.small}>
                      当前授权：
                      {connection.granted_metrics
                        .map(metric => metricLabels[metric])
                        .join('、') || '暂无读取权限'}
                      。读取仅包含已授权的所选项目。
                    </Text>
                  )}
                {connection.last_sync_at && (
                  <Text style={s.small}>
                    最近读取：{healthDate(connection.last_sync_at)}
                  </Text>
                )}
                {(!embedded || connection.status !== 'connected') && (
                  <>
                    {metricsPicker(id, connection.metrics)}
                    <Button
                      accessibilityLabel={'连接' + id}
                      loading={busy === id}
                      disabled={
                        busy !== null ||
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
                      {connection.status === 'connected'
                        ? '读取最近七天'
                        : connection.status === 'reconnect_required'
                        ? '重新授权'
                        : '连接并授权'}
                    </Button>
                  </>
                )}
                {!embedded && connection.status === 'connected' && (
                  <Button
                    accessibilityLabel={'调整' + id + '授权'}
                    variant="ghost"
                    disabled={busy !== null || !requested(connection).length}
                    onPress={() => authorize(connection)}
                  >
                    调整授权项目
                  </Button>
                )}
              </>
            ) : (
              <Text style={s.body}>
                当前服务器配置好此来源后，即可授权连接。
              </Text>
            )}
          </>
        ) : !refreshing && !error ? (
          <Notice>当前服务器尚未提供这个健康账号连接。</Notice>
        ) : null}
        {!embedded && (configured || receiptOpen) && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="使用一次性连接确认码"
            accessibilityState={{ expanded: receiptOpen }}
            disabled={busy !== null}
            style={v.quickLink}
            onPress={() => {
              if (receiptProvider !== id) setReceipt('');
              setReceiptProvider(id);
              setReceiptExpanded(!receiptOpen);
            }}
          >
            <Text style={v.selectedText}>
              {receiptOpen ? '收起确认码' : '使用一次性连接确认码'}
            </Text>
          </Pressable>
        )}
        {(
          embedded
            ? configured && connection.status !== 'connected'
            : receiptOpen
        )
          ? receiptForm
          : null}
        {!embedded && connection?.has_credentials && (
          <Button
            accessibilityLabel={'断开' + id}
            variant="ghost"
            disabled={busy !== null}
            onPress={() => disconnect(connection)}
          >
            断开连接并清除该来源记录
          </Button>
        )}
      </View>
    );
  };
  const nativeDetails = (id: 'health_connect' | 'apple_health') => {
    const native = availability?.provider === id ? availability : null;
    const canRead = native?.status === 'available';
    return (
      <View style={v.details}>
        <View style={v.row}>
          <Pill tone={canRead ? 'green' : 'neutral'}>
            {sources.find(item => item.id === id)?.status}
          </Pill>
          <Text style={s.small}>本机读取</Text>
        </View>
        <Text style={s.small}>
          {native?.detail ?? '当前设备暂未提供此来源的读取能力。'}
        </Text>
        {canRead && (
          <>
            {metricsPicker(id, nativeMetrics)}
            <Button
              accessibilityLabel="授权并读取本机健康记录"
              loading={busy === 'native'}
              disabled={
                busy !== null ||
                !selectedMetrics(id).some(metric =>
                  nativeMetrics.includes(metric),
                )
              }
              onPress={readNative}
            >
              授权并读取最近七天
            </Button>
          </>
        )}
        {native && native.status !== 'unavailable' && (
          <Button
            variant="ghost"
            accessibilityLabel="管理系统健康权限"
            disabled={busy !== null}
            onPress={() => {
              void run('settings', () => nativeHealth.settings());
            }}
          >
            管理系统健康权限
          </Button>
        )}
      </View>
    );
  };
  if (connectionOnlyProvider) {
    return (
      <View style={v.details}>
        <Text style={s.cardTitle}>
          {providerLabels[connectionOnlyProvider]}
        </Text>
        {feedback}
        {vendorDetails(connectionOnlyProvider, true)}
        {refreshButton}
      </View>
    );
  }

  const panelSource =
    panel && panel !== 'sources' && panel !== 'records'
      ? sources.find(item => item.id === panel)
      : undefined;
  const vendor =
    panelSource && connections.find(item => item.id === panelSource.id);
  return (
    <>
      <ScrollView style={s.screen} contentContainerStyle={s.content}>
        <View style={v.header}>
          <IconButton icon="back" label="返回" onPress={back} />
          <Text accessibilityRole="header" style={v.title}>
            我的健康
          </Text>
        </View>
        {!panel && feedback}
        <HealthOverview
          source={active}
          bucket={bucket}
          loading={busy === 'loading'}
          onPick={() => changePanel('sources')}
          onManage={() => changePanel(active?.id ?? 'sources')}
          onRecords={() => changePanel('records')}
        />
      </ScrollView>
      {panel && (
        <HealthSheet
          title={
            panel === 'sources'
              ? '切换数据来源'
              : panel === 'records'
              ? '记录明细'
              : providerLabels[panel]
          }
          onClose={() => changePanel(null)}
        >
          {feedback}
          {panel === 'sources' && (
            <>
              <HealthSourceList
                sources={sources}
                selected={active?.id}
                onSelect={chooseSource}
                onManage={item => changePanel(item.id)}
              />
              {refreshButton}
            </>
          )}
          {panel === 'records' && bucket && (
            <HealthRecordDetails bucket={bucket} />
          )}
          {panelSource && (
            <>
              {panelSource.id === 'huawei' || panelSource.id === 'xiaomi'
                ? vendorDetails(panelSource.id)
                : nativeDetails(panelSource.id)}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="数据与权限说明"
                accessibilityState={{ expanded: privacyExpanded }}
                style={v.quickLink}
                onPress={() => setPrivacyExpanded(value => !value)}
              >
                <Text style={v.selectedText}>
                  {privacyExpanded ? '收起数据说明' : '数据与权限说明'}
                </Text>
              </Pressable>
              {privacyExpanded && (
                <View style={v.privacyCopy}>
                  <Text style={s.small}>
                    {vendor ? vendor.detail : '系统健康记录在本机读取。'}{' '}
                    已读取的记录留在本机，不会自动发送给 AI。
                  </Text>
                  {vendor && (
                    <Text style={s.small} selectable>
                      当前服务器：{api.baseUrl}
                    </Text>
                  )}
                  {!durable && (
                    <Text style={s.small}>
                      此设备暂无法加密保存，读取结果仅在当前页面内存保留。
                    </Text>
                  )}
                  <Button
                    accessibilityLabel="清除本机健康记录"
                    variant="ghost"
                    disabled={busy !== null}
                    onPress={removeLocal}
                  >
                    清除本机健康记录
                  </Button>
                  <Text style={s.small}>健康记录用于个人生活参考。</Text>
                </View>
              )}
              <Button
                accessibilityLabel="返回来源列表"
                variant="ghost"
                disabled={busy !== null}
                onPress={() => changePanel('sources')}
              >
                查看其他来源
              </Button>
            </>
          )}
        </HealthSheet>
      )}
    </>
  );
}

const v = StyleSheet.create({
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 14,
  },
  title: {
    fontSize: 27,
    color: colors.ink,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  details: { gap: 9 },
  quickLink: {
    minHeight: 44,
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  privacyCopy: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.blueLight,
    gap: 5,
  },
  metricSection: { paddingTop: 3 },
  receipt: { marginBottom: 0 },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.blueLight },
  selectedText: { color: colors.action },
});

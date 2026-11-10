import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { errorMessage } from '../../api/client';
import { useApp } from '../../app/context';
import { appInputs, appInputSources } from '../../platform/appInputs';
import { photoIndex, photoIndexAvailable } from '../../platform/photoIndex';
import { platform } from '../../platform/ports';
import { Button, ErrorNotice, Notice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { Icon, type IconName } from '../../ui/visuals';
import { healthApi } from '../health/api';
import { nativeHealth } from '../health/native';
import { PhotoIndexSettings } from '../photo-index/PhotoIndexSettings';
import { PersonalMcpConnections } from '../personal-mcp/PersonalMcpConnections';
import type { PersonalMcpConnection } from '../personal-mcp/types';
import { readWalletMetadata } from '../personal-mcp/walletModel';
import { integrationsApi } from './api';
import { MailConnectionSheet } from './MailConnection';
import type { Integration } from './types';
import {
  connectionRows,
  filterConnectionRows,
  type ConnectionCategory,
  type ConnectionRow,
  type ConnectionSnapshot,
} from './connectionsCatalog';

export type IntegrationToolOptions = {
  tab?: 'apps' | 'inbox' | 'library';
  section?: 'local' | 'cloud';
  source?: string;
  cloudId?: string;
};
export type ConnectionBrowseState = {
  category: ConnectionCategory;
  query: string;
  managing: boolean;
};
const categories: [ConnectionCategory, string][] = [
  ['local', '本机应用'],
  ['cloud', '云端账号'],
  ['devices', '外部设备'],
];
const emptySnapshot = (): ConnectionSnapshot => ({
  native: null,
  integrations: null,
  mcp: null,
  health: null,
  systemHealth: null,
  photoEnabled: null,
});

function rowIcon(row: ConnectionRow): IconName {
  if (row.target.kind === 'notifications' || row.target.kind === 'app')
    return 'bell';
  if (row.target.kind === 'photos') return 'memory';
  if (row.target.kind === 'share') return 'arrowRight';
  if (row.target.kind === 'files') return 'file';
  if (row.category === 'devices') return 'memory';
  return 'attachment';
}

/** Connection overview only reads status. Actual grants and imports stay in their existing explicit flows. */
export function ConnectionsHub({
  onOpenTools,
  browseState,
  onBrowseStateChange,
}: {
  onOpenTools: (options: IntegrationToolOptions) => void;
  browseState?: ConnectionBrowseState;
  onBrowseStateChange?: (state: ConnectionBrowseState) => void;
}) {
  const { api, user, back, navigate } = useApp();
  const scope = useMemo(
    () => ({
      active: false,
      controller: new AbortController(),
      refreshing: false,
      sequence: 0,
      versions: {} as Record<string, number>,
    }),
    [api, user?.id],
  );
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot>(emptySnapshot);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState<ConnectionCategory>(() =>
    categories.some(([id]) => id === browseState?.category)
      ? browseState!.category
      : 'local',
  );
  const [query, setQuery] = useState(() =>
    typeof browseState?.query === 'string'
      ? browseState.query.slice(0, 200)
      : '',
  );
  const [managing, setManaging] = useState(browseState?.managing === true);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [mailConnection, setMailConnection] = useState<Integration | null>(
    null,
  );
  const [privacy, setPrivacy] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef(false);
  useEffect(() => {
    onBrowseStateChange?.({ category, query, managing });
  }, [category, query, managing, onBrowseStateChange]);

  const receive = useCallback(
    async <T,>(
      key: string,
      load: () => Promise<T>,
      apply: (value: T) => Partial<ConnectionSnapshot>,
    ) => {
      const version = (scope.versions[key] || 0) + 1;
      scope.versions[key] = version;
      const current = () => scope.active && scope.versions[key] === version;
      try {
        const value = await load();
        if (!current()) return;
        const patch = apply(value);
        setSnapshot(previous => ({ ...previous, ...patch }));
        setErrors(previous => {
          const next = { ...previous };
          delete next[key];
          return next;
        });
      } catch (failure) {
        if (current())
          setErrors(previous => ({
            ...previous,
            [key]: errorMessage(failure),
          }));
      }
    },
    [scope],
  );
  const refreshLocal = useCallback(async () => {
    if (!scope.active) return;
    const tasks: Promise<void>[] = [
      receive(
        'native',
        () => appInputs.getStatus(),
        value => ({ native: value }),
      ),
      receive(
        'systemHealth',
        () => nativeHealth.availability(),
        value => ({ systemHealth: value }),
      ),
    ];
    if (photoIndexAvailable && user)
      tasks.push(
        receive(
          'photos',
          () => photoIndex.status(api.baseUrl, user.id),
          value => ({ photoEnabled: value.enabled, photoState: value.state }),
        ),
      );
    await Promise.all(tasks);
  }, [api, user, scope, receive]);
  const refresh = useCallback(async () => {
    if (!scope.active || scope.refreshing) return;
    scope.refreshing = true;
    const sequence = ++scope.sequence;
    const current = () => scope.active && sequence === scope.sequence;
    setLoading(true);
    const tasks: Promise<void>[] = [
      refreshLocal(),
      receive(
        'integrations',
        () => integrationsApi(api, () => scope.controller.signal).list(),
        value => {
          if (!Array.isArray(value?.items))
            throw new Error('服务目录格式暂不可识别。');
          return {
            integrations: value.items.filter(
              item =>
                item &&
                typeof item.id === 'string' &&
                typeof item.name === 'string',
            ),
          };
        },
      ),
      receive(
        'mcp',
        () =>
          api.request<{ items: NonNullable<ConnectionSnapshot['mcp']> }>(
            '/personal-mcp',
            'GET',
            undefined,
            scope.controller.signal,
          ),
        value => {
          if (!Array.isArray(value?.items))
            throw new Error('账号目录格式暂不可识别。');
          return {
            mcp: value.items.filter(
              item =>
                item &&
                typeof item.id === 'string' &&
                typeof item.name === 'string',
            ),
            mcpUpdates: [],
          };
        },
      ),
      receive(
        'health',
        () => healthApi(api, () => scope.controller.signal).list(),
        value => ({ health: value }),
      ),
      receive('wallet', async () => readWalletMetadata(await api.request('/personal-wallet/alipay', 'GET', undefined, scope.controller.signal)), value => ({ wallet: value })),
    ];
    await Promise.all(tasks);
    if (current()) {
      scope.refreshing = false;
      setLoading(false);
    }
  }, [api, scope, receive, refreshLocal]);

  useEffect(() => {
    scope.active = true;
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    void refresh();
    const unsubscribe = platform.onForeground(() => {
      if (scope.refreshing) void refreshLocal();
      else void refresh();
    });
    return () => {
      scope.active = false;
      scope.sequence += 1;
      scope.refreshing = false;
      scope.controller.abort();
      unsubscribe();
    };
  }, [scope, refresh, refreshLocal]);

  const rows = useMemo(
    () => connectionRows(snapshot, appInputSources),
    [snapshot],
  );
  const selected = rows.find(row => row.key === detailKey);
  const shown = filterConnectionRows(rows, category, query, managing);
  const added = rows.filter(row => row.added).length;
  const usable = rows.filter(row => row.usable).length;
  const attention = rows.filter(row => row.added && row.attention).length;
  const receiveConnection = useCallback(
    (item: PersonalMcpConnection) => {
      if (!scope.active) return;
      scope.versions.mcp = (scope.versions.mcp || 0) + 1;
      setSnapshot(previous => ({
        ...previous,
        mcpUpdates: [
          ...(previous.mcpUpdates || []).filter(value => value.id !== item.id),
          item,
        ],
      }));
    },
    [scope],
  );
  const goBack = useCallback(() => {
    if (detailKey || privacy) {
      if (detailKey) void refreshLocal();
      setDetailKey(null);
      setPrivacy(false);
      setNotice('');
      return true;
    }
    if (managing) {
      setManaging(false);
      setQuery('');
      return true;
    }
    if (query) {
      setQuery('');
      return true;
    }
    return false;
  }, [detailKey, privacy, managing, query, refreshLocal]);
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (!goBack()) back();
        return true;
      },
    );
    return () => subscription.remove();
  }, [goBack, back]);

  const run = async (operation: () => Promise<void>) => {
    if (!scope.active || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      if (scope.active) setNotice(errorMessage(failure));
    } finally {
      mutation.current = false;
      if (scope.active) setBusy(false);
    }
  };
  const setApp = (id: string, enabled: boolean) =>
    run(async () => {
      scope.versions.native = (scope.versions.native || 0) + 1;
      const latest = await appInputs.getStatus();
      if (!scope.active) return;
      await appInputs.setApps(
        enabled
          ? [...new Set([...latest.selected_apps, id])]
          : latest.selected_apps.filter(value => value !== id),
      );
      if (!scope.active) return;
      const readVersion = (scope.versions.native || 0) + 1;
      scope.versions.native = readVersion;
      const next = await appInputs.getStatus();
      if (!scope.active || scope.versions.native !== readVersion) return;
      setSnapshot(previous => ({ ...previous, native: next }));
      setNotice(
        enabled
          ? next.notification_access
            ? '只接收之后的新通知，等待你确认导入。'
            : '已选中应用。还需开启系统通知使用权。'
          : '已停止接收这个应用的新通知。',
      );
    });
  const openNotifications = () => {
    void run(async () => {
      await appInputs.openNotificationSettings();
    });
  };
  const openRow = (row: ConnectionRow) => {
    const target = row.target;
    const mail =
      target.kind === 'integration'
        ? snapshot.integrations?.find(item => item.id === target.id)
        : undefined;
    if (mail?.mode === 'mail' && mail.status === 'not_connected') {
      setMailConnection(mail);
      return;
    }
    setDetailKey(row.key);
    setNotice('');
  };

  const header = (title?: string) => (
    <View style={v.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          detailKey || privacy || managing ? '返回连接列表' : '返回能力'
        }
        onPress={() => {
          if (!goBack()) back();
        }}
        style={v.back}
      >
        <Icon name="back" size={23} />
      </Pressable>
      <Text style={v.headerTitle}>{title || '妥啦'}</Text>
      {!detailKey && !privacy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="隐私与权限"
          onPress={() => {
            setPrivacy(true);
          }}
          style={v.privacy}
        >
          <Icon name="settings" size={15} color={colors.secondary} />
          <Text style={v.privacyText}>隐私与权限</Text>
        </Pressable>
      ) : (
        <View style={v.headerSpace} />
      )}
    </View>
  );

  const notificationControls = (row?: ConnectionRow) => {
    const native = snapshot.native;
    const appId = row?.target.kind === 'app' ? row.target.id : undefined;
    const installed = appId && native?.installed_apps.includes(appId);
    const enabled = appId
      ? native?.selected_apps.includes(appId) === true
      : false;
    return (
      <>
        <View style={v.panel}>
          <Text style={v.panelTitle}>使用范围</Text>
          <Text style={v.body}>
            通知先留在手机。只接收开启后应用展示的新通知，不读取完整聊天记录；验证码和安全验证类通知会过滤。只有你明确确认导入，所选内容才会保存到当前服务器。交给
            AI 时会经过对应模型服务。
          </Text>
        </View>
        {appId ? (
          <View style={v.panel}>
            <View style={v.between}>
              <View style={v.fill}>
                <Text style={v.panelTitle}>接收{row?.name}的新通知</Text>
                <Text style={v.caption}>
                  {!native
                    ? '正在确认本机状态'
                    : !installed
                    ? '手机未识别到此应用，仍可主动分享或粘贴'
                    : '关闭即可停止接收后续通知'}
                </Text>
              </View>
              <Switch
                accessibilityLabel={row?.name + '接收通知'}
                value={enabled}
                disabled={
                  busy || !native?.supported || (!installed && !enabled)
                }
                onValueChange={value => {
                  void setApp(appId, value);
                }}
                trackColor={{ false: colors.line, true: '#A9C4F8' }}
                thumbColor={enabled ? colors.action : '#FFFFFF'}
              />
            </View>
          </View>
        ) : null}
        {native?.supported ? (
          <Button
            disabled={busy}
            variant="secondary"
            onPress={openNotifications}
          >
            {native.notification_access ? '管理通知使用权' : '开启通知使用权'}
          </Button>
        ) : (
          <Text style={v.caption}>
            此系统尚未提供通知访问能力，仍可使用分享、文字与文件导入。
          </Text>
        )}
        {appId ? (
          <>
            <Button
              disabled={busy}
              onPress={() => onOpenTools({ source: appId })}
            >
              粘贴{row?.name}内容
            </Button>
            {installed ? (
              <Button
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  void run(async () => {
                    const opened = await appInputs.openApp(appId);
                    if (scope.active && !opened)
                      setNotice('没有找到可打开的应用，请直接粘贴内容。');
                  });
                }}
              >
                打开{row?.name}
              </Button>
            ) : null}
          </>
        ) : (
          <Button
            variant="secondary"
            onPress={() => onOpenTools({ section: 'local' })}
          >
            选择手机应用
          </Button>
        )}
      </>
    );
  };

  const renderDetail = (row: ConnectionRow) => {
    const target = row.target;
    return (
      <>
        {header(target.kind === 'mcp' ? row.name : '连接详情')}
        {target.kind !== 'mcp' ? <View style={v.detailHero}>
          <View style={v.detailIcon}>
            <Icon name={rowIcon(row)} size={25} color={colors.action} />
          </View>
          <View style={v.fill}>
            <Text style={v.detailTitle}>{row.name}</Text>
            <Text style={v.caption}>{row.method}</Text>
          </View>
        </View> : null}
        {target.kind !== 'mcp' && target.kind !== 'photos' ? (
          <Text style={[v.state, row.attention && v.warning]}>
            {row.status}
          </Text>
        ) : null}
        {notice ? <Notice>{notice}</Notice> : null}
        {target.kind === 'mcp' ? (
          <PersonalMcpConnections
            providerId={target.id}
            onConnectionChange={receiveConnection}
            hideTitle
          />
        ) : null}
        {target.kind === 'photos' ? (
          <>
            <View style={v.panel}>
              <Text style={v.panelTitle}>照片处理去向</Text>
              <Text style={v.body}>
                相册索引会在你明确确认后，上传分析副本并使用后台配置的图片和向量模型。以下沿用现有的授权、处理范围与关闭控制，不会因为打开此页而开始扫描。
              </Text>
            </View>
            <PhotoIndexSettings />
          </>
        ) : null}
        {target.kind === 'app' || target.kind === 'notifications'
          ? notificationControls(row)
          : null}
        {target.kind === 'share' || target.kind === 'files' ? (
          <>
            <View style={v.panel}>
              <Text style={v.panelTitle}>
                {target.kind === 'files'
                  ? '只处理你选择的文件'
                  : '从你正在使用的应用开始'}
              </Text>
              <Text style={v.body}>
                {target.kind === 'files'
                  ? '通过系统文件选择器主动选择文件，确认后上传到当前服务器。不会因此获得整个存储空间的访问权。'
                  : '页面支持系统分享时，点击“分享”并选择妥啦。无法分享时，复制需要的文字或链接后粘贴。不会因此获得微信、QQ 或其他应用的完整聊天历史。'}
              </Text>
              <Text style={[v.body, { marginTop: 12 }]}>
                分享来的内容会先放在“待接收”。你确认导入或上传后才会保存到当前服务器，发送给
                AI 时会使用相应模型服务。
              </Text>
            </View>
            <Button
              onPress={() =>
                onOpenTools(
                  target.kind === 'files'
                    ? { section: 'local' }
                    : { source: 'shared' },
                )
              }
            >
              {target.kind === 'files' ? '前往选取文件' : '粘贴文字 / 链接'}
            </Button>
            <Button
              variant="secondary"
              onPress={() => onOpenTools({ tab: 'inbox' })}
            >
              查看待接收内容
            </Button>
          </>
        ) : null}
        {target.kind === 'integration' ? (
          <>
            <View style={v.panel}>
              <Text style={v.panelTitle}>连接方式</Text>
              <Text style={v.body}>{row.purpose}</Text>
              <Text style={[v.caption, { marginTop: 12 }]}>
                个人邮箱使用你本人的客户端授权码。高德使用你自己申请的 Web 服务
                Key，按当前用户加密保存；可用范围以当前服务目录为准。
              </Text>
            </View>
            <Button
              onPress={() =>
                onOpenTools({ section: 'cloud', cloudId: target.id })
              }
            >
              打开连接设置
            </Button>
          </>
        ) : null}
        {target.kind === 'health' ? (
          <>
            <View style={v.panel}>
              <Text style={v.panelTitle}>设备与数据来源</Text>
              <Text style={v.body}>
                {target.id === 'apple'
                  ? 'Apple Watch 通常与 iPhone 配对。在当前 Android 客户端中不能直接连接 Apple Watch。iOS 版仍需完成构建和真机验证。'
                  : target.id === 'system'
                  ? snapshot.systemHealth?.detail ||
                    '先检查手机是否支持系统健康通道，再由你选择只读范围。'
                  : snapshot.health?.find(item => item.id === target.id)
                      ?.detail ||
                    '当前服务器的健康服务状态尚未确认。手表仍需与对应厂商健康应用完成配对；开通服务后，再由你亲自授权。'}
              </Text>
              <Text style={[v.body, { marginTop: 12 }]}>
                健康数据在前台按需读取，不会自动交给
                AI。云端通道的授权和读取经过当前服务器，系统健康通道使用手机权限。不同来源的记录保留来源，不简单相加。
              </Text>
            </View>
            {target.id !== 'apple' || Platform.OS === 'ios' ? (
              <Button onPress={() => navigate({ name: 'health' })}>
                管理健康数据来源
              </Button>
            ) : null}
            <Text style={[v.caption, { marginTop: 12 }]}>
              此入口打开完整健康连接页，请在其中选择对应厂商或系统来源；不会自动授权或同步。
            </Text>
          </>
        ) : null}
      </>
    );
  };

  const renderPrivacy = () => (
    <>
      {header('隐私与权限')}
      <Text style={v.title}>
        每一种连接，<Text>{'\n'}</Text>都有清楚的边界。
      </Text>
      {[
        [
          '本机应用',
          '通知与系统分享先留在手机；你确认导入后保存到当前服务器。相册分析需要单独确认副本上传及图片、向量模型的去向。',
        ],
        [
          '云端账号',
          '只使用你自己的账号授权或个人凭证，保存在当前服务器。普通用户无需填写公共地图、模型等开发者 Key。',
        ],
        [
          '外部设备',
          '先连接厂商健康应用或系统健康来源，再按需读取。健康资料不自动用于 AI，权限随时可在连接页面或手机设置中管理。',
        ],
        [
          '暂停、断开与撤销',
          '手机应用关闭通知开关可停止接收。账号凭据可在各自连接页断开；移除妥啦的凭据，不等于撤销厂商侧授权，厂商授权需到对应平台设置中管理。',
        ],
      ].map(([title, body]) => (
        <View key={title} style={v.panel}>
          <Text style={v.panelTitle}>{title}</Text>
          <Text style={v.body}>{body}</Text>
        </View>
      ))}
      <Button
        onPress={() => {
          setPrivacy(false);
          setManaging(true);
          setQuery('');
        }}
      >
        管理我的连接
      </Button>
    </>
  );

  const row = (item: ConnectionRow) => (
    <Pressable
      key={item.key}
      testID={'connection-row-' + item.key}
      accessibilityRole="button"
      accessibilityLabel={item.name + '，' + item.status + '，' + item.action}
      onPress={() => openRow(item)}
      style={({ pressed }) => [v.row, pressed && v.pressed]}
    >
      <View style={[v.sourceIcon, item.category === 'devices' && v.deviceIcon]}>
        {item.target.kind === 'app' ? (
          <Text style={v.sourceLetter}>
            {item.name === 'QQ' ? 'QQ' : item.name.slice(0, 1)}
          </Text>
        ) : (
          <Icon name={rowIcon(item)} size={21} color={colors.action} />
        )}
      </View>
      <View style={v.fill}>
        <Text style={v.rowTitle}>{item.name}</Text>
        <Text style={v.purpose}>{item.purpose}</Text>
        <Text style={v.method}>{item.method}</Text>
        <Text
          style={[
            v.state,
            item.attention && v.warning,
            item.unavailable && v.subdued,
          ]}
        >
          {item.status}
        </Text>
      </View>
      <Text style={v.rowAction}>{item.action}</Text>
      <Icon name="chevronRight" size={13} color={colors.muted} />
    </Pressable>
  );
  const groups: [string, ConnectionRow[]][] =
    managing || query.trim()
      ? [[query.trim() ? '搜索结果' : '已添加的连接', shown]]
      : [
          ['已添加', shown.filter(item => item.added)],
          ['可以添加', shown.filter(item => !item.added && !item.unavailable)],
          [
            '待开通或检查兼容性',
            shown.filter(item => !item.added && item.unavailable),
          ],
        ];

  return (
    <View style={v.screen}>
      <MailConnectionSheet
        item={mailConnection}
        onClose={() => setMailConnection(null)}
        onConnected={async () => {
          await refresh();
          if (scope.active) {
            setMailConnection(null);
            setNotice('邮箱已连接，可以查找和发送邮件。');
          }
        }}
      />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={v.content}
        refreshControl={
          !detailKey && !privacy ? (
            <RefreshControl
              refreshing={loading}
              onRefresh={() => {
                void refresh();
              }}
            />
          ) : undefined
        }
      >
        {privacy ? (
          renderPrivacy()
        ) : selected ? (
          renderDetail(selected)
        ) : (
          <>
            {header(managing ? '已添加的连接' : undefined)}
            <Text style={v.title}>
              {managing ? '连接，由你掌控' : '我的连接'}
            </Text>
            <Text style={v.subtitle}>
              {managing
                ? '看清使用范围，随时调整或解除。'
                : '把常用的资料、日程与健康，连在一起。'}
            </Text>
            {!managing ? (
              <View style={v.summary}>
                <View style={v.fill}>
                  <Text style={v.summaryTitle}>{added} 项已添加</Text>
                  <Text style={v.caption}>
                    {usable} 项当前可用
                    {attention ? ' · ' + attention + ' 项需处理' : ''}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="管理已添加的连接"
                  onPress={() => {
                    setManaging(true);
                    setQuery('');
                  }}
                  style={v.manage}
                >
                  <Text style={v.rowAction}>管理</Text>
                  <Icon name="chevronRight" size={15} color={colors.action} />
                </Pressable>
              </View>
            ) : null}
            <View style={v.quickActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="待接收"
                style={v.quickAction}
                onPress={() => onOpenTools({ tab: 'inbox' })}
              >
                <Icon name="attachment" size={15} color={colors.action} />
                <Text style={v.quickLabel}>
                  待接收
                  {snapshot.native?.pending_count
                    ? ' · ' + snapshot.native.pending_count
                    : ''}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="已导入"
                style={v.quickAction}
                onPress={() => onOpenTools({ tab: 'library' })}
              >
                <Icon name="file" size={15} color={colors.action} />
                <Text style={v.quickLabel}>已导入</Text>
              </Pressable>
            </View>
            <View style={v.search}>
              <Icon name="search" size={18} color={colors.secondary} />
              <TextInput
                accessibilityLabel="搜索应用或用途"
                value={query}
                onChangeText={setQuery}
                placeholder="搜索应用，或试试“通知”“网盘”"
                placeholderTextColor={colors.secondary}
                style={v.searchInput}
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="never"
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="清空搜索"
                  onPress={() => setQuery('')}
                  style={v.clear}
                >
                  <Icon name="close" size={16} color={colors.secondary} />
                </Pressable>
              ) : null}
            </View>
            {!managing ? (
              <View style={v.tabs}>
                {categories.map(([id, label]) => (
                  <Pressable
                    key={id}
                    accessibilityRole="tab"
                    accessibilityLabel={label}
                    accessibilityState={{ selected: category === id }}
                    onPress={() => {
                      setCategory(id);
                      setQuery('');
                    }}
                    style={[v.tab, category === id && v.activeTab]}
                  >
                    <Text
                      style={[v.tabLabel, category === id && v.activeTabLabel]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {errors.native ? (
              <ErrorNotice
                message="暂时无法读取本机连接状态，仍可主动粘贴文字或选择文件。"
                retry={() => {
                  void refresh();
                }}
              />
            ) : null}
            {(category === 'cloud' || query || managing) &&
            (errors.mcp || errors.integrations) ? (
              <View style={v.statusNotice}>
                <Text style={v.caption}>
                  部分云端状态暂不可用，本机导入仍可使用。未确认的服务不会计为已连接。
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="重试连接状态"
                  onPress={() => {
                    void refresh();
                  }}
                  style={v.retry}
                >
                  <Text style={v.rowAction}>重试</Text>
                </Pressable>
              </View>
            ) : null}
            {(category === 'devices' || query || managing) && errors.health ? (
              <View style={v.statusNotice}>
                <Text style={v.caption}>
                  厂商健康接口暂不可用，请在详情查看接入条件。系统健康能力独立检查。
                </Text>
              </View>
            ) : null}
            {groups
              .filter(([, items]) => items.length)
              .map(([title, items]) => (
                <View key={title}>
                  <View style={v.groupHeader}>
                    <Text style={v.groupTitle}>{title}</Text>
                    <Text style={v.caption}>{items.length} 项</Text>
                  </View>
                  {items.map(row)}
                </View>
              ))}
            {!shown.length ? (
              <View style={v.empty}>
                <Icon name="search" size={25} color={colors.muted} />
                <Text style={v.emptyTitle}>
                  {query.trim() ? '没有找到匹配的连接' : '这里还没有添加的连接'}
                </Text>
                <Button
                  variant="ghost"
                  onPress={() => {
                    setQuery('');
                    setManaging(false);
                  }}
                >
                  {query.trim() ? '清空搜索' : '去发现连接'}
                </Button>
              </View>
            ) : null}
            <Text style={v.footer}>
              本机读取、账号授权、主动导入，各有清楚的边界。连接不代表自动把全部资料交给
              AI。
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const v = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  content: { paddingHorizontal: 22, paddingTop: 8, paddingBottom: 35 },
  fill: { flex: 1, minWidth: 0 },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 23,
  },
  back: {
    minHeight: 44,
    minWidth: 40,
    justifyContent: 'center',
    marginLeft: -9,
  },
  headerTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '500' },
  headerSpace: { width: 32 },
  privacy: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  privacyText: { fontSize: 11, color: colors.secondary },
  title: {
    color: colors.ink,
    fontSize: 28,
    lineHeight: 38,
    fontWeight: '600',
    letterSpacing: -0.7,
  },
  subtitle: {
    color: colors.secondary,
    fontSize: 13,
    lineHeight: 22,
    marginTop: 7,
  },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    gap: 12,
  },
  summaryTitle: {
    fontSize: 15,
    lineHeight: 24,
    color: colors.ink,
    fontWeight: '500',
    marginBottom: 5,
  },
  manage: {
    minHeight: 44,
    flexDirection: 'row',
    gap: 3,
    alignItems: 'center',
    paddingLeft: 12,
  },
  caption: { fontSize: 11, lineHeight: 18, color: colors.secondary },
  quickActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 15,
    marginBottom: 18,
  },
  quickAction: {
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    backgroundColor: colors.background,
  },
  quickLabel: { fontSize: 11, color: colors.secondary },
  search: {
    backgroundColor: colors.background,
    borderRadius: 15,
    minHeight: 48,
    paddingHorizontal: 13,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: colors.ink,
    fontSize: 14,
    paddingVertical: 12,
  },
  clear: {
    minWidth: 32,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    marginTop: 16,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  tab: {
    flex: 1,
    minHeight: 47,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  activeTab: { borderBottomColor: colors.action },
  tabLabel: { fontSize: 13, color: colors.secondary },
  activeTabLabel: { color: colors.action, fontWeight: '500' },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 24,
    marginBottom: 5,
  },
  groupTitle: { fontSize: 13, fontWeight: '500', color: colors.ink },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 102,
    paddingVertical: 17,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.65 },
  sourceIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: colors.blueLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceIcon: { backgroundColor: colors.lilac },
  sourceLetter: { color: colors.action, fontSize: 16, fontWeight: '500' },
  rowTitle: {
    fontSize: 15,
    lineHeight: 23,
    fontWeight: '500',
    color: colors.ink,
  },
  purpose: {
    fontSize: 12,
    lineHeight: 19,
    color: colors.secondary,
    marginTop: 3,
  },
  method: {
    fontSize: 10,
    lineHeight: 17,
    color: colors.secondary,
    marginTop: 4,
  },
  state: { fontSize: 10, lineHeight: 17, color: '#287864', marginTop: 4 },
  warning: { color: colors.amber },
  subdued: { color: colors.secondary },
  rowAction: { fontSize: 12, color: colors.action, fontWeight: '500' },
  statusNotice: {
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  retry: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 8 },
  empty: { alignItems: 'center', paddingVertical: 35, gap: 12 },
  emptyTitle: { fontSize: 13, color: colors.secondary },
  footer: {
    fontSize: 11,
    lineHeight: 19,
    color: colors.secondary,
    marginTop: 23,
  },
  detailHero: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  detailIcon: {
    width: 54,
    height: 54,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blueLight,
  },
  detailTitle: {
    fontSize: 22,
    fontWeight: '500',
    color: colors.ink,
    lineHeight: 30,
    marginBottom: 5,
  },
  panel: {
    backgroundColor: colors.background,
    borderRadius: 20,
    padding: 17,
    marginVertical: 13,
  },
  panelTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 22,
    marginBottom: 8,
  },
  body: { color: colors.secondary, fontSize: 13, lineHeight: 22 },
  between: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});

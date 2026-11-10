import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { errorMessage, type ApiClient } from '../../api/client';
import { useApp } from '../../app/context';
import { platform } from '../../platform/ports';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Notice,
  Pill,
  Section,
} from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { connectionGuide } from '../integrations/connectionGuides';
import { isConnectionVisible } from '../integrations/connectionVisibility';
import { personalMcpApi } from './api';
import { AlipayWalletConnection } from './AlipayWalletConnection';
import { McpConnectionCard, McpConnectionRow } from './McpConnectionCard';
import type {
  McpEnvironment,
  PersonalMcpAction,
  PersonalMcpConnection,
  PersonalMcpTool,
} from './types';

let nextSession = 0;

/** Remount the credential form synchronously when the authenticated API changes. */
export function PersonalMcpConnections({
  providerId,
  initialConnection,
  onConnectionChange,
  hideTitle = false,
}: {
  providerId?: string;
  initialConnection?: PersonalMcpConnection;
  onConnectionChange?: (item: PersonalMcpConnection) => void;
  hideTitle?: boolean;
} = {}) {
  const { api, user, invalidate } = useApp();
  const session = useMemo(
    () => ({ id: ++nextSession, api, userId: user?.id, providerId }),
    [api, user?.id, providerId],
  );
  return user ? (
    <ConnectionsSession
      key={session.id}
      api={api}
      providerId={providerId}
      initialConnection={initialConnection}
      onConnectionChange={onConnectionChange}
      hideTitle={hideTitle}
      onRideChanged={invalidate}
    />
  ) : null;
}

const statusLabels: Record<PersonalMcpConnection['status'], string> = {
  not_configured: '暂不可用',
  not_connected: '未连接',
  connected: '已连接',
  needs_reconnect: '需要重新连接',
};

function ConnectionsSession({
  api,
  providerId,
  initialConnection,
  onConnectionChange,
  onRideChanged,
  hideTitle,
}: {
  api: ApiClient;
  providerId?: string;
  initialConnection?: PersonalMcpConnection;
  onConnectionChange?: (item: PersonalMcpConnection) => void;
  onRideChanged: () => void;
  hideTitle: boolean;
}) {
  const connectOnly = initialConnection !== undefined;
  const compact = providerId !== undefined;
  const scope = useMemo(
    () => ({
      active: false,
      controller: new AbortController(),
      refreshSequence: 0,
      refreshing: false,
      catalog: initialConnection ? [initialConnection] : [] as PersonalMcpConnection[],
      selectedId: null as string | null,
    }),
    [initialConnection],
  );
  const client = useMemo(
    () => personalMcpApi(api, () => scope.controller.signal),
    [api, scope],
  );
  const [items, setItems] = useState<PersonalMcpConnection[]>(scope.catalog);
  const [actions, setActions] = useState<PersonalMcpAction[]>([]);
  const [loading, setLoading] = useState(!connectOnly);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [account, setAccount] = useState('');
  const [clientId, setClientId] = useState('');
  const [environment, setEnvironment] = useState<McpEnvironment>('production');
  const [toolOwner, setToolOwner] = useState<string | null>(null);
  const [tools, setTools] = useState<PersonalMcpTool[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const mutation = useRef(false);
  const [, tick] = useState(0);

  const receiveCatalog = useCallback(
    (catalog: PersonalMcpConnection[]) => {
      const visible = providerId
        ? catalog.filter(item => item.id === providerId)
        : catalog;
      scope.catalog = visible;
      setItems(visible);
      visible.forEach(item => onConnectionChange?.(item));
      const selectedItem = visible.find(item => item.id === scope.selectedId);
      if (
        scope.selectedId &&
        (!selectedItem || selectedItem.status === 'not_configured')
      ) {
        scope.selectedId = null;
        setSelected(null);
        setToken('');
        setServerUrl('');
        setAccount('');
        setClientId('');
        setToolOwner(null);
        setTools([]);
      }
    },
    [scope, providerId, onConnectionChange],
  );

  const refresh = useCallback(async () => {
    if (!scope.active || scope.refreshing || mutation.current) return;
    if (providerId === 'alipay') {
      receiveCatalog([]);
      setActions([]);
      setLoading(false);
      return;
    }
    scope.refreshing = true;
    const sequence = ++scope.refreshSequence;
    setLoading(true);
    const result = await Promise.allSettled([client.list(), client.actions()]);
    if (sequence === scope.refreshSequence) scope.refreshing = false;
    if (!scope.active || sequence !== scope.refreshSequence) return;
    if (result[0].status === 'fulfilled') {
      receiveCatalog(result[0].value.items);
    }
    if (result[1].status === 'fulfilled')
      setActions(
        providerId
          ? result[1].value.items.filter(item => item.provider === providerId)
          : result[1].value.items,
      );
    const failed = result.find(value => value.status === 'rejected');
    setError(failed?.status === 'rejected' ? errorMessage(failed.reason) : '');
    setLoading(false);
  }, [client, scope, receiveCatalog, providerId]);

  useEffect(() => {
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    scope.active = true;
    if (connectOnly) {
      return () => {
        scope.active = false;
        scope.controller.abort();
      };
    }
    void refresh();
    const unsubscribe = platform.onForeground(() => {
      void refresh();
    });
    const timer = setInterval(() => {
      if (scope.active) {
        tick(value => value + 1);
        void refresh();
      }
    }, 15000);
    return () => {
      scope.active = false;
      ++scope.refreshSequence;
      scope.refreshing = false;
      scope.controller.abort();
      unsubscribe();
      clearInterval(timer);
    };
  }, [scope, refresh, connectOnly]);

  const run = async (id: string, operation: () => Promise<void>) => {
    if (!scope.active || mutation.current) return;
    mutation.current = true;
    ++scope.refreshSequence;
    scope.refreshing = false;
    setLoading(false);
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (failure) {
      if (scope.active) setError(errorMessage(failure));
    } finally {
      mutation.current = false;
      if (scope.active) setBusy(null);
    }
  };

  const updateConnection = (item: PersonalMcpConnection) => {
    scope.catalog = scope.catalog.map(value =>
      value.id === item.id ? item : value,
    );
    setItems(scope.catalog);
    onConnectionChange?.(item);
    setToolOwner(null);
    setTools([]);
  };
  const openForm = (item: PersonalMcpConnection) => {
    if (
      mutation.current ||
      scope.catalog.find(value => value.id === item.id)?.status ===
        'not_configured'
    )
      return;
    setToken('');
    setServerUrl(item.server_url || '');
    setAccount('');
    setClientId('');
    setEnvironment(item.environment || 'production');
    setSelected(item.id);
    scope.selectedId = item.id;
    setToolOwner(null);
    setTools([]);
    setError('');
    setNotice('');
  };
  const closeForm = () => {
    if (mutation.current) return;
    setSelected(null);
    scope.selectedId = null;
    setToken('');
    setServerUrl('');
    setAccount('');
    setClientId('');
  };
  const connect = (item: PersonalMcpConnection) =>
    run(item.id, async () => {
      const current = scope.catalog.find(value => value.id === item.id);
      if (!current || current.status === 'not_configured')
        throw new Error('这个连接目前不可用，请刷新后再试。');
      const credential = token.trim();
      if (!credential)
        throw new Error('请先填写你本人的' + item.credential_label + '。');
      const address = item.requires_server_url ? serverUrl.trim() : undefined;
      if (item.requires_server_url && !address)
        throw new Error('请先填写' + item.name + '服务地址。');
      if (item.requires_account && !account.trim())
        throw new Error('请先填写你本人的' + item.name + '账号。');
      if (item.requires_client_id && !clientId.trim())
        throw new Error('请先填写 Client ID。');
      const result = await client.connect(
        item.id,
        credential,
        environment,
        address,
        {
          ...(item.requires_account ? { account: account.trim() } : {}),
          ...(item.requires_client_id ? { client_id: clientId.trim() } : {}),
        },
      );
      if (!scope.active) return;
      updateConnection(result);
      setToken('');
      setServerUrl('');
      setAccount('');
      setClientId('');
      setSelected(null);
      scope.selectedId = null;
      setNotice(item.name + '已通过实际连接校验，现在可以在对话中使用。');
    });
  const test = (item: PersonalMcpConnection) =>
    run(item.id, async () => {
      let result: PersonalMcpConnection;
      try {
        result = await client.test(item.id);
      } catch (failure) {
        // The server may have marked this credential as needing reconnection.
        // Re-read that state without replacing the original test error.
        try {
          const current = await client.list();
          if (scope.active) {
            receiveCatalog(current.items);
            setTools([]);
            setToolOwner(null);
          }
        } catch {
          /* The connection test error remains authoritative. */
        }
        throw failure;
      }
      if (!scope.active) return;
      updateConnection(result);
      setNotice(item.name + '校验成功，已实际获取可用工具。');
    });
  const showTools = (item: PersonalMcpConnection) =>
    run(item.id, async () => {
      if (toolOwner === item.id) {
        setToolOwner(null);
        setTools([]);
        return;
      }
      const result = await client.tools(item.id);
      if (!scope.active) return;
      setTools(result.items);
      setToolOwner(item.id);
    });
  const disconnect = (item: PersonalMcpConnection) => {
    if (mutation.current) return;
    Alert.alert(
      '断开' + item.name + '？',
      '妥啦会删除此服务器保存的账号凭证，并停止使用这个连接。已导入的资料保留。',
      [
        { text: '保留连接', style: 'cancel' },
        {
          text: '断开连接',
          style: 'destructive',
          onPress: () => {
            void run(item.id, async () => {
              await client.disconnect(item.id);
              if (!scope.active) return;
              if (item.id === 'didi') onRideChanged();
              const current =
                scope.catalog.find(value => value.id === item.id) || item;
              updateConnection({
                ...current,
                status:
                  current.status === 'not_configured'
                    ? 'not_configured'
                    : 'not_connected',
                has_credentials: false,
                tool_count: 0,
                checked_at: null,
              });
              setToken('');
              setAccount('');
              setClientId('');
              setServerUrl('');
              setSelected(null);
              scope.selectedId = null;
              setActions(previous =>
                previous.filter(value => value.provider !== item.id),
              );
              setNotice(
                '已断开' +
                  item.name +
                  '。若要在厂商侧撤销凭证，请前往官方账号设置。',
              );
            });
          },
        },
      ],
    );
  };
  const updateAction = (value: PersonalMcpAction) =>
    setActions(previous =>
      previous.map(item => (item.id === value.id ? value : item)),
    );
  const confirm = (action: PersonalMcpAction) => {
    if (mutation.current) return;
    Alert.alert(
      '确认执行这项操作？',
      action.provider_name +
        ' · ' +
        action.tool +
        '\n将按下方完整参数执行，可能修改资料或产生订单与费用。',
      [
        { text: '暂不执行', style: 'cancel' },
        {
          text: '确认执行',
          onPress: () => {
            void run(action.id, async () => {
              const expiry = Date.parse(action.expires_at);
              if (!Number.isFinite(expiry) || expiry <= Date.now()) {
                updateAction({ ...action, status: 'expired' });
                throw new Error('这项操作已过期，请在对话中重新提出需求。');
              }
              try {
                const result = await client.confirm(action.id);
                if (!scope.active) return;
                updateAction(result);
                if (result.status === 'completed' && result.provider === 'didi' && result.tool === 'taxi_create_order') {
                  onRideChanged();
                }
                setNotice(
                  result.status === 'completed'
                    ? '操作已完成，请查看下方执行结果。'
                    : result.status === 'failed'
                    ? '操作未成功，请查看下方返回结果。'
                    : result.status === 'unknown_outcome'
                    ? '执行结果尚不确定，请到原应用核实，勿重复提交。'
                    : '操作状态已更新，请查看下方详情。',
                );
              } catch (failure) {
                if (scope.active) {
                  updateAction({ ...action, status: 'unknown_outcome' });
                  setNotice(
                    '未能确认执行结果。请刷新状态并到原应用核实，勿重复提交。',
                  );
                }
                throw failure;
              }
            });
          },
        },
      ],
    );
  };
  const cancel = (action: PersonalMcpAction) =>
    run(action.id, async () => {
      const result = await client.cancel(action.id);
      if (!scope.active) return;
      updateAction(result);
      setNotice(
        result.status === 'cancelled'
          ? '这项操作已取消。'
          : result.status === 'completed'
          ? '这项操作已完成，无法取消。'
          : result.status === 'executing'
          ? '这项操作已经开始执行，请到原应用核实。'
          : result.status === 'unknown_outcome'
          ? '结果不确定，请到原应用核实，勿重复执行。'
          : '操作状态已更新，请查看下方详情。',
      );
    });
  const openHelp = (
    item: PersonalMcpConnection,
    url = (item.id === 'liepin' ? connectionGuide(item.id)?.url : undefined) ?? item.help_url,
  ) =>
    run(item.id, async () => {
      if (!/^https:\/\/[^\s/@]+(?:\/|$)/i.test(url))
        throw new Error('官方说明链接暂不可用。');
      await platform.openUrl(url);
    });
  const renderGuide = (item: PersonalMcpConnection) => {
    const guide = connectionGuide(item.id);
    return guide ? (
      <Text style={s.body} testID={'connection-guide-' + item.id}>
        {guide.before}
        <Text
          accessibilityRole="link"
          accessibilityLabel={item.name + '授权获取教程'}
          accessibilityHint="在浏览器中打开官方授权入口或教程"
          accessibilityState={{ disabled: busy !== null }}
          disabled={busy !== null}
          style={v.helpLink}
          onPress={() => {
            void openHelp(item, guide.url);
          }}
        >
          {guide.linkText}
        </Text>
        {guide.after}
      </Text>
    ) : null;
  };

  return (
    <View testID="personal-mcp-connections">
      {!compact && <>
      <Section
        title="我的账号"
        action={loading ? '正在刷新' : '刷新连接'}
        onAction={() => {
          void refresh();
        }}
      />
      <Text style={[s.small, v.intro]}>
        连接你自己的账号，让妥啦使用授权范围内的资料与服务。每个连接使用你本人的凭证，加密保存在当前登录的服务器。
      </Text>
      </>}
      <ErrorNotice
        message={error}
        retry={connectOnly ? undefined : () => { void refresh(); }}
      />
      {notice ? <Notice>{notice}</Notice> : null}
      {!providerId || providerId === 'alipay' ? (
        <AlipayWalletConnection api={api} hideTitle={hideTitle} showUnavailable={compact} />
      ) : null}
      {compact && providerId !== 'alipay' && loading && !items.length ? (
        <McpConnectionCard status="检查中" description="正在检查连接状态。" />
      ) : null}
      {providerId &&
      providerId !== 'alipay' &&
      !loading &&
      !items.some(isConnectionVisible) &&
      !error ? (
        <McpConnectionCard status="暂不可用" description="当前服务器尚未开通这项连接。" />
      ) : null}
      {items.filter(isConnectionVisible).map(item => {
        const tone = item.status === 'connected' ? 'green' : item.status === 'needs_reconnect' ? 'amber' : 'neutral';
        const connected = item.status === 'connected';
        const unavailable = item.status === 'not_configured';
        const formOpen = selected === item.id && !unavailable;
        const showManagement = !compact || (showDetails && !formOpen);
        const primary = !formOpen && (item.status === 'not_connected' ? (
          <Button disabled={busy !== null} onPress={() => openForm(item)} accessibilityLabel={'连接' + item.name + '账号'}>
            连接账号
          </Button>
        ) : item.status === 'needs_reconnect' ? (
          <Button disabled={busy !== null} loading={busy === item.id} onPress={() => { void test(item); }}
            accessibilityLabel={'校验' + item.name + '连接'}>
            核实连接
          </Button>
        ) : null);
        const content = <>
          {!compact ? <>
          <View style={s.between}>
            <Text style={[s.cardTitle, s.fill]}>{item.name}</Text>
            <Pill tone={tone}>{statusLabels[item.status]}</Pill>
          </View>
          <Text style={[s.body, v.description]}>{item.description}</Text>
          </> : null}
          {compact && showManagement ? <Text style={s.small}>{item.description}</Text> : null}
          {(!compact || showManagement || formOpen) && item.environment === 'experience' ? (
            <Text style={[s.small, v.description]}>
              个人体验 · 限时开放，非正式环境；请阅读官方使用说明后连接。
            </Text>
          ) : null}
          {!compact && unavailable ? (
            <Text style={[s.small, v.description]}>
              {item.unavailable_reason ||
                '这个服务尚未在当前服务器开通，请联系服务器管理员。'}
            </Text>
          ) : null}
          {showManagement && connected ? (
            <Text style={[s.small, v.description]}>
              {item.tool_count} 个可用工具
              {item.environment === 'experience' ? ' · 个人体验环境' : ''}
              {item.supports_sandbox
                ? item.environment === 'sandbox'
                  ? ' · 模拟测试环境'
                  : ' · 正式环境'
                : ''}
              {item.checked_at
                ? '\n上次校验：' + new Date(item.checked_at).toLocaleString()
                : ''}
            </Text>
          ) : null}
          {showManagement ? <View style={v.actions}>
            {!unavailable && (!connectOnly || !connected) && !formOpen && (!compact || item.status !== 'not_connected') && (
              <Button
                variant={item.status === 'connected' ? 'ghost' : 'secondary'}
                disabled={busy !== null}
                onPress={() => openForm(item)}
                accessibilityLabel={'连接' + item.name + '账号'}
              >
                {connected ? '更换凭证' : item.status === 'needs_reconnect' ? '重新连接' : '连接账号'}
              </Button>
            )}
            {!connectOnly && (item.status === 'connected' || item.status === 'needs_reconnect') ? (
              <>
                {(!compact || connected) ? <Button
                  variant="ghost"
                  disabled={busy !== null}
                  loading={busy === item.id}
                  onPress={() => {
                    void test(item);
                  }}
                  accessibilityLabel={'校验' + item.name + '连接'}
                >
                  测试连接
                </Button> : null}
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onPress={() => {
                    void showTools(item);
                  }}
                  accessibilityLabel={'查看' + item.name + '工具'}
                >
                  可用工具
                </Button>
              </>
            ) : null}
            {!connectOnly && (item.has_credentials || item.status === 'connected' || item.status === 'needs_reconnect') ? (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onPress={() => disconnect(item)}
                accessibilityLabel={'断开' + item.name + '连接'}
              >
                断开
              </Button>
            ) : null}
            <Button
              variant="ghost"
              disabled={busy !== null}
              onPress={() => {
                void openHelp(item);
              }}
              accessibilityLabel={item.name + '官方连接说明'}
            >
              官方说明 ↗
            </Button>
          </View> : null}
          {formOpen && (
            <View style={v.form}>
              {renderGuide(item)}
              <Text style={s.small}>
                请在官方页面获取你本人的凭证。凭证仅提交给当前连接的服务器，加密保存，不会在这里回显。
              </Text>
              {item.requires_server_url && (
                <Field
                  label={
                    item.id === 'memos'
                      ? 'Memos 服务地址'
                      : item.name + '服务地址'
                  }
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="https://notes.example.com"
                  keyboardType="url"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={busy === null}
                />
              )}
              {item.requires_account && (
                <Field
                  label={item.name + '账号'}
                  value={account}
                  onChangeText={setAccount}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  editable={busy === null}
                />
              )}
              {item.requires_client_id && (
                <Field
                  label="Client ID"
                  value={clientId}
                  onChangeText={setClientId}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  importantForAutofill="no"
                  editable={busy === null}
                />
              )}
              <Field
                label={item.credential_label}
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="none"
                autoComplete="off"
                importantForAutofill="no"
                editable={busy === null}
              />
              {item.supports_sandbox && (
                <View>
                  <Text style={s.label}>使用环境</Text>
                  <View style={v.environment}>
                    {(['production', 'sandbox'] as McpEnvironment[]).map(
                      value => (
                        <Pressable
                          key={value}
                          accessibilityRole="radio"
                          accessibilityLabel={
                            value === 'production' ? '正式环境' : '模拟测试环境'
                          }
                          accessibilityState={{
                            checked: environment === value,
                            disabled: busy !== null,
                          }}
                          disabled={busy !== null}
                          onPress={() => setEnvironment(value)}
                          style={[
                            v.environmentOption,
                            environment === value && v.environmentSelected,
                          ]}
                        >
                          <Text
                            style={environment === value ? s.link : s.small}
                          >
                            {value === 'production' ? '正式环境' : '模拟测试'}
                          </Text>
                        </Pressable>
                      ),
                    )}
                  </View>
                  <Text style={s.small}>
                    {environment === 'sandbox'
                      ? '仅模拟业务，不会产生真实叫车订单。'
                      : '会连接你的真实账号。下单等操作需在下方确认后执行，可能产生费用。'}
                  </Text>
                </View>
              )}
              <Button
                disabled={
                  busy !== null ||
                  !token.trim() ||
                  (item.requires_account === true && !account.trim()) ||
                  (item.requires_client_id === true && !clientId.trim()) ||
                  (item.requires_server_url === true && !serverUrl.trim())
                }
                loading={busy === item.id}
                onPress={() => {
                  void connect(item);
                }}
                accessibilityLabel={'校验并连接' + item.name}
              >
                校验并连接
              </Button>
              <Button
                variant="ghost"
                disabled={busy !== null}
                onPress={closeForm}
              >
                取消填写
              </Button>
            </View>
          )}
          {toolOwner === item.id && item.status !== 'not_configured' && (
            <View style={v.toolList}>
              <Text style={s.label}>当前账号可用的工具</Text>
              {!tools.length && (
                <Text style={s.small}>
                  当前账号没有可用工具，请检查厂商授权范围。
                </Text>
              )}
              {tools.map(tool => (
                <View key={tool.name} style={v.tool}>
                  <Text selectable style={s.body}>
                    {tool.name}
                  </Text>
                  {tool.description ? (
                    <Text style={s.small}>{tool.description}</Text>
                  ) : null}
                </View>
              ))}
              <Text style={s.small}>
                在对话中告诉妥啦你的需求。修改资料、下单等操作会先出现在下方，等待你确认。
              </Text>
            </View>
          )}
        </>;
        return compact ? (
          <McpConnectionCard key={item.id} title={hideTitle ? undefined : item.name}
            status={statusLabels[item.status]} tone={tone}
            description={unavailable ? item.unavailable_reason || '当前服务器尚未开通这项连接。' : item.description}
            descriptionLines={unavailable ? undefined : 2} action={primary}>
            {!formOpen ? <McpConnectionRow label={connected || item.status === 'needs_reconnect' || item.has_credentials ? '管理连接' : '授权范围与帮助'}
              expanded={showDetails} disabled={busy !== null} onPress={() => {
                setShowDetails(!showDetails);
                if (showDetails) {
                  setToolOwner(null);
                  setTools([]);
                }
              }} /> : null}
            {content}
          </McpConnectionCard>
        ) : <Card key={item.id}>{content}</Card>;
      })}
      {!providerId && !loading && !error && !items.length && (
        <Card>
          <Text style={s.body}>当前服务器尚未提供个人账号连接。</Text>
        </Card>
      )}
      {compact && actions.length > 0 ? <McpConnectionRow
        label={actions.some(item => item.status === 'pending' && Date.parse(item.expires_at) > Date.now())
          ? '待确认操作' : '账号操作记录'} expanded={showActions}
        disabled={busy !== null} onPress={() => setShowActions(!showActions)} /> : null}
      {!compact && actions.length > 0 && <Section title="账号操作" />}
      {(!compact || showActions) && actions.map(action => {
        const expiry = Date.parse(action.expires_at);
        const expired = !Number.isFinite(expiry) || expiry <= Date.now();
        const argumentsText = JSON.stringify(action.arguments, null, 2);
        const readable = argumentsText.length <= 24000;
        const resultText =
          action.result === undefined
            ? ''
            : JSON.stringify(action.result, null, 2);
        return (
          <Card key={action.id}>
            <Text style={s.cardTitle}>
              {action.provider_name} · {action.tool}
            </Text>
            <Text style={[s.small, v.description]}>
              {action.status === 'pending'
                ? expired
                  ? '确认已过期，不会执行。'
                  : '等待你确认；可能修改资料或产生订单与费用。'
                : action.status === 'executing'
                ? '正在执行，请勿重复提交。'
                : action.status === 'unknown_outcome'
                ? '结果不确定。请到原应用核实，勿重复执行。'
                : action.status === 'completed'
                ? '已完成'
                : action.status === 'failed'
                ? '操作未成功'
                : action.status === 'cancelled'
                ? '已取消'
                : '已过期'}
            </Text>
            {readable ? (
              <Text selectable style={[s.small, v.arguments]}>
                {argumentsText}
              </Text>
            ) : (
              <Text style={s.small}>
                操作参数过长，无法完整展示，请取消后让妥啦缩小操作范围。
              </Text>
            )}
            {(action.status === 'completed' || action.status === 'failed') &&
            action.result !== undefined ? (
              <Text selectable style={s.body}>
                {resultText.length > 16000
                  ? resultText.slice(0, 16000) +
                    '\n（结果较长，仅展示前 16000 字符。）'
                  : resultText}
              </Text>
            ) : null}
            {action.status === 'pending' && (
              <View style={v.actions}>
                <Button
                  disabled={busy !== null || expired || !readable}
                  loading={busy === action.id}
                  accessibilityLabel={
                    '确认执行' + action.provider_name + action.tool
                  }
                  onPress={() => confirm(action)}
                >
                  确认执行
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  accessibilityLabel={'取消操作' + action.id}
                  onPress={() => {
                    void cancel(action);
                  }}
                >
                  取消操作
                </Button>
              </View>
            )}
          </Card>
        );
      })}
    </View>
  );
}

const v = StyleSheet.create({
  intro: { marginBottom: 16 },
  helpLink: { color: '#36A7CB', textDecorationLine: 'underline' },
  description: { marginTop: 10 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  form: {
    gap: 12,
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderColor: colors.line,
  },
  environment: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  environmentOption: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: colors.cream,
  },
  environmentSelected: {
    backgroundColor: colors.blueLight,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  toolList: { marginTop: 12, borderTopWidth: 1, borderColor: colors.line },
  tool: { gap: 4, marginBottom: 12 },
  arguments: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: colors.background,
    marginVertical: 12,
  },
});

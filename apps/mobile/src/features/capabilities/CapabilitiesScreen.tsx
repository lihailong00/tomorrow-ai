import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAction, useApp, useResource } from '../../app/context';
import { platform } from '../../platform/ports';
import { appInputs } from '../../platform/appInputs';
import {
  canReadPhoneSource,
  phoneSourceIds,
  phoneSources,
} from '../../platform/phoneSources';
import { Text } from '../../ui/Text';
import { Button, ErrorNotice, Loading, Notice } from '../../ui/components';
import { Icon, IconName } from '../../ui/visuals';
import { integrationsApi } from '../integrations/api';
import { CloudConnection } from '../integrations/IntegrationsScreen';
import { healthApi } from '../health/api';
import { personalMcpApi } from '../personal-mcp/api';
import { PhoneSourcesEntry } from '../phone-sources/PhoneSourcesEntry';
import {
  buildHubEntries,
  capabilityAppearance as c,
  HubCategory,
  HubEntry,
  splitHubEntries,
} from './model';

const categories: Array<'全部' | HubCategory> = [
  '全部',
  '邮箱',
  '日程',
  '文件',
  '健康',
  '手机',
];
const categoryIcons: Record<HubCategory, IconName> = {
  邮箱: 'attachment',
  日程: 'calendar',
  文件: 'file',
  健康: 'memory',
  手机: 'bell',
};

export function CapabilitiesScreen() {
  const { api, user, preferences, revision, navigate } = useApp();
  const owner = useMemo(
    () => ({ active: true, controller: new AbortController() }),
    [api, user?.id, preferences.instance?.id],
  );
  useEffect(() => {
    owner.active = true;
    if (owner.controller.signal.aborted)
      owner.controller = new AbortController();
    return () => {
      owner.active = false;
      owner.controller.abort();
    };
  }, [owner]);
  const client = useMemo(
    () => integrationsApi(api, () => owner.controller.signal),
    [api, owner],
  );
  const healthClient = useMemo(
    () => healthApi(api, () => owner.controller.signal),
    [api, owner],
  );
  const mcpClient = useMemo(
    () => personalMcpApi(api, () => owner.controller.signal),
    [api, owner],
  );
  const legacy = useResource(() => api.connectors(), [api, user?.id, revision]);
  const domestic = useResource(() => client.list(), [client, revision]);
  const health = useResource(
    () => healthClient.list(),
    [healthClient, revision],
  );
  const mcp = useResource(() => mcpClient.list(), [mcpClient, revision]);
  const notifications = useResource(
    () => appInputs.getStatus(),
    [api, user?.id, revision],
  );
  const phone = useResource(async () => {
    const [status, raw] = await Promise.all([
      phoneSources.status(),
      AsyncStorage.getItem(
        'tada.phone.sources.v1:' +
          JSON.stringify([api.baseUrl, user?.id, preferences.instance?.id]),
      ),
    ]);
    const saved = raw ? JSON.parse(raw) : null;
    const selected =
      saved?.seen === true && Array.isArray(saved.enabled)
        ? phoneSourceIds.filter(id => saved.enabled.includes(id))
        : [];
    return {
      supported: phoneSources.supported,
      selected: selected.length,
      readable: selected.filter(id =>
        canReadPhoneSource(status.permissions[id]),
      ).length,
    };
  }, [api, user?.id, preferences.instance?.id, revision]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'全部' | HubCategory>('全部');
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const action = useAction();
  const resources = [legacy, domestic, health, mcp, notifications, phone];
  const refresh = () => resources.forEach(resource => resource.refresh());
  useEffect(
    () =>
      platform.onForeground(() => {
        legacy.refresh();
        domestic.refresh();
        health.refresh();
        mcp.refresh();
        notifications.refresh();
        phone.refresh();
      }),
    [
      api,
      user?.id,
      legacy.refresh,
      domestic.refresh,
      health.refresh,
      mcp.refresh,
      notifications.refresh,
      phone.refresh,
    ],
  );
  const entries = useMemo(
    () =>
      buildHubEntries({
        connectors: legacy.value?.items,
        integrations: domestic.value?.items,
        health: health.value ?? undefined,
        mcp: mcp.value?.items,
        notifications: notifications.value,
        phone: phone.value,
      }),
    [
      legacy.value,
      domestic.value,
      health.value,
      mcp.value,
      notifications.value,
      phone.value,
    ],
  );
  const groups = splitHubEntries(entries, query, category);
  const selected = entries.find(entry => entry.key === opened);
  const available =
    expanded || query.trim() || category !== '全部'
      ? groups.available
      : groups.available.slice(0, 4);
  const loading = resources.some(resource => resource.loading);
  const failures = resources.filter(resource => resource.error);
  const ready = resources.some(resource => resource.value !== null);
  const close = () => {
    if (action.busy) return;
    setOpened(null);
    action.setError(null);
    refresh();
  };
  const open = (key: string) => {
    setNotice('');
    action.setError(null);
    setOpened(key);
  };
  const goToManager = () => {
    setOpened(null);
    navigate({ name: 'integrations' });
  };
  const reloadDomestic = async () => {
    const next = await client.list();
    if (owner.active) domestic.setValue(next);
  };
  const stateLabel = (entry: HubEntry) =>
    entry.state === 'connected'
      ? '已连接'
      : entry.state === 'reconnect'
      ? '重新授权'
      : entry.state === 'unavailable'
      ? '暂不可用'
      : entry.kind === 'integration' && entry.source.mode === 'import'
      ? '导入'
      : entry.kind === 'integration' && entry.source.mode === 'map'
      ? '使用'
      : '连接';
  const row = (entry: HubEntry, index: number) => (
    <Pressable
      key={entry.key}
      testID={'capability-source-' + entry.key}
      accessibilityRole="button"
      accessibilityLabel={entry.name + '，' + stateLabel(entry)}
      onPress={() => open(entry.key)}
      style={({ pressed }) => [
        v.row,
        index > 0 && v.divider,
        pressed && { opacity: 0.65 },
      ]}
    >
      <View
        style={[
          v.icon,
          entry.category === '健康' && v.rose,
          entry.category === '邮箱' && v.teal,
        ]}
      >
        <Icon
          name={categoryIcons[entry.category]}
          size={21}
          color={
            entry.category === '健康'
              ? '#B26583'
              : entry.category === '邮箱'
              ? '#467F73'
              : c.accent
          }
        />
      </View>
      <View style={v.fill}>
        <Text style={v.name}>{entry.name}</Text>
        <Text style={v.description} numberOfLines={2}>
          {entry.detail}
        </Text>
      </View>
      <View style={v.state}>
        <Text
          style={[
            v.stateText,
            entry.state === 'connected' && { color: c.green },
            entry.state === 'reconnect' && { color: c.amber },
            entry.state === 'unavailable' && { color: c.secondary },
          ]}
        >
          {stateLabel(entry)}
        </Text>
        <Icon name="chevronRight" size={14} color="#A2A8B7" />
      </View>
    </Pressable>
  );
  const connectorDetails =
    selected?.kind === 'connector' ? selected.source : null;
  return (
    <View style={v.screen}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={v.content}
        refreshControl={
          <RefreshControl
            refreshing={loading && ready}
            onRefresh={refresh}
            tintColor={c.accent}
          />
        }
      >
        <Text style={v.title}>能力</Text>
        <Text style={v.subtitle}>连接你常用的工具，让帮助更贴近生活。</Text>
        {!!failures.length && (
          <ErrorNotice
            message={failures
              .map(resource => resource.error)
              .filter((value, index, array) => array.indexOf(value) === index)
              .join('；')}
            retry={refresh}
          />
        )}
        {loading && !ready ? <Loading label="正在查看连接状态…" /> : null}
        <View testID="capabilities-connected-section">
          <View style={v.section}>
            <Text style={v.sectionTitle}>
              已连接<Text style={v.count}> {groups.connected.length} 项</Text>
            </Text>
            {groups.connected.some(entry => entry.state === 'reconnect') ? (
              <Text style={v.warning}>有连接需要重新授权</Text>
            ) : null}
          </View>
          {groups.connected.length ? (
            <View style={v.group}>{groups.connected.map(row)}</View>
          ) : (
            <View style={v.empty}>
              <Icon name="sparkles" size={25} color={c.accent} />
              <Text style={v.emptyTitle}>
                {loading
                  ? '正在核实连接状态'
                  : failures.length
                  ? '部分连接状态暂时无法确认'
                  : '从一个熟悉的工具开始'}
              </Text>
              <Text style={v.emptyBody}>
                {failures.length
                  ? '请刷新重试。下方已确认可用的入口仍可使用。'
                  : '选择下方的邮箱、手机资料或其他工具，按你的需要授权。'}
              </Text>
            </View>
          )}
        </View>
        {!!notice && <Notice>{notice}</Notice>}
        <View testID="capabilities-available-section">
          <View style={v.section}>
            <Text style={v.sectionTitle}>添加更多连接</Text>
            <Text style={v.count}>按你的需要选择</Text>
          </View>
          <View style={v.search}>
            <Icon name="search" size={17} color={c.secondary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              accessibilityLabel="搜索未连接的应用或用途"
              placeholder="搜索未连接的应用或用途"
              placeholderTextColor="#858DA0"
              style={v.input}
              autoCorrect={false}
            />
          </View>
          <View style={v.filters}>
            {categories.map(item => (
              <Pressable
                key={item}
                accessibilityRole="button"
                accessibilityLabel={item + '连接'}
                accessibilityState={{ selected: category === item }}
                onPress={() => setCategory(item)}
                style={[v.chip, category === item && v.chipActive]}
              >
                <Text
                  style={[
                    v.chipText,
                    category === item && { color: '#FFFFFF' },
                  ]}
                >
                  {item}
                </Text>
              </Pressable>
            ))}
          </View>
          {available.length ? (
            <View style={v.group}>{available.map(row)}</View>
          ) : (
            <View style={v.empty}>
              <Text style={v.emptyTitle}>
                {query.trim()
                  ? '没有找到可添加的连接'
                  : '这个分类暂无可添加的连接'}
              </Text>
              <Text style={v.emptyBody}>
                试试其他名称或分类，已连接的工具在上方管理。
              </Text>
            </View>
          )}
          {!expanded &&
          !query.trim() &&
          category === '全部' &&
          groups.available.length > 4 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="查看全部未连接工具"
              onPress={() => setExpanded(true)}
              style={v.more}
            >
              <Text style={v.link}>查看全部 {groups.available.length} 项</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={[v.group, v.secondaryGroup]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="导入 AI 对话"
            onPress={() => navigate({ name: 'aiHistory' })}
            style={v.row}
          >
            <View style={v.icon}>
              <Icon name="history" color={c.accent} size={21} />
            </View>
            <View style={v.fill}>
              <Text style={v.name}>带上过去的 AI 对话</Text>
              <Text style={v.description}>ChatGPT · Claude · DeepSeek</Text>
            </View>
            <Icon name="chevronRight" size={15} color="#A2A8B7" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="管理手机通知、分享与已导入资料"
            onPress={goToManager}
            style={[v.row, v.divider]}
          >
            <View style={v.icon}>
              <Icon name="file" color={c.accent} size={21} />
            </View>
            <View style={v.fill}>
              <Text style={v.name}>分享与已导入资料</Text>
              <Text style={v.description}>查看待接收内容，确认后再导入</Text>
            </View>
            <Icon name="chevronRight" size={15} color="#A2A8B7" />
          </Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="查看授权范围与数据去向"
          onPress={() => open('privacy')}
          style={v.privacy}
        >
          <Text style={v.privacyText}>授权范围与数据去向，随时可查看</Text>
          <Icon name="chevronRight" size={13} color={c.secondary} />
        </Pressable>
      </ScrollView>
      <Modal
        visible={Boolean(opened)}
        animationType="slide"
        transparent
        onRequestClose={close}
      >
        <View style={v.overlay}>
          <SafeAreaView
            style={v.sheet}
            edges={['bottom']}
            accessibilityViewIsModal
          >
            <View style={v.sheetHeader}>
              <Text style={v.sheetTitle}>
                {selected?.name ||
                  (opened === 'privacy' ? '数据怎么用，你说了算' : '连接详情')}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭连接详情"
                disabled={action.busy}
                onPress={close}
                style={v.close}
              >
                <Icon name="close" size={20} color={c.secondary} />
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={v.sheetContent}
            >
              <ErrorNotice message={action.error} />
              {opened === 'privacy' ? (
                <>
                  <Text style={v.body}>
                    手机资料先在本机读取和预览，通知只接收你选择应用后续显示的内容。无法直接读取微信或
                    QQ 的全部聊天。
                  </Text>
                  <Text style={v.body}>
                    官方服务由妥啦服务器处理；自建服务由你选择的服务器处理。你发起
                    AI 整理时，相关内容会发送至配置的模型服务。
                  </Text>
                  <Text style={v.body}>
                    断开连接后停止后续访问。已导入的资料需要单独删除；导入对话不会自动写入长期记忆。
                  </Text>
                </>
              ) : null}
              {selected ? (
                <>
                  <Text style={v.body}>{selected.detail}</Text>
                  <View style={v.permission}>
                    <Text style={v.permissionTitle}>你保留选择权</Text>
                    <Text style={v.description}>
                      只在授权范围内读取。发送消息、修改资料等操作需要你明确确认。
                    </Text>
                  </View>
                </>
              ) : null}
              {selected?.state === 'unavailable' ? (
                <Text style={v.body}>
                  当前服务或设备尚未启用这项连接。可以先使用其他来源，或在服务设置中联系管理员完成配置。
                </Text>
              ) : null}
              {selected?.kind === 'integration' ? (
                <CloudConnection
                  key={selected.key}
                  item={selected.source}
                  onChanged={reloadDomestic}
                  onNotice={value => {
                    if (owner.active) setNotice(value);
                  }}
                  onImport={result => {
                    void action.run(async ({ isCurrent }) => {
                      const input = {
                        source_app: selected.source.id,
                        title: result.title,
                        text: result.text,
                        ...(result.url ? { url: result.url } : {}),
                      };
                      await client.importContent(input);
                      if (!owner.active || !isCurrent()) return;
                      setNotice('资料已导入，可在“分享与已导入资料”中查看。');
                      setOpened(null);
                    });
                  }}
                />
              ) : null}
              {connectorDetails &&
              connectorDetails.status === 'not_connected' ? (
                <Button
                  loading={action.busy}
                  onPress={() => {
                    void action.run(async ({ isCurrent }) => {
                      const result = await api.authorizeConnector(
                        connectorDetails.id,
                      );
                      if (!isCurrent()) return;
                      await platform.openUrl(result.authorization_url);
                      if (isCurrent())
                        setNotice(
                          '请在浏览器完成授权。返回 App 后会刷新真实连接状态。',
                        );
                    });
                  }}
                >
                  前往账号授权
                </Button>
              ) : null}
              {connectorDetails?.status === 'connected' ? (
                <LegacyConnection
                  id={connectorDetails.id}
                  onDisconnect={() =>
                    Alert.alert(
                      '断开 ' + connectorDetails.name + '？',
                      '撤销 Google 授权可能同时断开该账号的其他 Google 连接。已导入资料仍会保留。',
                      [
                        { text: '保留', style: 'cancel' },
                        {
                          text: '撤销并断开',
                          style: 'destructive',
                          onPress: () => {
                            void action.run(async ({ isCurrent }) => {
                              const result = await api.disconnectConnector(
                                connectorDetails.id,
                              );
                              if (!isCurrent()) return;
                              legacy.setValue(previous =>
                                previous
                                  ? {
                                      items: previous.items
                                        .filter(
                                          item =>
                                            item.id !== connectorDetails.id,
                                        )
                                        .concat({
                                          ...connectorDetails,
                                          status: 'not_connected',
                                        }),
                                    }
                                  : previous,
                              );
                              setNotice(
                                result.revoked
                                  ? '已撤销授权并断开。重新使用时需要再次授权。'
                                  : '本服务已解绑，平台端撤销未确认，请在原平台检查。',
                              );
                              setOpened(null);
                              legacy.refresh();
                            });
                          },
                        },
                      ],
                    )
                  }
                />
              ) : null}
              {selected?.kind === 'phone' ? <PhoneSourcesEntry /> : null}
              {selected?.kind === 'notifications' ? (
                <>
                  <Text style={v.body}>
                    仅处理通知里已经出现的内容。接收后先保留在本机，由你确认是否导入。
                  </Text>
                  <Button onPress={goToManager}>选择应用与管理通知</Button>
                </>
              ) : null}
              {selected?.kind === 'health' ? (
                <Button
                  onPress={() => {
                    setOpened(null);
                    navigate({ name: 'health' });
                  }}
                >
                  管理健康数据与授权
                </Button>
              ) : null}
              {selected?.kind === 'mcp' ? (
                <Button onPress={goToManager}>管理这个账号的连接</Button>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

function LegacyConnection({
  id,
  onDisconnect,
}: {
  id: string;
  onDisconnect: () => void;
}) {
  const { api, formatDate } = useApp();
  const [show, setShow] = useState(false);
  return (
    <>
      <Button variant="secondary" onPress={() => setShow(value => !value)}>
        {show ? '收起资料' : '查看已授权资料'}
      </Button>
      {show ? (
        <LegacyItems key={id} id={id} api={api} formatDate={formatDate} />
      ) : null}
      <Button variant="ghost" onPress={onDisconnect}>
        断开连接
      </Button>
    </>
  );
}
function LegacyItems({
  id,
  api,
  formatDate,
}: {
  id: string;
  api: ReturnType<typeof useApp>['api'];
  formatDate: ReturnType<typeof useApp>['formatDate'];
}) {
  const result = useResource(() => api.connectorItems(id), [api, id]);
  const action = useAction();
  return (
    <>
      <ErrorNotice message={result.error} retry={result.refresh} />
      <ErrorNotice message={action.error} />
      {result.loading && !result.value ? <Loading /> : null}
      {result.value?.items.map(item => (
        <View key={item.id} style={v.source}>
          <Text style={v.name}>{item.title}</Text>
          {item.date ? (
            <Text style={v.description}>{formatDate(item.date)}</Text>
          ) : null}
          <Text selectable style={v.body}>
            {item.preview}
          </Text>
          {item.link ? (
            <Button
              variant="ghost"
              onPress={() => {
                void action.run(() => platform.openUrl(item.link!));
              }}
            >
              打开原始来源
            </Button>
          ) : null}
        </View>
      ))}
      {result.value && !result.value.items.length ? (
        <Text style={v.body}>已连接，当前没有可显示的资料。</Text>
      ) : null}
      {result.value?.next_page_token ? (
        <Text style={v.description}>
          显示最近一页，更多资料请前往原始服务查看。
        </Text>
      ) : null}
    </>
  );
}

const v = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 },
  fill: { flex: 1, minWidth: 0 },
  title: {
    fontSize: 30,
    lineHeight: 39,
    fontWeight: '600',
    letterSpacing: -0.7,
    color: c.ink,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 22,
    color: c.secondary,
    marginTop: 6,
    marginBottom: 7,
  },
  section: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginTop: 25,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    lineHeight: 22,
    fontWeight: '600',
    color: c.ink,
  },
  count: {
    fontSize: 12,
    lineHeight: 20,
    color: c.secondary,
    fontWeight: '400',
  },
  warning: { fontSize: 11, color: c.amber, flexShrink: 1 },
  group: { backgroundColor: c.surface, borderRadius: 21, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: 76,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
  icon: {
    width: 39,
    height: 39,
    borderRadius: 12,
    backgroundColor: c.tint,
    justifyContent: 'center',
    alignItems: 'center',
  },
  rose: { backgroundColor: '#FAEDF2' },
  teal: { backgroundColor: '#E9F4F0' },
  name: { fontSize: 15, lineHeight: 22, fontWeight: '500', color: c.ink },
  description: {
    fontSize: 12,
    lineHeight: 19,
    color: c.secondary,
    marginTop: 3,
  },
  state: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 },
  stateText: { fontSize: 11, lineHeight: 19, color: c.accent },
  empty: { backgroundColor: c.surface, borderRadius: 21, padding: 20, gap: 8 },
  emptyTitle: { fontSize: 15, lineHeight: 23, fontWeight: '500', color: c.ink },
  emptyBody: { fontSize: 12, lineHeight: 21, color: c.secondary },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#E9EBF2',
    borderRadius: 12,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingVertical: 9,
    fontSize: 16,
    color: c.ink,
  },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginVertical: 12,
  },
  chip: {
    paddingHorizontal: 12,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: '#ECEEF5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: c.accent },
  chipText: { fontSize: 12, color: c.secondary },
  more: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  link: { fontSize: 12, color: c.accent },
  secondaryGroup: { marginTop: 18 },
  privacy: {
    minHeight: 48,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
  },
  privacyText: { fontSize: 11, color: c.secondary },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(23,33,62,.26)',
    justifyContent: 'flex-end',
    paddingTop: 64,
  },
  sheet: {
    backgroundColor: c.surface,
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    maxHeight: '100%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingLeft: 22,
    paddingRight: 12,
    paddingTop: 14,
    paddingBottom: 6,
  },
  sheetTitle: {
    fontSize: 21,
    lineHeight: 30,
    fontWeight: '600',
    color: c.ink,
    flex: 1,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetContent: { paddingHorizontal: 22, paddingTop: 5, paddingBottom: 28 },
  body: { fontSize: 14, lineHeight: 24, color: c.ink, marginVertical: 10 },
  permission: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: c.background,
    marginVertical: 12,
  },
  permissionTitle: {
    fontSize: 13,
    lineHeight: 21,
    color: c.ink,
    fontWeight: '500',
  },
  source: {
    marginTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.line,
    paddingTop: 12,
  },
});

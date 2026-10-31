import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useApp } from '../../app/context';
import { errorMessage, newRequestId } from '../../api/client';
import { platform } from '../../platform/ports';
import {
  canReadPhoneSource,
  phoneSources,
  phoneSourceIds,
  PhoneSnapshot,
  PhoneSource,
  PhoneStatus,
} from '../../platform/phoneSources';
import { Button, Card, ErrorNotice, Notice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { PhotoIndexSettings } from '../photo-index/PhotoIndexSettings';
import { integrationsApi } from '../integrations/api';
import { discoverPhoneTodos } from './discovery';
import { phoneImportText, recordDate, recordKey, sourceDetails } from './model';
import { PhoneWeatherCard } from './PhoneWeatherCard';

type SavedSetup = { seen: boolean; enabled: PhoneSource[] };
const initialSetup: SavedSetup = { seen: false, enabled: [] };
export function PhoneSourcesEntry({
  autoOpen = false,
  onShowTodos,
}: {
  autoOpen?: boolean;
  onShowTodos?: () => void;
}) {
  const { api, user, preferences } = useApp();
  if (!user || !phoneSources.supported) return null;
  return (
    <PhoneSourcesForOwner
      key={JSON.stringify([api.baseUrl, user.id, preferences.instance?.id])}
      autoOpen={autoOpen}
      onShowTodos={onShowTodos}
    />
  );
}
function PhoneSourcesForOwner({
  autoOpen,
  onShowTodos,
}: {
  autoOpen: boolean;
  onShowTodos?: () => void;
}) {
  const { api, user, preferences, invalidate, navigate } = useApp();
  const storageKey =
    'tada.phone.sources.v1:' +
    JSON.stringify([api.baseUrl, user!.id, preferences.instance?.id]);
  const owner = useRef({
    active: true,
    controller: new AbortController(),
  }).current;
  const [visible, setVisible] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<SavedSetup>(initialSetup);
  const savedRef = useRef(saved);
  const [selected, setSelected] = useState<PhoneSource[]>([...phoneSourceIds]);
  const [status, setStatus] = useState<PhoneStatus>();
  const [snapshots, setSnapshots] = useState<
    Partial<Record<PhoneSource, PhoneSnapshot>>
  >({});
  const [failures, setFailures] = useState<
    Partial<Record<PhoneSource, string>>
  >({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<PhoneSource>();
  const [photoSettings, setPhotoSettings] = useState(false);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const extraction = useRef(new Map<string, string>());
  const writeQueue = useRef(Promise.resolve());
  const persist = (next: SavedSetup) => {
    savedRef.current = next;
    setSaved(next);
    const write = writeQueue.current
      .catch(() => {})
      .then(() => AsyncStorage.setItem(storageKey, JSON.stringify(next)));
    writeQueue.current = write;
    return write;
  };
  useEffect(() => {
    owner.active = true;
    if (owner.controller.signal.aborted)
      owner.controller = new AbortController();
    void AsyncStorage.getItem(storageKey)
      .then(raw => {
        if (!owner.active) return;
        let next = initialSetup;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.seen === true && Array.isArray(parsed.enabled))
            next = {
              seen: true,
              enabled: phoneSourceIds.filter(id => parsed.enabled.includes(id)),
            };
        }
        savedRef.current = next;
        setSaved(next);
        if (next.seen) setSelected(next.enabled);
        if (autoOpen && !next.seen) setVisible(true);
        setLoaded(true);
      })
      .catch(() => {
        if (owner.active) {
          setLoaded(true);
          setError('本机连接设置暂时无法读取，请重新选择资料范围。');
        }
      });
    return () => {
      owner.active = false;
      owner.controller.abort();
    };
  }, [storageKey, autoOpen, owner]);
  const readSources = async (sources: PhoneSource[], ask: boolean) => {
    if (!owner.active || busyRef.current) return;
    busyRef.current = true;
    setBusy('正在检查本机资料权限…');
    setError('');
    setNotice('');
    try {
      if (ask) await persist({ seen: true, enabled: sources });
      let current = await phoneSources.status();
      if (!owner.active) return;
      setStatus(current);
      for (const source of phoneSourceIds.filter(id => sources.includes(id))) {
        if (!owner.active) return;
        setBusy(`正在整理${sourceDetails[source].title}…`);
        setSnapshots(previous => {
          const next = { ...previous };
          delete next[source];
          return next;
        });
        setChosen(previous =>
          previous.filter(key => !key.startsWith(source + ':')),
        );
        try {
          const permission = ask
            ? await phoneSources.request(source)
            : current.permissions[source];
          if (!owner.active) return;
          current = {
            ...current,
            permissions: { ...current.permissions, [source]: permission },
          };
          setStatus(current);
          if (!canReadPhoneSource(permission))
            throw new Error(
              source === 'sms'
                ? '未获得短信权限，可能受系统或安装来源限制；可以继续使用其他资料。'
                : '此来源未获授权，可以跳过，或在系统应用权限中开启。',
            );
          current = await phoneSources.status();
          if (!owner.active) return;
          setStatus(current);
          const result = await phoneSources.read(
            source,
            source === 'sms' &&
              sources.includes('contacts') &&
              canReadPhoneSource(current.permissions.contacts),
          );
          if (!owner.active) return;
          setSnapshots(previous => ({ ...previous, [source]: result }));
          setFailures(previous => ({ ...previous, [source]: '' }));
        } catch (failure) {
          if (!owner.active) return;
          setFailures(previous => ({
            ...previous,
            [source]: errorMessage(failure),
          }));
        }
      }
    } catch (failure) {
      if (owner.active) setError(errorMessage(failure));
    } finally {
      busyRef.current = false;
      if (owner.active) setBusy('');
    }
  };
  const readLatest = useRef(readSources);
  readLatest.current = readSources;
  useEffect(() => {
    if (!loaded) return;
    const refresh = () => {
      if (owner.active && !busyRef.current && savedRef.current.enabled.length)
        void readLatest.current(savedRef.current.enabled, false);
    };
    refresh();
    return platform.onForeground(refresh);
  }, [loaded, owner]);
  useEffect(() => {
    if (visible)
      void phoneSources
        .status()
        .then(value => {
          if (owner.active) setStatus(value);
        })
        .catch(failure => {
          if (owner.active) setError(errorMessage(failure));
        });
  }, [visible, owner]);
  const close = async () => {
    if (busyRef.current) return;
    try {
      await persist({ ...savedRef.current, seen: true });
      if (owner.active) setVisible(false);
    } catch {
      if (owner.active) {
        setVisible(false);
        setError('未能保存引导状态，下次打开可能再次显示。');
      }
    }
  };
  const toggle = (source: PhoneSource) => {
    if (busyRef.current) return;
    const enabling = !selected.includes(source);
    setSelected(previous =>
      enabling ? [...previous, source] : previous.filter(id => id !== source),
    );
    if (!enabling) {
      setSnapshots(previous => {
        const next = { ...previous };
        delete next[source];
        return next;
      });
      setChosen(previous =>
        previous.filter(key => !key.startsWith(source + ':')),
      );
      if (savedRef.current.enabled.includes(source))
        void persist({
          ...savedRef.current,
          enabled: savedRef.current.enabled.filter(id => id !== source),
        }).catch(() => {
          if (owner.active) setError('停止读取的设置未保存，请重试。');
        });
    }
  };
  const records = (['calendar', 'sms'] as PhoneSource[])
    .flatMap(source =>
      (snapshots[source]?.items ?? []).map(record => ({ source, record })),
    )
    .filter(
      item =>
        selected.includes(item.source) &&
        chosen.includes(recordKey(item.source, item.record)),
    );
  const discover = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('正在从所选资料发现待办…');
    setError('');
    setNotice('');
    try {
      const text = phoneImportText(records);
      const fingerprint = await phoneSources.fingerprint(text);
      if (!owner.active) return;
      // Persist only the idempotency receipt, never SMS/calendar/contacts content.
      const receiptKey = storageKey + ':discovery:' + fingerprint;
      let requestId =
        extraction.current.get(fingerprint) ??
        (await AsyncStorage.getItem(receiptKey));
      if (!owner.active) return;
      if (!requestId) {
        requestId = newRequestId();
        await AsyncStorage.setItem(receiptKey, requestId);
      }
      extraction.current.set(fingerprint, requestId);
      if (!owner.active) return;
      const imported = await integrationsApi(
        api,
        owner.controller.signal,
      ).importContent({
        source_app: 'shared',
        title: '手机短信与日历 · 用户选择的资料',
        text,
        external_id: 'phone-sources-v1:' + fingerprint,
      });
      if (!owner.active) return;
      const result = await discoverPhoneTodos(
        api,
        imported.id,
        requestId,
        owner.controller.signal,
      );
      if (!owner.active) return;
      setNotice(
        `已整理所选资料，本次新增 ${result.created_count} 条待办建议。请到事项的“新发现”确认。`,
      );
      invalidate();
    } catch (failure) {
      if (owner.active) setError(errorMessage(failure));
    } finally {
      busyRef.current = false;
      if (owner.active) setBusy('');
    }
  };
  const total = phoneSourceIds.reduce(
    (count, id) => count + (snapshots[id]?.items.length ?? 0),
    0,
  );
  const nextEvent = snapshots.calendar?.items[0];
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="连接与管理本机资料"
        onPress={() => setVisible(true)}
        style={ui.entry}
      >
        <View style={{ flex: 1 }}>
          <Text style={ui.entryTitle}>
            {total ? `已在本机整理 ${total} 条资料` : '让妥啦了解你的安排'}
          </Text>
          <Text style={s.small} numberOfLines={2}>
            {busy ||
              (nextEvent
                ? `接下来：${nextEvent.title} · ${recordDate(nextEvent)}`
                : '短信 · 日历 · 联系人 · 照片')}
          </Text>
        </View>
        <Text style={ui.link}>管理 ›</Text>
      </Pressable>
      <Modal
        visible={visible}
        animationType="slide"
        onShow={() => {
          scroll.current?.scrollTo({ x: 0, y: 0, animated: false });
          requestAnimationFrame(() => {
            if (owner.active)
              scroll.current?.scrollTo({ x: 0, y: 0, animated: false });
          });
        }}
        onRequestClose={() => {
          void close();
        }}
      >
        <SafeAreaView style={ui.screen} edges={['top', 'bottom']}>
          <View style={ui.header}>
            <Text style={ui.headerTitle}>连接本机资料</Text>
            <Button
              variant="ghost"
              disabled={Boolean(busy)}
              onPress={() => {
                void close();
              }}
            >
              稍后
            </Button>
          </View>
          <ScrollView
            ref={scroll}
            contentOffset={{ x: 0, y: 0 }}
            contentContainerStyle={s.content}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={s.title}>从你的生活开始</Text>
            <Text style={s.subtitle}>
              选好资料，妥啦就能帮你整理安排。先在手机上读取和预览，你选择交给
              AI 的内容才会发送。
            </Text>
            <Text style={[s.small, s.topGap]}>
              本机时区：{status?.timezone || '读取中'} · 邮箱可以以后单独连接
            </Text>
            <ErrorNotice message={error} />
            {notice ? <Notice>{notice}</Notice> : null}
            {phoneSourceIds.map(source => {
              const details = sourceDetails[source];
              const snapshot = snapshots[source];
              const showing =
                expanded === source
                  ? snapshot?.items
                  : snapshot?.items.slice(0, 3);
              return (
                <Card key={source} style={{ marginTop: 14 }}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`连接${details.title}`}
                    accessibilityState={{
                      checked: selected.includes(source),
                      disabled: Boolean(busy),
                    }}
                    disabled={Boolean(busy)}
                    onPress={() => toggle(source)}
                    style={ui.row}
                  >
                    <View
                      style={[
                        ui.check,
                        selected.includes(source) && ui.checked,
                      ]}
                    >
                      <Text
                        style={{
                          color: selected.includes(source)
                            ? '#FFFFFF'
                            : colors.secondary,
                        }}
                      >
                        {selected.includes(source) ? '✓' : ''}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.cardTitle}>{details.title}</Text>
                      <Text style={s.small}>{details.detail}</Text>
                    </View>
                  </Pressable>
                  <Text style={[s.small, { marginTop: 10 }]}>
                    {details.scope}
                  </Text>
                  {failures[source] ? (
                    <Text
                      style={[s.small, { color: colors.danger, marginTop: 8 }]}
                    >
                      {failures[source]}
                    </Text>
                  ) : null}
                  {status?.permissions[source] === 'blocked' && (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onPress={() => {
                        void phoneSources.openSettings().catch(() => {
                          if (owner.active)
                            setError(
                              '无法打开系统设置，请在手机设置的应用权限中查找妥啦。',
                            );
                        });
                      }}
                    >
                      打开系统权限设置
                    </Button>
                  )}
                  {snapshot ? (
                    <>
                      <Text style={[s.small, { marginTop: 10 }]}>
                        {snapshot.permission === 'limited'
                          ? '仅访问系统允许的部分照片。'
                          : ''}
                        {snapshot.items.length
                          ? `本次读取 ${snapshot.items.length} 条${
                              snapshot.limited ? '，已达到本次上限' : ''
                            }。`
                          : '已获授权，本次范围内没有可读取的记录。'}{' '}
                        {new Date(snapshot.readAt).toLocaleTimeString('zh-CN')}{' '}
                        更新
                      </Text>
                      {showing?.map(record => {
                        const selectable =
                          (source === 'sms' || source === 'calendar') &&
                          !record.truncated;
                        const checked = chosen.includes(
                          recordKey(source, record),
                        );
                        return (
                          <Pressable
                            key={record.id}
                            accessibilityRole={
                              selectable ? 'checkbox' : undefined
                            }
                            accessibilityLabel={record.title}
                            accessibilityState={
                              selectable ? { checked } : undefined
                            }
                            disabled={!selectable || Boolean(busy)}
                            onPress={() => {
                              if (!checked && chosen.length >= 10) {
                                setError('一次最多选择 10 条资料。');
                                return;
                              }
                              setChosen(previous =>
                                checked
                                  ? previous.filter(
                                      key => key !== recordKey(source, record),
                                    )
                                  : [...previous, recordKey(source, record)],
                              );
                            }}
                            style={ui.record}
                          >
                            {selectable && (
                              <Text style={ui.link}>{checked ? '☑' : '☐'}</Text>
                            )}
                            <View style={{ flex: 1 }}>
                              <Text style={ui.recordTitle} numberOfLines={2}>
                                {record.title}
                              </Text>
                              {recordDate(record) ? (
                                <Text style={s.small}>
                                  {recordDate(record)}
                                </Text>
                              ) : null}
                              {source !== 'contacts' && (
                                <Text
                                  style={s.small}
                                  numberOfLines={
                                    expanded === source ? undefined : 2
                                  }
                                >
                                  {record.text}
                                </Text>
                              )}
                              {record.truncated && (
                                <Text
                                  style={[s.small, { color: colors.amber }]}
                                >
                                  原文较长，当前仅预览部分；请从原应用分享完整内容后整理。
                                </Text>
                              )}
                            </View>
                          </Pressable>
                        );
                      })}
                      {snapshot.items.length > 3 && (
                        <Button
                          variant="ghost"
                          onPress={() =>
                            setExpanded(
                              expanded === source ? undefined : source,
                            )
                          }
                        >
                          {expanded === source
                            ? '收起'
                            : `查看本次 ${snapshot.items.length} 条资料`}
                        </Button>
                      )}
                    </>
                  ) : (
                    <Text style={[s.small, { marginTop: 10 }]}>
                      {status?.permissions[source] === 'blocked'
                        ? '系统尚未授予权限，可在应用权限中检查。'
                        : '尚未读取'}
                    </Text>
                  )}
                  {source === 'photos' && (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onPress={() => setPhotoSettings(value => !value)}
                    >
                      {photoSettings
                        ? '收起图片理解设置'
                        : '设置图片理解与相册检索'}
                    </Button>
                  )}
                </Card>
              );
            })}
            <View style={{ marginTop: 18 }}>
              <Button
                disabled={
                  !loaded || !selected.length || Boolean(busy) || photoSettings
                }
                loading={Boolean(busy)}
                onPress={() => {
                  void readSources(selected, true);
                }}
              >
                {busy || '授权并在本机整理'}
              </Button>
            </View>
            {photoSettings && (
              <Text style={[s.small, s.topGap]}>
                请先完成并收起图片理解设置，再读取其他来源。
              </Text>
            )}
            <Text style={[s.small, s.topGap]}>
              之后回到 App
              时，只刷新你已连接且仍获授权的来源。取消勾选可停止读取；系统权限可在手机设置中撤回。
            </Text>
            {photoSettings && <PhotoIndexSettings />}
            <PhoneWeatherCard />
            <Card style={{ marginTop: 20 }}>
              <Text style={s.cardTitle}>从所选资料发现待办</Text>
              <Text style={[s.small, s.topGap]}>
                勾选上方短信或日历原文，最多 10
                条。点击后会保存到当前服务器，并由该服务器的 AI
                处理。通讯录和照片不会随此操作上传。
              </Text>
              <Text selectable style={[s.small, s.topGap]}>
                当前服务器：{api.baseUrl}
              </Text>
              <Button
                disabled={!records.length || Boolean(busy)}
                onPress={() => {
                  void discover();
                }}
              >
                将 {records.length} 条资料交给 AI 整理
              </Button>
              {notice ? (
                <Button
                  variant="ghost"
                  onPress={() => {
                    void close().then(() => {
                      if (owner.active) {
                        if (onShowTodos) onShowTodos();
                        else navigate({ name: 'integrations' });
                      }
                    });
                  }}
                >
                  {onShowTodos ? '查看待办建议' : '查看已整理资料'}
                </Button>
              ) : null}
            </Card>
            <Card style={{ marginTop: 16 }}>
              <Text style={s.cardTitle}>其他手机资料</Text>
              <Text style={[s.small, s.topGap]}>
                健康记录、选定应用的新通知、备忘录分享，以及手动选择的录音和文件，也可以连接。系统闹钟、浏览器历史和第三方
                App 的私人数据库不能通用读取。
              </Text>
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onPress={() => {
                  void close().then(() => {
                    if (owner.active) navigate({ name: 'integrations' });
                  });
                }}
              >
                连接通知、分享与其他资料
              </Button>
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onPress={() => {
                  void close().then(() => {
                    if (owner.active) navigate({ name: 'health' });
                  });
                }}
              >
                连接健康记录
              </Button>
            </Card>
            <View style={{ height: 20 }} />
            <Button
              disabled={Boolean(busy)}
              onPress={() => {
                void close();
              }}
            >
              完成，开始使用妥啦
            </Button>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 22,
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: { fontSize: 17, color: colors.ink, fontWeight: '500' },
  entry: {
    marginHorizontal: 22,
    marginVertical: 8,
    padding: 14,
    borderRadius: 20,
    backgroundColor: '#EDF2FF',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  entryTitle: {
    fontSize: 14,
    lineHeight: 23,
    fontWeight: '500',
    color: colors.ink,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  check: {
    width: 26,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#BAC7E2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checked: { backgroundColor: colors.action, borderColor: colors.action },
  link: { color: colors.action, fontSize: 14 },
  record: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    marginTop: 8,
    flexDirection: 'row',
    gap: 10,
  },
  recordTitle: { fontSize: 14, lineHeight: 22, color: colors.ink },
});

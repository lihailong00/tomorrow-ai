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
  PhoneRecord,
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
import {
  calendarStatusLabel,
  canUsePhoneRecordForTodo,
  phoneImportText,
  recordDate,
  recordKey,
  sourceDetails,
  SelectedPhoneRecord,
} from './model';
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
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const [failures, setFailures] = useState<
    Partial<Record<PhoneSource, string>>
  >({});
  const [chosen, setChosen] = useState<SelectedPhoneRecord[]>([]);
  const [pageHistory, setPageHistory] = useState<
    Partial<Record<PhoneSource, string[]>>
  >({});
  const [detail, setDetail] = useState<PhoneRecord>();
  const [expanded, setExpanded] = useState<PhoneSource>();
  const [photoSettings, setPhotoSettings] = useState(false);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const refreshPending = useRef(false);
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
    if (ask) {
      setBusy('正在检查本机资料权限…');
      setError('');
      setNotice('');
    }
    try {
      if (ask) await persist({ seen: true, enabled: sources });
      let current = await phoneSources.status();
      if (!owner.active) return;
      setStatus(current);
      for (const source of phoneSourceIds.filter(id => sources.includes(id))) {
        if (!owner.active) return;
        if (ask) setBusy(`正在连接${sourceDetails[source].title}…`);
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
          if (!canReadPhoneSource(permission)) {
            // Revoked grants must not leave stale previews or selectable content visible.
            setSnapshots(previous => {
              const next = { ...previous };
              delete next[source];
              return next;
            });
            setChosen(previous =>
              previous.filter(item => item.source !== source),
            );
            await phoneSources.stop(source, storageKey);
            throw new Error(
              source === 'sms'
                ? '未获得短信权限，可能受系统或安装来源限制；可以继续使用其他资料。'
                : '此来源未获授权，可以跳过，或在系统应用权限中开启。',
            );
          }
          current = await phoneSources.status();
          if (!owner.active) return;
          setStatus(current);
          if (ask) setPageHistory(previous => ({ ...previous, [source]: [] }));
          let result = await phoneSources.read(
            source,
            source === 'sms' &&
              sources.includes('contacts') &&
              canReadPhoneSource(current.permissions.contacts),
            storageKey,
            ask,
          );
          if (!owner.active) return;
          const cursor = snapshotsRef.current[source]?.cursor;
          if (!ask && cursor && cursor !== '0') {
            result = await phoneSources.page(
              source,
              storageKey,
              cursor,
              source === 'sms' && sources.includes('contacts'),
            );
          }
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
      if (owner.active && refreshPending.current) {
        refreshPending.current = false;
        void readLatest.current(savedRef.current.enabled, false);
      }
    }
  };
  const readLatest = useRef(readSources);
  readLatest.current = readSources;
  useEffect(() => {
    if (!loaded) return;
    const refresh = () => {
      if (!owner.active || !savedRef.current.enabled.length) return;
      if (busyRef.current) refreshPending.current = true;
      else void readLatest.current(savedRef.current.enabled, false);
    };
    refresh();
    const foreground = platform.onForeground(refresh);
    const changes = phoneSources.onChange?.(refresh);
    return () => {
      foreground();
      changes?.();
    };
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
      void phoneSources.stop(source, storageKey).catch(failure => {
        if (owner.active) setError(errorMessage(failure));
      });
      setSnapshots(previous => {
        const next = { ...previous };
        delete next[source];
        return next;
      });
      setChosen(previous => previous.filter(item => item.source !== source));
      if (savedRef.current.enabled.includes(source))
        void persist({
          ...savedRef.current,
          enabled: savedRef.current.enabled.filter(id => id !== source),
        }).catch(() => {
          if (owner.active) setError('停止读取的设置未保存，请重试。');
        });
    }
  };
  const records = chosen.filter(item => selected.includes(item.source));
  const movePage = async (
    source: PhoneSource,
    cursor: string,
    back = false,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('正在读取本机资料…');
    try {
      const result = await phoneSources.page(
        source,
        storageKey,
        cursor,
        source === 'sms' && savedRef.current.enabled.includes('contacts'),
      );
      if (!owner.active) return;
      setPageHistory(previous => ({
        ...previous,
        [source]: back
          ? (previous[source] ?? []).slice(0, -1)
          : [...(previous[source] ?? []), snapshots[source]?.cursor ?? '0'],
      }));
      setSnapshots(previous => ({ ...previous, [source]: result }));
    } catch (failure) {
      if (owner.active) setError(errorMessage(failure));
    } finally {
      busyRef.current = false;
      if (owner.active) setBusy('');
    }
  };
  const showRecord = async (source: PhoneSource, record: PhoneRecord) => {
    try {
      const full = await phoneSources.record(source, storageKey, record.id);
      if (owner.active) setDetail(full);
    } catch (failure) {
      if (owner.active) setError(errorMessage(failure));
    }
  };
  // Poll a bounded preview only while work is actually queued/running.
  useEffect(() => {
    const pending = phoneSourceIds.filter(
      source =>
        saved.enabled.includes(source) &&
        ['queued', 'running'].includes(snapshots[source]?.syncState ?? ''),
    );
    if (!pending.length) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const updates: Partial<Record<PhoneSource, PhoneSnapshot>> = {};
      const errors: Partial<Record<PhoneSource, string>> = {};
      for (const source of pending) {
        if (
          cancelled ||
          !owner.active ||
          busyRef.current ||
          !savedRef.current.enabled.includes(source)
        )
          return;
        try {
          updates[source] = await phoneSources.page(
            source,
            storageKey,
            snapshots[source]?.cursor ?? '0',
            source === 'sms' && savedRef.current.enabled.includes('contacts'),
          );
        } catch (failure) {
          errors[source] = errorMessage(failure);
        }
      }
      if (cancelled || !owner.active) return;
      // One render for all sources; updating inside the loop would cancel sibling polls.
      setSnapshots(previous => ({ ...previous, ...updates }));
      setFailures(previous => ({ ...previous, ...errors }));
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [snapshots, saved.enabled, storageKey, owner, busy]);
  const discover = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy('正在从所选资料发现待办…');
    setError('');
    setNotice('');
    try {
      // Re-read selected records: an event may have been cancelled, or an SMS
      // may have changed or disappeared since the user selected its preview.
      const currentRecords: SelectedPhoneRecord[] = [];
      for (const item of records) {
        const record =
          item.source === 'calendar' || item.source === 'sms'
            ? await phoneSources.record(item.source, storageKey, item.record.id)
            : item.record;
        if (!owner.active) return;
        currentRecords.push({ source: item.source, record });
      }
      const text = phoneImportText(currentRecords);
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
    (count, id) =>
      count + (snapshots[id]?.cached ?? snapshots[id]?.items.length ?? 0),
    0,
  );
  const nextEvent = snapshots.calendar?.items
    .filter(
      item =>
        canUsePhoneRecordForTodo('calendar', { ...item, truncated: false }) &&
        (item.timestamp ?? 0) >= Date.now(),
    )
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))[0];
  const initialImport = phoneSourceIds.find(id => {
    const snapshot = snapshots[id];
    return (
      snapshot?.syncMode === 'full' &&
      ['queued', 'running'].includes(snapshot.syncState ?? '')
    );
  });
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
            {total ? `本机已保存 ${total} 条资料` : '让妥啦了解你的安排'}
          </Text>
          <Text style={s.small} numberOfLines={2}>
            {(initialImport
              ? `正在建立${sourceDetails[initialImport].title}资料库…`
              : '') ||
              (nextEvent
                ? `接下来：${nextEvent.title} · ${recordDate(nextEvent)}`
                : saved.enabled.length
                ? '变化时自动更新 · 资料保存在本机'
                : '短信 · 日历 · 联系人 · 照片')}
          </Text>
        </View>
        <Text style={ui.link}>管理 ›</Text>
      </Pressable>
      {detail ? (
        <Modal
          visible
          animationType="slide"
          onRequestClose={() => setDetail(undefined)}
        >
          <SafeAreaView style={ui.screen} edges={['top', 'bottom']}>
            <View style={ui.header}>
              <Text style={ui.headerTitle}>完整资料</Text>
              <Button variant="ghost" onPress={() => setDetail(undefined)}>
                关闭
              </Button>
            </View>
            <ScrollView contentContainerStyle={s.content}>
              <Text selectable style={s.cardTitle}>
                {detail?.title}
              </Text>
              <Text selectable style={[s.small, s.topGap]}>
                {detail ? recordDate(detail) : ''}
              </Text>
              <Text selectable style={s.subtitle}>
                {detail?.text}
              </Text>
              {detail?.data ? (
                <Text style={s.small}>
                  本机同时保存全部 {detail.data.length} 项联系人字段。
                </Text>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
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
                        {snapshot.syncState
                          ? `已保存 ${snapshot.processed ?? 0} / ${
                              snapshot.total ?? 0
                            } 条 · ${
                              snapshot.syncState === 'complete'
                                ? '本机资料已更新'
                                : snapshot.syncState === 'error'
                                ? '已暂停，保留进度'
                                : snapshot.syncMode === 'incremental'
                                ? '正在后台更新变化'
                                : '首次建立资料库'
                            }。`
                          : `本机已保存 ${snapshot.items.length} 条资料。`}{' '}
                        {new Date(snapshot.readAt).toLocaleTimeString('zh-CN')}{' '}
                        更新
                      </Text>
                      {showing?.map(record => {
                        const selectable = canUsePhoneRecordForTodo(
                          source,
                          record,
                        );
                        const checked = chosen.some(
                          item =>
                            recordKey(item.source, item.record) ===
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
                                      item =>
                                        recordKey(item.source, item.record) !==
                                        recordKey(source, record),
                                    )
                                  : [...previous, { source, record }],
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
                              {source === 'calendar' &&
                              calendarStatusLabel(record) ? (
                                <Text style={s.small}>
                                  {calendarStatusLabel(record)}
                                </Text>
                              ) : null}
                              {Boolean(record.text) && (
                                <Text
                                  style={s.small}
                                  numberOfLines={
                                    expanded === source ? undefined : 2
                                  }
                                >
                                  {record.text}
                                </Text>
                              )}
                              <Button
                                variant="ghost"
                                disabled={Boolean(busy)}
                                onPress={() => {
                                  void showRecord(source, record);
                                }}
                              >
                                查看完整资料
                              </Button>
                              {record.truncated && (
                                <Text
                                  style={[s.small, { color: colors.amber }]}
                                >
                                  原文已完整保存在本机，当前分页仅显示摘要。
                                </Text>
                              )}
                            </View>
                          </Pressable>
                        );
                      })}
                      {snapshot.syncError ? (
                        <Text style={[s.small, { color: colors.danger }]}>
                          {snapshot.syncError}
                        </Text>
                      ) : null}
                      {snapshot.syncState === 'error' && (
                        <Button
                          variant="ghost"
                          disabled={Boolean(busy)}
                          onPress={() => {
                            void readSources([source], false);
                          }}
                        >
                          继续整理
                        </Button>
                      )}
                      {expanded === source && (
                        <View style={ui.row}>
                          <Button
                            variant="ghost"
                            disabled={
                              Boolean(busy) || !pageHistory[source]?.length
                            }
                            onPress={() => {
                              const history = pageHistory[source] ?? [];
                              void movePage(
                                source,
                                history[history.length - 1] ?? '0',
                                true,
                              );
                            }}
                          >
                            上一页
                          </Button>
                          <Text style={s.small}>
                            第 {(pageHistory[source]?.length ?? 0) + 1} 页 ·
                            每页预览 50 条
                          </Text>
                          <Button
                            variant="ghost"
                            disabled={Boolean(busy) || !snapshot.nextCursor}
                            onPress={() => {
                              if (snapshot.nextCursor)
                                void movePage(source, snapshot.nextCursor);
                            }}
                          >
                            下一页
                          </Button>
                        </View>
                      )}
                      {snapshot.items.length > 3 ||
                      snapshot.nextCursor ||
                      pageHistory[source]?.length ? (
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
                            : `浏览全部资料（已保存 ${
                                snapshot.cached ?? snapshot.items.length
                              } 条）`}
                        </Button>
                      ) : null}
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
              首次读取后优先展示本机缓存，资料变化时后台增量更新，并低频核对遗漏变化。记录加密保存在手机本地；取消勾选会停止该来源并清除本机缓存，退出账号会清除全部本机资料缓存。系统权限可在手机设置中撤回。
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
                健康记录、选定应用的新通知、备忘录分享，以及手动选择的录音和文件，也可以连接。浏览器历史和第三方
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

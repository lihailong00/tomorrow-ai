import React, { useEffect, useRef, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { ActionScope, useAction, useApp } from '../../app/context';
import { ApiClient, ApiError, errorMessage } from '../../api/client';
import { inspectInstance } from '../../api/instance';
import {
  photoIndex,
  photoIndexAvailable,
  photoIndexPath,
  PhotoIndexStatus,
  PhotoAsset,
} from '../../platform/photoIndex';
import {
  Button,
  Card,
  ErrorNotice,
  Field,
  Notice,
  Section,
} from '../../ui/components';
import { styles as s } from '../../ui/theme';

const states: Record<string, string> = {
  queued: '等待充电和 Wi-Fi，随后开始处理',
  scanning: '正在上传分析副本并整理照片',
  analyzing: '云端正在分析照片，稍后自动同步结果',
  cloud_consent_required: '处理方式已更新，请重新确认云端分析授权',
  idle: '等待新增照片，后台约每 6 小时检查一次',
  paused: '已停止扫描',
  no_permission: '相册权限已收回，扫描已暂停',
  signed_out: '账号已退出，扫描已暂停',
  retrying: '暂未完成，稍后自动重试',
  processing_limited: '处理已暂缓，稍后继续；已完成的索引仍可查找',
};

export function PhotoIndexSettings() {
  const { api, user, preferences } = useApp();
  return <PhotoIndexSettingsForAccount key={JSON.stringify([api.baseUrl, user?.id, preferences.instance?.id])} />;
}

type PhotoSearchPage = { items: PhotoAsset[]; next_offset?: number | null; notice?: string | null };
type PhotoRemoteStatus = {
  enabled: boolean; indexed: number; facts_ready?: number; semantic_ready?: number;
  semantic_configured?: boolean; vision_configured?: boolean; epoch?: number;
  cloud_processing?: boolean; consent_scope?: string; consent_required?: boolean;
  configuration_paused?: boolean; consent_reason?: 'provider_changed' | 'legacy_consent' | null;
  configuration_revision?: number | null;
  processing_destinations?: {
    images: { processor: 'configured_provider' | 'not_configured'; destination: string | null };
    embeddings: { processor: 'configured_provider' | 'not_configured'; destination: string | null };
  };
};
type PhotoConsent = {
  instanceId: string; destination: string; embeddingDestination: string;
  consentScope: string;
};
function processingDestinations(status: PhotoRemoteStatus): { images: string; embeddings: string } | null {
  const describe = (value: NonNullable<PhotoRemoteStatus['processing_destinations']>['images'] | undefined) => {
    if (value?.processor === 'not_configured' && value.destination === null) return '未启用';
    if (value?.processor === 'configured_provider' && typeof value.destination === 'string' &&
      value.destination.length <= 2048 && /^https?:\/\/[^@\s?#]+$/.test(value.destination)) return value.destination;
    return null;
  };
  const images = describe(status.processing_destinations?.images);
  const embeddings = describe(status.processing_destinations?.embeddings);
  return images && embeddings ? { images, embeddings } : null;
}

function PhotoIndexSettingsForAccount() {
  const { api, user, preferences } = useApp();
  const [imageDestination, setImageDestination] = useState<string | null>(null);
  const [embeddingDestination, setEmbeddingDestination] = useState<string | null>(null);
  const [cloudConsent, setCloudConsent] = useState<Pick<PhotoRemoteStatus,
    'cloud_processing' | 'consent_required' | 'configuration_paused' | 'consent_reason' | 'consent_scope'>>({});
  const [local, setLocal] = useState<PhotoIndexStatus | null>(null);
  const [indexed, setIndexed] = useState(0);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [remoteEpoch, setRemoteEpoch] = useState<number | null>(null);
  const [searchReset, setSearchReset] = useState(0);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'hybrid' | 'keyword'>('hybrid');
  const [prepared, setPrepared] = useState({
    facts: 0,
    semantic: 0,
    semanticConfigured: false,
  });
  const [searchData, setSearchData] = useState<{
    key: string; api: ApiClient; items: PhotoAsset[]; nextOffset: number | null; notice: string;
  } | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const needsCloudConsent = cloudConsent.consent_required === true || cloudConsent.configuration_paused === true ||
    (remoteEnabled && cloudConsent.cloud_processing === false) || local?.state === 'cloud_consent_required';
  const effectiveSearchMode = needsCloudConsent ? 'keyword' : searchMode;
  const searchKey = JSON.stringify([api.baseUrl, user?.id, local?.deviceId, remoteEpoch, query.trim(), effectiveSearchMode, searchReset]);
  const currentSearch = useRef({ api, key: searchKey });
  currentSearch.current = { api, key: searchKey };
  const mounted = useRef(true);
  const refreshVersion = useRef(0);
  const currentOwner = useRef({ api, userId: user?.id });
  currentOwner.current = { api, userId: user?.id };
  const searchVersion = useRef(0);
  const pendingSearch = useRef<number | null>(null);
  const resetSearch = () => {
    searchVersion.current += 1;
    pendingSearch.current = null;
    setSearchData(null);
    setSearchBusy(false);
    setSearchError(null);
  };
  useEffect(() => {
    resetSearch();
    // A different query, consent epoch, device, account, or API cannot reuse a page.
  }, [api, searchKey]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; searchVersion.current += 1; };
  }, []);
  const visibleSearch = searchData?.key === searchKey && searchData.api === api ? searchData : null;
  const items = visibleSearch?.items ?? null;
  const searchNotice = visibleSearch?.notice ?? '';
  const searchPage = async (offset = 0) => {
    if (!local || !user || pendingSearch.current !== null) return;
    const version = ++searchVersion.current;
    pendingSearch.current = version;
    setSearchBusy(true);
    setSearchError(null);
    const isCurrent = () => mounted.current && searchVersion.current === version &&
      currentSearch.current.api === api && currentSearch.current.key === searchKey;
    try {
      const result = await api.request<PhotoSearchPage>(
        `${photoIndexPath(local.deviceId)}/assets?q=${encodeURIComponent(query.trim())}&mode=${effectiveSearchMode}&offset=${offset}`,
      );
      if (!isCurrent()) return;
      setSearchData(previous => {
        const existing = offset > 0 && previous?.key === searchKey && previous.api === api ? previous.items : [];
        const unique = new Map(existing.map(item => [item.asset_id, item]));
        for (const item of result.items) unique.set(item.asset_id, item);
        const next = result.next_offset;
        return { key: searchKey, api, items: [...unique.values()], notice: result.notice ?? '',
          nextOffset: result.items.length > 0 && typeof next === 'number' && Number.isSafeInteger(next) &&
            next > offset && next <= 50000 ? next : null };
      });
    } catch (error) {
      if (isCurrent()) setSearchError(errorMessage(error));
    } finally {
      if (isCurrent()) { pendingSearch.current = null; setSearchBusy(false); }
    }
  };
  const action = useAction();
  const refresh = async () => {
    if (!user || !photoIndexAvailable) return;
    const version = ++refreshVersion.current;
    const isCurrent = () => mounted.current && refreshVersion.current === version &&
      currentOwner.current.api === api && currentOwner.current.userId === user.id;
    const status = await photoIndex.status(api.baseUrl, user.id);
    if (!isCurrent()) return;
    setLocal(status);
    try {
      const remote = await api.request<PhotoRemoteStatus>(photoIndexPath(status.deviceId));
      if (!isCurrent()) return;
      setIndexed(remote.indexed);
      setVisionConfigured(remote.vision_configured === true);
      setRemoteEpoch(remote.epoch ?? null);
      setPrepared({
        facts: remote.facts_ready ?? 0,
        semantic: remote.semantic_ready ?? 0,
        semanticConfigured: remote.semantic_configured === true,
      });
      setRemoteEnabled(remote.enabled);
      setCloudConsent(remote);
      setUnavailable(false);
      setReady(true);
      const destinations = processingDestinations(remote);
      if (destinations) {
        setImageDestination(destinations.images);
        setEmbeddingDestination(destinations.embeddings);
      } else if (remote.vision_configured || remote.semantic_configured) {
        try {
          const latest = await inspectInstance(api.baseUrl, {
            allowInsecureLan: preferences.allowInsecureLan,
            expectedId: preferences.instance?.id,
          });
          if (isCurrent()) {
            setImageDestination(latest.instance.dataflow.images);
            setEmbeddingDestination(latest.instance.dataflow.embeddings ?? null);
          }
        } catch {
          if (isCurrent()) { setImageDestination(null); setEmbeddingDestination(null); }
        }
      } else {
        setImageDestination('未启用');
        setEmbeddingDestination('未启用');
      }
    } catch (error) {
      if (!isCurrent()) return;
      setReady(false);
      setImageDestination(null);
      setEmbeddingDestination(null);
      setUnavailable(error instanceof ApiError && error.status === 404);
      throw error;
    }
  };
  useEffect(() => {
    let listening = true;
    const reload = () => {
      if (listening) refresh().catch(() => {});
    };
    reload();
    const timer = setInterval(reload, 10000);
    return () => {
      listening = false;
      clearInterval(timer);
    };
    // Loading this view only reads configuration; it never opens the library or enables jobs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user?.id]);
  if (!user) return null;
  const run = (operation: (scope: ActionScope) => Promise<void>) =>
    action.run(async scope => {
      try {
        await operation(scope);
      } finally {
        if (scope.isCurrent()) await refresh().catch(() => {});
      }
    });
  const readPhotoConsent = async (scope: ActionScope, expectedId = preferences.instance?.id): Promise<PhotoConsent> => {
    if (!local) throw new Error('相册设置尚未读取完成，请稍后重试。');
    const latest = await inspectInstance(api.baseUrl, {
      allowInsecureLan: preferences.allowInsecureLan,
      expectedId,
    });
    if (!scope.isCurrent()) throw new Error('账号或连接已变化，请重新开启。');
    const remote = await api.request<PhotoRemoteStatus>(photoIndexPath(local.deviceId));
    if (!scope.isCurrent()) throw new Error('账号或连接已变化，请重新开启。');
    const destinations = processingDestinations(remote);
    if (!destinations || typeof remote.consent_scope !== 'string' || !remote.consent_scope) {
      throw new Error('当前服务器未提供完整的图片与文字向量授权信息，请更新服务器后再开启云端分析。已有索引仍可文字匹配。');
    }
    if (destinations.images === '未启用') {
      setImageDestination(null);
      throw new Error('当前服务器未启用图片分析，请刷新配置后再开启。');
    }
    // Display and token are one server snapshot; cached manifest destinations cannot grant consent.
    setImageDestination(destinations.images);
    setEmbeddingDestination(destinations.embeddings);
    setCloudConsent(remote);
    setRemoteEpoch(remote.epoch ?? null);
    return { instanceId: latest.instance.id, destination: destinations.images,
      embeddingDestination: destinations.embeddings, consentScope: remote.consent_scope };
  };
  const showPhotoConsent = (consent: PhotoConsent, renewing = false) => Alert.alert(
    renewing ? '重新确认云端分析' : '开启相册索引',
    `确认后，将在充电且连接 Wi-Fi 时，压缩你授权的照片并上传分析副本。图片分析去向：${consent.destination}。文字向量去向：${consent.embeddingDestination}。文字向量服务会处理照片中的文字、描述及你的查找内容；未启用时仅做文字匹配。手机原图不修改；服务器只保存分析结果和必要元信息。已有照片选择与索引会保留，你可以随时停止或清除索引。`,
    [
      { text: '暂不开启', style: 'cancel' },
      { text: renewing ? '确认并恢复云端分析' : '开启并选择照片', onPress: () => action.run(async scope => {
        const latest = await readPhotoConsent(scope, consent.instanceId);
        if (JSON.stringify(latest) !== JSON.stringify(consent)) {
          setNotice('图片或文字向量处理配置已更新，请确认最新处理去向后再开启。');
          showPhotoConsent(latest, renewing);
          return;
        }
        try {
          await photoIndex.enable(api, user.id, { consentScope: consent.consentScope });
          if (scope.isCurrent()) setNotice(renewing ? '已更新授权。连接 Wi-Fi 并充电后继续处理授权照片。' : '已开启。连接 Wi-Fi 并充电后开始处理授权照片。');
        } catch (error) {
          if (error instanceof ApiError && error.code === 'photo_cloud_consent_changed' && scope.isCurrent()) {
            const current = await readPhotoConsent(scope, consent.instanceId);
            setNotice('处理去向刚刚变化，请确认最新配置后再授权。');
            showPhotoConsent(current, renewing);
            return;
          }
          if (scope.isCurrent()) await refresh().catch(() => {});
          throw error;
        }
        if (scope.isCurrent()) await refresh().catch(() => {});
      }) },
    ],
  );
  return (
    <>
      <Section title="相册索引" />
      <Card>
        <Text style={s.cardTitle}>
          相册索引 · {needsCloudConsent ? '云端处理已暂停' : local?.enabled ? '已开启' : '未开启'}
        </Text>
        <Text style={[s.small, { marginVertical: 8 }]}>
          默认关闭。开启后，在充电且连接 Wi-Fi
          时，为你授权的照片生成高清分析副本，上传云端视觉模型提取文字、画面描述和标签。手机原图不修改，分析副本不落盘，服务器只保存分析结果与索引。
        </Text>
        <Text style={s.small}>
          图片分析去向：{imageDestination ?? '授权前将核实最新配置'}。文字向量去向：{embeddingDestination ?? '尚未核实'}。照片文字、画面描述及查找内容可能交由文字向量服务处理。图片与识别结果可能含隐私，请只授权你愿意分析的照片。此功能不会自动把推测写成你的长期记忆。
        </Text>
        {!photoIndexAvailable ? (
          <Notice>当前设备暂不支持相册索引。</Notice>
        ) : (
          <>
            <Text style={[s.small, s.topGap]}>
              已建立 {indexed} 张图片索引。
              {needsCloudConsent ? '云端处理已暂停，已有索引仍可文字匹配。' : local?.enabled
                ? states[local.state] ?? '已开启'
                : '不会读取相册或同步新索引。'}
            </Text>
            {unavailable && (
              <Notice>当前服务尚未提供相册索引，请更新后端后再开启。</Notice>
            )}
            {ready && !visionConfigured && <Notice>当前服务尚未配置云端图片分析，请稍后再开启。</Notice>}
            {needsCloudConsent && <Notice>{cloudConsent.consent_reason === 'provider_changed'
              ? '图片或文字向量服务已更换，请确认新的处理去向后恢复云端分析。'
              : '云端分析需要重新授权。已有照片选择、索引与系统权限会保留。'}</Notice>}
            {!ready && !unavailable && (
              <Notice>
                请确认服务连接后再开启。已有本机任务可以随时关闭。
              </Notice>
            )}
            <View style={s.topGap}>
              {local?.enabled ? (
                <Button
                  variant="secondary"
                  loading={action.busy}
                  onPress={() =>
                    run(async () => {
                      await photoIndex.disable(api, user.id);
                      setNotice('已关闭。已有云端索引会保留，可以单独清除。');
                    })
                  }
                >
                  关闭索引
                </Button>
              ) : !needsCloudConsent ? (
                <Button
                  disabled={!ready || !visionConfigured}
                  loading={action.busy}
                  onPress={() => action.run(async scope => { showPhotoConsent(await readPhotoConsent(scope)); })}
                >
                  开启相册索引
                </Button>
              ) : null}
            </View>
            {needsCloudConsent && <Button disabled={!ready || !visionConfigured} loading={action.busy}
              onPress={() => action.run(async scope => { showPhotoConsent(await readPhotoConsent(scope), true); })}>
              重新确认云端分析
            </Button>}
            {!local?.enabled && remoteEnabled && (
              <Button
                variant="ghost"
                loading={action.busy}
                onPress={() =>
                  run(async () => {
                    await photoIndex.disable(api, user.id);
                    setNotice('云端已确认关闭。');
                  })
                }
              >
                关闭索引
              </Button>
            )}
            {local && (
              <Button
                variant="ghost"
                loading={action.busy}
                onPress={() =>
                  run(async () => {
                    await photoIndex.manageAccess();
                  })
                }
              >
                管理相册权限
              </Button>
            )}
            {local?.enabled && (
              <Button
                variant="ghost"
                disabled={needsCloudConsent}
                loading={action.busy}
                onPress={() =>
                  run(async () => {
                    await photoIndex.scanNow();
                    setNotice('已加入处理队列，满足充电和 Wi-Fi 条件后运行。');
                  })
                }
              >
                检查新增照片
              </Button>
            )}
            {indexed > 0 && (
              <>
                <Text style={[s.small, s.topGap]}>
                  已整理 {prepared.facts} 张照片中的线索。
                  {needsCloudConsent ? '云端含义查找已暂停，仍可按文字匹配。' : `${prepared.semantic} 张可按含义查找。`}
                  {!prepared.semanticConfigured && !needsCloudConsent
                    ? '当前服务暂未开启含义搜索，仍可按文字匹配。'
                    : ''}
                </Text>
                <Field
                  label="查找已索引照片"
                  placeholder={
                    effectiveSearchMode === 'hybrid'
                      ? '例如：去昆明旅行的机票'
                      : '输入照片里出现的文字'
                  }
                  value={query}
                  onChangeText={value => { resetSearch(); setQuery(value); }}
                  maxLength={100}
                />
                <View style={[s.row, s.gap]}>
                  <View style={s.fill}>
                    <Button
                      variant={effectiveSearchMode === 'hybrid' ? 'secondary' : 'ghost'}
                      disabled={needsCloudConsent}
                      onPress={() => { resetSearch(); setSearchMode('hybrid'); }}
                    >
                      按含义查找
                    </Button>
                  </View>
                  <View style={s.fill}>
                    <Button
                      variant={effectiveSearchMode === 'keyword' ? 'secondary' : 'ghost'}
                      onPress={() => { resetSearch(); setSearchMode('keyword'); }}
                    >
                      文字匹配
                    </Button>
                  </View>
                </View>
                <Button
                  variant="ghost"
                  loading={searchBusy}
                  disabled={!local}
                  onPress={() => searchPage()}
                >
                  查看图片索引
                </Button>
              </>
            )}
            {searchNotice ? <Notice>{searchNotice}</Notice> : null}
            {items?.map(item => (
              <View
                key={item.asset_id}
                style={[s.topGap, { paddingVertical: 8 }]}
              >
                <Text style={s.small}>
                  {(
                    item.results.find(r => r.kind === 'description')?.content ||
                    item.results.find(r => r.kind === 'ocr')?.content ||
                    '图片索引'
                  ).slice(0, 240)}
                </Text>
                {Boolean(item.facts?.length) && (
                  <>
                    <Text style={[s.small, s.topGap]}>
                      图片中的线索 · 需要核实
                    </Text>
                    {item.facts!.slice(0, 8).map((fact, n) => (
                      <View key={`${fact.kind}-${n}`} style={{ paddingTop: 6 }}>
                        <Text style={s.small}>
                          {(
                            {
                              date: '日期',
                              date_without_year: '日期（年份未知）',
                              time: '时间',
                              time_without_period: '时间（时段未知）',
                              amount: '金额',
                              location: '地点',
                              flight_number: '航班',
                            } as Record<string, string>
                          )[fact.kind] ?? fact.kind}
                          ：{fact.value}
                        </Text>
                        <Text style={s.small}>依据：{fact.evidence}</Text>
                      </View>
                    ))}
                  </>
                )}
                <Button
                  variant="ghost"
                  onPress={() =>
                    run(async () => {
                      await photoIndex.openAsset(
                        api.baseUrl,
                        user.id,
                        item.asset_id,
                      );
                    })
                  }
                >
                  打开本机原图
                </Button>
              </View>
            ))}
            {items?.length === 0 && (
              <Text style={s.small}>没有找到匹配的图片索引。</Text>
            )}
            {visibleSearch?.nextOffset != null && <Button variant="ghost" loading={searchBusy}
              onPress={() => searchPage(visibleSearch.nextOffset!)}>加载更多图片索引</Button>}
            <ErrorNotice message={searchError} />
            <Button
              variant="ghost"
              disabled={!ready}
              loading={action.busy}
              onPress={() =>
                Alert.alert(
                  '清除本机照片的云端索引',
                  '同时关闭索引，删除该设备对应的云端描述、识别文字、标签和本地索引缓存。手机原图不会删除。',
                  [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '清除索引',
                      style: 'destructive',
                      onPress: () =>
                        run(async () => {
                          resetSearch();
                          setSearchReset(value => value + 1);
                          await photoIndex.clear(api, user.id);
                          setNotice('已关闭并清除该设备对应的图片索引。');
                        }),
                    },
                  ],
                )
              }
            >
              清除已有索引
            </Button>
          </>
        )}
        {notice ? <Notice>{notice}</Notice> : null}
        <ErrorNotice message={action.error} />
      </Card>
    </>
  );
}

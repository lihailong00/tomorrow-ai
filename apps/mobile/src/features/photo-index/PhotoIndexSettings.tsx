import React, { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { ApiError } from '../../api/client';
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
  const imageDestination = preferences?.instance?.dataflow.images ?? '当前服务器配置的图片分析服务';
  const [local, setLocal] = useState<PhotoIndexStatus | null>(null);
  const [indexed, setIndexed] = useState(0);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'hybrid' | 'keyword'>('hybrid');
  const [searchNotice, setSearchNotice] = useState('');
  const [prepared, setPrepared] = useState({
    facts: 0,
    semantic: 0,
    semanticConfigured: false,
  });
  const [items, setItems] = useState<PhotoAsset[] | null>(null);
  const action = useAction();
  const refresh = async () => {
    if (!user || !photoIndexAvailable) return;
    const status = await photoIndex.status(api.baseUrl, user.id);
    setLocal(status);
    try {
      const remote = await api.request<{
        enabled: boolean;
        indexed: number;
        facts_ready?: number;
        semantic_ready?: number;
        semantic_configured?: boolean;
        vision_configured?: boolean;
      }>(photoIndexPath(status.deviceId));
      setIndexed(remote.indexed);
      setVisionConfigured(remote.vision_configured === true);
      setPrepared({
        facts: remote.facts_ready ?? 0,
        semantic: remote.semantic_ready ?? 0,
        semanticConfigured: remote.semantic_configured === true,
      });
      setRemoteEnabled(remote.enabled);
      setUnavailable(false);
      setReady(true);
    } catch (error) {
      setReady(false);
      setUnavailable(error instanceof ApiError && error.status === 404);
      throw error;
    }
  };
  useEffect(() => {
    let mounted = true;
    const reload = () => {
      if (mounted) refresh().catch(() => {});
    };
    reload();
    const timer = setInterval(reload, 10000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
    // Loading this view only reads configuration; it never opens the library or enables jobs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, user?.id]);
  if (!user) return null;
  const run = (operation: () => Promise<void>) =>
    action.run(async () => {
      try {
        await operation();
      } finally {
        await refresh().catch(() => {});
      }
    });
  return (
    <>
      <Section title="相册索引" />
      <Card>
        <Text style={s.cardTitle}>
          相册索引 · {local?.enabled ? '已开启' : '未开启'}
        </Text>
        <Text style={[s.small, { marginVertical: 8 }]}>
          默认关闭。开启后，在充电且连接 Wi-Fi
          时，为你授权的照片生成高清分析副本，上传云端视觉模型提取文字、画面描述和标签。手机原图不修改，分析副本不落盘，服务器只保存分析结果与索引。
        </Text>
        <Text style={s.small}>
          处理去向：{imageDestination}。图片与识别结果可能含隐私，请只授权你愿意分析的照片。此功能不会自动把推测写成你的长期记忆。
        </Text>
        {!photoIndexAvailable ? (
          <Notice>当前设备暂不支持相册索引。</Notice>
        ) : (
          <>
            <Text style={[s.small, s.topGap]}>
              已建立 {indexed} 张图片索引。
              {local?.enabled
                ? states[local.state] ?? '已开启'
                : '不会读取相册或同步新索引。'}
            </Text>
            {unavailable && (
              <Notice>当前服务尚未提供相册索引，请更新后端后再开启。</Notice>
            )}
            {ready && !visionConfigured && <Notice>当前服务尚未配置云端图片分析，请稍后再开启。</Notice>}
            {local?.state === 'cloud_consent_required' && <Notice>旧版只上传文字。新版会临时上传图片分析副本，需要你重新确认开启。</Notice>}
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
              ) : (
                <Button
                  disabled={!ready || !visionConfigured}
                  loading={action.busy}
                  onPress={() =>
                    Alert.alert(
                      '开启相册索引',
                      `开启后，将在充电且连接 Wi-Fi 时，压缩你授权的照片并上传分析副本。处理去向：${imageDestination}。手机原图不修改；服务器在内存中临时处理图片，只保存分析结果和必要元信息。你可以只授权部分照片，并随时停止或清除索引。`,
                      [
                        { text: '暂不开启', style: 'cancel' },
                        {
                          text: '开启并选择照片',
                          onPress: () =>
                            run(async () => {
                              await photoIndex.enable(api, user.id);
                              setNotice(
                                '已开启。连接 Wi-Fi 并充电后开始处理授权照片。',
                              );
                            }),
                        },
                      ],
                    )
                  }
                >
                  开启相册索引
                </Button>
              )}
            </View>
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
            {local?.enabled && (
              <Button
                variant="ghost"
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
                  已整理 {prepared.facts} 张照片中的线索，{prepared.semantic}{' '}
                  张可按含义查找。
                  {!prepared.semanticConfigured
                    ? '当前服务暂未开启含义搜索，仍可按文字匹配。'
                    : ''}
                </Text>
                <Field
                  label="查找已索引照片"
                  placeholder={
                    searchMode === 'hybrid'
                      ? '例如：去昆明旅行的机票'
                      : '输入照片里出现的文字'
                  }
                  value={query}
                  onChangeText={setQuery}
                  maxLength={100}
                />
                <View style={[s.row, s.gap]}>
                  <View style={s.fill}>
                    <Button
                      variant={searchMode === 'hybrid' ? 'secondary' : 'ghost'}
                      onPress={() => setSearchMode('hybrid')}
                    >
                      按含义查找
                    </Button>
                  </View>
                  <View style={s.fill}>
                    <Button
                      variant={searchMode === 'keyword' ? 'secondary' : 'ghost'}
                      onPress={() => setSearchMode('keyword')}
                    >
                      文字匹配
                    </Button>
                  </View>
                </View>
                <Button
                  variant="ghost"
                  loading={action.busy}
                  onPress={() =>
                    run(async () => {
                      if (!local) return;
                      const result = await api.request<{
                        items: PhotoAsset[];
                        notice?: string | null;
                      }>(
                        `${photoIndexPath(
                          local.deviceId,
                        )}/assets?q=${encodeURIComponent(
                          query.trim(),
                        )}&mode=${searchMode}`,
                      );
                      setItems(result.items);
                      setSearchNotice(result.notice ?? '');
                    })
                  }
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
                          await photoIndex.clear(api, user.id);
                          setItems(null);
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

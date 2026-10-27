import React from 'react';
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useAction, useApp, useResource } from '../app/context';
import { Upload } from '../domain/types';
import {
  Button,
  Card,
  Empty,
  ErrorNotice,
  Loading,
  Pill,
} from '../ui/components';
import { styles as s } from '../ui/theme';

function fileDescription(item: Upload) {
  if (/\.(txt|md|csv|tsv|json|log)$/i.test(item.name)) {
    return '文本资料 · 可以用于对话（最多读取 64 KB）';
  }
  if (item.mime_type.startsWith('audio/')) {
    return '音频资料 · 需成功转写后才能用于对话';
  }
  if (/\.(docx|xlsx)$/i.test(item.name)) {
    return '文档资料 · 可读取 DOCX 正文/表格或 XLSX 单元格文字；不执行公式';
  }
  return '已保存原始文件 · 首版暂不解析此格式';
}

export function UploadsScreen() {
  const { api, navigate, formatDate } = useApp();
  const data = useResource(() => api.uploads(), [api]);
  const action = useAction();
  return (
    <ScrollView
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={data.loading && Boolean(data.value)}
          onRefresh={data.refresh}
        />
      }
    >
      <Text style={s.title}>我的资料</Text>
      <Text style={s.subtitle}>收好文件与录音，需要时随时找回。</Text>
      <ErrorNotice message={data.error} retry={data.refresh} />
      <ErrorNotice message={action.error} />
      {data.loading && !data.value && <Loading label="正在查看已保存的资料…" />}
      {data.value &&
        (data.value.items.length ? (
          <View style={{ marginTop: 24 }}>
            {data.value.items.map(item => (
              <Card key={item.id}>
                <Pill tone="neutral">
                  {item.mime_type.startsWith('audio/') ? '录音' : '文件'}
                </Pill>
                <Text selectable style={[s.cardTitle, { marginTop: 13 }]}>
                  {item.name}
                </Text>
                <Text style={[s.small, { marginTop: 7 }]}>
                  {Math.max(1, Math.ceil(item.size / 1024))} KB ·{' '}
                  {formatDate(item.created_at)}
                </Text>
                <Text style={[s.small, { marginTop: 7 }]}>
                  {fileDescription(item)}
                </Text>
                <Button
                  variant="ghost"
                  loading={action.busy}
                  onPress={() =>
                    Alert.alert(
                      '删除这份资料？',
                      '将删除服务端保存的「' +
                        item.name +
                        '」及其转写内容。已写入会话或成果的文字不会一起删除。',
                      [
                        { text: '保留', style: 'cancel' },
                        {
                          text: '删除资料',
                          style: 'destructive',
                          onPress: () =>
                            action.run(async () => {
                              await api.deleteUpload(item.id);
                              data.refresh();
                            }),
                        },
                      ],
                    )
                  }
                >
                  删除这份资料
                </Button>
              </Card>
            ))}
          </View>
        ) : (
          <Empty
            symbol="▤"
            title="给想法一点材料"
            body="在对话中选择文件或录制语音，上传成功的资料会出现在这里。"
            action="去对话上传"
            onAction={() => navigate({ name: 'chat' })}
          />
        ))}
      <Text style={[s.small, { textAlign: 'center', marginTop: 20 }]}>
        这里展示的是服务端资料。尚未上传的本机缓存可在设置里清理。
      </Text>
    </ScrollView>
  );
}

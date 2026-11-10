import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../../api/client';
import { useAction, useApp, useResource } from '../../app/context';
import { platform } from '../../platform/ports';
import { Button, ErrorNotice, Field, Loading } from '../../ui/components';
import { Text } from '../../ui/Text';
import { styles as s } from '../../ui/theme';
import { integrationsApi } from './api';
import type { Integration, IntegrationResult } from './types';

import { slackIntegration } from './slackModel';

type SearchPage = {
  query: string;
  items: IntegrationResult[];
  cursor: string | null;
};

export function SlackConnection({
  item,
  initialQuery,
  onChanged,
  connectOnly,
}: {
  item?: Integration;
  initialQuery?: string;
  onChanged?: () => Promise<void>;
  connectOnly?: boolean;
}) {
  const { api, user, preferences } = useApp();
  const owner = useMemo(
    () => ({ controller: new AbortController() }),
    [api, user?.id, preferences?.instance?.id],
  );
  useEffect(() => {
    if (owner.controller.signal.aborted)
      owner.controller = new AbortController();
    return () => owner.controller.abort();
  }, [owner]);
  const client = useMemo(
    () => integrationsApi(api, () => owner.controller.signal),
    [api, owner],
  );
  const connection = useResource(
    async () =>
      item ??
      (await client.list()).items.find(entry => entry.id === 'slack') ??
      slackIntegration,
    [client, item],
  );
  const action = useAction();
  const [query, setQuery] = useState(initialQuery ?? '');
  const [page, setPage] = useState<SearchPage | null>(null);
  const [reauthorize, setReauthorize] = useState(false);
  const [notice, setNotice] = useState('');
  const autoSearch = useRef(false);
  const connected = connection.value?.status === 'connected';
  const refresh = connection.refresh;
  useEffect(() => platform.onForeground(refresh), [refresh]);
  useEffect(() => {
    setPage(null);
    setReauthorize(false);
    setNotice('');
    setQuery(initialQuery ?? '');
    autoSearch.current = false;
  }, [owner, initialQuery]);
  useEffect(() => {
    if (!connected) setPage(null);
  }, [connected]);

  function search(term: string, cursor?: string) {
    const clean = term.trim();
    if (!clean || Array.from(clean).length > 250) {
      action.setError('请输入 1 到 250 个字的 Slack 搜索词。');
      return;
    }
    void action.run(async ({ isCurrent }) => {
      const signal = owner.controller.signal;
      if (!cursor) setPage(null);
      try {
        const result = await client.searchSlack(clean, cursor);
        if (!isCurrent() || signal.aborted) return;
        setPage(previous => {
          const items =
            cursor && previous?.query === clean ? [...previous.items] : [];
          for (const entry of result.items) {
            if (!items.some(existing => existing.id === entry.id))
              items.push(entry);
          }
          return {
            query: clean,
            items,
            cursor: result.next_cursor === cursor ? null : result.next_cursor,
          };
        });
        setReauthorize(false);
        setNotice('');
      } catch (error) {
        if (
          isCurrent() &&
          !signal.aborted &&
          error instanceof ApiError &&
          (error.code === 'connection_required' ||
            error.code === 'permission_required')
        ) {
          setPage(null);
          setReauthorize(true);
        }
        throw error;
      }
    });
  }

  const searchLatest = useRef(search);
  searchLatest.current = search;
  useEffect(() => {
    if (connected && initialQuery?.trim() && !autoSearch.current) {
      autoSearch.current = true;
      searchLatest.current(initialQuery);
    }
  }, [connected, initialQuery]);

  const authorize = () =>
    void action.run(async ({ isCurrent }) => {
      const result = await client.authorize('slack');
      if (!isCurrent() || owner.controller.signal.aborted) return;
      if (
        !/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/i.test(
          result.authorization_url,
        )
      ) {
        throw new Error('无法打开 Slack 官方授权页，请检查当前服务器。');
      }
      await platform.openUrl(result.authorization_url);
      if (isCurrent()) {
        setReauthorize(false);
        setNotice('在 Slack 完成授权后返回妥啦，连接状态会自动刷新。');
      }
    });
  const disconnect = () => {
    Alert.alert(
      '断开 Slack？',
      '妥啦会删除保存的凭据。也可以在 Slack 的应用管理中撤销授权。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '断开连接',
          style: 'destructive',
          onPress: () => {
            void action.run(async ({ isCurrent }) => {
              await client.disconnect('slack');
              if (!isCurrent() || owner.controller.signal.aborted) return;
              setPage(null);
              setReauthorize(false);
              connection.setValue(
                previous =>
                  previous && { ...previous, status: 'not_connected' },
              );
              setNotice('已断开 Slack。');
              if (onChanged) await onChanged();
              else refresh();
            });
          },
        },
      ],
    );
  };

  const disabled = connection.value?.status === 'not_configured';
  return (
    <View style={v.panel}>
      <Text style={s.small}>
        搜索已授权工作区的公开频道。结果只在这里临时显示。
      </Text>
      <ErrorNotice message={action.error || connection.error} />
      {notice ? (
        <Text accessibilityLiveRegion="polite" style={s.small}>
          {notice}
        </Text>
      ) : null}
      {connection.loading && !connection.value ? <Loading /> : null}
      {disabled ? (
        <Text style={s.body}>
          当前服务器还未开通 Slack，请联系管理员配置工作区授权。
        </Text>
      ) : null}
      {connection.value && !disabled && (!connected || reauthorize) ? (
        <Button loading={action.busy} onPress={authorize}>
          {reauthorize ? '重新授权 Slack' : '前往 Slack 授权'}
        </Button>
      ) : null}
      {!connected || reauthorize ? (
        <Button
          variant="ghost"
          disabled={connection.loading || action.busy}
          onPress={() => {
            refresh();
            if (onChanged) void onChanged().catch(() => {});
          }}
        >
          刷新 Slack 连接状态
        </Button>
      ) : null}
      {connected && !reauthorize && !connectOnly ? (
        <>
          {connection.value?.workspace_name ? (
            <Text style={s.small}>
              工作区：{connection.value.workspace_name}
            </Text>
          ) : null}
          <Field
            label="搜索 Slack 消息"
            value={query}
            onChangeText={setQuery}
            placeholder="例如：上线 in:release"
            maxLength={250}
            autoCorrect={false}
          />
          <Button
            loading={action.busy}
            disabled={!query.trim()}
            onPress={() => search(query)}
          >
            搜索公开频道
          </Button>
          {page && !page.items.length ? (
            <Text accessibilityLiveRegion="polite" style={s.small}>
              这页没有匹配的公开频道消息。
            </Text>
          ) : null}
          {page?.items.map(result => (
            <View key={result.id} style={v.result}>
              <Text style={s.cardTitle}>{result.title}</Text>
              <Text style={s.body}>{result.text}</Text>
              {result.url ? (
                <Button
                  variant="ghost"
                  onPress={() => {
                    const url = result.url;
                    if (
                      url &&
                      /^https:\/\/(?:[a-z0-9-]+\.)*slack\.com\/archives\/C[A-Z0-9]+\/p\d+(?:\?(?:thread_ts=\d+\.\d+|cid=C[A-Z0-9]+)(?:&(?:thread_ts=\d+\.\d+|cid=C[A-Z0-9]+))?)?$/i.test(
                        url,
                      )
                    ) {
                      void action.run(() => platform.openUrl(url));
                    }
                  }}
                >
                  打开 Slack 原消息 ↗
                </Button>
              ) : null}
            </View>
          ))}
          {page?.cursor && page.query === query.trim() ? (
            <Button
              variant="secondary"
              loading={action.busy}
              onPress={() => {
                if (page.cursor) search(page.query, page.cursor);
              }}
            >
              加载更多
            </Button>
          ) : null}
        </>
      ) : null}
      {connected && !connectOnly ? (
        <Button variant="ghost" disabled={action.busy} onPress={disconnect}>
          断开 Slack
        </Button>
      ) : null}
    </View>
  );
}

export function SlackSearchSheet({
  query,
  onClose,
}: {
  query: string;
  onClose: () => void;
}) {
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={v.screen}>
        <View style={v.header}>
          <Text accessibilityRole="header" style={s.cardTitle}>
            搜索 Slack
          </Text>
          <Button variant="ghost" onPress={onClose}>
            关闭
          </Button>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={v.content}
        >
          <SlackConnection initialQuery={query} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const v = StyleSheet.create({
  panel: { gap: 12, marginTop: 12 },
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  content: { paddingHorizontal: 20, paddingBottom: 24 },
  result: { borderRadius: 16, backgroundColor: '#F4F5FA', padding: 14, gap: 6 },
});

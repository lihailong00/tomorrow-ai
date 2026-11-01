import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useApp, useResource } from '../../app/context';
import { Text } from '../../ui/Text';
import { errorMessage } from '../../api/client';
import type { Memory } from '../../domain/types';

export function AutomaticMemoryConsent() {
  const { api } = useApp();
  const data = useResource(
    () =>
      api.request<{ enabled: boolean; configured: boolean }>(
        '/memory/preferences',
      ),
    [api],
  );
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const owner = useRef(api);
  owner.current = api;
  useEffect(() => {
    setDismissed(false);
    setBusy(false);
    setError('');
  }, [api]);
  if (!data.value || data.value.configured || dismissed) return null;
  return (
    <View style={styles.settings}>
      <Text style={styles.title}>让妥啦慢慢了解你</Text>
      <Text style={styles.small}>
        允许从聊天中记住你的偏好、目标和近况，下次不用从头说。使用你当前配置的模型，可随时关闭或忘记。
      </Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          style={styles.undo}
          disabled={busy}
          onPress={async () => {
            const current = api;
            setBusy(true);
            setError('');
            try {
              await api.request('/memory/preferences', 'PATCH', {
                enabled: true,
              });
              if (owner.current === current) data.refresh();
            } catch (e) {
              if (owner.current === current) setError(errorMessage(e));
            } finally {
              if (owner.current === current) setBusy(false);
            }
          }}
        >
          <Text style={styles.link}>{busy ? '正在开启…' : '允许自动记忆'}</Text>
        </Pressable>
        <Pressable
          style={styles.undo}
          accessibilityRole="button"
          disabled={busy}
          onPress={() => setDismissed(true)}
        >
          <Text style={styles.small}>暂时不用</Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function AutomaticMemorySettings() {
  const { api } = useApp();
  const data = useResource(
    () => api.request<{ enabled: boolean }>('/memory/preferences'),
    [api],
  );
  const owner = useRef(api);
  owner.current = api;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setBusy(false);
    setError('');
  }, [api]);
  return (
    <View style={styles.settings}>
      <View style={styles.row}>
        <Text style={styles.title}>从聊天中自动记住</Text>
        <Switch
          accessibilityLabel="从聊天中自动记住"
          value={data.value?.enabled ?? false}
          disabled={data.loading || busy || !data.value}
          onValueChange={async enabled => {
            const current = api;
            setBusy(true);
            setError('');
            try {
              await api.request('/memory/preferences', 'PATCH', { enabled });
              if (owner.current === current) data.refresh();
            } catch (e) {
              if (owner.current === current) setError(errorMessage(e));
            } finally {
              if (owner.current === current) setBusy(false);
            }
          }}
        />
      </View>
      <Text style={styles.small}>
        开启后，使用当前配置的模型整理你明确说过的偏好、目标和近况。关闭后停止自动新增，已有记忆仍可使用。
      </Text>
      {error || data.error ? (
        <Pressable onPress={data.refresh} accessibilityRole="button">
          <Text style={styles.error}>{error || data.error} · 重试</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type Receipt = {
  id: string;
  memory_id: string;
  content: string;
  updated?: boolean;
};
export function AutomaticMemoryNotice({
  replyId,
  active,
}: {
  replyId: string;
  active: boolean;
}) {
  const { api, navigate, invalidate } = useApp();
  const [state, setState] = useState<{
    api: typeof api;
    replyId: string;
    items: Receipt[];
  }>({ api, replyId, items: [] });
  const [error, setError] = useState('');
  const owner = useRef({ api, replyId });
  owner.current = { api, replyId };
  useEffect(() => {
    if (!active) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      attempts = 0;
    const abort = new AbortController();
    const poll = async () => {
      if (
        !alive ||
        (AppState.currentState && AppState.currentState !== 'active') ||
        attempts++ >= 25
      )
        return;
      try {
        const result = await api.request<{
          items: Receipt[];
          pending: boolean;
        }>(
          `/memory/receipts/${encodeURIComponent(replyId)}`,
          'GET',
          undefined,
          abort.signal,
        );
        if (!alive) return;
        setState({ api, replyId, items: result.items });
        if (result.items.length) invalidate();
        if (result.pending) timer = setTimeout(poll, 3000);
      } catch {
        /* Older self-hosted servers do not provide automatic memory. */
      }
    };
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        if (timer) clearTimeout(timer);
        poll();
      }
    });
    poll();
    return () => {
      alive = false;
      abort.abort();
      if (timer) clearTimeout(timer);
      subscription.remove();
    };
  }, [api, replyId, active, invalidate]);
  const items =
    state.api === api && state.replyId === replyId ? state.items : [];
  if (!items.length) return null;
  return (
    <View style={styles.notices}>
      {items.map(item => (
        <View key={item.id} style={styles.notice}>
          <Pressable
            style={styles.fact}
            accessibilityRole="button"
            onPress={async () => {
              const current = api;
              try {
                const memory = await api.request<Memory>(
                  `/memories/${encodeURIComponent(item.memory_id)}`,
                );
                if (
                  owner.current.api !== current ||
                  owner.current.replyId !== replyId
                )
                  return;
                if (memory) navigate({ name: 'memory', memory });
                else setError('请在记忆页查看或搜索这条记忆。');
              } catch (e) {
                if (owner.current.api === current) setError(errorMessage(e));
              }
            }}
          >
            <Text style={styles.small}>
              ✧ {item.updated ? '已更新' : '已记住'}：{item.content}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`撤销记忆：${item.content}`}
            style={styles.undo}
            onPress={async () => {
              const current = api;
              try {
                await api.request(
                  `/memory/receipts/${encodeURIComponent(item.id)}/undo`,
                  'POST',
                  {},
                );
                if (
                  owner.current.api === current &&
                  owner.current.replyId === replyId
                ) {
                  setState(s => ({
                    ...s,
                    items: s.items.filter(i => i.id !== item.id),
                  }));
                  invalidate();
                }
              } catch (e) {
                if (owner.current.api === current) setError(errorMessage(e));
              }
            }}
          >
            <Text style={styles.link}>撤销</Text>
          </Pressable>
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}
const styles = StyleSheet.create({
  settings: {
    padding: 18,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    marginBottom: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { fontSize: 15, color: '#303849', flex: 1 },
  small: { fontSize: 12, lineHeight: 21, color: '#707B91' },
  notices: { marginTop: 10 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fact: { flex: 1, minHeight: 36, justifyContent: 'center' },
  undo: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  link: { fontSize: 12, color: '#5665BE' },
  error: { fontSize: 12, color: '#AE465D', lineHeight: 20 },
});

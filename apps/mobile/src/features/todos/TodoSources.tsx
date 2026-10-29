import React, { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useAction, useApp } from '../../app/context';
import { newRequestId } from '../../api/client';
import { Button, ErrorNotice, Loading, Notice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { extractTodos } from './api';
import { useTodoList } from './useTodoList';
import { todoStyles as s } from './ui';

export function TodoSources({ conversationId }: { conversationId?: string }) {
  const { api, user, navigate, invalidate, formatDate } = useApp();
  const action = useAction();
  const data = useTodoList(
    offset => api.conversations({ offset, limit: 30 }),
    [api, user?.id],
  );
  const owner = useMemo(() => ({ api, userId: user?.id }), [api, user?.id]);
  const [selection, setSelection] = useState({
    owner,
    id: conversationId ?? '',
  });
  const selected = selection.owner === owner ? selection.id : '';
  const [result, setResult] = useState<{
    owner: typeof owner;
    count: number;
    created: number;
  }>();
  const retry = useRef({ source: '', id: '' });
  const discover = () =>
    action.run(async guard => {
      if (!selected) throw new Error('先选一段想整理的对话。');
      if (retry.current.source !== selected)
        retry.current = { source: selected, id: newRequestId() };
      const response = await extractTodos(api, {
        source_kind: 'conversation',
        source_id: selected,
        client_request_id: retry.current.id,
      });
      if (!guard.isCurrent()) return;
      setResult({
        owner,
        count: response.items.filter(item => item.status === 'suggested')
          .length,
        created: response.created_count,
      });
      invalidate();
    });
  return (
    <FlatList
      contentContainerStyle={s.page}
      data={data.items}
      keyExtractor={item => item.id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <>
          <Text style={s.title}>从资料发现</Text>
          <Text style={[s.body, { marginVertical: 15 }]}>
            选一段真实对话，妥啦会把有依据的待办收进“新发现”，由你确认加入。
          </Text>
          <View style={s.links}>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigate({ name: 'integrations' })}
            >
              <Text style={s.link}>从已确认的通知、邮件或分享资料发现 →</Text>
            </Pressable>
          </View>
          <Text style={s.small}>仅使用你选择或确认导入的内容。</Text>
          <ErrorNotice
            message={action.error}
            retry={() => {
              void discover();
            }}
          />
          {result?.owner === owner && (
            <Notice>{`这段对话待确认 ${result.count} 件，本次新增 ${result.created} 件。请到“新发现”逐项确认。`}</Notice>
          )}
          {result?.owner === owner && (
            <Button variant="ghost" onPress={() => navigate({ name: 'todos' })}>
              查看新发现
            </Button>
          )}
          <View style={{ marginVertical: 14 }}>
            <Button
              loading={action.busy}
              disabled={!selected}
              onPress={() => {
                void discover();
              }}
            >
              发现待办
            </Button>
          </View>
          <Text style={s.section}>选择一段对话</Text>
          <ErrorNotice message={data.error} retry={data.refresh} />
          {data.loading && !data.items.length && <Loading />}
          {!data.loading && !data.error && !data.items.length && (
            <Text style={s.empty}>
              还没有对话。和妥啦聊聊你想做的事，再来整理。
            </Text>
          )}
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: selected === item.id }}
          onPress={() => {
            setSelection({ owner, id: item.id });
            setResult(undefined);
          }}
          style={s.row}
        >
          <View style={s.rowContent}>
            <Text style={s.rowTitle}>{item.title}</Text>
            <Text style={s.small}>{formatDate(item.updated_at)}</Text>
          </View>
          <Text style={s.link}>{selected === item.id ? '已选' : '选择'}</Text>
        </Pressable>
      )}
      ListFooterComponent={
        data.hasMore ? (
          <Button
            variant="ghost"
            loading={data.loading}
            onPress={data.loadMore}
          >
            加载更多对话
          </Button>
        ) : null
      }
    />
  );
}

import React, { useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useAction, useApp, useResource } from '../../app/context';
import { Button, ErrorNotice, Loading } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { platform } from '../../platform/ports';
import { getGrowthHistory } from './api';
import { useGrowthData } from './context';
import { GrowthDays } from './GrowthDays';
import { localDateLabel } from './model';
import { growthStyles as s } from './styles';
import type { GrowthPeriod } from './types';

const periods = { week: '本周', month: '本月', all: '全部' };
export function GrowthHistoryScreen() {
  const { api, user, navigate, revision } = useApp();
  const growth = useGrowthData();
  const [period, setPeriod] = useState<GrowthPeriod>('week');
  const scope = useMemo(
    () => ({ api, userId: user?.id, period, revision }),
    [api, user?.id, period, revision],
  );
  const current = useRef(scope);
  current.current = scope;
  const [page, setPage] = useState({ scope, offset: 0 });
  const offset = page.scope === scope ? page.offset : 0;
  const resource = useResource(
    () => getGrowthHistory(api, period, offset),
    [scope, offset],
  );
  const [sharing, setSharing] = useState<typeof scope | null>(null);
  const [includeTitles, setIncludeTitles] = useState(false);
  const action = useAction();
  const data = resource.value;
  const records = data?.records ?? [];
  const shareText = data
    ? `我的成长 · ${periods[period]}\n实际行动 ${data.active_days} 天，完成 ${
        data.action_count
      } 件事。\n学习行动 ${data.learning_actions} 次，活动 ${
        data.exercise_minutes
      } 分钟（自行记录）。${
        includeTitles && records.length
          ? '\n\n这一页做成的事：\n' +
            records.map(item => '· ' + item.reward.title).join('\n')
          : ''
      }`
    : '';
  return (
    <FlatList
      contentContainerStyle={s.page}
      data={records}
      keyExtractor={item => item.reward.id}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={5}
      refreshing={resource.loading && !!data}
      onRefresh={resource.refresh}
      ListHeaderComponent={
        <>
          <Text style={s.title}>
            {period === 'week'
              ? '这一周，你做成了这些'
              : period === 'month'
              ? '这个月，留下的脚印'
              : '一路走来，都在这里'}
          </Text>
          <View style={[s.chips, { marginVertical: 16 }]}>
            {(Object.keys(periods) as GrowthPeriod[]).map(value => (
              <Pressable
                key={value}
                accessibilityRole="button"
                accessibilityLabel={`查看${periods[value]}成长`}
                accessibilityState={{ selected: period === value }}
                onPress={() => {
                  setPeriod(value);
                  setIncludeTitles(false);
                }}
                style={[
                  s.chip,
                  value === period && s.chipSelected,
                  { minHeight: 44 },
                ]}
              >
                <Text style={s.body}>{periods[value]}</Text>
              </Pressable>
            ))}
          </View>
          <ErrorNotice message={resource.error} retry={resource.refresh} />
          <ErrorNotice message={action.error} />
          {resource.loading && !data && <Loading />}
          {data && (
            <>
              <View style={s.panel}>
                <Text style={s.section}>
                  {data.action_count
                    ? `${periods[period]}，你为自己的事情留出了 ${data.active_days} 天`
                    : '先从一件小事开始'}
                </Text>
                <Text style={s.body}>
                  做成 {data.action_count} 件事 · 学习 {data.learning_actions}{' '}
                  次
                </Text>
                <Text style={s.small}>
                  活动 {data.exercise_minutes} 分钟（自行记录） · 累计{' '}
                  {data.total_xp} 成长
                </Text>
                <Text style={s.muted}>
                  根据你确认完成的记录整理，不推断你已经掌握某项技能。
                </Text>
              </View>
              <Text style={[s.muted, { marginTop: 8 }]}>
                仅计自行填写的时长，未填的不估算
              </Text>
              {period === 'week' && growth?.data?.summary && (
                <GrowthDays summary={growth.data.summary} />
              )}
              {data.action_count > 0 && (
                <Pressable
                  accessibilityRole="button"
                  style={s.textAction}
                  onPress={() => {
                    setSharing(scope);
                    setIncludeTitles(false);
                  }}
                >
                  <Text style={s.link}>分享这段成长 ↗</Text>
                </Pressable>
              )}
              {sharing === scope && (
                <View style={[s.panel, { marginVertical: 12 }]}>
                  <Text style={s.section}>选择分享内容</Text>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: includeTitles }}
                    onPress={() => setIncludeTitles(value => !value)}
                    style={s.textAction}
                  >
                    <Text style={s.body}>
                      {includeTitles ? '☑' : '□'} 附上本页成果标题
                    </Text>
                  </Pressable>
                  <Text style={s.small}>
                    默认只分享统计，不包含目标、任务标题和私人笔记。
                  </Text>
                  <Text style={s.body}>{shareText}</Text>
                  <Button
                    loading={action.busy}
                    onPress={() => {
                      void action.run(async guard => {
                        if (!guard.isCurrent() || current.current !== scope)
                          return;
                        await platform.share(shareText, '我的成长');
                      });
                    }}
                  >
                    打开系统分享
                  </Button>
                  <Button variant="ghost" onPress={() => setSharing(null)}>
                    收起预览
                  </Button>
                </View>
              )}
              <Text style={[s.section, { marginTop: 20, marginBottom: 8 }]}>
                做成的事
                {data.action_count > 30
                  ? ` · 第 ${Math.floor(offset / 30) + 1} 页`
                  : ''}
              </Text>
              {!records.length && (
                <View style={[s.panel, { marginVertical: 12 }]}>
                  <Text style={s.small}>
                    这一段时间还没有已确认的成长行动。完成一件真实的事情，就能在这里回看。
                  </Text>
                  <Button
                    variant="secondary"
                    onPress={() => navigate({ name: 'growth' })}
                  >
                    去做一件小事
                  </Button>
                </View>
              )}
            </>
          )}
        </>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={'查看成长来源事项：' + item.reward.title}
          onPress={() => navigate({ name: 'todo', id: item.reward.todo_id })}
          style={s.history}
        >
          <View style={s.flex}>
            <Text style={s.body}>{item.reward.title}</Text>
            <Text style={s.muted}>
              {localDateLabel(item.reward.local_date)}
              {item.reward.minutes != null
                ? ` · ${item.reward.minutes}分钟（自行记录）`
                : ''}
            </Text>
            {item.note && (
              <View
                style={{
                  borderLeftWidth: 2,
                  borderLeftColor: colors.line,
                  paddingLeft: 10,
                  marginTop: 8,
                }}
              >
                <Text style={s.small}>我留下的记录</Text>
                <Text style={s.body} numberOfLines={3}>
                  {item.note}
                </Text>
              </View>
            )}
          </View>
          <Text style={s.badge}>+{item.reward.xp}</Text>
        </Pressable>
      )}
      ListFooterComponent={
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 15 }}>
          {offset > 0 && (
            <View style={s.flex}>
              <Button
                variant="secondary"
                disabled={resource.loading}
                onPress={() =>
                  setPage({ scope, offset: Math.max(0, offset - 30) })
                }
              >
                上一页
              </Button>
            </View>
          )}
          {data?.next_offset != null && (
            <View style={s.flex}>
              <Button
                variant="secondary"
                disabled={resource.loading}
                onPress={() => setPage({ scope, offset: data.next_offset! })}
              >
                下一页
              </Button>
            </View>
          )}
        </View>
      }
    />
  );
}

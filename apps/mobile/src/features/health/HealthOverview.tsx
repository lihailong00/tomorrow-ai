import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Card, IconButton, Notice } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles as s } from '../../ui/theme';
import { Icon } from '../../ui/visuals';
import {
  metricLabels,
  type HealthBucket,
  type HealthProvider,
  type HealthRecord,
} from './types';

export type HealthSourceOption = {
  id: HealthProvider;
  name: string;
  status: string;
  channel: string;
  canView: boolean;
};

const unitLabels: Record<string, string> = {
  bpm: '次/分',
  min: '分钟',
  kcal: '千卡',
  kg: '公斤',
};

export function healthDate(value: string) {
  return new Date(value).toLocaleString();
}

function recordLabel(record: HealthRecord) {
  return record.sleep_basis === 'session_duration'
    ? '睡眠记录跨度'
    : metricLabels[record.metric];
}

function recordValue(record: HealthRecord) {
  return Math.round(record.value * 100) / 100;
}

function recordUnit(record: HealthRecord) {
  return record.metric === 'steps' && record.unit === 'count'
    ? '步'
    : unitLabels[record.unit] ?? record.unit;
}

function SourceMark({ id }: { id?: HealthProvider }) {
  return (
    <View
      style={[
        v.mark,
        id === 'huawei' && v.huaweiMark,
        id === 'xiaomi' && v.xiaomiMark,
      ]}
      accessible={false}
    >
      {id === 'huawei' || id === 'xiaomi' ? (
        <Text style={id === 'huawei' ? v.huaweiText : v.xiaomiText}>
          {id === 'huawei' ? '华' : '米'}
        </Text>
      ) : (
        <Icon name={id ? 'health' : 'plus'} size={18} color={colors.action} />
      )}
    </View>
  );
}

export function HealthOverview({
  source,
  bucket,
  loading,
  onPick,
  onManage,
  onRecords,
}: {
  source?: HealthSourceOption;
  bucket?: HealthBucket;
  loading: boolean;
  onPick: () => void;
  onManage: () => void;
  onRecords: () => void;
}) {
  const recent = new Map<HealthRecord['metric'], HealthRecord>();
  bucket?.records.forEach(record => {
    if (!recent.has(record.metric)) recent.set(record.metric, record);
  });
  const primary = recent.get('steps') ?? recent.values().next().value;
  const other = [...recent.values()].filter(record => record !== primary);
  const partial = bucket?.truncated || !!bucket?.unavailable_metrics?.length;
  return (
    <>
      <Text accessibilityRole="header" style={v.section}>
        数据来源
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          source ? `切换数据来源，当前${source.name}` : '选择健康来源'
        }
        accessibilityHint="打开来源列表"
        onPress={onPick}
        style={({ pressed }) => [v.source, pressed && v.pressed]}
      >
        <SourceMark id={source?.id} />
        <View style={v.flex}>
          <Text style={v.sourceName}>{source?.name ?? '选择健康来源'}</Text>
          <Text style={s.small}>
            {source
              ? `${source.status} · ${source.channel}`
              : '系统健康或运动 App'}
          </Text>
        </View>
        <Text style={v.link}>{source ? '切换' : '选择'}</Text>
        <Icon name="chevronDown" size={15} color={colors.action} />
      </Pressable>

      <View style={v.recordsHeading}>
        <Text accessibilityRole="header" style={v.section}>
          最近记录
        </Text>
        {primary && (
          <Text style={s.small}>
            {partial ? '部分数据 · ' : ''}
            {bucket?.records.length} 条记录
          </Text>
        )}
      </View>
      {loading ? (
        <Card style={v.empty}>
          <ActivityIndicator color={colors.action} />
          <Text style={s.small}>正在读取本机记录</Text>
        </Card>
      ) : primary ? (
        <>
          <Card style={v.hero}>
            <View style={v.heroOrb} pointerEvents="none" />
            <View style={v.mark}>
              <Icon name="health" size={18} color={colors.action} />
            </View>
            <Text style={s.small}>{recordLabel(primary)}</Text>
            <View style={v.measurement}>
              <Text style={v.number}>
                {recordValue(primary).toLocaleString('en-US')}
              </Text>
              <Text style={s.body}>{recordUnit(primary)}</Text>
            </View>
            <Text style={s.small}>
              {bucket?.provider === 'huawei' && primary.metric === 'steps'
                ? `按 UTC 日汇总 · ${new Date(primary.start_at)
                    .toISOString()
                    .slice(0, 10)}`
                : `最近一条 · ${healthDate(primary.end_at)}`}
            </Text>
          </Card>
          {other.map(record => (
            <View key={record.metric} style={v.metricRow}>
              <Text style={[s.body, v.flex]}>{recordLabel(record)}</Text>
              <Text style={s.cardTitle}>
                {recordValue(record)} {recordUnit(record)}
              </Text>
            </View>
          ))}
          <Button
            accessibilityLabel="查看当前来源记录明细"
            variant="ghost"
            onPress={onRecords}
          >
            查看记录明细
          </Button>
        </>
      ) : (
        <Card style={v.empty}>
          <Icon name="health" size={24} color={colors.action} />
          <Text style={s.cardTitle}>暂无健康记录</Text>
          <Text style={[s.small, v.center]}>
            {source
              ? '授权并读取后，该来源的记录会显示在这里。'
              : '连接一个来源后，记录会显示在这里。'}
          </Text>
        </Card>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="连接与权限"
        onPress={onManage}
        style={({ pressed }) => [v.manage, pressed && v.pressed]}
      >
        <Icon name="shield" size={17} color={colors.action} />
        <Text style={[v.flex, s.body]}>连接与权限</Text>
        <Icon name="chevronRight" size={15} color={colors.secondary} />
      </Pressable>
    </>
  );
}

export function HealthSourceList({
  sources,
  selected,
  onSelect,
  onManage,
}: {
  sources: HealthSourceOption[];
  selected?: HealthProvider;
  onSelect: (source: HealthSourceOption) => void;
  onManage: (source: HealthSourceOption) => void;
}) {
  return (
    <View style={v.options}>
      {sources.map(source => {
        const active = selected === source.id;
        return (
          <View key={source.id} style={[v.optionRow, active && v.activeOption]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                source.canView ? `查看${source.name}记录` : `设置${source.name}`
              }
              accessibilityState={
                source.canView ? { selected: active } : undefined
              }
              onPress={() => onSelect(source)}
              style={({ pressed }) => [v.option, pressed && v.pressed]}
            >
              <SourceMark id={source.id} />
              <View style={v.flex}>
                <Text style={v.sourceName}>{source.name}</Text>
                <Text style={s.small}>
                  {source.status} · {source.channel}
                </Text>
              </View>
              {active && <Icon name="check" size={17} color={colors.action} />}
              {!source.canView && (
                <Icon name="chevronRight" size={15} color={colors.secondary} />
              )}
            </Pressable>
            {source.canView && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`设置${source.name}`}
                onPress={() => onManage(source)}
                style={v.optionSettings}
              >
                <Icon name="settings" size={17} color={colors.secondary} />
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

export function HealthRecordDetails({ bucket }: { bucket: HealthBucket }) {
  return (
    <>
      <Text style={s.small}>
        读取于 {healthDate(bucket.synced_at)} · {bucket.records.length} 条记录
      </Text>
      {bucket.truncated && (
        <Notice>
          记录数量达到读取上限，本次仅包含部分数据。可在来源 App 查看完整记录。
        </Notice>
      )}
      {!!bucket.unavailable_metrics?.length && (
        <Notice>
          本次未能读取：
          {bucket.unavailable_metrics
            .map(metric => metricLabels[metric])
            .join('、')}
          。可能尚未授权或此设备不提供这些项目。
        </Notice>
      )}
      <Text style={s.small}>
        最多显示二十条原始记录。单条步数／睡眠记录不代表全天总量。
      </Text>
      {bucket.records.slice(0, 20).map(record => (
        <View
          key={JSON.stringify([
            record.source,
            record.source_app,
            record.source_id,
            record.metric,
            record.id,
          ])}
          style={v.record}
        >
          <View style={v.metricRow}>
            <Text style={[s.body, v.flex]}>{recordLabel(record)}</Text>
            <Text style={s.cardTitle}>
              {recordValue(record)} {recordUnit(record)}
            </Text>
          </View>
          <Text style={s.small}>
            {healthDate(record.start_at)} — {healthDate(record.end_at)}
          </Text>
          <Text style={s.small}>
            来源：{record.source_app || record.source}
            {record.source_device ? ' · ' + record.source_device : ''}
            {record.source_id ? ' · 设备来源 ' + record.source_id : ''}
          </Text>
          {record.sleep_basis === 'session_duration' && (
            <Text style={s.small}>起止跨度包含清醒时间。</Text>
          )}
        </View>
      ))}
    </>
  );
}

export function HealthSheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={v.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭健康弹层"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView
          edges={['bottom']}
          accessibilityViewIsModal
          style={v.sheet}
        >
          <View style={v.handle} />
          <View style={v.sheetHeader}>
            <Text accessibilityRole="header" style={[v.sheetTitle, v.flex]}>
              {title}
            </Text>
            <IconButton label="关闭" icon="close" onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={v.sheetContent}
          >
            {children}
          </ScrollView>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const v = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  section: { fontSize: 14, fontWeight: '700', color: colors.ink },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 66,
    marginTop: 8,
    padding: 11,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  sourceName: {
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '600',
    color: colors.ink,
  },
  mark: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.blueLight,
  },
  huaweiMark: { backgroundColor: '#F8E9F0' },
  xiaomiMark: { backgroundColor: '#FFF0E3' },
  huaweiText: { color: '#A04763', fontSize: 16, fontWeight: '600' },
  xiaomiText: { color: '#A95727', fontSize: 16, fontWeight: '600' },
  link: { fontSize: 12, fontWeight: '600', color: colors.action },
  recordsHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    marginTop: 24,
    marginBottom: 9,
  },
  hero: {
    gap: 5,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#F0F5FF',
    borderColor: '#E2EAF8',
    marginBottom: 5,
  },
  heroOrb: {
    position: 'absolute',
    width: 168,
    height: 168,
    borderRadius: 84,
    borderWidth: 1,
    borderColor: '#D8E5FB',
    right: -34,
    top: -57,
    backgroundColor: '#E9F0FE',
  },
  measurement: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 6,
  },
  number: {
    color: colors.ink,
    fontSize: 39,
    fontWeight: '700',
    letterSpacing: -1.1,
  },
  metricRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 8,
    minHeight: 35,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    minHeight: 148,
  },
  center: { textAlign: 'center' },
  manage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingHorizontal: 4,
    marginTop: 8,
  },
  pressed: { opacity: 0.72 },
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(28,40,67,0.35)',
  },
  sheet: {
    maxHeight: '88%',
    flexShrink: 1,
    paddingTop: 9,
    paddingHorizontal: 18,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  handle: {
    width: 34,
    height: 4,
    borderRadius: 4,
    alignSelf: 'center',
    backgroundColor: colors.line,
    marginBottom: 5,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: colors.ink },
  sheetContent: { paddingBottom: 22, gap: 8 },
  options: { gap: 4 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 13,
    paddingRight: 4,
  },
  activeOption: { backgroundColor: colors.blueLight },
  option: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    minHeight: 60,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  optionSettings: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  record: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    paddingTop: 9,
    paddingBottom: 3,
  },
});

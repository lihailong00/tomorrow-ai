import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import { dateLabel, inclusiveDays, monthDays, rangeError, shiftMonth, shortcutRange } from './model';
import { palette, u } from './styles';

export interface UsageDateRangeProps {
  minimum: string;
  today: string;
  initialStart: string;
  initialEnd: string;
  onCancel: () => void;
  onApply: (start: string, end: string) => void;
}

/** Mounted afresh for every opening: dismissing never changes the applied query. */
export function UsageDateRange({ minimum, today, initialStart, initialEnd, onCancel, onApply }: UsageDateRangeProps) {
  const [start, setStart] = useState(initialStart < minimum ? minimum : initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [target, setTarget] = useState<'start' | 'end'>('start');
  const [month, setMonth] = useState((initialStart < minimum ? minimum : initialStart).slice(0, 7));
  const error = rangeError(start, end, minimum, today);
  const select = (date: string) => {
    if (target === 'start') { setStart(date); setTarget('end'); }
    else setEnd(date);
  };
  const shortcut = (kind: 'last30' | 'lastmonth') => {
    const range = shortcutRange(kind, today);
    setStart(range.start); setEnd(range.end); setMonth(range.start.slice(0, 7));
  };
  return <Modal visible animationType="slide" onRequestClose={onCancel} presentationStyle="pageSheet">
    <SafeAreaView style={u.screen} accessibilityViewIsModal>
      <View style={u.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="取消选择时间段" onPress={onCancel} style={u.circle}><Icon name="back" /></Pressable>
        <Text accessibilityRole="header" style={u.title}>选择时间段</Text><View style={u.circle}><Icon name="calendar" color={palette.blue} /></View>
      </View>
      <ScrollView style={layout.scroll} contentContainerStyle={layout.content}>
        <Text style={[u.small, layout.hint]}>按北京时间统计，包含首尾两天。</Text>
        <View style={u.card}>
          <View style={layout.fields}>
          {(['start', 'end'] as const).map(field => <Pressable key={field} accessibilityRole="button"
            accessibilityLabel={field === 'start' ? '选择开始日期' : '选择结束日期'} accessibilityState={{ selected: target === field }}
            onPress={() => { setTarget(field); setMonth((field === 'start' ? start : end).slice(0, 7)); }} style={[layout.field, target === field && u.fieldSelected]}>
            <Text style={u.small}>{field === 'start' ? '开始日期' : '结束日期'}</Text><Text style={u.medium}>{dateLabel(field === 'start' ? start : end)}</Text>
          </Pressable>)}
          </View>
          <View style={u.monthNav}>
            <Pressable accessibilityRole="button" accessibilityLabel="上一个月" disabled={month <= minimum.slice(0, 7)}
              onPress={() => setMonth(shiftMonth(month, -1))} style={[u.quiet, month <= minimum.slice(0, 7) && u.disabled]}><Icon name="back" size={20} /></Pressable>
            <Text accessibilityRole="header" style={u.medium}>{month.replace('-', '年')}月</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="下一个月" disabled={month >= today.slice(0, 7)}
              onPress={() => setMonth(shiftMonth(month, 1))} style={[u.quiet, month >= today.slice(0, 7) && u.disabled]}><Icon name="chevronRight" size={20} /></Pressable>
          </View>
          <Text style={u.small}>正在选择{target === 'start' ? '开始日期' : '结束日期'}</Text>
          <View style={u.calendar}>{['一', '二', '三', '四', '五', '六', '日'].map(day => <View key={day} style={u.dayCell}><Text style={u.tiny}>{day}</Text></View>)}</View>
          <View style={u.calendar}>{monthDays(month).map((date, index) => {
            if (!date) return <View key={'empty-' + index} style={u.dayCell} />;
            const disabled = date < minimum || date > today;
            const selected = date === start || date === end;
            return <Pressable key={date} accessibilityRole="button" accessibilityLabel={'选择日期' + date}
              accessibilityState={{ disabled, selected }} disabled={disabled} onPress={() => select(date)}
              style={[u.dayCell, date > start && date < end && u.dayBetween, selected && u.daySelected, disabled && u.disabled]}>
              <Text style={[u.dayText, selected && u.primaryText]}>{Number(date.slice(-2))}</Text>
            </Pressable>;
          })}</View>
        </View>
        <View style={u.shortcuts}>{(['last30', 'lastmonth'] as const).map(kind => {
          const range = shortcutRange(kind, today);
          const invalid = Boolean(rangeError(range.start, range.end, minimum, today));
          return <Pressable key={kind} accessibilityRole="button" accessibilityLabel={kind === 'last30' ? '最近30天' : '上个月'}
            accessibilityState={{ disabled: invalid }} disabled={invalid} onPress={() => shortcut(kind)} style={[u.shortcut, invalid && u.disabled]}>
            <Text style={u.blueText}>{kind === 'last30' ? '最近30天' : '上个月'}</Text>
          </Pressable>;
        })}</View>
        <Text style={u.note}>{`可查询 ${dateLabel(minimum)} — ${dateLabel(today)}。`}</Text>
      </ScrollView>
      <View style={layout.footer}>
        {!error && <Text style={u.small}>{`已选 ${inclusiveDays(start, end)} 天`}</Text>}
        {error ? <Text accessibilityRole="alert" style={u.error}>{error}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="查看这段时间的费用" accessibilityState={{ disabled: Boolean(error) }} disabled={Boolean(error)}
          onPress={() => onApply(start, end)} style={[u.primary, layout.confirm, Boolean(error) && u.disabled]}><Text style={u.primaryText}>查看这段时间的费用</Text></Pressable>
      </View>
    </SafeAreaView>
  </Modal>;
}
const layout = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: 19, paddingBottom: 8 },
  hint: { marginHorizontal: 3, marginBottom: 10 },
  fields: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  field: { flex: 1, minHeight: 58, borderWidth: 1, borderColor: palette.line, borderRadius: 12, padding: 9, gap: 2 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, backgroundColor: '#FFF', paddingHorizontal: 19, paddingVertical: 10, gap: 4 },
  confirm: { marginTop: 0 },
});

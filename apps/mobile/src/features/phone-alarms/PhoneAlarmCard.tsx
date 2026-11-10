import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../../ui/Text';
import { Button, IconButton } from '../../ui/components';
import { Icon } from '../../ui/visuals';
import { colors } from '../../ui/theme';
import { platform } from '../../platform/ports';
import { phoneCalendar } from '../../platform/phoneCalendar';
import { phoneAlarms, type AlarmAvailability, type PhoneAlarm } from '../../platform/phoneAlarms';
import { isAlarmRequest, type AlarmProposal } from './alarmProposal';

export function PhoneAlarmCard({ text }: { text: string }) {
  const [error, setError] = useState('');
  if (!phoneAlarms.supported || !isAlarmRequest(text)) return null;
  return <View>
    {!!error && <Text accessibilityRole="alert">{error}</Text>}
    <Button variant="secondary" onPress={async () => {
      setError('');
      try { await phoneAlarms.openSystemClock(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : '无法打开系统闹钟'); }
    }}>打开系统闹钟</Button>
  </View>;
}

export function PhoneAlarmLauncher() {
  const [open, setOpen] = useState(false);
  if (!phoneAlarms.supported) return null;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="设置和管理本机闹铃" style={styles.card} onPress={() => setOpen(true)}>
      <Text style={styles.title}>本机闹铃</Text><Text>按具体日期提醒，也可以打开系统时钟。</Text>
    </Pressable>
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.heading}>本机闹铃</Text>
          <IconButton icon="close" label="关闭闹铃管理" onPress={() => setOpen(false)} />
        </View>
        <ScrollView contentContainerStyle={styles.modal} keyboardShouldPersistTaps="handled">
          <PhoneAlarmEditor initial={{ date: '', time: '', title: '提醒', needsReview: true }} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}

export function PhoneAlarmEditor({ initial, initialId, initialManage }: { initial: AlarmProposal; initialId?: string; initialManage?: boolean }) {
  const [date, setDate] = useState(initial.date), [time, setTime] = useState(initial.time), [title, setTitle] = useState(initial.title);
  const [id, setId] = useState(initialId ?? `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
  const [rows, setRows] = useState<PhoneAlarm[]>([]), [availability, setAvailability] = useState<AlarmAvailability | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [receipt, setReceipt] = useState('');
  const [manage, setManage] = useState(initialManage ?? !initialId);
  const alive = useRef(true), pending = useRef(false);
  const refresh = useCallback(async () => {
    const [next, status] = await Promise.all([phoneAlarms.list(), phoneAlarms.availability()]);
    if (alive.current) { setRows(next); setAvailability(status); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh().catch(() => {});
    });
    return () => { alive.current = false; subscription.remove(); };
  }, [refresh]);
  const run = async (operation: () => Promise<void>, refreshAfter = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await operation(); if (alive.current && refreshAfter) await refresh(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '操作未完成，请重试'); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const save = () => run(async () => {
    const result = await phoneAlarms.schedule({ id, date, time, title });
    if (alive.current) setReceipt(`已安排本机闹铃：${result.date} ${result.time} · ${result.title}（${result.zone}）`);
  });
  const edit = (row: PhoneAlarm) => {
    setId(row.id); setDate(row.date); setTime(row.time); setTitle(row.title); setReceipt(''); setError('');
  };
  const pick = (field: 'date' | 'time') => run(async () => {
    const value = await (field === 'date' ? phoneCalendar.pickDate(date) : phoneCalendar.pickTime(date, time));
    if (value && alive.current) {
      if (field === 'date') setDate(value);
      else setTime(value);
    }
  }, false);
  return <View style={styles.card} testID="phone-alarm-card">
    <Text style={styles.title}>设置闹铃</Text>
    <Text style={styles.small}>{initial.needsReview ? '确认日期和时间后，闹铃会按手机时区响铃。' : '按手机时区响铃，无需联网。'}</Text>
    <View style={styles.fields}>
      {([
        { key: 'date', label: '日期', icon: 'calendar', value: date, setValue: setDate, format: 'YYYY-MM-DD' },
        { key: 'time', label: '时间', icon: 'clock', value: time, setValue: setTime, format: 'HH:mm' },
      ] as const).map(field => <View key={field.key} style={styles.flex}>
        <Text style={styles.small}>{field.label}</Text>
        {phoneCalendar.dateTimePickerSupported ? <Pressable accessibilityRole="button" accessibilityLabel={'闹铃' + field.label}
          accessibilityValue={{ text: field.value || '未选择' }} disabled={busy} onPress={() => { void pick(field.key); }} style={[styles.input, styles.picker]}>
          <Icon name={field.icon} color={colors.action} size={18} />
          <Text style={field.value ? styles.value : styles.small}>{field.value || `选择${field.label}`}</Text>
        </Pressable> : <TextInput accessibilityLabel={'闹铃' + field.label} placeholder={field.format} value={field.value}
          onChangeText={field.setValue} editable={!busy} maxLength={field.format.length} style={styles.input} />}
      </View>)}
    </View>
    <Text style={styles.small}>提醒内容</Text>
    <TextInput accessibilityLabel="闹铃提醒内容" value={title} onChangeText={setTitle} editable={!busy} maxLength={120} style={styles.input} />
    {!availability && <Button variant="ghost" disabled={busy} onPress={() => run(async () => {})}>检查本机闹铃权限</Button>}
    {availability && !availability.exact && <Button disabled={busy} variant="ghost" onPress={() => run(async () => { await phoneAlarms.openExactSettings(); }, false)}>允许闹钟和提醒</Button>}
    {availability && !availability.notifications && <Button disabled={busy} variant="ghost" onPress={() => run(async () => {
      await platform.requestNotifications();
      if (alive.current) await phoneAlarms.openNotificationSettings();
    }, false)}>开启通知和闹铃声音</Button>}
    <Button disabled={busy || !date || !time || !title.trim() || !availability?.exact || !availability.notifications} onPress={save}>
      {rows.some(row => row.id === id) ? '确认修改本机闹铃' : '确认设置本机闹铃'}
    </Button>
    {!!receipt && <Text accessibilityRole="alert" style={styles.receipt}>{receipt}</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <View style={styles.system}>
    <Button disabled={busy} variant="ghost" onPress={() => run(async () => {
      await phoneAlarms.openSystemClock();
      if (alive.current) setReceipt('已打开系统时钟，请在系统时钟里确认修改结果。');
    }, false)}>打开系统闹钟</Button>
    <Button disabled={busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !title.trim()} variant="ghost" onPress={() => Alert.alert(
      '在系统时钟里新建', `将预填 ${time} 和提醒内容。系统接口不能传递日期 ${date || '（未选）'}，请在系统时钟核对日期及重复设置；这一步不会确认闹钟已设置。`,
      [{ text: '取消', style: 'cancel' }, { text: '前往系统时钟', onPress: () => run(async () => {
        if (!alive.current) return;
        await phoneAlarms.createSystemAlarm(Number(time.slice(0, 2)), Number(time.slice(3)), title);
        if (alive.current) setReceipt('已打开系统时钟的新建页，日期和保存结果请在系统时钟确认。');
      }, false) }],
    )}>在系统时钟新建（需核对日期）</Button>
    </View>
    {rows.length > 0 && <Button variant="secondary" disabled={busy} onPress={() => setManage(value => !value)}>{manage ? '收起已有闹铃' : `管理本机闹铃（${rows.length}）`}</Button>}
    {manage && rows.map(row => <View key={row.id} style={styles.saved}>
      <Text>{row.date} {row.time} · {row.title}</Text>
      <Text style={styles.small}>{row.state === 'scheduled' ? '已安排' : row.state === 'fired' ? '正在提醒' : row.state === 'stopped' ? '已停止' : row.state === 'missed' ? '已错过' : '需要重试'} · {row.zone}</Text>
      <View style={styles.row}><Button disabled={busy} variant="secondary" onPress={() => edit(row)}>编辑闹铃</Button>
        <Button disabled={busy} variant="secondary" onPress={() => run(async () => {
          await phoneAlarms.cancel(row.id);
          if (alive.current) setReceipt('已取消并删除这条本机闹铃。');
        })}>取消闹铃</Button></View>
    </View>)}
    <Text style={styles.small}>请保持闹铃声音和通知开启。勿扰、静音和省电设置可能影响响铃。</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderColor: '#E1E7F4', borderWidth: 1, borderRadius: 22, padding: 16, gap: 10, marginVertical: 10 },
  title: { fontSize: 17, fontWeight: '600', color: colors.ink }, small: { fontSize: 13, lineHeight: 20, color: colors.secondary },
  heading: { fontSize: 22, color: colors.ink, fontWeight: '600', flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  screen: { flex: 1, backgroundColor: colors.background },
  fields: { flexDirection: 'row', gap: 10, marginTop: 4 },
  picker: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 7, backgroundColor: colors.blueLight, marginTop: 4 },
  value: { flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '500' },
  system: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: 4 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' }, flex: { flex: 1 },
  input: { borderWidth: 1, borderColor: '#DFE5F0', borderRadius: 12, color: '#30394D', padding: 12, fontSize: 15 },
  saved: { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#E9ECF3', gap: 6 },
  receipt: { color: '#337B65', fontSize: 14 }, error: { color: '#AE4356', fontSize: 14 }, modal: { paddingHorizontal: 20, paddingBottom: 24 },
});

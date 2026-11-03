import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Text } from '../../ui/Text';
import { Button } from '../../ui/components';
import { platform } from '../../platform/ports';
import { phoneAlarms, type AlarmAvailability, type PhoneAlarm } from '../../platform/phoneAlarms';
import { alarmProposal, isAlarmRequest, type AlarmProposal } from './alarmProposal';

export function PhoneAlarmCard({ text, createdAt, messageId }: { text: string; createdAt: string; messageId: string }) {
  if (!phoneAlarms.supported || !isAlarmRequest(text)) return null;
  return <PhoneAlarmEditor key={messageId} initial={alarmProposal(text, createdAt)}
    initialManage={/取消|删除|修改|改成|改到/.test(text)}
    initialId={'alarm-' + messageId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 65)} />;
}

export function PhoneAlarmLauncher() {
  const [open, setOpen] = useState(false);
  if (!phoneAlarms.supported) return null;
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel="设置和管理本机闹铃" style={styles.card} onPress={() => setOpen(true)}>
      <Text style={styles.title}>本机闹铃</Text><Text>按具体日期提醒，也可以打开系统时钟。</Text>
    </Pressable>
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <ScrollView contentContainerStyle={styles.modal}><Button variant="secondary" onPress={() => setOpen(false)}>关闭闹铃管理</Button>
        <PhoneAlarmEditor initial={{ date: '', time: '', title: '提醒', needsReview: true }} />
      </ScrollView>
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
  return <View style={styles.card} testID="phone-alarm-card">
    <Text style={styles.title}>在这台手机设置闹铃</Text>
    <Text style={styles.small}>本机闹铃按具体日期响铃，不依赖服务器。系统时钟中的已有闹钟请在系统时钟修改。</Text>
    {initial.needsReview && <Text style={styles.small}>请核对日期、上午或下午，再确认设置。</Text>}
    <View style={styles.row}>
      <TextInput accessibilityLabel="闹铃日期" placeholder="YYYY-MM-DD" value={date} onChangeText={setDate} editable={!busy} maxLength={10} style={[styles.input, styles.flex]} />
      <TextInput accessibilityLabel="闹铃时间" placeholder="HH:mm" value={time} onChangeText={setTime} editable={!busy} maxLength={5} style={[styles.input, styles.flex]} />
    </View>
    <TextInput accessibilityLabel="闹铃提醒内容" value={title} onChangeText={setTitle} editable={!busy} maxLength={120} style={styles.input} />
    {!availability && <Button variant="secondary" disabled={busy} onPress={() => run(async () => {})}>检查本机闹铃权限</Button>}
    {availability && !availability.exact && <Button disabled={busy} variant="secondary" onPress={() => run(async () => { await phoneAlarms.openExactSettings(); }, false)}>允许闹钟和提醒</Button>}
    {availability && !availability.notifications && <Button disabled={busy} variant="secondary" onPress={() => run(async () => {
      await platform.requestNotifications();
      if (alive.current) await phoneAlarms.openNotificationSettings();
    }, false)}>开启通知和闹铃声音</Button>}
    <Button disabled={busy || !date || !time || !title.trim() || !availability?.exact || !availability.notifications} onPress={save}>
      {rows.some(row => row.id === id) ? '确认修改本机闹铃' : '确认设置本机闹铃'}
    </Button>
    {!!receipt && <Text accessibilityRole="alert" style={styles.receipt}>{receipt}</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    <Button disabled={busy} variant="secondary" onPress={() => run(async () => {
      await phoneAlarms.openSystemClock();
      if (alive.current) setReceipt('已打开系统时钟，请在系统时钟里确认修改结果。');
    }, false)}>打开系统闹钟</Button>
    <Button disabled={busy || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !title.trim()} variant="secondary" onPress={() => Alert.alert(
      '在系统时钟里新建', `将预填 ${time} 和提醒内容。系统接口不能传递日期 ${date || '（未选）'}，请在系统时钟核对日期及重复设置；这一步不会确认闹钟已设置。`,
      [{ text: '取消', style: 'cancel' }, { text: '前往系统时钟', onPress: () => run(async () => {
        if (!alive.current) return;
        await phoneAlarms.createSystemAlarm(Number(time.slice(0, 2)), Number(time.slice(3)), title);
        if (alive.current) setReceipt('已打开系统时钟的新建页，日期和保存结果请在系统时钟确认。');
      }, false) }],
    )}>在系统时钟新建（需核对日期）</Button>
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
    <Text style={styles.small}>请保持通知、闹铃声音及系统的闹钟权限开启。按设置时的手机时区计时；勿扰、静音和厂商省电设置可能影响提醒。</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#FFFFFF', borderColor: '#E1E7F4', borderWidth: 1, borderRadius: 22, padding: 16, gap: 10, marginVertical: 10 },
  title: { fontSize: 17, fontWeight: '600', color: '#30394D' }, small: { fontSize: 12, lineHeight: 19, color: '#697286' },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' }, flex: { flex: 1 },
  input: { borderWidth: 1, borderColor: '#DFE5F0', borderRadius: 12, color: '#30394D', padding: 12, fontSize: 15 },
  saved: { paddingTop: 10, borderTopWidth: 1, borderTopColor: '#E9ECF3', gap: 6 },
  receipt: { color: '#337B65', fontSize: 14 }, error: { color: '#AE4356', fontSize: 14 }, modal: { flex: 1, padding: 20, paddingTop: 48 },
});

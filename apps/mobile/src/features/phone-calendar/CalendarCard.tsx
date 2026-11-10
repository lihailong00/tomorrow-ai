import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { phoneCalendar, type CalendarEventDraft, type WritableCalendar } from '../../platform/phoneCalendar';
import { Text } from '../../ui/Text';
import { Card, ErrorNotice } from '../../ui/components';
import { Icon, type IconName } from '../../ui/visuals';
import { chatAppearance as colors } from '../../ui/ChatAppearance';
import { errorMessage } from '../../api/client';
import { validCalendarEvent } from './calendarRequest';

export const calendarPreferenceKey = (server: string, instance: string | undefined, user: string) =>
  `tada.defaultCalendar.v1:${JSON.stringify([server.replace(/\/+$/, ''), instance ?? '', user])}`;

export async function preferredCalendar(key: string | undefined, calendars: WritableCalendar[]): Promise<WritableCalendar | undefined> {
  const saved = key ? await AsyncStorage.getItem(key).catch(() => null) : null;
  return calendars.find(calendar => calendar.id === saved);
}

const reminders = [[-1, '不提醒'], [0, '开始时'], [15, '提前 15 分钟'], [30, '提前 30 分钟']] as const;
const pad = (value: number) => String(value).padStart(2, '0');
const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());

function readDate(value: string) {
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}

function dateLabel(value: string) {
  const [year, month, day] = value.trim().split('-').map(Number);
  const today = new Date();
  const date = `${month} 月 ${day} 日`;
  if (year !== today.getFullYear()) return `${year} 年 ${date}`;
  return month === today.getMonth() + 1 && day === today.getDate() ? `今天 · ${date}` : date;
}

function timeLabel(draft: CalendarEventDraft) {
  if (draft.allDay) return '全天';
  const [hour, minute] = draft.time.trim().split(':').map(Number);
  const end = hour * 60 + minute + draft.duration;
  return `${draft.time.trim()}–${end >= 1440 ? '次日 ' : ''}${pad(Math.floor(end / 60) % 24)}:${pad(end % 60)}`;
}

function reminderLabel(draft: CalendarEventDraft) {
  if (draft.allDay || draft.remindBefore < 0) return '不提醒';
  return draft.remindBefore === 0 ? '开始时提醒' : `提前 ${draft.remindBefore} 分钟提醒`;
}

function distinctAccount(calendar: WritableCalendar) {
  const account = calendar.account.trim();
  return account.toLowerCase() === calendar.name.trim().toLowerCase() ? '' : account;
}

export type CalendarFeedback = { kind: 'saved'; draft: CalendarEventDraft; calendarName: string; eventId: string } | { kind: 'editor' };

export function calendarReceipt(draft: CalendarEventDraft, calendar: WritableCalendar, eventId: string): CalendarFeedback {
  return { kind: 'saved', draft, calendarName: calendar.name, eventId };
}

export function CalendarFeedbackCard({ feedback, onClose }: { feedback: CalendarFeedback; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const opening = useRef(false);
  const saved = feedback.kind === 'saved';
  async function edit() {
    if (feedback.kind !== 'saved' || opening.current) return;
    opening.current = true;
    setBusy(true);
    setError('');
    try { await phoneCalendar.editSavedEvent(feedback.eventId); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { opening.current = false; setBusy(false); }
  }
  return <Card style={[styles.card, styles.receipt]}>
    <CalendarHeader title={saved ? '已保存到手机日历' : '已打开系统日历'}
      subtitle={saved ? feedback.calendarName : '请在日历中保存，并核对提醒设置'}
      icon={saved ? 'check' : 'calendar'} onClose={onClose} busy={busy} />
    {saved && <>
      <Text style={styles.receiptTitle}>{feedback.draft.title.trim()}</Text>
      <Text style={styles.hint}>{dateLabel(feedback.draft.date)} · {timeLabel(feedback.draft)} · {reminderLabel(feedback.draft)}</Text>
      <CalendarAction label="修改日程" busy={busy} secondary onPress={() => { void edit(); }} />
    </>}
    <ErrorNotice message={error} />
  </Card>;
}

function CalendarHeader({ title, subtitle, icon = 'calendar', onClose, busy, closeLabel = '关闭日历卡片' }: {
  title: string; subtitle: string; icon?: IconName; onClose: () => void; busy: boolean; closeLabel?: string;
}) {
  return <View style={styles.header}>
    <View style={[styles.badge, icon === 'check' && styles.savedBadge]}>
      <Icon name={icon} size={18} color={icon === 'check' ? '#236A55' : colors.accent} />
    </View>
    <View style={styles.copy}>
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.heading}>{title}</Text>
      <Text style={styles.hint}>{subtitle}</Text>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} disabled={busy}
      onPress={onClose} style={styles.iconButton}>
      <Icon name="close" size={18} color={colors.secondary} />
    </Pressable>
  </View>;
}

function CalendarRow({ label, value, caption, detail, spokenValue, badge, onPress, disabled, expanded }: {
  label: string; value: string; caption?: string; detail?: string; spokenValue?: string;
  badge: React.ReactNode; onPress: () => void;
  disabled: boolean; expanded: boolean;
}) {
  return <Pressable style={styles.item} accessibilityRole="button" accessibilityLabel={label}
    accessibilityValue={{ text: spokenValue ?? value }}
    accessibilityState={{ disabled, expanded }} disabled={disabled} onPress={onPress}>
    {badge}
    <View style={styles.copy}>
      {!!caption && <Text style={styles.hint}>{caption}</Text>}
      <Text style={styles.rowValue}>{value}</Text>
      {!!detail && <Text style={styles.hint}>{detail}</Text>}
    </View>
    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} color={colors.secondary} />
  </Pressable>;
}

function CalendarAction({ label, onPress, busy, disabled = false, secondary }: {
  label: string; onPress: () => void; busy: boolean; disabled?: boolean; secondary?: boolean;
}) {
  const color = secondary ? colors.accent : colors.onAccent;
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ busy, disabled: busy || disabled }}
    disabled={busy || disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, secondary && styles.secondaryAction, pressed && styles.pressed, (busy || disabled) && styles.dimmed]}>
    <Text style={[styles.actionText, { color }]}>{label}</Text>
    {busy ? <ActivityIndicator size="small" color={color} /> : secondary && <Icon name="arrowRight" size={16} color={color} />}
  </Pressable>;
}

function PanelDone({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel="完成" disabled={disabled}
    style={[styles.smallAction, styles.done, disabled && styles.dimmed]} onPress={onPress}>
    <Text style={styles.linkText}>完成</Text>
  </Pressable>;
}

type Editor =
  | { kind: 'title'; value: string }
  | { kind: 'time'; value: CalendarEventDraft; manual?: 'date' | 'time' }
  | { kind: 'calendar'; selection: string }
  | { kind: 'more' };

export function CalendarCard({ initial, index, total, wantsReminder, preferenceKey, autoError, isCurrent, onDone, onCancel }: {
  initial: CalendarEventDraft; index: number; total: number; wantsReminder: boolean; preferenceKey?: string; autoError?: string;
  isCurrent: () => boolean; onDone: (feedback: CalendarFeedback) => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => initial.allDay && initial.remindBefore < 0 && wantsReminder
    ? { ...initial, remindBefore: 0 } : initial);
  const [calendars, setCalendars] = useState<WritableCalendar[]>([]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(autoError ?? '');
  const [editor, setEditor] = useState<Editor | null>(null);
  const operation = useRef(false);
  const requestedCalendars = useRef(false);
  const currentFlow = useRef(isCurrent);
  currentFlow.current = isCurrent;
  const date = readDate(draft.date);
  const valid = Boolean(date) && validCalendarEvent(draft);
  const target = calendars.find(calendar => calendar.id === selected);
  const missingTime = !draft.allDay && !isTime(draft.time);

  useEffect(() => {
    let mounted = true;
    const current = () => mounted && !requestedCalendars.current && currentFlow.current();
    void (async () => {
      // Reading an already-authorized calendar never prompts on mount.
      if (!await phoneCalendar.hasAccess() || !current()) return;
      const writable = await phoneCalendar.calendars();
      if (!current()) return;
      const preferred = await preferredCalendar(preferenceKey, writable);
      if (!current()) return;
      setCalendars(writable);
      setSelected(preferred?.id ?? (writable.length === 1 ? writable[0].id : ''));
    })().catch(() => {});
    return () => { mounted = false; };
  }, [preferenceKey]);

  async function run(action: () => Promise<void>) {
    if (!isCurrent() || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try { await action(); }
    catch (failure) { if (isCurrent()) setError(errorMessage(failure)); }
    finally { operation.current = false; if (isCurrent()) setBusy(false); }
  }

  function resolveCalendar(save: boolean) {
    return run(async () => {
      requestedCalendars.current = true;
      if (!await phoneCalendar.requestAccess()) throw new Error('未获日历权限。你可以在系统设置中允许，也可以在系统日历里手动保存。');
      if (!isCurrent()) return;
      const writable = await phoneCalendar.calendars();
      if (!isCurrent()) return;
      setCalendars(writable);
      if (!writable.length) {
        setSelected('');
        throw new Error('手机没有可写日历。请在系统日历中创建日历或添加可写账号。');
      }
      const choice = selected ? writable.find(calendar => calendar.id === selected)
        : (await preferredCalendar(preferenceKey, writable) ?? (writable.length === 1 ? writable[0] : undefined));
      if (!isCurrent()) return;
      setSelected(choice?.id ?? '');
      if (!save || !choice) {
        setEditor({ kind: 'calendar', selection: choice?.id ?? '' });
        return;
      }
      // Keep the user's timed reminder available when toggling modes in the draft.
      const event = draft.allDay ? { ...draft, remindBefore: -1 } : draft;
      const saved = await phoneCalendar.add(choice.id, event);
      if (!isCurrent()) return;
      if (preferenceKey) void AsyncStorage.setItem(preferenceKey, choice.id).catch(() => {});
      onDone(calendarReceipt(event, choice, saved.id));
    });
  }

  function toggle(next: Editor) {
    setError('');
    setEditor(current => current?.kind === next.kind ? null : next);
  }

  function updateTime(patch: Partial<CalendarEventDraft>) {
    setEditor(current => current?.kind === 'time' ? { ...current, value: { ...current.value, ...patch } } : current);
  }

  function pick(field: 'date' | 'time', value: CalendarEventDraft) {
    return run(async () => {
      const result = field === 'date' ? phoneCalendar.pickDate(value.date.trim()) : phoneCalendar.pickTime(value.date.trim(), value.time.trim());
      if (!result) {
        setEditor(current => current?.kind === 'time' ? { ...current, manual: field } : current);
        return;
      }
      const picked = await result;
      if (picked && isCurrent()) updateTime({ [field]: picked });
    });
  }

  const time = missingTime ? '选择时间' : timeLabel(draft);
  const weekday = date ? `周${'日一二三四五六'[date.getUTCDay()]}` : '';
  const dateHint = date && date.getUTCFullYear() !== new Date().getFullYear() ? `${date.getUTCFullYear()} 年 · ` : '';
  const reminder = draft.allDay && wantsReminder ? '全天不提醒，可改为指定时间' : reminderLabel(draft);
  const titleMissing = !draft.title.trim();
  const primary = titleMissing ? '填写日程名称' : !date ? '选择日期' : missingTime ? '选择时间' : '保存到日历';
  const editing = Boolean(editor && editor.kind !== 'more');
  const sameName = target && calendars.some(calendar => calendar.id !== target.id && calendar.name === target.name);
  const targetAccount = sameName ? distinctAccount(target) : '';

  return <Card style={styles.card}>
    <View style={styles.header}>
      <View style={styles.badge}><Icon name="calendar" size={17} color={colors.accent} /></View>
      <Text accessibilityRole="header" style={[styles.copy, styles.draftLabel]}>
        日程草稿{total > 1 ? ` · ${index + 1}/${total}` : ''}
      </Text>
      <Pressable accessibilityRole="button" accessibilityLabel="更多日程选项"
        accessibilityState={{ expanded: editor?.kind === 'more', disabled: busy }} disabled={busy}
        style={styles.smallAction} onPress={() => toggle({ kind: 'more' })}>
        <Text style={styles.hint}>更多</Text>
      </Pressable>
    </View>

    <Pressable accessibilityRole="button" accessibilityLabel="编辑日程标题"
      accessibilityValue={{ text: draft.title }} accessibilityState={{ expanded: editor?.kind === 'title', disabled: busy }}
      disabled={busy} onPress={() => toggle({ kind: 'title', value: draft.title })} style={styles.event}>
      <Text style={styles.eventTitle}>{draft.title.trim() || '填写日程名称'}</Text>
      <Text style={styles.linkText}>修改</Text>
    </Pressable>
    {editor?.kind === 'title' && <View style={styles.panel}>
      <Text style={styles.hint}>日程名称</Text>
      <TextInput accessibilityLabel="日程名称" style={[styles.field, styles.titleInput]} autoFocus multiline
        maxLength={120} placeholder="日程名称" placeholderTextColor={colors.secondary} value={editor.value}
        onChangeText={value => setEditor({ kind: 'title', value })} />
      <PanelDone disabled={!editor.value.trim()} onPress={() => {
        setDraft({ ...draft, title: editor.value.trim() });
        setEditor(null);
      }} />
    </View>}

    <CalendarRow label="编辑时间与提醒" value={date ? `${weekday} · ${time}` : '选择日期'}
      detail={dateHint + reminder}
      spokenValue={date ? `${dateLabel(draft.date)}，${time}，${reminder}` : '选择日期'}
      badge={<View accessible={false} style={styles.dateTile}>{date ? <>
        <Text style={styles.month}>{date.getUTCMonth() + 1}月</Text>
        <Text style={styles.day}>{date.getUTCDate()}</Text>
      </> : <Icon name="calendar" size={18} color={colors.accent} />}</View>}
      expanded={editor?.kind === 'time'} disabled={busy} onPress={() => toggle({ kind: 'time', value: draft })} />
    {editor?.kind === 'time' && <View style={styles.panel}>
      <Text style={styles.hint}>日期</Text>
      {editor.manual === 'date' ? <TextInput accessibilityLabel="日程日期" style={styles.field} editable={!busy}
        maxLength={10} placeholder="YYYY-MM-DD" placeholderTextColor={colors.secondary} value={editor.value.date}
        onChangeText={value => updateTime({ date: value })} /> :
        <Pressable accessibilityRole="button" accessibilityLabel="选择日程日期" disabled={busy}
          onPress={() => { void pick('date', editor.value); }} style={styles.pickerField}>
          <Text style={[styles.copy, styles.rowValue]}>{readDate(editor.value.date) ? dateLabel(editor.value.date) : '选择日期'}</Text>
          <Icon name="calendar" size={17} color={colors.secondary} />
        </Pressable>}
      <View style={styles.segmented}>
        {([true, false] as const).map(allDay => {
          const label = allDay ? '全天' : '指定时间';
          const active = editor.value.allDay === allDay;
          return <Pressable key={label} accessibilityRole="radio" accessibilityLabel={label}
            accessibilityState={{ checked: active, disabled: busy }} disabled={busy}
            onPress={() => updateTime({ allDay })} style={[styles.segment, active && styles.choiceActive]}>
            <Text style={active ? styles.linkText : styles.rowValue}>{label}</Text>
          </Pressable>;
        })}
      </View>
      {!editor.value.allDay && <>
        <Text style={styles.hint}>开始时间</Text>
        {editor.manual === 'time' ? <TextInput accessibilityLabel="开始时间" style={styles.field} editable={!busy}
          maxLength={5} placeholder="HH:mm（24 小时制）" placeholderTextColor={colors.secondary} value={editor.value.time}
          onChangeText={value => updateTime({ time: value })} /> :
          <Pressable accessibilityRole="button" accessibilityLabel="选择开始时间" disabled={busy}
            onPress={() => { void pick('time', editor.value); }} style={styles.pickerField}>
            <Text style={[styles.copy, styles.rowValue]}>{isTime(editor.value.time) ? editor.value.time : '选择时间'}</Text>
            <Icon name="clock" size={17} color={colors.secondary} />
          </Pressable>}
        <Text style={styles.hint}>提醒</Text>
        <View style={styles.reminderChoices}>
          {reminders.map(([value, label]) => {
            const active = editor.value.remindBefore === value;
            return <Pressable key={value} accessibilityRole="radio" accessibilityLabel={label}
              accessibilityState={{ checked: active, disabled: busy }} disabled={busy}
              style={[styles.reminderChoice, active && styles.choiceActive]} onPress={() => updateTime({ remindBefore: value })}>
              <Text style={active ? styles.linkText : styles.hint}>{label}</Text>
            </Pressable>;
          })}
        </View>
      </>}
      <PanelDone disabled={busy || !readDate(editor.value.date) || (!editor.value.allDay && !isTime(editor.value.time))}
        onPress={() => { setDraft(editor.value); setEditor(null); }} />
    </View>}

    <CalendarRow label="选择保存日历" caption="保存到" value={target?.name ?? '选择日历'} detail={targetAccount}
      spokenValue={target ? [target.name, targetAccount].filter(Boolean).join('，') : '尚未选择'}
      badge={<View style={styles.calendarTile}><Icon name="calendar" size={17} color={colors.accent} /></View>}
      expanded={editor?.kind === 'calendar'} disabled={busy} onPress={() => {
        if (editor?.kind === 'calendar') setEditor(null);
        else void resolveCalendar(false);
      }} />
    {editor?.kind === 'calendar' && <View style={styles.panel}>
      <Text style={styles.hint}>选择要保存到的日历</Text>
      {calendars.map(calendar => {
        const account = distinctAccount(calendar);
        const active = editor.selection === calendar.id;
        return <Pressable key={calendar.id} accessibilityRole="radio"
          accessibilityLabel={[calendar.name, account].filter(Boolean).join('，')}
          accessibilityState={{ checked: active }} style={styles.calendarChoice}
          onPress={() => setEditor({ kind: 'calendar', selection: calendar.id })}>
          <View style={styles.copy}>
            <Text style={styles.rowValue}>{calendar.name}</Text>
            {!!account && <Text style={styles.hint}>{account}</Text>}
          </View>
          <View style={[styles.radioMark, active && styles.radioSelected]}>
            {active && <Icon name="check" size={13} color={colors.onAccent} />}
          </View>
        </Pressable>;
      })}
      <PanelDone disabled={!editor.selection} onPress={() => {
        setSelected(editor.selection);
        setEditor(null);
      }} />
    </View>}

    <ErrorNotice message={error} />
    {editor?.kind === 'more' && <View style={styles.panel}>
      <Pressable accessibilityRole="button" accessibilityLabel="在系统日历中编辑" disabled={busy || !valid}
        style={[styles.option, !valid && styles.dimmed]} onPress={() => run(async () => {
          await phoneCalendar.openEditor(draft);
          if (isCurrent()) onDone({ kind: 'editor' });
        })}>
        <Icon name="arrowRight" size={17} color={colors.accent} />
        <Text style={styles.rowValue}>在系统日历中编辑</Text>
      </Pressable>
      {!valid && <Text style={styles.hint}>补齐日程信息后即可打开系统日历。</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={total > 1 ? '跳过这项' : '取消添加'}
        disabled={busy} onPress={onCancel} style={styles.option}>
        <Icon name="close" size={17} color={colors.secondary} />
        <Text style={styles.rowValue}>{total > 1 ? '跳过这项' : '取消添加'}</Text>
      </Pressable>
    </View>}
    <CalendarAction label={primary} busy={busy} disabled={editing} onPress={() => {
      if (titleMissing) toggle({ kind: 'title', value: draft.title });
      else if (!valid) toggle({ kind: 'time', value: draft });
      else void resolveCalendar(true);
    }} />
  </Card>;
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 21, marginBottom: 8, backgroundColor: colors.surface, borderColor: colors.line },
  receipt: { gap: 8 },
  receiptTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.tint },
  savedBadge: { backgroundColor: '#E9F5EF' },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  heading: { fontSize: 16, fontWeight: '700', color: colors.ink },
  draftLabel: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.secondary, fontSize: 12 },
  event: { minHeight: 44, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventTitle: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 19, fontWeight: '700' },
  item: { minHeight: 56, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  dateTile: { minWidth: 42, minHeight: 44, paddingHorizontal: 4, paddingVertical: 3, borderRadius: 10,
    backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center' },
  month: { color: colors.accent, fontSize: 11 },
  day: { color: colors.accent, fontSize: 21, fontWeight: '700' },
  calendarTile: { width: 42, alignItems: 'center', justifyContent: 'center' },
  rowValue: { minWidth: 0, flexShrink: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  linkText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  panel: { padding: 10, gap: 6, borderRadius: 12, marginBottom: 8, backgroundColor: colors.voiceTint },
  field: { minHeight: 44, color: colors.ink, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line,
    borderRadius: 9, paddingHorizontal: 10, fontSize: 16 },
  titleInput: { minHeight: 64, paddingVertical: 8, textAlignVertical: 'top' },
  pickerField: { minHeight: 44, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.surface },
  segmented: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, minHeight: 44, padding: 5, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  reminderChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  reminderChoice: { minHeight: 44, paddingHorizontal: 8, paddingVertical: 5, justifyContent: 'center', borderRadius: 8 },
  choiceActive: { backgroundColor: colors.surface },
  calendarChoice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  radioMark: { width: 20, height: 20, borderRadius: 10, borderColor: colors.secondary, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  smallAction: { minWidth: 44, minHeight: 44, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  done: { alignSelf: 'flex-end' },
  option: { minHeight: 44, flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8 },
  action: { minHeight: 46, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginTop: 6,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, backgroundColor: colors.accent },
  actionText: { fontSize: 14, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
  secondaryAction: { backgroundColor: colors.tint },
  dimmed: { opacity: 0.5 },
  pressed: { opacity: 0.78 },
});

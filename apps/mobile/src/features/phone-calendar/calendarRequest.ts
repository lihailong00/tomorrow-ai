import type { Message } from '../../domain/types';
import type { CalendarEventDraft } from '../../platform/phoneCalendar';

const dayCue = /\d{4}-\d{2}-\d{2}|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|今天|明天|后天|(?:本|这|下)?(?:周|星期)[一二三四五六日天]/;
const clockCue = /(?<!\d)(?:凌晨|早上|上午|中午|下午|晚上)?\s*(?:\d{1,2}[:：]\d{2}(?!\d)|[0-9零一二两三四五六七八九十]{1,3}(?:点|时(?!间|候|长))(?:半|[0-9零一二两三四五六七八九十]{1,3}分)?)\s*/;
const prefix = /^(?:请\s*)?(?:(?:帮|给|替)我\s*)?(?:在(?:手机|系统|本机)?日历(?:里|中)?(?:添加|新增|创建|记下|安排|加上)|(?:添加|新增|创建)(?:一个|一条|个)?(?:日程|日历事件)|(?:把|将)(?=.+(?:加到|加入|记到|写进)(?:手机|系统|本机)?日历))/;
const suffix = /(?:(?:加到|加入|记到|写进)(?:手机|系统|本机)?日历|(?:帮我)?加个日程)(?:吧)?[。！!]*$/;
const followUp = /^(?:好[的吧]?[，,。]?\s*)?(?:(?:先)?记(?:住|得|下)(?:来)?[，,、。\s]*)?(?:到时(?:候)?|到点|届时|记得)(?:再)?提醒我(?:一下|一声)?(?:吧|哈)?[。！!]*$/;
const reminderIntent = /(?:请|记得|到时)?提醒我/;
const unrelated = /闹[钟铃]|叫醒我|每天|每周|每月|每年|工作日|不要|别(?:再|帮|给|提醒|添加)|取消|如果|假如|能不能|怎么|引用消息|^\s*>/;
const lead = /(?:[，,]\s*)?提前\s*([0-9零一二两三四五六七八九十]{1,3}|半)\s*(?:个)?(分钟|小时|天)(?:\s*(?:提醒我|提醒|通知我))?/;
const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function number(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '半') return 0.5;
  const digit = (text: string) => '零一二两三四五六七八九'.includes(text) && text ? '零一二三四五六七八九'.indexOf(text.replace('两', '二')) : NaN;
  if (!value.includes('十')) return digit(value);
  const [a, b, extra] = value.split('十');
  return extra === undefined ? (a ? digit(a) : 1) * 10 + (b ? digit(b) : 0) : NaN;
}

function readDate(cue: string, base: Date): string {
  const exact = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cue);
  const monthDay = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/.exec(cue);
  const literal = exact ?? monthDay;
  if (literal) {
    const year = literal[1] ? Number(literal[1]) : base.getFullYear();
    const month = Number(literal[2]); const day = Number(literal[3]);
    const d = new Date(year, month - 1, day);
    return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day ? dateText(d) : '';
  }
  const day = new Date(base);
  const relative = { 今天: 0, 明天: 1, 后天: 2 }[cue];
  if (relative !== undefined) day.setDate(day.getDate() + relative);
  else {
    const match = /^(本|这|下)?(?:周|星期)([一二三四五六日天])$/.exec(cue);
    if (!match) return '';
    const weekday = (day.getDay() + 6) % 7;
    const target = '一二三四五六日'.indexOf(match[2].replace('天', '日'));
    const delta = target - weekday + (match[1] === '下' || (!match[1] && target < weekday) ? 7 : 0);
    day.setDate(day.getDate() + delta);
  }
  return dateText(day);
}

function readTime(cue: string): string {
  const match = /^(凌晨|早上|上午|中午|下午|晚上)?\s*([0-9零一二两三四五六七八九十]{1,3})(?:[:：](\d{2})|[点时](半|[0-9零一二两三四五六七八九十]{1,3}分)?)$/.exec(cue.trim());
  if (!match) return '';
  const [, period, rawHour, digits, fraction] = match;
  let hour = number(rawHour);
  const minute = digits ? Number(digits) : fraction === '半' ? 30 : fraction ? number(fraction.slice(0, -1)) : 0;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return '';
  if (!period && !digits && hour > 0 && hour < 12) return '';
  if ((period === '早上' || period === '上午' || period === '凌晨') && hour > 12) return '';
  if ((period === '早上' || period === '上午') && hour === 12) return '';
  if (period === '凌晨' && hour === 12) hour = 0;
  if (period === '中午' && (hour < 11 || hour > 13)) return '';
  if (period === '晚上' && hour === 12) return '';
  if (period === '下午' || period === '晚上') {
    if (hour === 0) return '';
    if (hour < 12) hour += 12;
  }
  return `${pad(hour)}:${pad(minute)}`;
}

export type CalendarRequest = { drafts: CalendarEventDraft[]; automatic: boolean; needsReminderTime: boolean };

/** Only clear local calendar requests or immediate reminder follow-ups intercept chat. */
export function calendarRequest(text: string, messages: readonly Message[], now: Date): CalendarRequest | null {
  if (text.length > 400 || unrelated.test(text)) return null;
  const entered = text.trim();
  const instruction = entered.replace(lead, '').trim();
  const explicit = prefix.test(instruction) || suffix.test(instruction);
  const follow = followUp.test(entered);
  if (!explicit && !follow && !(reminderIntent.test(entered) && dayCue.test(entered))) return null;
  const previousUser = follow ? messages.slice(-6).reverse().find(message => message.role === 'user' &&
    (!message.delivery || message.delivery === 'sent')) : undefined;
  const recent = previousUser && dayCue.test(previousUser.content) && !unrelated.test(previousUser.content) ? previousUser : undefined;
  const source = follow ? (recent?.content ?? '') : entered;
  const base = recent ? new Date(recent.created_at) : now;
  const leadMatch = lead.exec(entered) ?? lead.exec(source);
  const wantsReminder = follow || Boolean(leadMatch) || reminderIntent.test(entered);
  const leadMinutes = leadMatch ? number(leadMatch[1]) * ({ 分钟: 1, 小时: 60, 天: 1440 }[leadMatch[2]] ?? 1) : 0;
  const parsedLead = Number.isInteger(leadMinutes) && leadMinutes >= 0 && leadMinutes <= 10080 ? leadMinutes : 0;
  const cleaned = source.replace(lead, '').trim().replace(prefix, '').replace(suffix, '')
    .replace(/^(?:请)?(?:(?:帮|给|替)我)?(?:记得)?提醒我[，,：:\s]*/, '')
    .replace(/[，,。\s]*(?:请|记得|到时)?提醒我(?:一下|一声)?(?:吧)?[。！!]*$/, '')
    .trim().replace(/^[：:，,\s]+/, '');
  const pieces = cleaned.split(/\s*[；;\n]+\s*|[，,]\s*(?:还要|还得|然后|另外|再去|再和)/).map(piece => piece.trim()).filter(Boolean);
  const cues = (pattern: RegExp, piece: string) => [...piece.matchAll(new RegExp(pattern.source, 'g'))];
  const firstDates = cues(dayCue, pieces[0] ?? '');
  const inheritedDate = firstDates.length === 1 ? firstDates[0][0] : undefined;
  const drafts = (pieces.length > 0 && pieces.length <= 4 ? pieces : [pieces.length ? '' : cleaned]).map(piece => {
    const dates = cues(dayCue, piece);
    const clocks = cues(clockCue, piece);
    const cue = dates.length === 1 ? dates[0][0] : dates.length ? undefined : inheritedDate;
    const clock = clocks.length === 1 && !/(?:点|时|\d:\d{2})\s*(?:到|至|[-~～])/.test(piece) ? clocks[0][0] : undefined;
    const date = Number.isFinite(base.getTime()) && cue ? readDate(cue, base) : '';
    const allDay = /全天/.test(piece) && clocks.length === 0;
    const time = !allDay && clock ? readTime(clock) : '';
    const title = piece.replace(dayCue, '').replace(clockCue, '').replace(/全天/, '')
      .replace(/^[\s，,：:、的]+|[\s。！!，,；;]+$/g, '')
      .replace(/^(?:提醒我|我要|我想|我打算|还有|要去)[\s，,：:]*/, '').trim().slice(0, 120);
    return { title, date, time, allDay, duration: 30, remindBefore: !allDay && wantsReminder ? parsedLead : -1 };
  });
  const [draft] = drafts;
  const automatic = explicit && !follow && drafts.length === 1 && Boolean(draft.title && draft.date && (draft.time || draft.allDay)) &&
    !/还是|或者|可能|也许|大概|暂定|到\s*\d|[?？]|[，,、；;\n]/.test(cleaned) &&
    cues(dayCue, cleaned).length === 1 && cues(clockCue, cleaned).length <= 1 &&
    /^(?:请\s*)?(?:(?:帮|给|替)我\s*)?(?:在|添加|新增|创建|把|将)/.test(instruction) && parsedLead === leadMinutes;
  return { drafts, automatic, needsReminderTime: wantsReminder };
}

export function validCalendarEvent(draft: CalendarEventDraft): boolean {
  return Boolean(draft.title.trim()) && /^\d{4}-\d{2}-\d{2}$/.test(draft.date.trim()) &&
    (draft.allDay || /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time.trim()));
}

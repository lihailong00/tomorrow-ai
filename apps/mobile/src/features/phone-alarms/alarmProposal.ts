export type AlarmProposal = { date: string; time: string; title: string; needsReview: boolean };
export const mentionsAlarm = (text: string) => /闹[钟铃]|\balarm\b/i.test(text);
export const isAlarmRequest = (text: string) => mentionsAlarm(text) ||
  (!/不要|别提醒|引用消息|^\s*>/.test(text) && /提醒我/.test(text) && /今天|明天|后天|\d{4}-\d{2}-\d{2}/.test(text));
const pad = (n: number) => String(n).padStart(2, '0');
const day = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
function number(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digit = (v: string) => '零一二三四五六七八九'.indexOf(v.replace('两', '二'));
  if (text === '十') return 10;
  if (text.includes('十')) {
    const [a, b] = text.split('十');
    return (a ? digit(a) : 1) * 10 + (b ? digit(b) : 0);
  }
  return text.length === 1 ? digit(text) : NaN;
}

/** An editable suggestion, never authority to execute. Relative days use message time. */
export function alarmProposal(text: string, createdAt: string): AlarmProposal {
  const empty: AlarmProposal = { date: '', time: '', title: '提醒', needsReview: true };
  const base = new Date(createdAt);
  if (!Number.isFinite(base.getTime())) return empty;
  // Quoted, negated or multiple requests must not become a guessed alarm.
  if (/引用消息|(?:^|\n)\s*>|不要|别(?:给我)?设|取消|删除|每[天周月年]|工作日|重复|提前|推迟|延后|[一三]刻|秒/.test(text)) return empty;
  const times = [...text.matchAll(/(?:(凌晨|早上|上午|中午|下午|晚上|晚间)\s*)?([\d零一二两三四五六七八九十]{1,3})(?::(\d{2})|[点时](半|[\d零一二两三四五六七八九十]{1,3}分?)?)/g)];
  if (times.length !== 1) return empty;
  const [full, period, rawHour, minutes, fraction] = times[0];
  let hour = number(rawHour);
  const minute = minutes !== undefined ? Number(minutes) : fraction === '半' ? 30 : fraction ? number(fraction.replace('分', '')) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || minute < 0 || minute > 59 || !Number.isInteger(minute)) return empty;
  if ((/晚上|晚间/.test(period ?? '') && (hour === 0 || hour === 12)) || (/上午|早上/.test(period ?? '') && hour === 12)) return empty;
  if (period === '下午' && hour === 0) return empty;
  if (period && /下午|晚上|晚间/.test(period) && hour >= 1 && hour < 12) hour += 12;
  if (period === '凌晨' && hour === 12) hour = 0;
  if ((period === '中午' && hour < 11) || (/凌晨|上午|早上/.test(period ?? '') && hour > 12)) return empty;
  const target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);
  const explicit = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  const relatives = [...text.matchAll(/今天|明天|后天/g)];
  if (relatives.length > 1 || (explicit && relatives.length)) return empty;
  if (explicit) {
    const y = Number(explicit[1]), m = Number(explicit[2]), d = Number(explicit[3]);
    target.setFullYear(y, m - 1, d);
    if (target.getFullYear() !== y || target.getMonth() !== m - 1 || target.getDate() !== d) return empty;
  } else if (relatives.length) target.setDate(target.getDate() + ({ 今天: 0, 明天: 1, 后天: 2 }[relatives[0][0]] ?? 0));
  else {
    // Unsupported month/day phrases require manual date selection.
    if (/\d+月|星期|周[一二三四五六日天]|下周/.test(text)) return empty;
    if (target.getTime() <= base.getTime()) target.setDate(target.getDate() + 1);
  }
  const title = /提醒(?:我)?\s*([^。！？!?\n]{1,120})/.exec(text)?.[1]?.trim() ?? '提醒';
  return { date: day(target), time: `${pad(hour)}:${pad(minute)}`, title,
    needsReview: !period && hour > 0 && hour < 12 && !full.includes(':') };
}

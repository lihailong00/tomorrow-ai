import type { DailyPlan, DailyPlanItem } from './types';

/** Server dates are civil dates, not midnight timestamps in the device zone. */
export function localDateLabel(date: string, weekday = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match.map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.toISOString().slice(0, 10) !== date) return date;
  return `${month}月${day}日${
    weekday ? ' · 周' + '日一二三四五六'[value.getUTCDay()] : ''
  }`;
}
export function dayName(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return (
    '周' +
    '日一二三四五六'[
      new Date(
        Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
      ).getUTCDay()
    ]
  );
}
export function visiblePlanItems(
  plan: DailyPlan | null | undefined,
): DailyPlanItem[] {
  if (!plan) return [];
  return plan.items
    .filter(item => {
      if (item.status === 'skipped') return false;
      if (
        item.todo &&
        ['completed', 'dismissed', 'waiting'].includes(item.todo.status)
      )
        return false;
      if (plan.status === 'paused' && item.status !== 'accepted') return false;
      return true;
    })
    .slice(0, 3);
}
export function levelProgress(levelXp: number, perLevel: number): number {
  return perLevel > 0 ? Math.max(0, Math.min(1, levelXp / perLevel)) : 0;
}

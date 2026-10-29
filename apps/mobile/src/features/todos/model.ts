import type { Todo, TodoKind } from './types';
export const todoKinds: Record<TodoKind, string> = {
  general: '日常',
  communication: '沟通',
  learning: '学习',
  exercise: '运动',
  errand: '跑腿',
  reading: '阅读',
  expense: '报销',
};
export const kindIcons = {
  general: 'tasks',
  communication: 'file',
  learning: 'memory',
  exercise: 'today',
  errand: 'clock',
  reading: 'file',
  expense: 'file',
} as const;
// Display names from crates/connectors/src/domestic/catalog.rs; these describe
// an already imported source and do not imply a connected or readable account.
const importSourceNames: Record<string, string> = {
  wechat: '微信',
  qq: 'QQ',
  qq_mail: 'QQ 邮箱',
  netease163: '163 邮箱',
  netease126: '126 邮箱',
  tencent_docs: '腾讯文档',
  wps: 'WPS',
  amap: '高德地图',
  xiaohongshu: '小红书',
  bilibili: '哔哩哔哩',
  douyin: '抖音',
  zhihu: '知乎',
  feishu: '飞书',
  dingtalk: '钉钉',
  yuque: '语雀',
  wecom: '企业微信',
  taobao: '淘宝',
  jd: '京东',
  meituan: '美团',
  alipay: '支付宝',
  didi: '滴滴',
};
export function shortSourceLabel(todo: Todo): string {
  if (todo.source_kind === 'manual') return '你添加';
  if (todo.source_kind === 'conversation') return '对话';
  if (todo.source_kind === 'integration_import') {
    const id = /^已导入\s*·\s*([a-z0-9_]+)\s*·/.exec(todo.source_label)?.[1];
    if (id === 'shared') return '分享资料';
    if (id && Object.prototype.hasOwnProperty.call(importSourceNames, id))
      return importSourceNames[id];
  }
  return '导入资料';
}
export function nextAction(todo: Todo): string {
  if (todo.status === 'suggested') return '确认';
  if (todo.status === 'completed' || todo.status === 'waiting') return '查看';
  if (todo.kind === 'exercise')
    return todo.status === 'in_progress' ? '结束' : '开始';
  if (todo.draft)
    return todo.kind === 'communication'
      ? '审阅'
      : todo.kind === 'learning'
      ? '继续'
      : '看内容';
  return {
    communication: '拟回复',
    learning: '准备',
    exercise: '开始',
    errand: '取办',
    reading: '整理',
    expense: '整理',
    general: '打开',
  }[todo.kind];
}
export function progressLabel(todo: Todo): string {
  if (todo.status === 'suggested') return '待你确认加入';
  if (todo.status === 'completed') return '你已确认完成';
  if (todo.status === 'waiting') return '等待后续进展';
  if (todo.progress_notes?.trim())
    return todo.progress_notes.trim().split('\n').pop()!;
  if (todo.draft) return '内容已准备，待你确认';
  if (todo.linked_task_id) return '查看准备进展';
  return todo.status === 'in_progress' ? '进行中 · 自行记录' : '待处理';
}
export function validateMinutes(input: string): number | null {
  if (!input.trim()) return null;
  if (!/^\d+$/.test(input.trim()) || Number(input) < 1 || Number(input) > 360)
    throw new Error('请输入 1–360 的整数分钟，或留空。');
  return Number(input);
}
// The editor reads and writes wall-clock times in the account's timezone.
export function localDue(
  value: string | null | undefined,
  timezone: string,
): string {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = (name: string) => parts.find(part => part.type === name)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get(
    'minute',
  )}`;
}
export function parseDue(input: string, timezone: string): string | null {
  if (!input.trim()) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(input.trim());
  if (!match) throw new Error('时间请按 2026-10-29 19:00 填写，或留空。');
  const [, year, month, day, hour, minute] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = utc;
  for (let i = 0; i < 3; i++) {
    const shown = localDue(new Date(guess).toISOString(), timezone);
    const digits = shown.match(/\d+/g)!.map(Number);
    const wall = Date.UTC(
      digits[0],
      digits[1] - 1,
      digits[2],
      digits[3],
      digits[4],
    );
    guess += utc - wall;
  }
  const result = new Date(guess).toISOString();
  if (localDue(result, timezone) !== input.trim())
    throw new Error('这个日期或当地时间无效，请重新填写。');
  return result;
}

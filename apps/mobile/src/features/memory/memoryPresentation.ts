import type { Memory, MemoryConfirmation, MemoryKind } from '../../domain/types';

export const memoryGroups = {
  preference: '偏好',
  goal: '目标',
  fact: '关于我',
} as const;
export type MemoryGroup = keyof typeof memoryGroups;

export function memoryGroup(kind: MemoryKind): MemoryGroup {
  if (kind === 'project') return 'goal';
  if (kind === 'person') return 'fact';
  return kind;
}

// Also recognize older records which predate server-side confirmation metadata.
const weightPattern =
  /(?:体重|weight)[^，。；\n]{0,32}?([“"]?\s*(?:一|[-−－])?\s*\d+(?:\.\d+)?)\s*(kg|公斤|千克|斤)[”"]?/i;

export function getMemoryConfirmation(
  memory: Memory,
): MemoryConfirmation | undefined {
  if (memory.confirmation) return memory.confirmation;
  const match = weightPattern.exec(memory.content);
  if (!match) return undefined;
  const token = match[1].replace(/[“"\s]/g, '');
  const mixed = token.startsWith('一');
  const value = Number(token.replace(/^一/, '').replace(/[−－]/, '-'));
  const factor = match[2] === '斤' ? 0.5 : 1;
  if (!mixed && value > 0 && value * factor <= 1000) return undefined;
  const options: number[] = [];
  const suggested = Math.abs(value) * factor;
  if (suggested > 0 && suggested <= 1000) options.push(suggested);
  if (mixed && value >= 0 && value < 100) options.push((100 + value) * factor);
  return { field: 'weight', options, proposed_content: memory.content };
}

export function confirmedWeightContent(
  review: MemoryConfirmation,
  kilograms: number,
): string | undefined {
  if (!Number.isFinite(kilograms) || kilograms <= 0 || kilograms > 1000)
    return undefined;
  const match = weightPattern.exec(review.proposed_content);
  if (!match) return undefined;
  const start = match.index + match[0].lastIndexOf(match[1]);
  return (
    review.proposed_content.slice(0, start) +
    `${kilograms} 公斤` +
    review.proposed_content.slice(match.index + match[0].length)
  );
}

export const memoryCategories = [
  '个人资料',
  '生活习惯',
  '沟通偏好',
  '兴趣偏好',
  '目标计划',
  '工作项目',
  '人物关系',
  '其他',
] as const;
export type MemoryCategory = (typeof memoryCategories)[number];

export function memoryCategory(memory: Memory): MemoryCategory {
  const text = `${memory.title} ${memory.content}`;
  if (memory.kind === 'person') return '人物关系';
  if (memory.kind === 'project') return '工作项目';
  if (memory.kind === 'goal') return '目标计划';
  if (/项目|正在.{0,8}(?:开发|筹备|制作)/.test(text)) return '工作项目';
  if (memory.kind === 'preference' && /回答|回复|沟通|语气|先说结论/.test(text))
    return '沟通偏好';
  if (/身高|体重|年龄|出生|职业|居住/.test(text)) return '个人资料';
  if (/饮食|运动|睡眠|作息|喝|吃|上午|下午|晚上|每周|习惯/.test(text))
    return '生活习惯';
  if (memory.kind === 'preference') return '兴趣偏好';
  return '其他';
}

export function memorySource(source: string): {
  label: string;
  date?: string;
  quote?: string;
  conversationId?: string;
} {
  const [header, ...rest] = source.split(/\r?\n/);
  const quote = rest
    .join('\n')
    .replace(/^你的原话[：:]\s*/, '')
    .trim();
  if (/^用户通过\s*Agent/.test(header)) return { label: '来自对话中的记录' };
  const id =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(
      header,
    )?.[0];
  const date = /\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/.exec(
    header,
  )?.[0];
  if (/^对话(?:\s|·)/.test(header))
    return {
      label: '来自对话',
      date,
      quote: quote || undefined,
      conversationId: id,
    };
  // Never display UUIDs or machine timestamps, including in legacy/imported labels.
  const label = header
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/g, '')
    .trim();
  return {
    label: label.slice(0, 80) || '你主动添加',
    quote: quote || undefined,
  };
}

import type { Memory, MemoryKind } from '../../domain/types';
import type { IconName } from '../../ui/visuals';

/** Presentation labels describe saved text; they never generate new personal facts. */
export function describeMemory(memory: Memory): {
  label: string;
  icon: IconName;
  effect: string;
} {
  const text = `${memory.title} ${memory.content}`;
  if (memory.kind === 'project') {
    return {
      label: '最近在忙',
      icon: 'file',
      effect: '聊到相关项目时，可以少解释一遍背景。',
    };
  }
  if (/回答|回复|结论|要点|沟通|语气/.test(text)) {
    return {
      label: '喜欢的沟通方式',
      icon: 'compose',
      effect: '相关回答可以参考你希望的表达方式。',
    };
  }
  if (
    /上午|下午|晚上|早晨|作息|专注|工作节奏|每周|周[一二三四五六日天]/.test(
      text,
    )
  ) {
    return {
      label: '适合你的节奏',
      icon: 'today',
      effect: '讨论时间安排时，可以参考你的习惯和固定安排。',
    };
  }
  if (memory.kind === 'person') {
    return {
      label: '重要的人',
      icon: 'memory',
      effect: '聊到这个人时，可以参考你已经说明的背景。',
    };
  }
  if (memory.kind === 'goal') {
    return {
      label: '想做到的事',
      icon: 'sparkles',
      effect: '讨论下一步时，可以参考你想达到的目标。',
    };
  }
  return {
    label: memory.kind === 'preference' ? '你的偏好' : '你告诉我的事',
    icon: 'memory',
    effect: '在相关回答和建议中，供助手参考。',
  };
}

export function selectMemoryHighlights(items: readonly Memory[]): Memory[] {
  const selected: Memory[] = [];
  const labels = new Set<string>();
  // Prefer different aspects of the user, while preserving recency within each.
  const ordered = [...items].sort((a, b) => {
    const left = Date.parse(a.updated_at);
    const right = Date.parse(b.updated_at);
    return Number.isFinite(left) && Number.isFinite(right) ? right - left : 0;
  });
  for (const memory of ordered) {
    const label = describeMemory(memory).label;
    if (!labels.has(label)) {
      selected.push(memory);
      labels.add(label);
    }
    if (selected.length === 3) return selected;
  }
  for (const memory of ordered) {
    if (!selected.some(item => item.id === memory.id)) selected.push(memory);
    if (selected.length === 3) break;
  }
  return selected;
}

export function suggestedMemoryKind(text: string): MemoryKind {
  // A conservative default for the existing API, rather than asking users to file notes.
  if (/我(?:更|不)?喜欢|偏好|习惯|回答|回复|结论/.test(text))
    return 'preference';
  if (/正在(?:做|开发)|项目|产品开发/.test(text)) return 'project';
  if (/我的目标|目标是|希望学会/.test(text)) return 'goal';
  return 'fact';
}

export const memoryTryPrompt =
  '请先检索我已保存的相关记忆，再帮我安排明天。结合已记录的工作重点、习惯和固定安排给出简短建议；说明参考了哪几条记忆，没有记录的信息不要猜测。先给我建议，不要创建事项、计划或新记忆。';

export const memoryReviewPrompt =
  '请从你能检索到的我过去的对话中，找出值得长期记住的偏好、背景或固定安排。逐条列出候选内容和可追溯的对话来源，跳过已保存的重复记忆；如果无法检索对话，请直接说明并让我选择原文。先让我确认，不要保存、修改或删除任何记忆。';

/** Public tool operations only; never render model reasoning or raw tool arguments. */
export type ChatActivity = {
  id: string;
  tool: string;
  label: string;
  detail: string;
  state: 'running' | 'complete' | 'failed' | 'interrupted';
};

const titles: Record<string, string> = {
  web_search: '搜索网页', web_fetch: '读取网页',
  research_plan: '整理调查清单', research_review: '核对来源与缺口',
};
const clean = (value: unknown, limit: number) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';

export function updateActivity(previous: readonly ChatActivity[] | undefined,
  body: Record<string, any>, sequence: number, end: boolean): ChatActivity[] {
  const items = previous ?? [];
  const tool = clean(body.tool, 80);
  const id = clean(body.tool_call_id, 160) || `event-${sequence}`;
  const existing = items.find(item => item.id === id);
  const metadata = body.activity;
  let detail = '';
  if (tool === 'web_search') detail = clean(metadata?.query, 128);
  if (tool === 'web_fetch') {
    // The server sends only a public origin/path. Older servers safely fall back to a label.
    const value = clean(metadata?.url, 1000);
    if (/^https?:\/\/[^\s@?#]+$/i.test(value)) detail = value;
  }
  const item: ChatActivity = { id, tool, label: titles[tool] ?? '使用工具',
    detail: detail || existing?.detail || '',
    state: end ? body.is_error === true ? 'failed' : 'complete' : 'running' };
  return [...items.filter(value => value.id !== id), item].slice(-24);
}

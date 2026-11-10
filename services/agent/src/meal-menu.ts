const MAX_CHARS = 1024 * 1024;
const MAX_CANDIDATES = 48;
type ObjectValue = Record<string, unknown>;
type Entry = { code: string; name: string; currentPrice?: string | number; originalPrice?: string | number;
  discountType?: string; withOrder?: ObjectValue; categories: string[] };
type MenuProjection = { status: 'completed'; result: { structuredContent: { success: true; data: {
  items: Entry[]; source_menu_count?: number; partial: boolean; recovered_from_json_prefix: boolean; usage_note: string;
} } } };

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}
function shortText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined;
}
function money(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return value;
}
function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Walk direct object members. For an incomplete member we retain its start so
// that a caller can descend into the expected data.meals path, never read it as
// a complete item. Escaped strings and arbitrary nesting inside a row are skipped.
function* members(text: string, start: number): Generator<{ key: string; start: number; end?: number }> {
  const space = (at: number) => { while (/\s/u.test(text[at] ?? '')) at++; return at; };
  const stringEnd = (at: number) => {
    while (++at < text.length) {
      if (text[at] === '\\') at++;
      else if (text[at] === '"') return at + 1;
    }
    return -1;
  };
  let at = space(start);
  if (text[at++] !== '{') return;
  for (;;) {
    at = space(at);
    if (text[at] !== '"') return;
    const end = stringEnd(at);
    if (end < 0) return;
    const key = parse(text.slice(at, end));
    at = space(end);
    if (typeof key !== 'string' || text[at++] !== ':') return;
    const valueStart = at = space(at);
    const stack: string[] = [];
    let boundary = false;
    for (; at < text.length; at++) {
      const char = text[at];
      if (char === '"') {
        const end = stringEnd(at);
        if (end < 0) break;
        at = end - 1;
      } else if (char === '{' || char === '[') {
        if (stack.length >= 128) break;
        stack.push(char === '{' ? '}' : ']');
      } else if (!stack.length && (char === ',' || char === '}')) {
        boundary = true; break;
      } else if (char === '}' || char === ']') {
        if (stack.pop() !== char) break;
        if (!stack.length && space(at + 1) === text.length) { at++; boundary = true; break; }
      }
    }
    yield { key, start: valueStart, ...(boundary ? { end: at } : {}) };
    if (!boundary || text[at++] !== ',') return;
  }
}

function menuPrefix(text: string): ObjectValue | undefined {
  // The response must establish success before a partial catalogue is usable.
  let success = false;
  for (const field of members(text, 0)) {
    if (field.key === 'success' && field.end !== undefined) success = parse(text.slice(field.start, field.end)) === true;
    if (field.key !== 'data' || !success) continue;
    for (const data of members(text, field.start)) {
      if (data.key !== 'meals') continue;
      const rows: ObjectValue = Object.create(null);
      for (const row of members(text, data.start)) {
        if (row.end === undefined) break;
        if (/^\d{1,24}$/.test(row.key)) rows[row.key] = parse(text.slice(row.start, row.end));
      }
      return { meals: rows };
    }
  }
}

export function isMealTool(name: string, args: unknown, tool: string): boolean {
  const call = object(args);
  return name === 'call_mcp_tool' && call?.provider === 'mcdonalds' && call.tool === tool;
}

/** Project McDonald's MCP data.meals dictionary, whose keys are the real product codes. */
export function projectMealMenu(value: unknown): MenuProjection | undefined {
  const envelope = object(value);
  const result = object(envelope?.result);
  if (!result || envelope?.status !== 'completed' || result.isError === true) return;
  const candidates = [result.structuredContent, ...(Array.isArray(result.content)
    ? result.content.flatMap(part => object(part)?.type === 'text' ? [object(part)?.text] : []) : [])];
  let best: { entries: Entry[]; recovered: boolean } | undefined;
  for (const payload of candidates.slice(0, 8)) {
    const text = typeof payload === 'string' ? payload.slice(0, MAX_CHARS) : undefined;
    const doc = object(text !== undefined ? parse(text) : payload);
    if (doc?.success === false) continue;
    const data = doc ? object(doc.data) : text ? menuPrefix(text) : undefined;
    const meals = object(data?.meals);
    if (!meals) continue;
    const categories = new Map<string, string[]>();
    for (const raw of Array.isArray(data?.categories) ? data.categories : []) {
      const category = object(raw), name = shortText(category?.name, 48);
      if (!name || !Array.isArray(category?.meals)) continue;
      for (const item of category.meals) {
        const code = shortText(object(item)?.code, 48);
        if (!code || !Object.hasOwn(meals, code)) continue;
        const current = categories.get(code) ?? [];
        if (current.length < 3 && !current.includes(name)) categories.set(code, [...current, name]);
      }
    }
    const entries = Object.entries(meals).flatMap(([code, raw]): Entry[] => {
      const meal = object(raw), name = shortText(meal?.name, 100);
      if (!name || !/^[\w-]{1,48}$/u.test(code)) return [];
      const withOrder = object(meal?.withOrder);
      const card = Object.fromEntries(['cardId', 'cardType', 'membershipCode', 'specId'].flatMap(key => {
        const item = shortText(withOrder?.[key], 60);
        return item ? [[key, item]] : [];
      }));
      return [{ code, name, currentPrice: money(meal?.currentPrice), originalPrice: money(meal?.originalPrice),
        discountType: shortText(meal?.discountType, 48), ...(Object.keys(card).length ? { withOrder: card } : {}),
        categories: categories.get(code) ?? [] }];
    });
    if (!best || (doc && entries.length) || entries.length > best.entries.length) best = { entries, recovered: !doc };
    if (doc && entries.length) break;
  }
  if (!best) return;
  const rank = (item: Entry) => /双人|两人|2人|分享|欢乐餐/u.test(item.name) ? 0 :
    /套餐|组合/u.test(item.name) ? 1 : /汉堡|麦乐鸡|麦辣|麦香|巨无霸|鸡腿|薯条|可乐/u.test(item.name) ? 2 : 3;
  const ranked = best.entries.sort((a, b) => rank(a) - rank(b));
  const priority = ranked.filter(item => rank(item) <= 1).slice(0, 32);
  const picked = new Set(priority);
  const items = [...priority, ...ranked.filter(item => rank(item) > 1).slice(0, 12)];
  for (const item of items) picked.add(item);
  items.push(...ranked.filter(item => !picked.has(item)).slice(0, MAX_CANDIDATES - items.length));
  return { status: 'completed', result: { structuredContent: { success: true, data: { items,
    source_menu_count: best.recovered ? undefined : ranked.length,
    partial: best.recovered || ranked.length > items.length,
    recovered_from_json_prefix: best.recovered,
    usage_note: 'code 是真实餐品编码。currentPrice 是门店菜单参考价（元），可能附带优惠条件；查详情后使用 calculate-price 核实应付金额。partial 表示只看到菜单的一部分。' } } } };
}

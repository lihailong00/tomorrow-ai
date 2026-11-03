import type { ChatClientContext, ChatLocationContext } from '../../domain/types';

export const DEVICE_LOCATION_TTL = 5 * 60 * 1000;
export const MANUAL_LOCATION_TTL = 24 * 60 * 60 * 1000;

export function validLocation(value: ChatLocationContext | null | undefined, now = Date.now()): value is ChatLocationContext {
  if (!value) return false;
  const observed = Date.parse(value.observed_at);
  if (!Number.isFinite(observed) || observed > now || now - observed >
    (value.source === 'manual' ? MANUAL_LOCATION_TTL : DEVICE_LOCATION_TTL)) return false;
  if (value.source === 'manual') return typeof value.label === 'string' && value.label.trim().length > 0 &&
    Array.from(value.label).length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value.label);
  return value.source === 'device' && typeof value.latitude === 'number' && Number.isFinite(value.latitude) &&
    Math.abs(value.latitude) <= 90 && typeof value.longitude === 'number' && Number.isFinite(value.longitude) &&
    Math.abs(value.longitude) <= 180 && typeof value.accuracy_m === 'number' && Number.isFinite(value.accuracy_m) &&
    value.accuracy_m >= 0 && value.coordinate_system === 'wgs84';
}

export function deviceTimezone(fallback?: string): string {
  const valid = (value?: string) => {
    if (!value || value.length > 100) return false;
    try { return Boolean(new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone); }
    catch { return false; }
  };
  let current: string | undefined;
  try { current = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* older OS Intl */ }
  return valid(current) ? current! : valid(fallback) ? fallback! : 'UTC';
}

/** Only requests that depend on the user's physical position need a fix. */
export function needsCurrentLocation(text: string, previous: readonly { role: string; content: string }[] = []): boolean {
  const placeDependent = /打车|叫车|出发|上车|路线|导航|怎么走|多远|公里|车程|路程|停车|公交|地铁|酒店|餐厅|饭店|咖啡|超市|医院|药店|天气|气温|下雨|降温|刮风|美食|景点|运动场|好玩|去处|公园|商场|门店|店铺|套餐|外卖|外送|配送/u;
  // Technical work can quote location words without asking to reveal a fix.
  // Merely mentioning an API/MCP is allowed for an actual nearby lookup.
  const technical = (value: string) => /(?:写|编写|实现|重构|调试|修复|解释|讲解|分析|检查|设计|测试|优化|生成|修改).*(?:代码|函数|API|接口|类型|SDK|Rust|TypeScript|JavaScript|Python|SQL|JSON|MCP|程序)|(?:代码|函数|接口|API|SDK|Rust|TypeScript|JavaScript|Python|SQL|JSON).*(?:类型|报错|函数|算法|怎么写|怎样写|如何实现|实现方式|源码)|(?:计算|价格|类型|回调|接口|数据|定位|获取).{0,12}函数/iu.test(value) ||
    /\b(?:write|implement|debug|explain|refactor|generate).{0,60}\b(?:code|function|api|interface|type|sdk)\b/i.test(value);
  const local = (value: string) => {
    if (technical(value)) return false;
    if (/\b(?:near me|my (?:current )?location|from here|around me)\b/i.test(value) ||
      /当前位置|当前所在|(?:我|我们)(?:现在|当前)?的?(?:位置|地址|定位)|我所在的位置|我(?:现在)?在哪|从我(?:这个|这|这里|这儿|这边)(?:位置|里|儿|边)?(?:出发|到|去|打车|走|骑|开车)/u.test(value)) return true;
    if (/我(?:这里|这儿|这边|所在|这个位置)|身边|我附近/u.test(value) && placeDependent.test(value)) return true;
    // Anchor the relative place. A supplied place such as “苏州附近” is already
    // an origin; generic meal/pricing questions never imply device location.
    return /^(?:请|麻烦)?(?:你)?(?:帮我|给我|帮我们|我想|我想要|我想找|有没有|有什么)?(?:找|查|推荐|看看|搜|搜索)?(?:一下)?(?:我|我们)?(?:附近|周边)/u.test(value) && placeDependent.test(value);
  };
  const followUp = (value: string, prior: string) => {
    if (technical(value)) return false;
    const compact = value.replace(/[\s，,。.!！?？、：:；;]/gu, '');
    if (/^(?:那你|那就|那|就|还是|继续|帮我|请)?(?:现在|现在出发|多少钱|要多少钱|价格呢|费用呢|附近呢|周边呢|那附近呢|那边呢|这边呢|这家(?:店)?(?:吧|呢|到店吃|到店|外送|配送|的套餐多少钱)?|那家(?:店)?(?:吧|呢|到店吃|到店|外送|配送)?|换一家(?:附近的)?|查一下外送范围)$/u.test(compact)) return true;
    if (/^(?:那你|那就|继续|帮我|请)?(?:再)?(?:用|调用|通过)(?:它的|这家的|刚才的)?(?:MCP|工具|服务)(?:服务|工具)?(?:来)?(?:查一下|查询一下|搜索一下|查查|查|查询|搜索)(?:附近|周边)?(?:门店|套餐|价格|外送范围)?(?:吧|呢)?$/iu.test(compact)) return true;
    const complaint = /^你不是可以调用(.{1,30}?)的工具吗[？?]为什么你?(?:调用|用)(?:网页)?搜索(?:却|而)?不调用(?:它|这家)的MCP服务呢?[？?。！!]*$/iu.exec(value);
    return Boolean(complaint && prior.includes(complaint[1]));
  };
  let value = text.trim();
  if (local(value)) return true;
  if (technical(value)) return false;
  // Trace at most four real user turns. A new topic/place breaks the chain;
  // assistant text cannot grant permission to reuse a user's coordinates.
  let turns = 0;
  for (let index = previous.length - 1; index >= 0 && turns < 4; index--) {
    const message = previous[index];
    if (message.role !== 'user') continue;
    turns++;
    if (!followUp(value, message.content)) return false;
    value = message.content.trim();
    if (local(value)) return true;
    if (technical(value)) return false;
  }
  return false;
}

export function captureClientContext(location?: ChatLocationContext | null, fallbackTimezone?: string): ChatClientContext {
  const selected = validLocation(location) ? Object.freeze({ ...location }) : undefined;
  return Object.freeze({ timezone: deviceTimezone(fallbackTimezone), ...(selected ? { location: selected } : {}) });
}

export function locationCaption(location?: ChatLocationContext | null, approximate = false, cached = false): string {
  if (!validLocation(location)) return '位置 · 未设置';
  if (location.source === 'manual') return `手动 · ${location.label}`;
  const accuracy = Math.max(1, Math.round(location.accuracy_m!));
  return `${cached ? '上次' : ''}${approximate || accuracy > 200 ? '大概位置' : '自动定位'} · 约${accuracy >= 1000 ? `${(accuracy / 1000).toFixed(1)}公里` : `${accuracy}米`}`;
}

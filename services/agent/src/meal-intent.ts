type Turn = { role: string; content: string };
const brand = /麦当劳|麦麦|mcdonalds?/iu;
const meal = /套餐|菜单|点餐|两人|两个人吃|双人|吃什么|吃点啥|推荐|价格|多少钱|实付|预算/u;

/** A short recommendation follow-up inherits the last actual user's meal goal. */
export function mealQuoteIntent(messages: readonly Turn[]): boolean {
  const user = messages.filter(item => item.role === 'user').slice(-4).map(item => item.content.trim());
  const last = user.pop() ?? '';
  if (/^(?:请|帮我)?(?:写|实现|调试|修复|解释|测试|重构).{0,40}(?:代码|函数|接口|API|MCP|程序|JSON)/iu.test(last)) return false;
  if (brand.test(last) && meal.test(last)) return true;
  if (!/直接.{0,8}推荐|不知道选|两个人吃|继续.{0,8}(?:查价|推荐)|(?:推荐|查价)(?:一下|吧|呢)?[？?。！!]*$/u.test(last)) return false;
  for (const prior of user.reverse()) {
    if (brand.test(prior) && meal.test(prior)) return true;
    if (!/我(?:现在)?在哪|我(?:现在|当前)的?位置|不知道选|两个人吃/u.test(prior)) break;
  }
  return false;
}

export const MEAL_QUOTE_INSTRUCTION = '\n本轮是查麦当劳餐品和核价；如果用户说「你直接推荐」，继续刚才的任务。先用本轮已验证位置或用户明确给出的地点找最近营业门店；不要拿城市、时区、IP、旧回复或收藏猜当前门店。位置缺失且必须查门店时直接调用 request_location 卡片。地点已知就按到店自取、常规搭配先查，除非用户已指定外送、口味、忌口或预算。先从菜单选实际可用的商品编号；没有双人套餐可自己挑两份主餐组合。优先核价1～3个可行组合，使用真实商品编号、默认规格，按需读取详情；就算菜单只恢复一部分也继续给出可验证的推荐。选项、预算和餐品偏好没有指定时，不需要问用户来替你选。只查询，不领券、下单或付款。';

/** Finite public operation codes. Never persist raw arguments, queries or addresses. */
const PROVIDERS = new Set(['amap','baidu_maps','didi','liepin','fliggy','dida365','jianguoyun','weread','weiyun','luckin','qq_music','ima','mcdonalds','tencent_docs','yuque','notion','memos','tencent_meeting','feishu','baidu_netdisk','yinxiang']);
export function toolActivity(name: string, args: unknown): { provider?: string; operation?: string } {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string,unknown> : {};
  const provider = typeof input.provider === 'string' && PROVIDERS.has(input.provider) ? input.provider : undefined;
  if (!provider) return {};
  if (name === 'list_mcp_tools') return { provider, operation: 'discover' };
  if (name === 'read_integration' && provider === 'amap' && (input.query as { operation?: unknown } | undefined)?.operation === 'nearby') return { provider, operation: 'nearby' };
  if (name !== 'call_mcp_tool' && name !== 'read_integration' && name !== 'prepare_personal_tool') return {};
  // Inspect only the tool identifier; no model-written title can become a UI label.
  const tool = typeof input.tool === 'string' ? input.tool.toLowerCase().slice(0,160) : '';
  if (provider === 'tencent_docs' && name === 'call_mcp_tool' && ['search_documents','read_document'].includes(tool)) {
    return { provider, operation: tool };
  }
  const operation = /estimate|quote|taxi.*price|fare/.test(tool) ? 'estimate' :
    /regeo|geocod|maps_geo/.test(tool) ? 'geocode' :
    /direction|route/.test(tool) ? 'route' :
    /nearby|around/.test(tool) ? 'nearby' :
    /calculate.*price|price.*calculat/.test(tool) ? 'price' :
    /menu|meal/.test(tool) ? 'menu' :
    /coupon|discount|promotion/.test(tool) ? 'offers' :
    /flight/.test(tool) ? 'flights' : /hotel/.test(tool) ? 'hotels' : 'execute';
  return { provider, operation };
}

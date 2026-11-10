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
  get_current_time: '查看当前时间',
  request_location: '询问出发位置',
  ask_user_choice: '请你选择',
  inspect_app_permissions: '请求检查手机应用权限',
  list_integrations: '查看已连接的应用',
  list_mcp_connections: '查看已授权的应用服务',
  list_mcp_tools: '查找应用可用的工具',
  search_tools: '查找适合本次问题的工具',
  call_mcp_tool: '调用已授权的应用工具',
  get_mcp_action: '核对应用操作状态',
  read_integration: '读取已授权的应用资料',
  list_memories: '查找相关记忆', search_memories: '查找相关记忆',
  get_memory: '读取记忆内容', save_memory: '保存记忆',
  update_memory: '修改记忆', delete_memory: '删除记忆',
  search_knowledge_graph: '查找记忆中的关联信息',
  index_memory_graph: '整理记忆中的关联信息',
  list_tasks: '查看任务列表', get_task: '读取任务详情',
  create_task: '创建待确认的任务', cancel_task: '取消任务',
  list_schedules: '查看计划安排', get_schedule: '读取计划详情',
  create_schedule: '创建计划草稿', pause_schedule: '暂停计划',
  read_attachment: '读取上传的附件', read_upload: '读取上传的附件',
  search_imports: '查找已导入的资料',
  search_ai_history: '查找历史对话', read_ai_history: '读取历史对话',
  alipay_wallet_status: '查看支付宝连接状态',
  prepare_alipay_payment: '准备待确认的付款请求',
  get_alipay_payment: '核对付款状态',
  list_alipay_transactions: '查看通过妥啦发起的交易',
};
const services: Record<string, string> = {
  amap: '高德地图', baidu_maps: '百度地图', didi: '滴滴出行', liepin: '猎聘',
  fliggy: '飞猪', dida365: '滴答清单', jianguoyun: '坚果云',
  weread: '微信读书', weiyun: '腾讯微云', luckin: '瑞幸咖啡',
  qq_music: 'QQ 音乐', ima: 'ima', mcdonalds: '麦当劳',
  tencent_docs: '腾讯文档', yuque: '语雀', notion: 'Notion',
  memos: 'Memos', tencent_meeting: '腾讯会议', feishu: '飞书',
  baidu_netdisk: '百度网盘', yinxiang: '印象笔记',
};
const clean = (value: unknown, limit: number) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';

/** Describe only the tool actually named by the event, never infer a service from the user's question. */
export function toolActivityLabel(value: unknown, activity?: unknown): string {
  const tool = clean(value, 80);
  const meta = activity && typeof activity === 'object' ? activity as Record<string, unknown> : {};
  const provider = typeof meta.provider === 'string' && Object.prototype.hasOwnProperty.call(services, meta.provider) ? services[meta.provider] : '';
  const operations: Record<string, string> = { estimate: '查询打车预估价', geocode: '定位地址', route: '查询路线', nearby: '查找附近地点', price: '核算价格', menu: '查看菜单', offers: '查询优惠', flights: '查询航班', hotels: '查询酒店', execute: '调用应用工具' };
  if (provider && (tool === 'list_mcp_tools' && meta.operation === 'discover')) return `查找${provider}可用的工具`;
  if (provider && (['call_mcp_tool', 'read_integration'].includes(tool) || tool.startsWith('mcp_')) && typeof meta.operation === 'string' && Object.prototype.hasOwnProperty.call(operations, meta.operation)) return `${provider} · ${operations[meta.operation]}`;
  if (Object.prototype.hasOwnProperty.call(titles, tool)) return titles[tool];
  // Dynamically loaded tools include their provider ID; opaque hashes are not useful UI copy.
  const qualifiedProvider = Object.keys(services).find(id => tool.startsWith(`mcp_${id}_`));
  if (qualifiedProvider) return `调用${services[qualifiedProvider]}工具`;
  // A new tool remains distinguishable without exposing arguments or arbitrary event content.
  return /^[a-z][a-z0-9_.:-]{0,79}$/i.test(tool)
    ? `调用工具 · ${tool.slice(0, 48)}` : '调用未识别的工具';
}

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
  const hasOperation = metadata && typeof metadata.operation === 'string';
  const item: ChatActivity = { id, tool, label: end && !hasOperation && existing ? existing.label : toolActivityLabel(tool, metadata),
    detail: detail || existing?.detail || '',
    state: end ? body.is_error === true ? 'failed' : 'complete' : 'running' };
  // Completion order may differ for parallel tools. Keep the original start order.
  return (existing ? items.map(value => value.id === id ? item : value) : [...items, item]).slice(-24);
}

/** Merge adjacent identical terminal operations without hiding failures or active calls. */
export function groupedActivities(items: readonly ChatActivity[]): (ChatActivity & { count: number })[] {
  const groups: (ChatActivity & { count: number })[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && item.state === 'complete' && last.state === item.state && last.tool === item.tool && last.label === item.label && last.detail === item.detail) last.count++;
    else groups.push({ ...item, count: 1 });
  }
  return groups;
}

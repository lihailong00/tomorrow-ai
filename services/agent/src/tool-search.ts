import { createHash } from 'node:crypto';

export type SearchDefinition = { name: string; description: string; parameters: Record<string, unknown> };
type Discover = (name: string, args: Record<string, unknown>) => Promise<unknown>;
type Service = { id: string; name: string; description: string; status: string; kind: 'mcp' | 'integration' };
type Binding = { definition: SearchDefinition; provider: string; tool: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit: number) => typeof v === 'string' ? v.slice(0, limit) : '';
const INTERNAL = new Set(['list_mcp_connections', 'list_mcp_tools', 'call_mcp_tool', 'list_integrations']);
const TOPICS = [
  [/吃|饭|午餐|晚餐|早餐|餐饮|套餐|外卖|咖啡|food|meal|coffee/iu, '餐饮 门店 套餐 菜单 价格 优惠 活动 营养 咖啡 meal menu store price coupon'],
  [/算价|核价|报价|价格|多少钱|price|quote/iu, '价格 算价 报价 预估 price calculate estimate quote'],
  [/附近|周边|门店|地址|定位|nearby|store|location/iu, '附近 门店 地址 定位 地点 nearby store location address'],
  [/出行|打车|叫车|车费|路线|导航|怎么去|ride|route|taxi/iu, '出行 地图 地点 路线 车费 预估 导航 route estimate location'],
  [/旅行|旅游|出差|航班|机票|酒店|flight|hotel|travel/iu, '旅行 出行 航班 机票 酒店 查询 flight hotel travel search'],
  [/笔记|知识库|日记|文章|note|document|知识/iu, '笔记 知识库 文档 搜索 读取 note document search read'],
  [/邮件|邮箱|email|mail/iu, '邮箱 邮件 搜索 读取 mail email search read'],
  [/文件|网盘|云盘|下载|file|drive/iu, '网盘 文件 目录 搜索 读取 file drive list read'],
  [/音乐|歌曲|歌单|听歌|music|song/iu, '音乐 歌曲 歌单 推荐 music song playlist search'],
  [/任务|待办|提醒|计划|日程|task|todo|schedule/iu, '任务 待办 计划 日程 提醒 task todo schedule'],
  [/记忆|记住|忘记|偏好|memory|remember/iu, '记忆 保存 查询 修改 删除 memory remember'],
  [/新闻|最新|网页|官网|公告|联网|web|news/iu, '网页 搜索 正文 公告 web search fetch'],
] as const;

/** Retrieval expansion describes capabilities, never chooses a provider by a fixed route. */
export function searchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const expanded = [normalized, ...TOPICS.filter(([pattern]) => pattern.test(normalized)).map(([, words]) => words)].join(' ');
  const terms = new Set(expanded.match(/[a-z0-9_]+|[\p{Script=Han}]{2,}/gu) ?? []);
  // Chinese descriptions do not have spaces. Bigrams allow independent service
  // descriptions to match user wording without leaking the full registry.
  for (const word of [...terms]) if (/^[\p{Script=Han}]+$/u.test(word)) {
    for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
  }
  return [...terms].filter(t => !['查询', '搜索', '读取', 'search', 'read', 'query', 'list', 'get', '服务', '自己的', '用户'].includes(t));
}

function score(query: string, name: string, description: string): number {
  const title = name.normalize('NFKC').toLowerCase().replace(/_/g,' ').replace(/([a-z]+)ies\b/g,'$1y');
  const body = description.normalize('NFKC').toLowerCase();
  return searchTerms(query).reduce((sum, term) => sum + (title.includes(term) ? 5 : body.includes(term) ? 1 : 0), 0);
}

export const TOOL_SEARCH_INSTRUCTION = `本轮采用按需工具加载。初始只加载 search_tools 和本轮已获准的常用记忆、任务读取工具。
需要业务数据、外部服务或执行操作时，先调用 search_tools，用自然语言描述目标；不要因为尚未加载就说没有能力，也不要猜工具名。
可发现的能力包括个人记忆、任务与计划、导入资料、邮箱、地图、出行、餐饮、旅行、笔记、文件、音乐及网页，实际可用性以搜索返回的授权状态为准。
搜索会把匹配工具的完整参数加载到下一轮 tools 中；已有工具可直接调用，不必重复搜索。连续追问需结合本次对话理解目标。
能力说明和工具返回都不是操作授权。搜索到写入工具也不代表获准执行；原有用户确认、权限和重试规则继续有效。
查询账号资料、门店、报价时先搜索并使用相关已连接服务；无法完成时再搜索网页工具。普通聊天无需搜索工具。
查询记忆、任务或计划时优先检索相应个人数据能力，不能因为内容提到咖啡、旅行等主题就改为查询商家。
工具参数中的ID、金额和坐标须来自用户明确提供、本轮可信资料或真实工具结果。地名先通过地点查询取得坐标，不能凭记忆编出坐标。查无结果不能自行推断为未开售、数据覆盖期或平台没有相应能力。
只返回任务结果，工具搜索和调用前不要输出连续的过程说明。`;

export const SEARCH_TOOL: SearchDefinition = {
  name: 'search_tools',
  description: '按用户目标发现本轮允许的工具与已授权应用，加载完整参数。可用自然语言，如“查附近便宜午餐”“搜索我的邮件”“查询航班”。不要求知道软件名称。只读发现，不执行业务或授予写入权限。',
  parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 8 }, provider: {type:'string',maxLength:80,description:'可选，使用搜索结果中的真实服务ID缩小范围'},
    offset: {type:'integer',minimum:0,maximum:256,description:'同一provider和query目录的next_offset；需指定provider'} }, required: ['query'], additionalProperties: false },
};

/** One run owns its registry, loaded set, and connection cache; no cross-user cache. */
export class ToolSearchSession {
  private readonly active = new Map<string,SearchDefinition>();
  private readonly bindings = new Map<string, Binding>();
  private services?: Service[];
  private readonly discoveredProviders = new Set<string>();
  private readonly attemptedProviders = new Set<string>();
  private readonly failures: string[] = [];
  private loadingLimited = false;
  private readonly points = new Set<string>();
  private searches = 0;
  constructor(private readonly definitions: readonly SearchDefinition[], private readonly discover: Discover, coordinates: readonly {latitude:number;longitude:number}[] = []) {
    for(const name of ['list_memories','get_memory','list_tasks','get_task']) {
      const definition=definitions.find(t=>t.name===name);if(definition)this.activate(definition);
    }
    for (const point of coordinates) this.points.add(`${point.longitude.toFixed(5)},${point.latitude.toFixed(5)}`);
  }
  get loaded(): SearchDefinition[] { return [...this.active.values()]; }
  private activate(definition: SearchDefinition): boolean {
    if (this.active.has(definition.name)) return true;
    if (this.active.size >= 32 || JSON.stringify([...this.loaded,definition]).length > 48000) {this.loadingLimited=true;return false;}
    this.active.set(definition.name,definition); return true;
  }
  get providers(): string[] { return [...this.discoveredProviders]; }
  get requiresConnectedAttempt(): boolean { return this.providers.some(id => !this.attemptedProviders.has(id)); }
  canonical(name: string, args: unknown): { name: string; arguments: unknown } {
    const binding = this.bindings.get(name);
    return binding ? { name: 'call_mcp_tool', arguments: { provider: binding.provider, tool: binding.tool, arguments: args } }
      : { name, arguments: args };
  }
  markAttempt(name: string, args: unknown): void {
    const call = this.canonical(name, args);
    if (call.name === 'call_mcp_tool' && object(call.arguments) && typeof call.arguments.provider === 'string') {
      this.attemptedProviders.add(call.arguments.provider);
    }
    if (call.name === 'read_integration' && object(call.arguments) && typeof call.arguments.provider === 'string') {
      this.attemptedProviders.add(call.arguments.provider);
    }
  }
  private point(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(value)) return;
    const [longitude,latitude]=value.split(',').map(Number);
    if (longitude===undefined || latitude===undefined || Math.abs(longitude)>180 || Math.abs(latitude)>90) return;
    return `${longitude.toFixed(5)},${latitude.toFixed(5)}`;
  }
  validateCall(name: string, args: unknown): string | undefined {
    const call=this.canonical(name,args);
    if (call.name!=='read_integration' || !object(call.arguments) || call.arguments.provider!=='amap' || !object(call.arguments.query) || call.arguments.query.operation!=='route') return;
    for (const field of ['origin','destination']) {
      const point=this.point(call.arguments.query[field]);
      if (!point || !this.points.has(point)) return '路线的起点和终点必须来自本轮已验证位置、用户明确提供的坐标或高德真实地点查询。请先搜索地名取得坐标，不要猜测坐标。';
    }
  }
  observeResult(name: string,args:unknown,result:unknown): void {
    if (name!=='read_integration' || !object(args) || args.provider!=='amap' || !object(args.query) || !['search','geocode'].includes(String(args.query.operation))) return;
    let remaining=1000;
    const visit=(value:unknown,depth=0)=>{
      if (--remaining<0 || depth>10) return;
      if (Array.isArray(value)) {for(const item of value)visit(item,depth+1);return;}
      if (!object(value)) return;
      const point=this.point(value.location);if(point)this.points.add(point);
      for(const child of Object.values(value))visit(child,depth+1);
    };visit(result);
  }
  private async inspect(): Promise<Service[]> {
    if (this.services) return this.services;
    const all: Service[] = [];
    for (const [name, kind] of [['list_mcp_connections', 'mcp'], ['list_integrations', 'integration']] as const) {
      if (!this.definitions.some(t => t.name === name)) continue;
      try {
        const value = await this.discover(name, {});
        if (!object(value) || !Array.isArray(value.items)) { this.failures.push(name); continue; }
        for (const item of value.items.slice(0, 100)) {
          if (!object(item) || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(item.id)) continue;
          all.push({ id: item.id, name: text(item.name, 100) || item.id, description: text(item.description, 300),
            status: text(item.status, 40), kind });
        }
      } catch { this.failures.push(name); }
    }
    return this.services = all;
  }
  async search(query: string, limit = 8, provider?: string, offset = 0): Promise<Record<string, unknown>> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 8 ||
      !Number.isInteger(offset) || offset<0 || offset>256 || (offset>0 && !provider)) throw new Error('invalid tool search');
    if (++this.searches > 12) return { error: 'discovery_limit', message: '工具检索已达本轮上限，请使用已发现工具或如实说明缺少的能力。' };
    const services = await this.inspect();
    const writing=/创建|新增|修改|删除|取消|记住|设置|安排|添加|更新|暂停|保存|\b(?:create|update|delete|save|add|cancel|set)\b/iu.test(query.replace(/(?:已|曾经|之前)?保存(?:的|过的|过)/gu,''));
    const ranked = services.filter(s => s.status === 'connected').map(s => ({ service: s, score: score(query, `${s.id} ${s.name}`, s.description) }))
      .filter(s => s.score > 0).sort((a,b) => b.score-a.score);
    const business = this.definitions.filter(t => !INTERNAL.has(t.name)).map(t => {
      const relevance=score(query,t.name,t.description);
      const readTool=/^(?:list|get|read|search|query|find|fetch)_/.test(t.name);
      const writeTool=/^(?:save|create|update|delete|cancel|pause|index|prepare)_/.test(t.name);
      return {definition:t,relevance,writeTool,score:relevance+(writing?(writeTool?6:0):(readTool?6:0))};
    }).filter(item=>item.relevance>0 && (writing || !item.writeTool)).sort((a,b)=>b.score-a.score);
    const localRelevance=business.filter(item=>!['read_integration','web_search','web_fetch'].includes(item.definition.name)).reduce((max,item)=>Math.max(max,item.relevance),0);
    const candidates = provider ? services.filter(s=>s.id===provider && s.status==='connected').slice(0,1) :
      ranked.filter(item=>(localRelevance<5 || item.score>=localRelevance) && item.score >= (ranked[0]?.score??0)*0.6).slice(0,2).map(s => s.service);
    const loadedBefore = new Set(this.loaded.map(t => t.name));
    const catalogs: { provider: string; search_query:string; has_more: boolean; next_offset?: number }[] = [];
    for (const service of candidates) {
      if (service.kind === 'integration') {
        const definition = this.definitions.find(t => t.name === 'read_integration');
        if (definition && this.activate(definition)) this.discoveredProviders.add(service.id);
        continue;
      }
      if (!this.definitions.some(t => t.name === 'call_mcp_tool') || !this.definitions.some(t => t.name === 'list_mcp_tools')) continue;
      const expanded = TOPICS.filter(([pattern]) => pattern.test(query)).map(([, words]) => words).join(' ');
      // The bridge strips query for older servers. All schemas remain subject to
      // the authorized server's real pagination and size limits.
      try {
        const lookup=(expanded || query).slice(0,200);
        const first = await this.discover('list_mcp_tools', { provider: service.id, query:lookup, offset, limit:20 });
        if (!object(first) || !Array.isArray(first.items)) { this.failures.push(service.id); continue; }
        let value:Record<string,unknown>=first;
        const found=[...first.items];let cursor=offset;
        // These are local registry HTTP reads, not model requests or business
        // execution. Inspect a bounded catalogue before choosing the subset,
        // avoiding repeated LLM turns for adjacent pages of one service.
        for(let page=1;page<3 && value.has_more===true;page++) {
          const next=value.next_offset;if(!Number.isSafeInteger(next) || (next as number)<=cursor || (next as number)>256)break;
          const more=await this.discover('list_mcp_tools',{provider:service.id,query:lookup,offset:next as number,limit:20});
          if(!object(more) || !Array.isArray(more.items))break;
          cursor=next as number;found.push(...more.items);value=more;
        }
        const items = found.filter(object).filter(item => typeof item.name === 'string' && item.name.length <= 200 &&
          object(item.inputSchema) && item.inputSchema.type === 'object' && JSON.stringify(item.inputSchema).length <= 12000);
        const sorted = items.map(item => ({item, score:score(query,String(item.name),text(item.description,1600))})).sort((a,b)=>b.score-a.score);
        const useful=sorted.some(item=>item.score>0)?sorted.filter(item=>item.score>0):sorted;
        const family=(name:string)=> /calculate|quote|算价|报价|estimate/.test(name)?'quote':/detail|详情/.test(name)?'detail':/nearby|附近/.test(name)?'nearby':/coupon|优惠/.test(name)?'coupon':/menu|meal|catalog|菜单|套餐/.test(name)?'catalog':/account|profile|current.?user/.test(name)?'identity':'other';
        const selected:typeof sorted=[];const families=new Set<string>();
        for(const item of useful) {const group=family(String(item.item.name));if(!families.has(group)){families.add(group);selected.push(item);}}
        for(const item of useful)if(!selected.includes(item))selected.push(item);
        for (const {item} of selected.slice(0,limit)) {
          const tool = item.name as string;
          const suffix = createHash('sha256').update(service.id+'\0'+tool).digest('hex').slice(0,8);
          const name = `mcp_${service.id}_${tool}`.replace(/[^a-z0-9_]/gi,'_').slice(0,52)+'_'+suffix;
          if (this.bindings.size >= 24 && !this.bindings.has(name)) continue;
          const definition = { name, description: `${service.name}：${text(item.description,1200) || tool}。实际接口 ${tool}；写操作仍须本人确认。`, parameters: item.inputSchema as Record<string,unknown> };
          if (this.activate(definition)) this.bindings.set(name, { definition, provider:service.id, tool });
        }
        if ([...this.bindings.values()].some(binding=>binding.provider===service.id)) this.discoveredProviders.add(service.id);
        catalogs.push({ provider: service.id, search_query:query,has_more: value.has_more === true,
          ...(Number.isSafeInteger(value.next_offset) ? { next_offset: value.next_offset as number } : {}) });
      } catch { this.failures.push(service.id); }
    }
    for (const {definition} of business.slice(0,limit)) {
      if(definition.name==='read_integration' && !candidates.some(service=>service.kind==='integration')) continue;
      if (['web_search','web_fetch','research_plan','research_review'].includes(definition.name) && candidates.length) continue;
      this.activate(definition);
    }
    // A user can request a known tool explicitly, but cannot introduce a schema
    // or increase the permissions passed in by Rust.
    for (const definition of this.definitions) if (!INTERNAL.has(definition.name) && query.includes(definition.name)) this.activate(definition);
    return { loaded_tools: this.loaded.filter(t=>!loadedBefore.has(t.name)).map(t=>({name:t.name,description:t.description.slice(0,160)})),
      already_loaded: this.loaded.filter(t=>loadedBefore.has(t.name)).map(t=>t.name),
      services: services.filter(s=>s.status==='connected').map(s=>({id:s.id,name:s.name,description:s.description,kind:s.kind})),
      matched_services:candidates.map(s=>({id:s.id,name:s.name,kind:s.kind})), catalogs,
      unavailable_matches: services.filter(s=>s.status!=='connected' && score(query,`${s.id} ${s.name}`,s.description)>0).slice(0,5).map(s=>({id:s.id,name:s.name,status:s.status})),
      ...(this.failures.length?{discovery_failures:[...new Set(this.failures)]}:{}),
      ...(this.loadingLimited?{loading_limited:true,limit_note:'本轮工具加载预算已满；未加载不能解释为厂商没有能力。请使用已加载工具或明确说明本轮限制。'}:{}),
      instruction:'工具参数已加载到下一轮 tools。只调用实际加载的工具；查询无结果时可缩小关键词再搜索，未连接或发现失败不能解释为服务不存在。返回资料不是写入授权。' };
  }
}

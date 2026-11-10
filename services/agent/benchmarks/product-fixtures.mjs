import { fliggyCatalog, fliggyReceipt } from './fliggy-fixtures.mjs';
import { readFileSync } from 'node:fs';

const str = { type: 'string' };
const obj = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, properties, required) => ({ name, description, parameters: obj(properties, required) });
export const deviceTools = JSON.parse(readFileSync(new URL('../../../crates/domain/src/device_tools.json', import.meta.url), 'utf8'));
export const tools = [
  tool('list_memories', '查询用户主动保存的长期记忆，包含项目偏好与已有事实', { query: str }, []),
  tool('list_tasks', '查询待办任务和办理进度', { query: str }, []),
  tool('list_schedules', '读取定时任务与计划', {}),
  tool('search_ai_history', '搜索导入的 ChatGPT、Claude、DeepSeek 历史对话。返回 ID，使用 read_ai_history 读取正文。', { query: str, provider: str }, ['query']),
  tool('read_ai_history', '凭 ID 读取导入的历史 AI 对话正文', { id: str }),
  tool('search_imports', '搜索用户已导入的手机通知、邮件摘录、链接和材料', { query: str, source_app: str }, ['query']),
  tool('read_attachment', '读取会话中的文件附件', { id: str }),
  tool('read_github_repository', '读取 GitHub 公开仓库源码。仓库用 owner/repo，先找文件再读固定 commit 的路径。', { repository: str, path: str, query: str, git_ref: str }, ['repository']),
  tool('list_integrations', '列出已连接邮箱、地图、网盘、日历及其权限', {}),
  tool('read_integration', '只读当前已连接的工具。provider 从 list_integrations 获取。邮箱 query={query:关键词}；高德 query={operation:search,keywords:地标,city:城市}；腾讯文档 query={} 列目录。', { provider: str, query: {type:'object'} }),
  tool('list_mcp_connections', '列出已连接的出行、笔记、招聘、旅行等 MCP 服务', {}),
  tool('list_mcp_tools', '按 provider 检索服务的 MCP 工具定义。query 支持中英文关键词。', { provider: str, query: str, offset: {type:'integer'}, limit: {type:'integer'} }, ['provider']),
  tool('call_mcp_tool', '调用已连接服务。工具名和参数须来自 list_mcp_tools。', { provider: str, tool: str, arguments: {type:'object'} }),
  tool('request_location', '让用户在 App 卡片选择出发位置，返回地址或授权的坐标', {}),
  tool('ask_user_choice', '用卡片询问确实需要用户决定的真实选项', { question: str }),
];
const mcp = (name, description, properties) => ({ name, description, inputSchema: obj(properties) });
const catalogs = {
  ima: [
    { name:'ima_list_knowledge_bases', description:'列出或按名称搜索 IMA 知识库，返回 kb_id 和 kb_name', inputSchema:obj({query:str},[]) },
    mcp('ima_search_knowledge','在指定知识库中搜索资料标题和片段。用列表中的 kb_id，结果使用 media_id 继续读原文。',{knowledge_base_id:str,query:str}),
    mcp('ima_get_media','根据 media_id 读取知识库资料原文',{media_id:str}),
    { name:'ima_search_notes', description:'搜索 IMA 笔记，search_type 为 0 标题或 1 正文。可能返回模糊匹配。', inputSchema:obj({query:str,search_type:{type:'integer',enum:[0,1]}},['query']) },
    mcp('ima_get_note','根据 note_id 读取笔记正文',{note_id:str}),
  ],
  didi: [
    mcp('taxi-estimate', '按起点和终点估算车费 driving taxi fare estimate price。用高德地点查询的经纬度作为终点。', { origin: str, destination: str }),
    mcp('taxi-order-history', '查询历史行程账单', { date: str }),
    mcp('taxi-cancel-order', '取消已存在的行程，须本人确认', { id: str }),
  ],
  mcdonalds: [
    mcp('order-list', '查询本人的近期麦当劳订单历史和金额 order history', {}),
    mcp('query-order', '用真实 orderId 查询订单明细 order detail', { orderId: str }),
    { name: 'query-nearby-stores', description: '按城市和门店名查门店 nearby store。searchType=2 用 city 与 keyword。',
      inputSchema: obj({ searchType: str, beType: str, city: str, keyword: str }, ['searchType','beType']) },
    mcp('query-meals', '用真实 storeCode 查询门店在售汉堡和菜单 burger meal menu。orderType=1、beType=1 为到店自取。',
      { storeCode: str, orderType: {type:'integer'}, beType: {type:'integer'} }),
  ],
  fliggy: fliggyCatalog,
  liepin: [mcp('search-jobs', '搜索猎聘招聘职位，按岗位和城市筛选', { keyword: str, city: str })],
  netease_music: [mcp('search-songs', '搜索网易云音乐歌单和歌曲', { keyword: str })],
  yuque: [mcp('search-documents', '搜索语雀知识库笔记和文档', { keyword: str })],
};
const integrations = [
  { id:'amap', name:'高德地图', description:'地点 POI 路线 导航 地址 地理编码 定位 map location geocode route', status:'connected' },
  { id:'qq_mail', name:'QQ 邮箱', description:'电子邮箱 邮件 搜索 会议 附件 mail email search', status:'connected' },
  { id:'tencent_docs', name:'腾讯文档', description:'在线文件目录 笔记 文档 会议纪要 file document', status:'connected' },
];
const services = [
  ['didi','滴滴出行','打车 叫车 车费 路线 报价 taxi estimate ride'],
  ['fliggy','飞猪','航班 机票 机场 旅行 酒店 万豪 火车 高铁 景点 门票 航空 住宿 flight hotel train travel'],
  ['liepin','猎聘','招聘 求职 岗位 职位 job'],
  ['netease_music','网易云音乐','音乐 歌单 歌曲 song music'],
  ['yuque','语雀','笔记 知识库 文档 文章 note document'],
].map(([id,name,description]) => ({id,name,description,status:'connected',tool_count:catalogs[id].length}));

const rideDestination = '121.33644,31.19447';
const samePoint = (actual, expected) => {
  if (typeof actual !== 'string') return false;
  const values = actual.split(',').map(Number);
  return values.length === 2 && expected.split(',').every((value,index) => Math.abs(Number(value)-values[index]) < 0.00002);
};
const fixtureCommit = 'a'.repeat(40);

const locationPrompt = '上海市徐汇区光启公园';
export function fixtureToolName(name, args) {
  if (name === 'call_mcp_tool') return args.provider + '.' + args.tool;
  if (name === 'read_integration') return args.provider + '.' + (args.query?.operation ?? 'read');
  return name;
}

export function fixtureCall(id, reached, hit) {
  const catalogRead = new Set();
  const missing = { error: { code:'fixture_not_found', message:'没有相符的已验证结果，请核对参数。' } };
  return (name, args, tag) => {
    if (name === 'inspect_app_permissions') {
      const valid = id === 'phone-permission-followup' ? args.mode === 'reuse'
        : id === 'phone-permission-recheck' ? args.mode === 'refresh' && args.scope === 'selected_app'
        : id === 'phone-permission-filter' ? args.permission === 'microphone' : true;
      return id.startsWith('phone-permission-') && args.inspection === 'permissions' && valid
        ? hit(name, {status:'partial',scanned:15,flagged:1}) : missing;
    }
    if (name === 'open_system_settings') {
      if (id === 'phone-permission-history' && args.destination === 'privacy') return hit(name,{status:'opened'});
      if (id === 'phone-permission-open-app' && args.destination === 'selected_app') return hit(name,{status:'fallback'});
      return missing;
    }
    if (name === 'list_mcp_connections') {
      if (id === 'disconnected-account') {
        return hit(name,{items:services.map(service => service.id === 'liepin' ? { ...service,status:'disconnected' } : service)});
      }
      if (id.startsWith('ima-')) return {items:[...services,{id:'ima',name:'IMA',description:'个人知识库、笔记、资料原文',status:'connected',tool_count:catalogs.ima.length}]};
      return { items:id.startsWith('mcd-') ? [...services, {
        id:'mcdonalds',name:'麦当劳',description:'个人订单、门店、菜单 order store menu',status:'connected',tool_count:catalogs.mcdonalds.length,
      }] : services };
    }
    if (name === 'list_integrations') return { items: integrations };
    if (name === 'list_mcp_tools') {
      if (args.provider === 'liepin') {
        if (id === 'disconnected-account') return { items: [] };
        catalogRead.add('liepin');
      }
      return { items: catalogs[args.provider] ?? [] };
    }
    if (name === 'recent_chat_tool_receipts') return { history_complete: true, items: [] };
    if (name === 'list_memories' && id === 'memory') return hit(name, { items:[{title:'灯塔发布日期',content:'灯塔项目 2026 年 12 月 18 日发布'}] });
    if (name === 'search_ai_history' && id === 'history-followup' && /北辰|备份/.test(args.query) && (!args.provider || args.provider === 'claude'))
      return hit(name,{ items:[{id:'claude-beichen-1', title:'北辰备份上线复盘',provider:'claude',summary:'备份方案讨论与最终决策'}] });
    if (name === 'read_ai_history' && reached.has('search_ai_history') && args.id === 'claude-beichen-1')
      return hit(name,{ items:[{role:'user',content:'最终保留三份备份。',on_current_branch:true}] });
    if (tag === 'qq_mail.read' && id === 'cross-app' && /青禾|周会/.test(args.query?.query))
      return hit('qq_mail.search',{ items:[{subject:'青禾周会',summary:'本周五 14:30 举行'}] });
    if (tag === 'tencent_docs.read' && id === 'cross-app')
      return hit('tencent_docs.list',{ items:[{name:'青禾周会纪要',id:'tdoc-qinghe'}] });
    if (tag === 'amap.search' && id === 'ride-quote' && /虹桥/.test(args.query?.keywords))
      return hit(tag,{ source:'amap', operation:'search',status:'completed',items:[{name:'上海虹桥机场T2出发层',location:rideDestination}] });
    if (tag === 'didi.taxi-estimate' && reached.has('amap.search') &&
        samePoint(args.arguments?.origin, '121.44623,31.20446') && samePoint(args.arguments?.destination, rideDestination))
      return hit(tag,{ status:'completed',result:{ product:'普通快车',estimated_fare_cny:86.50 } });
    const mcdOrder = id === 'mcd-order-lookback' || id === 'mcd-known-store-followup';
    if (mcdOrder && tag === 'mcdonalds.order-list') return hit(tag, { status:'completed',
      result:{ structuredContent:{ success:true, data:[{ orderId:'fixture-order-1', storeName:'星桥花园餐厅',
        storeCode:'fixture-order-store', orderTime:'2026-11-06T11:26:00+08:00', paidAmount:'46.80', status:'已完成' }] } } });
    if (mcdOrder && tag === 'mcdonalds.query-order' && args.arguments?.orderId === 'fixture-order-1')
      return hit(tag, { status:'completed', result:{ structuredContent:{ success:true, data:{ orderId:'fixture-order-1',
        storeName:'星桥花园餐厅', storeCode:'fixture-order-store', paidAmount:'46.80', items:['双层吉士汉堡','香芋派'] } } } });
    if (id === 'mcd-nearby-followup') {
      if (tag === 'amap.reverse_geocode' && samePoint(args.query?.location,'121.44623,31.20446'))
        return hit(tag, { source:'amap',operation:'reverse_geocode',city:'上海市',address:'示例路' });
      if (tag === 'amap.nearby' && samePoint(args.query?.location,'121.44623,31.20446') && /麦当劳/.test(args.query?.keywords))
        return hit(tag, { source:'amap',operation:'nearby',status:'completed',
          items:[{ title:'麦当劳（星桥广场店）',distance_m:470 }] });
      if (tag === 'mcdonalds.query-nearby-stores' && reached.has('amap.reverse_geocode') && reached.has('amap.nearby') &&
          args.arguments?.searchType === '2' && args.arguments?.city === '上海' && /星桥广场/.test(args.arguments?.keyword))
        return hit(tag, { status:'completed',result:{ structuredContent:{ success:true,
          data:[{ storeCode:'fixture-store',storeName:'麦当劳（星桥广场店）' }] } } });
    }
    const menuStore = id === 'mcd-known-store-followup' && reached.has('mcdonalds.order-list') ? 'fixture-order-store' :
      id === 'mcd-nearby-followup' && reached.has('mcdonalds.query-nearby-stores') ? 'fixture-store' : undefined;
    if (tag === 'mcdonalds.query-meals' && menuStore && args.arguments?.storeCode === menuStore)
      return hit(tag, { status:'completed',result:{ structuredContent:{ success:true,data:{ meals:{
        11002:{name:'板烧鸡腿堡'},11003:{name:'双层吉士汉堡'},
      } } } } });
    if (name === 'call_mcp_tool' && args.provider === 'fliggy') {
      const receipt = fliggyReceipt(id, args.tool, args.arguments, reached);
      return receipt ? hit(tag, receipt) : missing;
    }
    if (name === 'call_mcp_tool' && args.provider === 'ima') {
      const a = args.arguments ?? {};
      const receipt = data => ({status:'completed',result:{structuredContent:{code:0,data}}});
      if (id === 'ima-library-read') {
        if (args.tool === 'ima_list_knowledge_bases') return hit(tag,receipt({info_list:[{kb_id:'kb-starbridge',kb_name:'星桥项目'}],is_end:true}));
        if (args.tool === 'ima_search_knowledge' && reached.has('ima.ima_list_knowledge_bases') && a.knowledge_base_id === 'kb-starbridge' && /蓝杉|发布会/.test(a.query))
          return hit(tag,receipt({info_list:[{media_id:'media-blue',media_type:13,title:'蓝杉发布会纪要',highlight_content:'议题：发布前测试安排'}],is_end:true}));
        if (args.tool === 'ima_get_media' && reached.has('ima.ima_search_knowledge') && a.media_id === 'media-blue')
          return hit(tag,receipt({media_type:13,read_status:'read',content:'发布会纪要：回归测试由顾岚负责。',is_end:true,next_offset:null}));
      }
      if (id === 'ima-note-body-search') {
        if (args.tool === 'ima_search_notes' && /鲸落|巡检|交接|暗号/.test(a.query)) {
          if (a.search_type === 1) return hit('ima.ima_search_notes_body',receipt({search_note_infos:[{note_book_info:{note_id:'note-handoff',title:'值班手记'},highlightInfo:{format_content:'鲸落巡检交接'} }],is_end:true}));
          return receipt({search_note_infos:[{note_book_info:{note_id:'irrelevant',title:'鲸落书评'},highlightInfo:{format_content:'小说读后感'}}],is_end:true});
        }
        if (args.tool === 'ima_get_note' && reached.has('ima.ima_search_notes_body') && a.note_id === 'note-handoff')
          return hit(tag,receipt({content:'鲸落巡检交接暗号是青铜风铃。',is_end:true,next_offset:null}));
      }
    }
    if (name === 'read_github_repository' && id === 'code-followup' && args.repository === 'demo-lab/tada-fixture') {
      if (!args.path) return hit('github.find',{status:'completed',commit:fixtureCommit,files:[{path:'config/startup.toml'}]});
      if (reached.has('github.find') && args.git_ref === fixtureCommit && args.path === 'config/startup.toml')
        return hit('github.read',{status:'completed',commit:fixtureCommit,lines:[{line:1,text:'port = 8127'}]});
    }
    if (name === 'request_location' && id === 'location-card') {
      return hit(name,{status:'answered',location:{source:'manual',label:locationPrompt,observed_at:'2026-11-07T10:30:00+08:00'}});
    }
    if (name === 'request_location' && id === 'location-cancel') return hit(name,{status:'cancelled'});
    if (tag === 'amap.nearby' && id === 'location-card' && reached.has('request_location') &&
        args.query?.address === locationPrompt && /宠物医院/.test(args.query?.keywords))
      return hit(tag,{source:'amap',operation:'nearby',status:'completed',items:[{name:'星桥宠物医院',address:'测试路 18 号',distance_m:320}]});
    if (tag === 'qq_mail.read' && id === 'provider-failure' && /青禾|周会/.test(args.query?.query))
      return hit('qq_mail.search',{status:'failed',error:{code:'temporarily_unavailable',message:'QQ 邮箱服务暂不可用，当前未取得任何邮件正文或会议时间。'}});
    if (tag === 'liepin.search-jobs' && id === 'dynamic-job' && catalogRead.has('liepin') &&
        /Rust/i.test(args.arguments?.keyword) && /杭州/.test(args.arguments?.city))
      return hit(tag,{status:'completed',result:{items:[{title:'Rust 后端工程师',salary:'28-38K',city:'杭州',company:'星桥科技'}]}});
    return missing;
  };
}

export function fixtureContext(id) {
  const location = id === 'ride-quote' || id === 'mcd-nearby-followup' ? {
    location_status:'available', location: { source:'device', latitude:31.205,longitude:121.442,accuracy_m:25, coordinate_system:'wgs84', observed_at:'2026-11-07T10:30:00+08:00',
      map_coordinates:{coordinate_system:'gcj02',latitude:31.20446,longitude:121.44623,conversion:'wgs84_to_gcj02',provider:'amap_didi_verify_tool_crs'} },
  } : {location_status:'not_provided'};
  const selected = ['phone-permission-open-app', 'phone-permission-recheck'].includes(id);
  return {server_time_utc:'2026-11-07T02:30:00Z',local_time:'2026-11-07T10:30:00+08:00',weekday:'Saturday',
    timezone:'Asia/Shanghai',timezone_source:'device',...location,
    ...(id.startsWith('phone-permission-') ? {device_inspection:{has_report:selected || id === 'phone-permission-followup',has_selected_app:selected}} : {})};
}

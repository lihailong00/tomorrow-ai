import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { resolveModel } from './config.js';
import { executeRun, type Bridge, type RunInput } from './runtime.js';
import { ToolSearchSession, type SearchDefinition } from './tool-search.js';

const definition = (name:string,description:string):SearchDefinition=>({name,description,parameters:{type:'object',properties:{},additionalProperties:false}});
const definitions = [definition('get_current_time','读取当前时间'), definition('list_mcp_connections','连接状态'),definition('list_mcp_tools','工具目录'),
  definition('call_mcp_tool','调用真实服务'),definition('list_integrations','查看邮箱和地图连接'),definition('read_integration','读取已连接的邮箱邮件、地图路线'),
  definition('list_memories','查询个人记忆偏好'),definition('save_memory','用户明确要求时保存记忆'),definition('create_task','创建待本人确认的任务'),
  definition('list_tasks','查询待办任务'),definition('web_search','搜索最新公开网页新闻'),definition('web_fetch','读取网页正文')];
const services = [
  {id:'mcdonalds',name:'麦当劳',description:'查询活动、营养与账号开放的服务',status:'connected',token:'secret-never-forward'},
  {id:'fliggy',name:'飞猪',description:'查询航班、酒店与旅行信息',status:'connected'},
  {id:'notes',name:'私人笔记',description:'个人笔记知识库',status:'needs_reconnect'},
];
const schema = {type:'object',properties:{storeCode:{type:'string'}},required:['storeCode'],additionalProperties:false};

test('no upfront connection lookup; anonymous dining and travel discover real authorized services',async()=>{
  const calls:{name:string;args:Record<string,unknown>}[]=[];
  const session=new ToolSearchSession(definitions,async(name,args)=>{
    calls.push({name,args});
    if(name==='list_mcp_connections')return {items:services};
    if(name==='list_integrations')return {items:[{id:'qq_mail',name:'QQ邮箱',description:'搜索和读取本人邮件',status:'connected',password:'hidden'}]};
    return {items:[{name:args.provider==='fliggy'?'search-flights':'query-menu',description:args.provider==='fliggy'?'查询航班机票':'查询餐饮套餐菜单',inputSchema:schema}],has_more:true,next_offset:10};
  });
  assert.deepEqual(session.loaded.map(t=>t.name),['list_memories','list_tasks']);assert.equal(calls.length,0);
  const food=await session.search('帮我找附近50元以内的午餐');
  assert.deepEqual(food.matched_services,[{id:'mcdonalds',name:'麦当劳',kind:'mcp'}]);
  const native=session.loaded.find(t=>t.name.startsWith('mcp_'))!;
  assert.deepEqual(native.parameters,schema);
  assert.deepEqual(session.canonical(native.name,{storeCode:'real-id'}),{name:'call_mcp_tool',arguments:{provider:'mcdonalds',tool:'query-menu',arguments:{storeCode:'real-id'}}});
  assert.ok(!JSON.stringify(food).includes('secret-never-forward'));assert.ok(!JSON.stringify(food).includes('hidden'));
  assert.ok(!session.loaded.some(t=>['call_mcp_tool','web_search'].includes(t.name)));
  const travel=await session.search('查询明天上海到杭州的航班');
  assert.deepEqual(travel.matched_services,[{id:'fliggy',name:'飞猪',kind:'mcp'}]);
  assert.equal(calls.filter(c=>c.name==='list_mcp_connections').length,1);
});

test('mail connects through the actual integration ID; explicit missing accounts cannot be promoted',async()=>{
  const calls:unknown[]=[];
  const session=new ToolSearchSession(definitions,async(name,args)=>{calls.push([name,args]);return name==='list_integrations'
    ?{items:[{id:'qq_mail',name:'QQ邮箱',description:'搜索本人邮件',status:'connected'}]}:{items:services};});
  const mail=await session.search('帮我找客户昨天发来的邮件');
  assert.deepEqual(mail.matched_services,[{id:'qq_mail',name:'QQ邮箱',kind:'integration'}]);
  assert.ok(session.loaded.some(t=>t.name==='read_integration'));
  const missing=await session.search('搜索我的笔记',5,'notes');
  assert.deepEqual(missing.matched_services,[]);
  assert.equal(calls.filter(c=>(c as unknown[])[0]==='list_mcp_tools').length,0);
  assert.ok(JSON.stringify(missing.unavailable_matches).includes('needs_reconnect'));
});

test('catalog pagination passes the same retrieval query; schemas and cache stay scoped to one run',async()=>{
  const requests:Record<string,unknown>[]=[];
  const session=new ToolSearchSession(definitions,async(name,args)=>{
    if(name==='list_mcp_connections')return {items:services};
    if(name==='list_integrations')return {items:[]};
    requests.push(args);return {items:[{name:'page-'+args.offset,inputSchema:schema}],has_more:args.offset===0,next_offset:10};
  });
  await session.search('航班',3,'fliggy');await session.search('航班',3,'fliggy',10);
  assert.equal(requests[0]!.query,requests[1]!.query);assert.equal(requests[1]!.offset,10);
  const other=new ToolSearchSession(definitions,async()=>({items:[]}));
  assert.deepEqual((await other.search('航班')).matched_services,[]);assert.equal(other.loaded.some(t=>t.name.startsWith('mcp_')),false);
  await assert.rejects(session.search('航班',3,undefined,10));
});

test('tool search cannot load disallowed tools, invalid schemas, or exceed a bounded schema budget',async()=>{
  const session=new ToolSearchSession(definitions,async(name)=>name==='list_mcp_connections'?{items:services}:name==='list_integrations'?{items:[]}:
    {items:[{name:'bad',inputSchema:{type:'string'}},{name:'huge',inputSchema:{type:'object',description:'x'.repeat(13000)}},{name:'valid',inputSchema:schema}]});
  await session.search('午餐');await session.search('exec_command 终端执行');
  assert.equal(session.loaded.filter(t=>t.name.startsWith('mcp_')).length,1);
  assert.ok(!session.loaded.some(t=>t.name==='exec_command'));
  assert.ok(JSON.stringify(session.loaded).length<=48000);
});

test('reading a remembered coffee preference loads memory search before merchant or memory writers',async()=>{
  const local=[...definitions,definition('get_memory','读取记忆正文'),definition('update_memory','修改记忆'),definition('delete_memory','删除记忆'),definition('index_memory_graph','构建记忆知识图谱')];
  let catalogs=0;
  const session=new ToolSearchSession(local,async(name)=>{
    if(name==='list_mcp_connections')return {items:services};if(name==='list_integrations')return {items:[]};
    catalogs++;return {items:[]};
  });
  await session.search('查询我保存的记忆中咖啡口味偏好',3);
  assert.ok(session.loaded.some(t=>t.name==='list_memories'));assert.equal(catalogs,0);
  assert.ok(!session.loaded.some(t=>t.name==='save_memory'));
});

test('routes reject invented coordinates and accept only current inputs or actual map search results',()=>{
  const session=new ToolSearchSession(definitions,async()=>({items:[]}),[{longitude:121.478223,latitude:31.228458}]);
  const call={provider:'amap',query:{operation:'route',origin:'121.478223,31.228458',destination:'121.320000,31.195000'}};
  assert.match(session.validateCall('read_integration',call)??'',/不能|不要/);
  session.observeResult('read_integration',{provider:'qq_mail',query:{operation:'search'}},{items:[{location:call.query.destination}]});
  assert.ok(session.validateCall('read_integration',call));
  session.observeResult('read_integration',{provider:'amap',query:{operation:'search'}},{data:{pois:[{location:'121.320081,31.193964'}]}});
  assert.equal(session.validateCall('read_integration',{...call,query:{...call.query,destination:'121.320081,31.193964'}}),undefined);
});

test('real Pi loop starts small then executes a dynamically loaded MCP tool through the original journal',async()=>{
  const request:RunInput={run_id:'11111111-1111-4111-8111-111111111111',run_token:'a'.repeat(64),scope:'chat',operation_slots:true,
    messages:[{role:'user',content:'帮我找附近便宜的午餐'}],tools:definitions.filter(t=>!['web_search','web_fetch'].includes(t.name))};
  const effects:{name:string;args:unknown;index?:number}[]=[];const events:unknown[]=[];let sequence=1;
  const bridge:Bridge={state:async()=>({next_sequence:sequence}),event:async e=>{events.push(e);sequence=e.sequence+1;},
    tool:async(name,args,_signal,index)=>{
      effects.push({name,args,index});
      if(name==='list_mcp_connections')return {items:services};if(name==='list_integrations')return {items:[]};
      if(name==='list_mcp_tools')return {items:[{name:'query-menu',description:'读取餐饮菜单',inputSchema:schema}]};
      assert.equal(name,'call_mcp_tool');return {status:'completed',result:{items:[{name:'合成午餐',price:25}]}};
    }};
  const inventories:string[][]=[];let turn=0;
  const stream:StreamFn=(model,context)=>{
    const tools=getCurrentTools(context.messages)??[];inventories.push(tools.map(t=>t.name));
    let content:AssistantMessage['content'];
    if(turn++===0)content=[{type:'toolCall',id:'discover',name:'search_tools',arguments:{query:'附近便宜午餐'}}];
    else if(turn===2)content=[{type:'toolCall',id:'read-menu',name:tools.find(t=>t.name.startsWith('mcp_'))!.name,arguments:{storeCode:'test-store'}}];
    else content=[{type:'text',text:'测试门店有一份25元的合成午餐。'}];
    const isTool=content.some(c=>c.type==='toolCall');
    const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:isTool?'toolUse':'stop',
      usage:{input:10,output:5,cacheRead:0,cacheWrite:0,totalTokens:15,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const result=createAssistantMessageEventStream();queueMicrotask(()=>{result.push({type:'start',partial:message});result.push({type:'done',reason:isTool?'toolUse':'stop',message});});return result;
  };
  const output=await executeRun(request,resolveModel({DEEPSEEK_API_KEY:'fixture-only'}),bridge,undefined,undefined,stream,undefined,{toolSearch:true});
  assert.equal(output.content,'测试门店有一份25元的合成午餐。');
  assert.deepEqual(inventories[0],['search_tools','list_memories','list_tasks']);
  assert.ok(inventories[1]!.some(t=>t.startsWith('mcp_')));assert.ok(!inventories[1]!.includes('save_memory'));
  assert.equal(effects.filter(e=>e.name==='call_mcp_tool').length,1);
  assert.deepEqual(effects.find(e=>e.name==='call_mcp_tool')?.args,{provider:'mcdonalds',tool:'query-menu',arguments:{storeCode:'test-store'}});
  assert.equal(effects.find(e=>e.name==='call_mcp_tool')?.index,1);
  assert.ok(JSON.stringify(events).includes('"provider":"mcdonalds"'));
});

test('ordinary Pi chat has no discovery calls, and experimental search cannot be supplied by the user tool list',async()=>{
  const request:RunInput={run_id:'11111111-1111-4111-8111-111111111111',run_token:'b'.repeat(64),scope:'chat',messages:[{role:'user',content:'你好'}],tools:definitions.filter(t=>!t.name.startsWith('web_'))};
  let calls=0;const bridge:Bridge={state:async()=>({next_sequence:1}),event:async()=>{},tool:async()=>{calls++;return {};}};
  const stream:StreamFn=(model,context)=>{
    assert.deepEqual(getCurrentTools(context.messages)?.map(t=>t.name),['search_tools','list_memories','list_tasks']);
    const message:AssistantMessage={role:'assistant',content:[{type:'text',text:'你好！'}],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const result=createAssistantMessageEventStream();queueMicrotask(()=>result.push({type:'done',reason:'stop',message}));return result;
  };
  await executeRun(request,resolveModel({DEEPSEEK_API_KEY:'fixture-only'}),bridge,undefined,undefined,stream,undefined,{toolSearch:true});
  assert.equal(calls,0);
  await assert.rejects(executeRun({...request,tools:[definition('search_tools','override')]},resolveModel({DEEPSEEK_API_KEY:'fixture-only'}),bridge));
});

test('deferred memory writes preserve the same mutation slot and per-tool replay index on retry',async()=>{
  const save={name:'save_memory',description:'用户明确要求时保存记忆',parameters:{type:'object',properties:{content:{type:'string'}},required:['content'],additionalProperties:false}};
  const request:RunInput={run_id:'11111111-1111-4111-8111-111111111111',run_token:'c'.repeat(64),scope:'chat',operation_slots:true,
    messages:[{role:'user',content:'记住我喜欢简洁回答'}],tools:[...definitions.filter(t=>['list_mcp_connections','list_integrations'].includes(t.name)),save]};
  let sequence=1,writes=0;const receipts=new Map<number,string>();
  const bridge:Bridge={state:async()=>({next_sequence:sequence}),event:async event=>{sequence=event.sequence+1;},tool:async(name,args,_signal,index,slot)=>{
    if(name!=='save_memory')return {items:[]};
    assert.equal(index,1);assert.equal(slot,1);const identity=JSON.stringify({name,args,index});
    if(!receipts.has(slot!)){writes++;receipts.set(slot!,identity);}else assert.equal(receipts.get(slot!),identity);
    return {id:'fixture-memory',status:'saved'};
  }};
  const stream=():StreamFn=>{let turn=0;return(model)=>{
    const content:AssistantMessage['content']=turn++===0?[{type:'toolCall',id:'find-save',name:'search_tools',arguments:{query:'保存记忆'}}]:
      turn===2?[{type:'toolCall',id:'save',name:'save_memory',arguments:{content:'喜欢简洁回答'}}]:[{type:'text',text:'已保存。'}];
    const tool=content.some(c=>c.type==='toolCall');const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:tool?'toolUse':'stop',
      usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    const result=createAssistantMessageEventStream();queueMicrotask(()=>result.push({type:'done',reason:tool?'toolUse':'stop',message}));return result;
  }};
  for(let attempt=0;attempt<2;attempt++)await executeRun(request,resolveModel({DEEPSEEK_API_KEY:'fixture-only'}),bridge,undefined,undefined,stream(),undefined,{toolSearch:true});
  assert.equal(writes,1);
});

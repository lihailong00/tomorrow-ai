import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareConnectedTools } from './connected-tools.js';

test('the screenshot query discovers actual connected meal tools before the first model request', async () => {
  const calls: unknown[] = [];
  const result = await prepareConnectedTools([{role:'user',content:'有没有50块钱以内的麦当劳套餐？给我推荐一下呢。'}], async (name,args) => {
    calls.push({name,args});
    return name === 'list_mcp_connections' ? {items:[{id:'mcdonalds',name:'麦当劳',status:'connected',tool_count:36,token:'never-forward-secret'}]} :
      {items:[{name:'query-meals',inputSchema:{type:'object',properties:{storeId:{type:'string'}}}}],has_more:true,next_offset:1};
  });
  assert.deepEqual(result.preferred,['mcdonalds']);
  assert.equal(calls.length,2); assert.match(JSON.stringify(calls),/meal menu coupon price/);
  assert.match(result.context,/query-meals/); assert.match(result.context,/next_offset/);
  assert.ok(!result.context.includes('never-forward-secret'));
});

test('ordinary chat does not inspect personal connections and a disconnected service is never promoted', async () => {
  let calls=0;
  assert.equal((await prepareConnectedTools([{role:'user',content:'你好，讲讲Rust所有权'}],async()=>{calls++;return null;})).context,'');
  assert.equal(calls,0);
  const value=await prepareConnectedTools([{role:'user',content:'推荐麦当劳套餐'}],async()=>({items:[{id:'mcdonalds',name:'麦当劳',status:'needs_reconnect'}]}));
  assert.deepEqual(value.preferred,[]);
});

test('the location follow-up keeps the named merchant but unrelated topics do not inherit it', async () => {
  const history=[{role:'user',content:'推荐麦当劳套餐'}];
  const discover=async(name:string)=>name==='list_mcp_connections'?{items:[{id:'mcdonalds',name:'麦当劳',status:'connected'}]}:{items:[{name:'query-nearby-stores'}]};
  assert.deepEqual((await prepareConnectedTools([...history,{role:'user',content:'那你把我们当前的地址设置过去，他就知道附近有哪些店了。'}],discover)).preferred,['mcdonalds']);
  assert.deepEqual((await prepareConnectedTools([...history,{role:'user',content:'搜索Rust最新版本'}],discover)).preferred,[]);
});

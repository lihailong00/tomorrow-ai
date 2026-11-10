import { findContinuation, needsPreviousContext, type RecentContext } from '../src/features/conversation-continuation/model';
import { createRecentContextIndex } from '../src/features/conversation-continuation/recentContext';
import type { ApiClient } from '../src/api/client';
const row=(id:string,title:string,text:string):RecentContext=>({id,title,updated_at:'2026-11-03T01:00:00Z',excerpts:[text],preview:[]});
const recent=[row('rust','Rust 学习计划','每天 20 分钟学 Rust，先做一个小工具'),row('customer','客户交付沟通','客户希望缩短交付周期，回复不要提前承诺日期'),row('walk','周末散步','每次在公园走一个小时')];
test('uses real recent context for explicit continuation but does not redirect a new question',()=>{
  expect(findContinuation('我明天只有20分钟，Rust学习计划怎么调整？',recent)?.conversation.id).toBe('rust');
  expect(findContinuation('把上次给客户的回复改得更简洁一点。',recent)?.conversation.id).toBe('customer');
  expect(findContinuation('Rust里的所有权是什么意思？',recent)).toBeNull();
  expect(findContinuation('法国的首都是哪里？',recent)).toBeNull();
  expect(findContinuation('这是一个新问题，继续解释 Rust 所有权',recent)).toBeNull();
  expect(findContinuation('继续 Rust',recent.slice(0,1))?.conversation.id).toBe('rust');
});
test('does not choose between equally suitable threads or rely on generic continuation words',()=>{
  expect(findContinuation('继续之前的学习计划',recent)).toBeNull();
  expect(findContinuation('接着Rust学习计划往下聊',[recent[0],{...recent[0],id:'duplicate'}])).toBeNull();
  expect(needsPreviousContext('接着'+ 'x'.repeat(4001))).toBe(false);
  expect(findContinuation('继续 Rust',Array.from({length:21},(_,i)=>row(String(i),i===20?'Rust':'其它话题','其它内容')))).toBeNull();
});
test('bounds indexing to twenty threads, four-message pages, three concurrent reads, and one route cache',async()=>{
  const index=createRecentContextIndex();const owner={};let active=0,max=0;
  const request=jest.fn(async(path:string)=>{
    if(path.startsWith('/conversations?'))return {items:Array.from({length:25},(_,i)=>({id:String(i),title:`会话${i}`,updated_at:''}))};
    active++;max=Math.max(max,active);await Promise.resolve();active--;
    const id=path.split('/')[2];return{items:[{id:'u-'+id,conversation_id:id,role:'user',content:'测'.repeat(1000),created_at:''},{id:'foreign',conversation_id:'other',role:'user',content:'foreign',created_at:''}]};
  });
  const api={request} as unknown as ApiClient;
  const result=await index.load(api,owner);
  expect(result).toHaveLength(20);expect(max).toBeLessThanOrEqual(3);
  expect(request).toHaveBeenCalledTimes(21);
  expect(result[0].excerpts[0]).toHaveLength(480);expect(result.every(item=>item.preview.length===1)).toBe(true);
  expect(request.mock.calls.slice(1).every(([path])=>path.endsWith('messages?limit=4&offset=0'))).toBe(true);
  expect(await index.load(api,owner)).toBe(result);expect(request).toHaveBeenCalledTimes(21);
  index.clear();
});
test('drops late old-owner data and cancels outstanding requests',async()=>{
  const index=createRecentContextIndex();let release!:(value:unknown)=>void;
  const request=jest.fn((_path:string,_method:string,_body:unknown,signal:AbortSignal)=>new Promise(resolve=>{release=resolve;expect(signal.aborted).toBe(false);}));
  const pending=index.load({request} as unknown as ApiClient,{});index.clear();
  expect(request.mock.calls[0][3].aborted).toBe(true);release({items:[{id:'private',title:'private',updated_at:''}]});
  expect(await pending).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
});
test('account, instance or history revision changes invalidate even a reused API object',async()=>{
  const index=createRecentContextIndex();const owner={};const request=jest.fn().mockResolvedValue({items:[]});const api={request} as unknown as ApiClient;
  await index.load(api,owner,'account-a:instance-one:revision-1');
  await index.load(api,owner,'account-a:instance-one:revision-1');expect(request).toHaveBeenCalledTimes(1);
  await index.load(api,owner,'account-b:instance-one:revision-1');expect(request).toHaveBeenCalledTimes(2);
  await index.load(api,owner,'account-b:instance-two:revision-1');expect(request).toHaveBeenCalledTimes(3);
  await index.load(api,owner,'account-b:instance-two:revision-2');expect(request).toHaveBeenCalledTimes(4);
});

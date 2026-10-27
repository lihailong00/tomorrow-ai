import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startBudgetGateway,reserveForPayload} from './budget-gateway.mjs';

const settings={apiKey:'real-model-secret-must-never-persist',model:{baseUrl:'https://api.deepseek.com'}};
const token='local-proxy-capability-'.repeat(3);
const payload={model:'deepseek-flash',messages:[{role:'user',content:'hello'}],max_tokens:100,stream:false};
async function fixture(options={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'tomorrow-budget-'));
  const ledgerPath=path.join(directory,'ledger.json');
  const server=await startBudgetGateway({settings,token,ledgerPath,...options});
  return {...server,ledgerPath,async cleanup(){await server.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});}};
}
const call=(f,p=payload)=>fetch(`${f.baseUrl}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(p)});
test('concurrent paid admissions cannot overspend the shared reservation ceiling',async()=>{
  let calls=0;let release;const wait=new Promise(r=>release=r);
  const reserve=reserveForPayload(payload).reserved_nano/1e9;
  const f=await fixture({budgetCny:reserve*1.5,fetchImpl:async()=>{calls++;await wait;return new Response(JSON.stringify({model:'deepseek-flash',choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}),{headers:{'Content-Type':'application/json'}});}});
  try{
    const first=call(f);const readyDeadline=Date.now()+5000;
    while(calls<1&&Date.now()<readyDeadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,1);
    const second=await call(f);assert.equal(second.status,402);assert.equal(calls,1);
    release();assert.equal((await first).status,200);
    assert.ok(f.status().accounted_upper_bound_cny<=f.status().budget_cny);
    assert.equal((await readFile(f.ledgerPath,'utf8')).includes(settings.apiKey),false);
  }finally{release();await f.cleanup();}
});
test('a provider failure with unknown billing permanently retains its reservation',async()=>{
  let calls=0;const reserve=reserveForPayload(payload).reserved_nano/1e9;
  const f=await fixture({budgetCny:reserve*1.5,fetchImpl:async()=>{calls++;throw new Error(settings.apiKey);}});
  try{
    const failed=await call(f);assert.equal(failed.status,400);assert.equal((await failed.text()).includes(settings.apiKey),false);
    await new Promise(r=>setTimeout(r,10));
    assert.equal((await call(f)).status,402);assert.equal(calls,1);
    assert.equal(f.ledger.requests[0].charge_nano,undefined);
  }finally{await f.cleanup();}
});
test('split SSE usage is settled accurately without persisting content or reasoning',async()=>{
  const f=await fixture({fetchImpl:async()=>new Response(new ReadableStream({start(c){
    c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"private-thought"}}]}\n\n'));
    c.enqueue(new TextEncoder().encode('data: {"model":"deepseek-flash","usage":{"prompt_tokens":100,"completion_'));
    c.enqueue(new TextEncoder().encode('tokens":20,"prompt_cache_hit_tokens":40,"total_tokens":120}}\n\ndata: [DONE]\n\n'));c.close();
  }}),{headers:{'Content-Type':'text/event-stream'}})});
  try{
    const response=await call(f,{...payload,stream:true});await response.text();await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(f.ledger.requests[0].usage,{input:60,cache_read:40,output:20,total_tokens:120});
    const saved=await readFile(f.ledgerPath,'utf8');assert.equal(saved.includes('private-thought'),false);assert.equal(saved.includes(settings.apiKey),false);
  }finally{await f.cleanup();}
});

test('downstream SDK cancellation after DONE still drains upstream and settles final usage',async()=>{
  let upstreamSignal;
  const f=await fixture({fetchImpl:async(_url,options)=>{
    upstreamSignal=options.signal;
    return new Response(new ReadableStream({start(c){
      options.signal.addEventListener('abort',()=>c.error(new Error('upstream aborted')),{once:true});
      c.enqueue(new TextEncoder().encode('data: {"model":"deepseek-flash","usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\ndata: [DONE]\n\n'));
      setTimeout(()=>{if(!options.signal.aborted)c.close();},80);
    }}),{headers:{'Content-Type':'text/event-stream'}});
  }});
  try{
    const response=await call(f,{...payload,stream:true});
    const reader=response.body.getReader();await reader.read();await reader.cancel();
    await new Promise(r=>setTimeout(r,120));
    assert.equal(upstreamSignal.aborted,false);
    assert.equal(f.ledger.requests[0].status,'settled');
    assert.equal(f.status().unknown_or_pending_reserved_cny,0);
    assert.equal(f.status().accounted_upper_bound_cny,0.00036);
  }finally{await f.cleanup();}
});
test('rejects unpriced models, unbounded images, extra generations and missing output caps before payment',()=>{
  for(const p of [{...payload,model:'other'}, {...payload,max_tokens:undefined},{...payload,n:2},
    {...payload,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.test/image.png'}}]}]}])assert.throws(()=>reserveForPayload(p));
});
test('a second process gateway cannot allocate another copy of the same experiment budget',async()=>{
  const f=await fixture({fetchImpl:async()=>{throw new Error('must not call provider');}});
  try{await assert.rejects(startBudgetGateway({settings,token,ledgerPath:f.ledgerPath,budgetCny:10}),/already owns/);}
  finally{await f.cleanup();}
});

test('fifty simultaneous requests share one durable spending ceiling',async()=>{
  const reserve=reserveForPayload(payload).reserved_nano/1e9;
  let paid=0,rejected=0,release;const blocked=new Promise(resolve=>release=resolve);
  const f=await fixture({budgetCny:reserve*3.5,maxConcurrent:50,fetchImpl:async()=>{
    paid++;await blocked;
    return new Response(JSON.stringify({model:'deepseek-flash',choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
  }});
  try{
    const requests=Array.from({length:50},()=>call(f).then(async response=>{const status=response.status;await response.text();if(status===402)rejected++;return status;}));
    const deadline=Date.now()+3000;
    while((rejected<47||paid<3)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(rejected,47);assert.equal(paid,3);
    assert.ok(f.status().accounted_upper_bound_cny<=f.status().budget_cny);
    release();const statuses=await Promise.all(requests);
    assert.equal(statuses.filter(status=>status===200).length,3);
    assert.ok(f.status().accounted_upper_bound_cny<=f.status().budget_cny);
  }finally{release();await f.cleanup();}
});

test('a conservative byte spending estimate is not mistaken for actual model context tokens',()=>{
  const reservation=reserveForPayload({...payload,messages:[{role:'user',content:'a'.repeat(510000)}]});
  assert.ok(reservation.input_token_upper_bound>1_000_000);
  assert.ok(reservation.reserved_nano>2_000_000_000);
});

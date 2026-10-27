import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBudgetGateway, reserveForPayload } from './budget-gateway.mjs';

const settings={apiKey:'fake-upstream-no-payment',model:{baseUrl:'https://api.deepseek.com'}};
const token='fake-proxy-capability-'.repeat(3);
const payload={model:'deepseek-flash',messages:[{role:'user',content:'budget wait review'}],max_tokens:100,stream:false};
const response=()=>new Response(JSON.stringify({model:'deepseek-flash',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}),
  {headers:{'Content-Type':'application/json'}});
const call=(gateway,signal)=>fetch(`${gateway.baseUrl}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal});
async function until(predicate){const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw new Error('Fixture condition timeout');await new Promise(resolve=>setTimeout(resolve,5));}}
async function fixture(options){
  const directory=await mkdtemp(path.join(os.tmpdir(),'tomorrow-budget-wait-'));
  const reserve=reserveForPayload(payload).reserved_nano/1e9;
  const gateway=await startBudgetGateway({settings,token,ledgerPath:path.join(directory,'ledger.json'),budgetCny:reserve*1.5,waitForBudgetReservations:true,...options});
  return {...gateway,cleanup:async()=>{await gateway.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await rm(directory,{recursive:true,force:true});}};
}

test('temporarily unavailable budget waits for real in-flight settlement before paying',async()=>{
  let release,calls=0;const blocker=new Promise(resolve=>release=resolve);
  const f=await fixture({fetchImpl:async()=>{calls++;if(calls===1)await blocker;return response();}});
  try{
    const first=call(f);await until(()=>calls===1);
    const second=call(f);await until(()=>f.status().waiting_for_budget===1);
    assert.equal(calls,1);assert.equal(f.ledger.requests.length,1,'waiting must not create a paid ledger row');
    release();await (await first).text();await (await second).text();
    assert.equal(calls,2);assert.equal(f.status().waiting_for_budget,0);
    assert.ok(f.status().accounted_upper_bound_cny<=f.status().budget_cny);
  }finally{release();await f.cleanup();}
});

test('unknown settlement wakes waiters to reject, without releasing uncertain charges or waiting forever',async()=>{
  let release,calls=0;const blocker=new Promise(resolve=>release=resolve);
  const f=await fixture({fetchImpl:async()=>{calls++;await blocker;throw new Error('unknown real provider result');}});
  try{
    const first=call(f);await until(()=>calls===1);
    const second=call(f);await until(()=>f.status().waiting_for_budget===1);
    release();await (await first).text();assert.equal((await second).status,402);
    assert.equal(calls,1);assert.equal(f.ledger.requests.length,1);
    assert.equal(f.ledger.requests[0].charge_upper_bound_nano,undefined);
    assert.equal(f.status().waiting_for_budget,0);
  }finally{release();await f.cleanup();}
});

test('cancelling a waiting client makes no provider call and creates no paid unknown row',async()=>{
  let release,calls=0;const blocker=new Promise(resolve=>release=resolve);
  const f=await fixture({fetchImpl:async()=>{calls++;await blocker;return response();}});
  try{
    const first=call(f);await until(()=>calls===1);
    const controller=new AbortController();const second=call(f,controller.signal);
    const rejected=assert.rejects(second);
    await until(()=>f.status().waiting_for_budget===1);controller.abort();await rejected;
    await until(()=>f.status().waiting_for_budget===0);
    assert.equal(calls,1);assert.equal(f.ledger.requests.length,1);
    release();await (await first).text();
  }finally{release();await f.cleanup();}
});

test('the whole-request deadline includes waiting and expires before any new provider call',async()=>{
  let release,calls=0;const blocker=new Promise(resolve=>release=resolve);
  // Deliberately ignore the upstream abort in this fixture, keeping the first
  // reservation live while proving the independent waiter's deadline works.
  const f=await fixture({requestTimeoutMs:100,fetchImpl:async()=>{calls++;await blocker;return response();}});
  try{
    const first=call(f);await until(()=>calls===1);
    const second=call(f);await until(()=>f.status().waiting_for_budget===1);
    assert.equal((await second).status,400);
    assert.equal(calls,1);assert.equal(f.ledger.requests.length,1);
    assert.equal(f.status().waiting_for_budget,0);
    release();await (await first).text();
  }finally{release();await f.cleanup();}
});

test('many awakened waiters recheck the common ceiling rather than spending the same release twice',async()=>{
  let release,calls=0;const blocker=new Promise(resolve=>release=resolve);
  const f=await fixture({maxConcurrent:20,fetchImpl:async()=>{calls++;if(calls===1)await blocker;return response();}});
  try{
    const first=call(f);await until(()=>calls===1);
    const requests=Array.from({length:8},()=>call(f).then(async reply=>{await reply.text();return reply.status;}));
    await until(()=>f.status().waiting_for_budget===8);assert.equal(calls,1);
    release();await (await first).text();
    assert.deepEqual(await Promise.all(requests),Array(8).fill(200));
    assert.equal(calls,9);assert.equal(f.status().waiting_for_budget,0);
    assert.ok(f.status().accounted_upper_bound_cny<=f.status().budget_cny);
  }finally{release();await f.cleanup();}
});

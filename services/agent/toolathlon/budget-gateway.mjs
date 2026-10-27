import {createServer} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,open,unlink} from 'node:fs/promises';
import path from 'node:path';

const NANO=1_000_000_000;
const PEAK={input:2000,cache:40,output:8000};
const OFFPEAK={input:1000,cache:20,output:4000};

function authorized(header,token){
  const a=Buffer.from(header??''),b=Buffer.from(`Bearer ${token}`);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function containsNonTextInput(value){
  if(Array.isArray(value))return value.some(containsNonTextInput);
  if(!value||typeof value!=='object')return false;
  if(['image_url','input_image','file','input_file'].includes(value.type))return true;
  return Object.values(value).some(containsNonTextInput);
}
export function reserveForPayload(body){
  if(body.model!=='deepseek-flash')throw new Error('model_not_allowed');
  if(!Array.isArray(body.messages)||!body.messages.length||body.n&&body.n!==1)throw new Error('invalid_request');
  if(containsNonTextInput(body.messages))throw new Error('unbounded_non_text_input');
  const output=body.max_tokens??body.max_completion_tokens;
  if(!Number.isInteger(output)||output<1||output>8192)throw new Error('explicit_output_cap_required');
  if(body.max_tokens!==undefined&&body.max_completion_tokens!==undefined)throw new Error('conflicting_output_caps');
  if(body.tools?.some(t=>t.type!=='function'))throw new Error('server_side_tools_not_allowed');
  // UTF-8 byte count is deliberately much more conservative than text tokenization.
  // Double it, plus per-message/function overhead, before reserving at peak uncached rates.
  const bytes=Buffer.byteLength(JSON.stringify(body),'utf8');
  const input=bytes*2+8192+256*(body.messages.length+(body.tools?.length??0));
  // This byte-derived value bounds spending; it is not a tokenizer result.
  // A large upper bound must not reject a history whose actual tokens still
  // fit the provider context. The monetary admission check remains authoritative.
  return {input_token_upper_bound:input,max_output_tokens:output,reserved_nano:input*PEAK.input+output*PEAK.output};
}
function billingRates(date){
  const d=new Date(new Date(date).getTime()+8*3600_000);
  const hour=d.getUTCHours(),day=d.getUTCDay();
  // Ignoring public holidays can only overestimate, never under-reserve a charge.
  return day>0&&day<6&&((hour>=9&&hour<12)||(hour>=14&&hour<18))?PEAK:OFFPEAK;
}
function normalizeUsage(u){
  if(!u||!Number.isSafeInteger(u.prompt_tokens)||u.prompt_tokens<0||!Number.isSafeInteger(u.completion_tokens)||u.completion_tokens<0)return null;
  const cache=u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens??0;
  if(!Number.isSafeInteger(cache)||cache<0||cache>u.prompt_tokens)return null;
  const total=u.prompt_tokens+u.completion_tokens;
  if(!Number.isSafeInteger(total)||u.total_tokens!==undefined&&u.total_tokens!==total)return null;
  return {input:u.prompt_tokens-cache,cache_read:cache,output:u.completion_tokens,total_tokens:total};
}
export async function startBudgetGateway({settings,token,ledgerPath,budgetCny=10,port=0,fetchImpl=fetch,maxConcurrent=4,
  waitForBudgetReservations=false,requestTimeoutMs=180000}){
  if(!token||token.length<32)throw new Error('Gateway token is required');
  if(!(budgetCny>0&&budgetCny<=10))throw new Error('Budget must be positive and at most CNY 10');
  if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1)throw new Error('Invalid bounded request timeout');
  const cap=Math.floor(budgetCny*NANO);
  await mkdir(path.dirname(ledgerPath),{recursive:true});
  const lockPath=`${ledgerPath}.lock`;
  let lock;
  try{lock=await open(lockPath,'wx');}catch(error){
    if(error.code!=='EEXIST')throw error;
    // Never steal a stale-looking lock: simultaneous recovery processes could
    // unlink each other's new lock and each allocate the full budget.
    throw new Error('Another gateway already owns this experiment budget or its lock requires explicit recovery');
  }
  await lock.writeFile(JSON.stringify({pid:process.pid,created_at:new Date().toISOString()}));
  await lock.close();
  let ledger;
  try{ledger=JSON.parse(await readFile(ledgerPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(ledger&&ledger.budget_nano!==cap)throw new Error('Cannot change an existing budget');
  ledger??={created_at:new Date().toISOString(),budget_cny:budgetCny,budget_nano:cap,model:'deepseek-flash',
    pricing_source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    reservation_policy:'Double complete UTF-8 payload bytes plus generous message/tool overhead; peak uncached input and bounded output. Unknown charges retain their full reservation.',requests:[]};
  if(!Array.isArray(ledger.requests))throw new Error('Invalid persisted budget ledger');
  for(const row of ledger.requests){
    for(const field of ['reserved_nano','charge_nano','charge_upper_bound_nano']){
      if(field==='reserved_nano'||row[field]!==undefined){
        if(!Number.isSafeInteger(row[field])||row[field]<0)throw new Error('Invalid persisted budget charge');
      }
    }
    if(row.charge_nano!==undefined&&row.charge_upper_bound_nano===undefined)throw new Error('Ledger is missing conservative settled charge bound');
    if(row.status==='pending')row.status='unknown_after_restart';
  }
  await mkdir(path.dirname(ledgerPath),{recursive:true});
  let writes=Promise.resolve(),frozen=false,active=0,peak=Number.isSafeInteger(ledger.summary?.peak_concurrency)?ledger.summary.peak_concurrency:0;
  const inFlight=new Set(),budgetWaiters=new Set();
  const notifyBudgetWaiters=()=>{for(const wake of [...budgetWaiters])wake();};
  const hasPendingReservation=()=>ledger.requests.some(row=>inFlight.has(row.id)&&row.status==='pending');
  const waitForSettlement=signal=>new Promise((resolve,reject)=>{
    const wake=()=>{budgetWaiters.delete(wake);signal.removeEventListener('abort',abort);resolve();};
    const abort=()=>{budgetWaiters.delete(wake);signal.removeEventListener('abort',abort);reject(signal.reason??new Error('Budget wait aborted'));};
    if(signal.aborted){abort();return;}
    budgetWaiters.add(wake);signal.addEventListener('abort',abort,{once:true});
  });
  const costBound=()=>ledger.requests.reduce((sum,r)=>sum+(r.charge_upper_bound_nano??r.reserved_nano),0);
  if(!Number.isSafeInteger(costBound())||costBound()>cap)throw new Error('Persisted budget is over its ceiling');
  const snapshot=()=>({budget_cny:budgetCny,accounted_upper_bound_cny:costBound()/NANO,
    usage_estimate_cny:ledger.requests.reduce((sum,r)=>sum+(r.charge_nano??0),0)/NANO,
    unknown_or_pending_reserved_cny:ledger.requests.filter(r=>r.charge_upper_bound_nano===undefined).reduce((sum,r)=>sum+r.reserved_nano,0)/NANO,
    remaining_cny:(cap-costBound())/NANO,requests:ledger.requests.length,active,peak_concurrency:peak,
    waiting_for_budget:budgetWaiters.size,frozen});
  const persist=()=>{
    writes=writes.then(async()=>{
      ledger.summary=snapshot();await writeFile(`${ledgerPath}.tmp`,JSON.stringify(ledger,null,2));
      // Windows readers can briefly prevent an atomic replacement. Retrying
      // only this filesystem operation never sends a duplicate model request.
      for(let attempt=0;;attempt++){
        try{await rename(`${ledgerPath}.tmp`,ledgerPath);break;}
        catch(error){if(attempt>=8||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));}
      }
    })
      .catch(e=>{frozen=true;throw e;});
    return writes;
  };
  await persist();
  const server=createServer(async(req,res)=>{
    const json=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}};
    if(!authorized(req.headers.authorization,token)){json(401,{error:{code:'unauthorized',message:'Gateway authentication failed'}});return;}
    if(req.method==='GET'&&req.url==='/budget'){json(200,snapshot());return;}
    if(req.method!=='POST'||!['/v1/chat/completions','/chat/completions'].includes(req.url)){json(404,{error:{code:'not_found',message:'Only bounded model inference is available'}});return;}
    if(frozen){json(503,{error:{code:'budget_frozen',message:'Budget accounting is frozen'}});return;}
    if(active>=maxConcurrent){json(503,{error:{code:'busy',message:'Model gateway concurrency limit'}});return;}
    let row;let observedUsage=null;let upstreamStatus;
    active++;peak=Math.max(peak,active);
    const controller=new AbortController();
    // Waiting requests have not incurred a provider charge. They can be
    // cancelled immediately; admitted streams continue draining as before.
    const abortUnadmitted=()=>{if(!row&&!res.writableEnded)controller.abort(new Error('Unadmitted client disconnected'));};
    res.on('close',abortUnadmitted);
    // A streaming SDK may close the downstream connection as soon as it sees
    // [DONE], before this proxy's upstream iterator observes EOF. Keep draining
    // the bounded upstream request so its final billing usage can be recorded.
    // Client cancellation never removes the reservation; real upstream failures
    // and the hard timeout still keep the full uncertain charge reserved.
    const timeout=setTimeout(()=>controller.abort(),requestTimeoutMs);
    try{
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>8*1024*1024)throw new Error('request_too_large');chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const reservation=reserveForPayload(body);
      while(costBound()+reservation.reserved_nano>cap){
        if(frozen){json(503,{error:{code:'budget_frozen',message:'Budget accounting is frozen'}});return;}
        // Only a still-running admitted request can release a reservation.
        // Historical unknown charges never justify waiting or a new budget.
        if(!waitForBudgetReservations||!hasPendingReservation()){
          json(402,{error:{code:'budget_exhausted',message:'CNY 10 ceiling: insufficient budget for this request'}});return;
        }
        await waitForSettlement(controller.signal);
      }
      if(frozen){json(503,{error:{code:'budget_frozen',message:'Budget accounting is frozen'}});return;}
      if(controller.signal.aborted||res.destroyed)throw new Error('Request cancelled before budget admission');
      row={id:randomUUID(),run_id:String(req.headers['x-toolathlon-run']??'unspecified').slice(0,160),
        started_at:new Date().toISOString(),status:'pending',...reservation};
      ledger.requests.push(row);inFlight.add(row.id);
      // Durable admission is completed before any paid request leaves the process.
      await persist();
      const upstream=await fetchImpl(`${settings.model.baseUrl.replace(/\/$/,'')}/chat/completions`,{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${settings.apiKey}`},
        body:JSON.stringify(body),signal:controller.signal,redirect:'error'});
      upstreamStatus=upstream.status;
      if(!upstream.ok){row.status=`upstream_http_${upstream.status}_charge_unknown`;json(502,{error:{code:'upstream_failed',message:`Model provider returned HTTP ${upstream.status}`}});return;}
      res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json','Cache-Control':'no-store'});
      if(body.stream){
        let pending='';const decoder=new TextDecoder();
        const inspect=line=>{
          if(!line.startsWith('data:'))return;
          try{const event=JSON.parse(line.slice(5).trim());if(event.usage)observedUsage=normalizeUsage(event.usage);if(event.model)row.response_model=String(event.model).slice(0,120);}catch{}
        };
        for await(const chunk of upstream.body){
          pending+=decoder.decode(chunk,{stream:true});
          let end;
          while((end=pending.indexOf('\n'))>=0){inspect(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1);}
          if(!res.destroyed)res.write(chunk);
        }
        pending+=decoder.decode();if(pending)inspect(pending.trim());
      }else{
        const text=await upstream.text();
        const parsed=JSON.parse(text);observedUsage=normalizeUsage(parsed.usage);row.response_model=parsed.model;
        if(!res.destroyed)res.write(text);
      }
      row.status=observedUsage?'settled':'usage_missing_charge_unknown';
      if(observedUsage){
        const rates=billingRates(row.started_at);
        const charge=observedUsage.input*rates.input+observedUsage.cache_read*rates.cache+observedUsage.output*rates.output;
        const upper=observedUsage.input*PEAK.input+observedUsage.cache_read*PEAK.cache+observedUsage.output*PEAK.output;
        row.usage=observedUsage;row.charge_nano=charge;row.charge_upper_bound_nano=upper;row.estimated_cost_cny=charge/NANO;
        if(observedUsage.input+observedUsage.cache_read>row.input_token_upper_bound||observedUsage.output>row.max_output_tokens||upper>row.reserved_nano){frozen=true;row.status='usage_bound_violation';}
      }
      if(!res.destroyed)res.end();
    }catch(error){
      if(row)row.status='transport_or_stream_failure_charge_unknown';
      if(!res.headersSent)json(400,{error:{code:row?'model_interrupted':'request_rejected',message:row?'Model request interrupted; full budget reservation retained':'Request failed bounded-input validation'}});
      else if(!res.destroyed)res.destroy();
    }finally{
      clearTimeout(timeout);res.off('close',abortUnadmitted);active--;
      if(row){
        row.finished_at=new Date().toISOString();row.upstream_status=upstreamStatus;
        await persist().catch(()=>{});
        inFlight.delete(row.id);notifyBudgetWaiters();
      }
    }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address();
  return {baseUrl:`http://127.0.0.1:${address.port}/v1`,token,status:snapshot,
    async close(){await new Promise(resolve=>server.close(resolve));await writes;await unlink(lockPath);},ledger};
}

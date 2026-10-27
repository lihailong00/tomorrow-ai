import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { resolveModel } from '../dist/config.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, 'artifacts/agent-benchmarks');
const limit = Number(process.env.BENCHMARK_CONCURRENCY ?? 100);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Concurrency must be 1..100');
const dry = process.argv.includes('--dry-run');
const only = process.argv.find(x => x.startsWith('--only='))?.slice(7);
const settings = dry ? undefined : resolveModel(process.env);
const usageZero = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0, model_requests: 0, tool_calls: 0 });
function normalUsage(u = {}) {
  return { input: u.input ?? 0, output: u.output ?? 0, cache_read: u.cache_read ?? u.cacheRead ?? 0,
    cache_write: u.cache_write ?? u.cacheWrite ?? 0, total_tokens: u.total_tokens ?? u.totalTokens ?? 0,
    model_requests: u.model_requests ?? 0, tool_calls: u.tool_calls ?? 0 };
}
function sumUsage(rows) {
  return rows.reduce((sum, row) => {
    const usage = normalUsage(row.usage);
    for (const key of Object.keys(sum)) sum[key] += usage[key];
    return sum;
  }, usageZero());
}
class Semaphore {
  active = 0; peak = 0; queue = [];
  constructor(max) { this.max = max; }
  async take() {
    if (this.active >= this.max) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    this.peak = Math.max(this.peak, this.active);
    return () => { const next=this.queue.shift(); if(next) next(); else this.active--; };
  }
  async with(action) { const release = await this.take(); try { return await action(); } finally { release(); } }
}
const allRequests = new Semaphore(limit);
// The live production sidecar is configured for four runs. Do not change the user's service settings.
const productRequests = new Semaphore(Math.min(limit, 4));
const modelLedger = [];
const sessions = [];
function cleanError(error) {
  let text = error instanceof Error ? error.message : String(error);
  if (settings?.apiKey) text = text.split(settings.apiKey).join('[REDACTED]');
  return text.slice(0, 2000);
}
function assistantText(message) {
  return Array.isArray(message?.content) ? message.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
}
function inputMessage(m) {
  const timestamp = Date.now();
  if (m.role === 'assistant') return { ...m, content: typeof m.content === 'string' ? [{type: 'text', text: m.content}] : m.content,
    api: settings.model.api, provider: settings.model.provider, model: settings.model.id,
    usage: {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:'stop',timestamp };
  return { ...m, timestamp };
}

async function runCore(options, caseId, stage = 'agent') {
  return allRequests.with(async () => {
    const start = Date.now(); const calls = []; const outputs = []; const turns = [];
    let turnCount = 0, toolCount = 0, timedOut = false, limitHit = false;
    const tools = (options.tools ?? []).map(def => ({ ...def, label: def.name, executionMode: 'sequential',
      execute: async (_id, args) => {
        const record = { name: def.name, arguments: args, tool_call_id:_id }; calls.push(record);
        try {
          record.result = options.executeTool ? await options.executeTool(def.name, args) : { benchmark_stub: true };
          return { content:[{type:'text',text:JSON.stringify(record.result)}], details:{benchmark:true} };
        } catch (error) { record.isError = true; record.error = cleanError(error); throw error; }
      },
    }));
    const agent = new Agent({
      initialState: { model: settings.model, thinkingLevel: 'off', tools,
        messages: [{role:'system',content:options.system ?? 'You are a helpful assistant.',timestamp:Date.now()}, ...(options.messages ?? []).map(inputMessage)] },
      toolExecution:'sequential',
      streamFn: (model, context, opts) => streamSimple(model, context, { ...opts, apiKey:settings.apiKey,
        maxTokens:options.maxTokens ?? 4096, temperature:options.temperature ?? 0,
        maxRetries:0, maxRetryDelayMs:1000, timeoutMs:options.timeoutMs ?? 180000,
      }),
      beforeToolCall: async () => {
        toolCount++;
        if (toolCount > (options.maxTools ?? 20)) { limitHit = true; return {block:true,reason:'Benchmark tool limit',terminate:true}; }
      },
      finishTurn: ({message}) => {
        turnCount++;
        if (options.stopAfterToolCall || turnCount >= (options.maxTurns ?? 10)) {
          if (!options.stopAfterToolCall && message.content.some(c=>c.type==='toolCall')) limitHit = true;
          return {action:'end'};
        }
      },
    });
    agent.subscribe(event => {
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        const message = event.message;
        for(const call of message.content.filter(c=>c.type==='toolCall')) {
          if(!calls.some(c=>c.tool_call_id===call.id)) calls.push({name:call.name,arguments:call.arguments,tool_call_id:call.id,isError:true,error:'Call rejected before execution'});
        }
        const u = normalUsage(message.usage); u.model_requests = 1;
        turns.push(u);
        outputs.push({role:'assistant',content:message.content.filter(c=>c.type!=='thinking'),stopReason:message.stopReason,
          response_model:message.responseModel,usage:u,error:message.errorMessage ? cleanError(message.errorMessage) : undefined});
      }
    });
    const timer = setTimeout(()=>{ timedOut=true; agent.abort(); },options.timeoutMs ?? 180000);
    let error;
    try { await agent.continue(); } catch (e) { error = cleanError(e); }
    finally { clearTimeout(timer); agent.abort(); }
    const last = [...agent.state.messages].reverse().find(m=>m.role==='assistant');
    if (timedOut) error = 'benchmark_timeout';
    if (limitHit) error = 'benchmark_step_limit';
    if (last && ['error','aborted','length'].includes(last.stopReason)) error ??= cleanError(last.errorMessage ?? last.stopReason);
    const usage = sumUsage(turns.map(usage=>({usage}))); usage.tool_calls = calls.length;
    const trace = { content:assistantText(last),calls,messages:outputs,usage,error,duration_ms:Date.now()-start };
    modelLedger.push({case_id:caseId,stage,started_at:new Date(start).toISOString(),duration_ms:trace.duration_ms,usage,
      error,usage_complete:!error || usage.total_tokens>0});
    return trace;
  });
}

const apiBase = (process.env.BENCHMARK_API_URL ?? 'http://127.0.0.1:8080').replace(/\/$/,'');
async function request(pathname, method='GET', body, token) {
  const response = await fetch(`${apiBase}/v1${pathname}`, { method,
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),signal:AbortSignal.timeout(125000),redirect:'error' });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${value.error?.message ?? 'API failure'}`);
  return value;
}
async function createUser(label, caseId) {
  const suffix=randomUUID();
  const auth=await request('/auth/register','POST',{email:`bench-${suffix}@tomorrow.local`,password:randomUUID(),name:String(label).slice(0,60),timezone:'Asia/Shanghai'});
  const token=auth.token;
  const api=(pathname,method,body)=>request(pathname,method,body,token);
  const session={api,
    async chat(prompt,conversationId) {
      return productRequests.with(()=>allRequests.with(async()=>{
        const start=Date.now();
        const reply=await api('/chat','POST',{message:prompt,client_request_id:randomUUID(),...(conversationId?{conversation_id:conversationId}:{})});
        const trace=reply.agent_run_id?await api(`/agent-runs/${reply.agent_run_id}`):undefined;
        const usage=normalUsage(trace?.usage);
        const result={content:reply.message.content,conversation_id:reply.conversation_id,run_id:reply.agent_run_id,trace,usage,duration_ms:Date.now()-start};
        modelLedger.push({case_id:caseId,stage:'product_chat',started_at:new Date(start).toISOString(),duration_ms:result.duration_ms,usage,usage_complete:!!trace?.usage});
        return result;
      }));
    },
    async cleanup() {
      if(session.cleaned) return;
      const failures=[];
      for(const resource of ['schedules','memories','tasks']) {
        try {
          const rows=(await api(`/${resource}`)).items;
          for(const item of rows) {
            try {
              if(resource==='tasks') {
                if(['pending','queued','waiting_approval','running'].includes(item.status)) await api(`/tasks/${item.id}/cancel`,'POST',{});
              } else await api(`/${resource}/${item.id}`,'DELETE');
            } catch(e) {failures.push(`${resource}: ${cleanError(e)}`);}
          }
        } catch(e){failures.push(`${resource}: ${cleanError(e)}`);}
      }
      try {await api('/auth/logout','POST',{});} catch(e){failures.push(`logout: ${cleanError(e)}`);}
      session.cleaned=true; session.cleanup_failures=failures;
      return failures;
    },
  };
  sessions.push(session); return session;
}

const modules = ['bfcl','toolsandbox','memory'];
const cases=[];
for(const name of modules) {
  const module=await import(`./${name}.mjs`);
  cases.push(...await module.loadCases());
}
if(cases.length!==40 || new Set(cases.map(c=>c.id)).size!==40) throw new Error('Expected 40 unique cases');
await mkdir(output,{recursive:true});
const manifest=cases.map(({run,...rest})=>rest);
await writeFile(path.join(output,'manifest.json'),JSON.stringify({created_at:new Date().toISOString(),cases:manifest},null,2));
if(dry){console.log(JSON.stringify({dry_run:true,total:cases.length,groups:manifest.reduce((a,c)=>(a[c.benchmark]=(a[c.benchmark]??0)+1,a),{})}));process.exit(0);}
const selected=only?cases.filter(c=>c.benchmark.toLowerCase()===only.toLowerCase() || c.id===only):cases;
if(selected.length===0) throw new Error('No benchmark cases selected');
const start=Date.now();
try {
  const previous=JSON.parse(await readFile(path.join(output,'results.json'),'utf8'));
  await copyFile(path.join(output,'results.json'),path.join(output,`results-${previous.started_at.replace(/[:.]/g,'-')}.json`));
} catch(error) {if(error.code!=='ENOENT') throw error;}
const report={started_at:new Date(start).toISOString(),harness:'Pi Agent Core 1.4.0',model:settings.model.id,
  model_config:{context_window:settings.model.contextWindow,reasoning_supported:settings.model.reasoning,thinking_level:'off',max_output_tokens:4096,core_temperature:0,core_max_retries:0},
  max_concurrency:limit,product_chat_concurrency:Math.min(limit,4),selected_cases:selected.length,
  comparability:'Selected subset. BFCL/Mem2Act: official questions with schema transport adapter; ToolSandbox: product adaptations; LongMemEval: full-context baseline, surrogate DeepSeek judge. Not a full official leaderboard score.',
  cases:[],model_calls:[],status:'running'};
let saveChain=Promise.resolve();
function save() {
  saveChain=saveChain.then(async()=>{
    report.model_calls=[...modelLedger];report.usage=sumUsage(modelLedger);
    report.peak_concurrency=allRequests.peak;
    const data=JSON.stringify(report,null,2);
    await writeFile(path.join(output,'results.tmp'),data);await rename(path.join(output,'results.tmp'),path.join(output,'results.json'));
  });return saveChain;
}
await save();
await Promise.all(selected.map(async test=>{
  const clock=Date.now();
  const ctx={
    runCore:opts=>runCore(opts,test.id),
    createUser:label=>createUser(label,test.id),
    async judge(options) {
      // Same prompt as the benchmark; model substitution is explicitly recorded.
      const {buildLongMemEvalJudgePrompt}=await import('./memory.mjs');
      const prompt=options.prompt ?? buildLongMemEvalJudgePrompt(options);
      const trace=await runCore({messages:[{role:'user',content:prompt}],tools:[],maxTokens:16,maxTurns:1,temperature:0},test.id,'judge');
      return {passed:!trace.error && /^yes\b/i.test(trace.content.trim()),raw:trace.content,usage:trace.usage,model:settings.model.id,error:trace.error};
    },
  };
  let result;
  try {result=await test.run(ctx);} catch(error) {result={passed:false,error:cleanError(error),execution_error:true};}
  report.cases.push({id:test.id,benchmark:test.benchmark,name:test.name,provenance:test.provenance,duration_ms:Date.now()-clock,...result});
  console.log(`${result.passed?'PASS':'FAIL'} ${test.id} (${Date.now()-clock} ms)`);
  await save();
}));
await Promise.all(sessions.map(s=>s.cleanup()));
report.cleanup_failures=sessions.flatMap(s=>s.cleanup_failures??[]);
report.cases.sort((a,b)=>cases.findIndex(c=>c.id===a.id)-cases.findIndex(c=>c.id===b.id));
report.status='completed';report.finished_at=new Date().toISOString();report.duration_ms=Date.now()-start;
report.passed=report.cases.filter(c=>c.passed).length;report.failed=report.cases.length-report.passed;
await save();
console.log(JSON.stringify({completed:true,passed:report.passed,failed:report.failed,duration_ms:report.duration_ms,usage:report.usage,report:path.join(output,'results.json')}));

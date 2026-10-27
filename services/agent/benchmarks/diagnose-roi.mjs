import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { resolveModel } from '../dist/config.js';
import { _test } from './bfcl.mjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// A separate controlled diagnostic. Official questions, scores and reports are never rewritten.
const dataRoot = new URL('../../../research/benchmarks/bfcl/', import.meta.url);
const output = new URL('../../../artifacts/agent-benchmarks/diagnostics/', import.meta.url);
const settings = resolveModel(process.env);
const text = await readFile(new URL('BFCL_v4_simple_python.json', dataRoot), 'utf8');
const row = text.trim().split(/\r?\n/).map(JSON.parse).find(r => r.id === 'simple_python_150');
if (!row) throw new Error('Pinned question missing');
const definition = {name: row.function[0].name,description:row.function[0].description,
  parameters:_test.jsonSchema(row.function[0].parameters)};
const system = 'You are an expert in composing functions. Use the provided tools to fulfill the user request when applicable. Do not invent tools or missing required values. If no function applies, respond without calling any tool.';
const messages = row.question.flat();
const variants = [
  {id:'original',description:definition.parameters.properties.annual_interest_rate.description,expected_rate:0.03},
  {id:'explicit_fraction',description:'The annual interest rate as a decimal fraction, not a percentage number. For example, 5% must be passed as 0.05.',expected_rate:0.03},
  {id:'explicit_percent',description:'The annual interest rate as a percentage number, not a decimal fraction. For example, 5% must be passed as 5.',expected_rate:3},
  {id:'plain_arithmetic',description:null},
];
const zero = () => ({input:0,output:0,cache_read:0,cache_write:0,total_tokens:0,model_requests:0});
function add(sum,u){sum.input+=u.input;sum.output+=u.output;sum.cache_read+=u.cacheRead;sum.cache_write+=u.cacheWrite;sum.total_tokens+=u.totalTokens;sum.model_requests++;}
async function run(variant,repeat) {
  const start=Date.now();const usage=zero();let payloadSummary;let timedOut=false;
  const tool=structuredClone(definition);
  if(variant.description) tool.parameters.properties.annual_interest_rate.description=variant.description;
  const tools=variant.id==='plain_arithmetic'?[]:[{...tool,label:tool.name,execute:async()=>({content:[{type:'text',text:'{"benchmark_stub":true}'}],details:{benchmark:true}})}];
  const agent=new Agent({initialState:{model:settings.model,thinkingLevel:'off',tools,
    messages:[{role:'system',content:variant.id==='plain_arithmetic'?'You are a helpful assistant. Answer briefly and include the interest earned in dollars, return percentage, and ending balance.':system,timestamp:Date.now()},
      ...messages.map(m=>({...m,timestamp:Date.now()}))]},toolExecution:'sequential',
    streamFn:(model,context,options)=>streamSimple(model,context,{...options,apiKey:settings.apiKey,maxTokens:4096,temperature:0,maxRetries:0,timeoutMs:60000,
      onPayload:payload=>{payloadSummary={model:payload.model,max_tokens:payload.max_tokens,max_completion_tokens:payload.max_completion_tokens,
        temperature:payload.temperature,thinking:payload.thinking};}}),
    finishTurn:()=>({action:'end'}),
  });
  agent.subscribe(event=>{if(event.type==='turn_end'&&event.message.role==='assistant') add(usage,event.message.usage);});
  const timer=setTimeout(()=>{timedOut=true;agent.abort();},60000);
  let error;
  try{await agent.continue();}catch(e){error=String(e?.message??e).split(settings.apiKey).join('[REDACTED]');}
  finally{clearTimeout(timer);agent.abort();}
  const response=[...agent.state.messages].reverse().find(m=>m.role==='assistant');
  if(timedOut) error='timeout';
  if(!response||['error','aborted','length'].includes(response.stopReason)) error??=response?.stopReason??'no_response';
  const calls=response?.content.filter(c=>c.type==='toolCall').map(c=>({name:c.name,arguments:c.arguments}))??[];
  const content=response?.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'';
  return {variant:variant.id,repeat,tool_rate_description:variant.description,content,calls,
    unit_contract_satisfied:variant.expected_rate===undefined?null:!error&&calls.length===1&&calls[0].name===definition.name&&calls[0].arguments.annual_interest_rate===variant.expected_rate&&calls[0].arguments.deposit===1000&&calls[0].arguments.years===1,
    expected_rate:variant.expected_rate,stop_reason:response?.stopReason,payload:payloadSummary,usage,error,duration_ms:Date.now()-start};
}
const started=new Date().toISOString();
const results=await Promise.all(variants.flatMap(v=>[1,2,3].map(n=>run(v,n))));
const usage=results.reduce((sum,r)=>{for(const k of Object.keys(sum))sum[k]+=r.usage[k];return sum;},zero());
const report={started_at:started,finished_at:new Date().toISOString(),diagnostic_only:true,
  source_id:row.id,source_revision:'6ea57973c7a6097fd7c5915698c54c17c5b1b6c8',source_sha256:createHash('sha256').update(text).digest('hex'),
  model:settings.model.id,pi_version:'1.4.0',thinking:'off',temperature:0,question:messages,
  design:'Three independent repetitions per condition. Same original user question. Tool variants differ only in the annual_interest_rate description. Plain arithmetic has no tool. Explicit-percent is a different contract and is never counted as passing the original BFCL task.',
  limitations:'Small controlled diagnostic; it supports an interface-unit explanation but does not reveal internal model reasoning or prove determinism. No actual banking API or ROI calculator is executed.',
  results,usage,official_benchmark_score_unchanged:true};
await mkdir(output,{recursive:true});
const name=`roi-diagnostic-${started.replace(/[:.]/g,'-')}.json`;
await writeFile(new URL(name,output),JSON.stringify(report,null,2));
console.log(JSON.stringify({file:new URL(name,output).pathname,results:results.map(r=>({variant:r.variant,repeat:r.repeat,calls:r.calls,content:r.content,passed:r.unit_contract_satisfied,error:r.error})),usage},null,2));

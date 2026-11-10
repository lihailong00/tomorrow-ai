/** Run the same turns as the phone through the real Rust chat stream. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../../../crates/connectors/src/personal_mcp/tencent_docs_fixture.json',import.meta.url),'utf8'));
const base = new URL(process.env.TADA_DEBUG_BASE_URL ?? 'http://127.0.0.1:18080');
const output = process.argv[2];
const email = process.env.TADA_TENCENT_DOCS_FIXTURE_EMAIL;
const password = process.env.TADA_TENCENT_DOCS_FIXTURE_PASSWORD;
assert.ok(email?.endsWith('@tada-debug.invalid') && password && output,'Debug account and report path are required');
assert.ok(base.protocol==='http:' && base.pathname==='/' && !base.username && !base.password && !base.search && !base.hash &&
  /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(base.hostname) && /^\d+(?:\.\d+){3}$/.test(base.hostname),
'Use a private sandbox URL');

let token;
async function request(path,body) {
  const response = await fetch(new URL('/v1'+path,base),{
    method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(100000),
    headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  assert.ok(response.ok,path+' returned HTTP '+response.status);
  return response;
}
async function json(path,body) { return (await request(path,body)).json(); }
const health = await json('/health');
token = (await json('/auth/login',{email,password})).token;
assert.ok(token);
const connections = await json('/personal-mcp');
assert.ok(connections.items.some(item=>item.id==='tencent_docs' && item.simulated===true && item.status==='connected'));

const normalize = text => text.normalize('NFKC').replaceAll(/\s/g,'');
const research = fixture.documents[0];
const rows = [];
const repeats = Number(process.env.TADA_DEBUG_REPEATS ?? 2);
assert.ok(Number.isInteger(repeats) && repeats>=1 && repeats<=5);
try {
  for (let repeat=1; repeat<=repeats; repeat++) {
    for (const rewrite of repeat%2 ? [false,true] : [true,false]) {
      let conversationId;
      for (const [index,question] of fixture.questions.entries()) {
        const start = performance.now();
        const response = await request('/chat/stream',{
          client_request_id:randomUUID(),conversation_id:conversationId,interaction_mode:'enabled',
          message:(rewrite?'【改写开】':'【改写关】')+question,remember:false,
        });
        const frames = (await response.text()).split(/\r?\n\r?\n/);
        const done = frames.find(frame=>/^event: done$/m.test(frame));
        const elapsedMs = Math.round(performance.now()-start);
        const data = done?.match(/^data: (.+)$/m)?.[1];
        if (!data) {
          const failure = frames.find(frame=>/^event: error$/m.test(frame))?.match(/^data: (.+)$/m)?.[1];
          rows.push({repeat,rewrite,turn:index+1,elapsed_ms:elapsedMs,pass:false,error:failure?JSON.parse(failure):'missing_done'});
          break;
        }
        const result = JSON.parse(data).response;
        conversationId = result.conversation_id;
        const trace = await json('/agent-runs/'+result.agent_run_id);
        const operations = trace.events.filter(event=>event.kind==='tool_start' && event.body.activity?.provider==='tencent_docs')
          .map(event=>({name:event.body.activity.operation,success:trace.events.some(end=>
            end.kind==='tool_end' && end.body.tool_call_id===event.body.tool_call_id && end.body.is_error===false)}));
        const searched = operations.some(op=>op.name==='search_documents' && op.success);
        const read = operations.some(op=>op.name==='read_document' && op.success);
        const answer = result.message.content;
        const normalized = normalize(answer);
        const facts = research.facts.every(fact=>normalized.includes(fact));
        const rewriteRequests = trace.usage?.query_rewrite_requests;
        const pass = trace.usage?.debug_scenario===fixture.id && trace.usage?.query_rewrite_enabled===rewrite &&
          (rewrite || rewriteRequests===0) && (index===0 ? searched && !read && /研发/.test(answer) && /销售/.test(answer) :
            index===1 ? !read && /研发/.test(answer) : read && facts && !normalized.includes('赵南') && (!rewrite || rewriteRequests===1));
        rows.push({repeat,rewrite,turn:index+1,elapsed_ms:elapsedMs,pass,operations,answer,
          rewrite_requests:rewriteRequests,model_requests:trace.usage?.model_requests,total_tokens:trace.usage?.total_tokens});
        console.log(JSON.stringify({repeat,rewrite,turn:index+1,pass,elapsed_ms:elapsedMs,rewrite_requests:rewriteRequests}));
      }
    }
  }
} finally {
  try { await json('/auth/logout',{}); } catch { /* Report the recorded runs even if logout fails. */ }
  const summary = [false,true].map(rewrite=>{
    const group = rows.filter(row=>row.rewrite===rewrite);
    const times = group.filter(row=>row.turn===3).map(row=>row.elapsed_ms).sort((a,b)=>a-b);
    return {rewrite,turns:group.length,turns_passed:group.filter(row=>row.pass).length,
      conversations_passed:Array.from({length:repeats},(_,i)=>i+1).filter(repeat=>
        group.filter(row=>row.repeat===repeat && row.pass).length===fixture.questions.length).length,
      final_turn_p50_ms:times.length?(times[Math.floor(times.length/2)]+times[Math.floor((times.length-1)/2)])/2:null,
      model_requests:group.reduce((sum,row)=>sum+(row.model_requests??0),0),
      rewrite_requests:group.reduce((sum,row)=>sum+(row.rewrite_requests??0),0)};
  });
  await writeFile(output,JSON.stringify({scenario:fixture.id,model:health.runtime.model_name,harness:health.runtime.agent_harness,repeats,summary,rows},null,2)+'\n');
  console.log(JSON.stringify(summary));
}
if (rows.length!==repeats*2*fixture.questions.length || rows.some(row=>!row.pass)) process.exitCode=1;

import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolveModel} from '../dist/config.js';
import {startBudgetGateway} from './budget-gateway.mjs';
import {runBundle} from './pi-host.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const i=arg.indexOf('=');return [arg.slice(2,i<0?undefined:i),i<0?true:arg.slice(i+1)];}));
const budget=Number(args.budget??10),limit=Number(args.limit??8),turns=Number(args.turns??80),concurrency=Number(args.concurrency??50),outputTokens=Number(args['output-tokens']??8192);
if(!(budget>0&&budget<=10)||!Number.isInteger(limit)||limit<1||limit>8||!Number.isInteger(turns)||turns<1||turns>100)throw new Error('Invalid benchmark budget or limits');
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>50)throw new Error('Concurrency must be 1..50');
if(!Number.isInteger(outputTokens)||outputTokens<1||outputTokens>8192)throw new Error('Output tokens must be 1..8192');
const sessionId=new Date().toISOString().replace(/[:.]/g,'-');
const output=path.resolve(root,args.output??`artifacts/toolathlon/runs/${sessionId}`);
const publicRoot=path.join(output,'tasks'),privateRoot=path.join(output,'private');
if(!output.startsWith(path.join(root,'artifacts','toolathlon')+path.sep))throw new Error('Output must be beneath artifacts/toolathlon');
await mkdir(output,{recursive:true});
const manifest=JSON.parse(await readFile(path.join(root,'research/toolathlon-integration.json'),'utf8'));
const tasks=manifest.tasks.slice(0,limit);
const sourceCommit=(await readFile(path.join(root,'.tools/toolathlon/SOURCE_COMMIT.txt'),'utf8')).trim();
if(sourceCommit!==manifest.source_commit)throw new Error('Official source revision mismatch');
const resumePath=args.resume?path.resolve(root,args.resume):null;
if(resumePath&&!resumePath.startsWith(path.join(root,'artifacts','toolathlon')+path.sep))throw new Error('Resume must be a Toolathlon results file');
const previous=resumePath?JSON.parse(await readFile(resumePath,'utf8')):null;
if(previous&&(previous.source_commit!==sourceCommit||previous.model!=='deepseek-flash'||!Array.isArray(previous.tasks)))throw new Error('Resume source/model mismatch');
const plan={benchmark:manifest.benchmark,source_commit:sourceCommit,selected:tasks.map(t=>t.source_id),budget_cny:budget,max_turns:turns,max_output_tokens:outputTokens,concurrency,
  repetitions:1,scoring_policy:'Integration smoke test with operationally incomplete attempts resumed after harness repairs. All attempts retained; not a pass@1 leaderboard submission.',selection:'Feasibility-selected local document/file tasks requiring no additional personal cloud accounts; not full leaderboard.',
  protocol:'Official preprocess, unmodified task prompts, actual MCP tools and official deterministic evaluators. Pi host agent loop; evaluator/groundtruth artifacts hidden during agent execution.',
  interaction_scope:'One user instruction followed by multiple sequential model/tool rounds, following the chosen tasks default. Not multi-user-turn conversation or dynamic-tool-discovery evidence.',
  evaluation_cost:'Selected official evaluators make no model calls. Every agent model request passes the single durable CNY budget gateway.',
  output_root:output,...(resumePath?{resume_from:resumePath}:{})};
await writeFile(path.join(output,'plan.json'),JSON.stringify(plan,null,2));
if(args['dry-run']){console.log(JSON.stringify({...plan,dry_run:true},null,2));process.exit(0);}
const settings=resolveModel(process.env);
if(settings.model.id!=='deepseek-flash'||new URL(settings.model.baseUrl).origin!=='https://api.deepseek.com')throw new Error('This cost policy is verified only for official DeepSeek Flash');
const gatewayToken=randomBytes(32).toString('hex');
// One ledger for the entire authorized experiment, including failed pilots and reruns.
// A fresh output directory must never silently grant another CNY 10.
const sharedLedger=path.join(root,'artifacts/toolathlon/budget-ledger.json');
const gateway=await startBudgetGateway({settings,token:gatewayToken,ledgerPath:sharedLedger,budgetCny:budget,maxConcurrent:concurrency,waitForBudgetReservations:true});
const proxySettings={apiKey:gatewayToken,model:{...settings.model,baseUrl:gateway.baseUrl}};
const report={...plan,started_at:new Date().toISOString(),status:'running',model:settings.model.id,thinking_level:'off',harness:'Pi Agent Core 1.4.0',tasks:[]};
if(previous)report.previous_attempts=[...(previous.previous_attempts??[]),...previous.tasks.map(item=>({
  source_id:item.source_id,status:item.status,passed:item.passed,agent_status:item.agent_status,
  output_dir:item.output_dir??item.artifact_dir??path.join(previous.output_root,'tasks',item.source_id.split('/')[1]),
  started_at:item.started_at,finished_at:item.finished_at,
  reason:item.agent?.error??item.error??item.evaluation?.details}))];
const redact=text=>String(text).split(settings.apiKey).join('[REDACTED]').split(gatewayToken).join('[REDACTED]');
const shell=process.env.TOMORROW_POWERSHELL??'C:/Program Files/PowerShell/7/pwsh.exe';
async function powershell(script,parameters,log){
  const safeEnv={...process.env};
  for(const name of ['DEEPSEEK_API_KEY','MODEL_API_KEY','TOOLATHLON_OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY'])delete safeEnv[name];
  return new Promise((resolve,reject)=>{
    const child=spawn(shell,['-NoProfile','-NonInteractive','-File',path.join(root,'scripts',script),...parameters],{cwd:root,env:safeEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text='';
    child.stdout.on('data',chunk=>{text+=chunk.toString();});child.stderr.on('data',chunk=>{text+=chunk.toString();});
    child.once('error',reject);
    child.once('close',async code=>{
      try{await mkdir(path.dirname(log),{recursive:true});await writeFile(log,redact(text));
        if(code===0)resolve(text);else reject(new Error(`${script} exited ${code}; see private infrastructure log`));
      }catch(e){reject(e);}
    });
  });
}
let saveWrites=Promise.resolve();
const save=()=>{
  report.budget=gateway.status();const snapshot=JSON.stringify(report,null,2);
  saveWrites=saveWrites.then(async()=>{const filename=path.join(output,'results.json');await writeFile(`${filename}.tmp`,snapshot);await rename(`${filename}.tmp`,filename);});
  return saveWrites;
};
await save();
try{
  let cursor=0,stopDispatch=false;
  const executeTask=async index=>{
    const task=tasks[index],name=task.source_id.split('/')[1],port=18761+index;
    const completed=previous?.tasks.find(item=>item.source_id===task.source_id&&typeof item.evaluation?.pass==='boolean'&&item.agent_status==='success');
    if(completed){
      report.tasks.push({...completed,agent_limits:completed.agent_limits??{max_turns:previous.max_turns,max_output_tokens:previous.max_output_tokens??4096},output_dir:completed.output_dir??completed.artifact_dir??path.join(previous.output_root,'tasks',name),reused_from:resumePath});
      await save();console.log(`KEEP ${completed.passed?'PASS':'FAIL'} ${task.source_id} | no new model requests`);return;
    }
    const container=`tomorrow-toolathlon-${name}-${randomBytes(3).toString('hex')}`;
    const outputDir=path.join(publicRoot,name),privateDir=path.join(privateRoot,name);
    const item={source_id:task.source_id,label_zh:task.label_zh,official_source:task.official_source,
      status:'preparing',started_at:new Date().toISOString(),container,gateway_port:port,output_dir:outputDir,agent_limits:{max_turns:turns,max_output_tokens:outputTokens}};
    report.tasks.push(item);await save();
    console.log(`PREPARE ${task.source_id} | budget available CNY ${gateway.status().remaining_cny.toFixed(4)}`);
    let started=false;
    try{
      await powershell('toolathlon-infra.ps1',['-Action','Start','-Task',name,'-GatewayPort',String(port),'-ContainerName',container,'-OutputRoot',publicRoot],path.join(privateDir,'start.log'));
      started=true;
      await powershell('toolathlon-task.ps1',['-Action','Prepare','-Task',name,'-ContainerName',container,'-OutputRoot',publicRoot,'-PrivateRoot',privateRoot,'-GatewayPort',String(port),'-MaxSteps',String(turns)],path.join(privateDir,'prepare.log'));
      item.status='agent_running';await save();
      const trajectory=await runBundle({bundle:path.join(privateDir,'agent_bundle.json'),gatewayUrl:`http://127.0.0.1:${port}/sse`,
        settings:proxySettings,outputDir,maxTurns:turns,maxOutputTokens:outputTokens,maxToolCalls:500,timeoutMs:20*60_000,runId:`${sessionId}:${task.source_id}`});
      item.agent_status=trajectory.status;
      item.agent=trajectory.tomorrow_pi;
      item.key_stats=trajectory.key_stats;
      item.status='evaluating';await save();
      await powershell('toolathlon-task.ps1',['-Action','Evaluate','-Task',name,'-ContainerName',container,'-OutputRoot',publicRoot,'-PrivateRoot',privateRoot,'-GatewayPort',String(port),'-MaxSteps',String(turns),'-AgentExitCode',trajectory.status==='success'?'0':'1'],path.join(privateDir,'evaluate.log'));
      const evaluation=JSON.parse(await readFile(path.join(outputDir,'eval_res.json'),'utf8'));
      item.evaluation=evaluation;
      // Only the official boolean result can mark a task passed; no textual self-claim does so.
      const verdict=Object.hasOwn(evaluation,'pass')?evaluation.pass:evaluation.success??evaluation.evaluation_status??evaluation.passed;
      if(typeof verdict!=='boolean'&&verdict!==null)throw new Error('Official evaluation result has no recognized verdict');
      item.passed=verdict===true;item.status=verdict===true?'passed':verdict===null?'agent_incomplete':'failed';
      console.log(`${verdict?'PASS':'FAIL'} ${task.source_id} | budget accounted CNY ${gateway.status().accounted_upper_bound_cny.toFixed(4)}`);
    }catch(e){
      item.status='infrastructure_or_adapter_error';item.error=redact(e?.message??e).slice(0,2000);
      console.log(`ERROR ${task.source_id}: ${item.error}`);
    }finally{
      item.finished_at=new Date().toISOString();
      if(started){try{await powershell('toolathlon-infra.ps1',['-Action','Stop','-ContainerName',container],path.join(privateDir,'cleanup.log'));}catch(e){item.cleanup_error=redact(e?.message??e);}}
      await save();
    }
    if(item.status==='infrastructure_or_adapter_error'){
      report.stop_reason='Pilot infrastructure/adapter must be repaired before dispatching more tasks';stopDispatch=true;return;
    }
    if(gateway.status().remaining_cny<0.2||gateway.status().frozen||String(item.agent?.error??'').includes('budget_exhausted')){report.stop_reason='Budget reserve threshold reached';stopDispatch=true;}
  };
  const worker=async()=>{while(!stopDispatch&&cursor<tasks.length){const index=cursor++;await executeTask(index);}};
  await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},()=>worker()));
  report.tasks.sort((a,b)=>tasks.findIndex(t=>t.source_id===a.source_id)-tasks.findIndex(t=>t.source_id===b.source_id));
}finally{
  report.finished_at=new Date().toISOString();report.status='completed';
  report.passed=report.tasks.filter(t=>t.passed).length;
  report.failed=report.tasks.filter(t=>t.evaluation?.pass===false).length;
  report.incomplete=report.tasks.filter(t=>t.status==='agent_incomplete').length;
  report.infrastructure_errors=report.tasks.filter(t=>t.status==='infrastructure_or_adapter_error').length;
  await gateway.close();report.experiment_peak_concurrency=gateway.status().peak_concurrency;await save();
  await writeFile(path.join(output,'budget-ledger.json'),await readFile(sharedLedger,'utf8'));
  await writeFile(path.join(root,'artifacts/toolathlon/latest.json'),JSON.stringify({output,...report},null,2));
}
console.log(JSON.stringify({report:path.join(output,'results.json'),passed:report.passed,failed:report.failed,infrastructure_errors:report.infrastructure_errors,budget:report.budget}));

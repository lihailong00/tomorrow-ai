import {readFile,writeFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const directory=new URL('../../../artifacts/agent-benchmarks/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,directory),'utf8'));
const report=await read('results.json');
if(report.status!=='completed'||report.cases.length!==40) throw new Error('A complete 40-case run is required');
const productCases=report.cases.filter(test=>test.benchmark==='ToolSandbox');
const coverage={
  purpose:'基础回归与局部诊断，不是完整 Agent 能力验收',
  total:40,
  online_multi_turn_cases:productCases.filter(test=>test.chats.length>1).map(test=>({id:test.id,user_turns:test.chats.length})),
  online_multi_turn_max_user_turns:Math.max(...productCases.map(test=>test.chats.length)),
  bfcl:{cases:16,maximum_candidate_tools:Math.max(...report.cases.filter(test=>test.benchmark==='BFCL').map(test=>test.tool_definitions.length)),first_response_only:true,official_multi_turn_runner_used:false},
  mem2act:{cases:4,only_target_tool_exposed:true,broad_tool_selection_tested:false},
  longmemeval:{cases:8,full_history_in_single_request:true,online_user_interaction:false,product_automatic_memory_ingestion_tested:false},
  dynamic_tool_visibility:{tested:false,product_implemented:false},
  product_capabilities:{fixed_chat_tools:13,max_tools_per_run:20,active_tool_list_refreshed_within_run:false,tool_search_or_discovery:false},
  conclusion:'33/40 only summarizes this fixed subset. It does not establish multi-turn planning, large-catalog tool selection, or dynamic tool discovery capability.',
};
await writeFile(new URL('coverage-audit.json',directory),JSON.stringify(coverage,null,2));
const leaderboardSelection={checked_on:'2026-10-26',criteria:['Official public leaderboard with recent mainstream-model entries','Pinned executable environments and verifiable state-based scoring','Prefer complete trajectories, explicit harness and reasoning settings','Distinguish model-release date from evaluation/update date'],boards:[
  {name:'Toolathlon-Verified',priority:'primary',url:'https://toolathlon.xyz/docs/leaderboard',
    observed_models:['GPT-5.5','Claude Opus 4.8','Claude Sonnet 5','Gemini 3.5 Flash','DeepSeek V4 Pro 0813','Kimi K3','GLM 5.3 Flash'],
    date_note:'Current Verified series released 2026-06-30; latest evaluation date visible in the current table is 2026-08-30. Not proof that all newly released models have been evaluated.',
    scope:'Long-horizon cross-application execution; 108 tasks; 604 tools across 32 MCP servers plus local toolkits. Catalog total is not per-task exposure. Agent turns are not necessarily user-dialogue turns.',
    comparison:'Current rows use Agent=Default; checkmarks indicate evaluations by benchmark authors. Keep Verified separate from the archived score series.'},
  {name:'tau3-Banking / tau-bench',priority:'primary',url:'https://taubench.com/leaderboard/?benchmark=core',
    observed_models:['GPT-5.6-sol','GPT-5.5','Claude Opus 5','Qwen 3.8 Max','Grok 4.5','Kimi K3'],
    date_note:'The Released column is model release date, not evaluation date. No single latest-evaluation timestamp confirmed.',
    scope:'Interactive user simulation, domain policies, knowledge retrieval and tool execution.',
    comparison:'Match the exact task set, release, retrieval mode, reasoning setting and user simulator; do not mix tau2, tau3, text-v1 or versioned score series.'},
  {name:'MCPMark Verified',priority:'supplementary',url:'https://mcpmark.ai/leaderboard/verified',
    observed_models:['GPT-5.6-sol','GPT-5.5','Claude Fable 5','Claude Opus 4.8','Kimi K3','DeepSeek V4 Pro'],
    date_note:'Leaderboard updated 2026-07-20; current Verified panel has 127 tasks and eight model entries.',
    scope:'Executable MCP tasks across filesystem, GitHub, Notion, Playwright and PostgreSQL.',
    comparison:'Current Verified results are single-run only. Opus 4.8 and Kimi K2.6 are scores-only entries without per-task traces.'},
],diagnostic_only:[{name:'BFCL',url:'https://gorilla.cs.berkeley.edu/leaderboard.html',reason:'Page last updated 2026-04-12; retain multi-turn/missing-function diagnostics, not the primary recent-model comparison.'}],
uncovered_requirement:'A large catalog and a recent-model leaderboard do not by themselves prove runtime tool discovery, authorization-based exposure or revocation. Keep these as explicit separate tests.'};
await writeFile(new URL('leaderboard-selection.json',directory),JSON.stringify(leaderboardSelection,null,2));
const advancedPlan={status:'proposed_not_run',leaderboard_selection:'leaderboard-selection.json',official_interactive_episodes:[
  {source:'Toolathlon-Verified',count:20,selection:'Diverse complete cross-application tasks from the current Verified series',protocol:'Keep initialization, executable tools and final state evaluators; adapt Pi agent loop explicitly',url:'https://toolathlon.xyz/docs/leaderboard'},
  {source:'tau-bench',count:12,selection:'Current text interaction tasks, prioritizing the exact Banking leaderboard protocol and a pinned task set',protocol:'Retain interactive user simulator, domain rules, retrieval configuration and original grading; record exact score series',url:'https://taubench.com/leaderboard/?benchmark=core'},
  {source:'MCPMark Verified',count:8,selection:'Version-pinned executable tasks across representative MCP services',protocol:'Retain service state initialization and deterministic evaluation; disclose Pi scaffold and model reasoning setting',url:'https://mcpmark.ai/leaderboard/verified'},
],dynamic_product_extension:{count:20,status:'requires_new_product_capabilities_or_explicitly_labelled_simulator',catalog_sizes:[100,300,1000],
  initially_visible_tools:['get_current_time','search_tools'],per_stage_visible_target:[5,10],
  scenarios:['discover tools among near-name distractors','user authorization reveals read tools','confirmed draft unlocks scoped submission','permission revoked during execution','tool failure or version replacement without duplicate effects'],
  scoring:'Task state, authorization boundaries, discovery and visibility trace, no duplicate effects; do not report simulator-only features as existing product capability'},
repetitions_per_episode:3,global_concurrency_ceiling:100,
metrics:['first-attempt task success','all-three-attempts success','constraint and authorization compliance','unnecessary or hallucinated tool calls','recovery without duplicate effects','complete token/cost ledger including simulated users and judges'],
mandatory_distinction:'Official episodes, product adaptations and dynamic-tool simulator extensions must be reported separately. Do not merge them into an official leaderboard score.',
};
await writeFile(new URL('advanced-evaluation-plan.json',directory),JSON.stringify(advancedPlan,null,2));
const files=await readdir(directory);
const prior=await Promise.all(files.filter(name=>/^results-.*\.json$/.test(name)).map(read));
const finalReview=await read('final-manual-review.json');
const memoryReview=await read('memory-manual-review.json');
let roiDiagnosis;
try{roiDiagnosis=await read('diagnostics/roi-unit-diagnosis.json');}catch(error){if(error.code!=='ENOENT')throw error;}
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pretty=value=>esc(JSON.stringify(value,null,2));
const date=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date(value));
const allRuns=[...prior,report].sort((a,b)=>a.started_at.localeCompare(b.started_at));
const allCalls=allRuns.flatMap(run=>run.model_calls);
const usage=allCalls.reduce((a,row)=>{
  for(const key of Object.keys(a)) a[key]+=row.usage?.[key]??0;
  return a;
},{input:0,output:0,cache_read:0,cache_write:0,total_tokens:0,model_requests:0,tool_calls:0});
// These runs took place after 22:00 China time, outside both published peak windows.
for(const row of allCalls){
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(new Date(row.started_at)));
  if(hour>=9&&hour<12||hour>=14&&hour<18) throw new Error('Rate selection needs review for peak-hour calls');
}
const estimate=u=>((u?.input??0)+(u?.cache_read??0)*0.02+(u?.output??0)*4)/1000000;
const cost={currency:'CNY',estimate:estimate(usage),basis:'Reported uncached input × 1 + cache-read × 0.02 + output × 4, divided by 1,000,000; off-peak rates.',
  source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',includes:'Both full 40-case runs and all eight answer-judge calls. Preparation/model-free tests do not call model APIs.',
  account_bill:false,usage_complete:allCalls.every(row=>row.usage_complete),by_run:allRuns.map(r=>({started_at:r.started_at,estimate:estimate(r.usage),usage:r.usage}))};
const reviewRows=finalReview.cases??finalReview.reviews??[];
const memoryRows=memoryReview.cases??memoryReview.reviews??[];
function reviewOf(id){return [...reviewRows,...memoryRows].find(row=>(row.id??row.case_id)===id);}
// An unsupported operational recommendation is a failure even when database state is correct.
function auditedPass(test){
  const review=reviewOf(test.id);
  const taskCompleted=typeof review?.task_completion==='boolean'?review.task_completion:test.passed;
  return taskCompleted && !(review?.verdict==='fail'||review?.passed===false||review?.unsupported_guidance===true);
}
function strictPass(test){return auditedPass(test)&&reviewOf(test.id)?.policy_following!==false;}
const groups=[...new Set(report.cases.map(c=>c.benchmark))].map(name=>{
  const rows=report.cases.filter(c=>c.benchmark===name);
  return {name,total:rows.length,automated_passed:rows.filter(c=>c.passed).length,audited_passed:rows.filter(auditedPass).length,strict_passed:rows.filter(strictPass).length};
});
const summary={tested_at:report.finished_at,model:report.model,model_config:report.model_config,
  evaluation_scope:'基础回归与局部诊断；多轮、大工具池、动态工具发现覆盖不足',coverage_audit:'coverage-audit.json',advanced_plan:'advanced-evaluation-plan.json',
  total:40,automated_passed:report.passed,audited_passed:report.cases.filter(auditedPass).length,groups,
  strict_passed:report.cases.filter(strictPass).length,
  roi_diagnostic:roiDiagnosis?{source:'diagnostics/roi-unit-diagnosis.json',original_benchmark_score_unchanged:true,usage_separate_from_original_runs:roiDiagnosis.usage}:undefined,
  max_concurrency:report.max_concurrency,observed_peak_concurrency:report.peak_concurrency,
  final_run_duration_ms:report.duration_ms,all_attempts:allRuns.reduce((sum,r)=>sum+r.cases.length,0),usage_all_attempts:usage,cost,
  limitations:[
    'Fixed small subsets; no official full leaderboard claim or confidence estimate.',
    'BFCL grades first-response tool calls against its pinned official AST checker, not full real-world task execution.',
    'ToolSandbox questions are mapped product scenarios. They use the live Rust API, real Pi model calls, separate users, and database-state assertions.',
    'LongMemEval supplies complete S histories to Pi core. It is not Tomorrow automatic long-term-memory ingestion or retrieval. Judge prompt follows the authors; DeepSeek replaces their listed judge models.',
    'Mem2Act supplies full associated mixed sessions and the target tool schema to an isolated call recorder, grading exact JSON arguments. It does not test broad candidate-tool selection.',
    'Initial run exposed stale context metadata and ineffective thinking-off configuration. Initial responses and charges are retained; final run repeats all 40 rather than only failed cases.',
  ],cleanup_failures:report.cleanup_failures};
await writeFile(new URL('summary.json',directory),JSON.stringify(summary,null,2));
const notes={
  BFCL:'官方原题、原参数标准；检查第一轮工具调用。',
  ToolSandbox:'个人助理产品改编题，经过真实 Rust + Pi 流程；另人工核验操作指引。',
  'LongMemEval-S':'完整长历史上下文基线；使用 DeepSeek 替代官方列出的评分模型。',
  'Mem2ActBench-small':'历史到工具参数；严格计分保留两道题目的歧义标记。',
};
function answerOf(test){
  if(test.chats) return test.chats.map((chat,i)=>`第 ${i+1} 轮：\n${chat.content}`).join('\n\n');
  return test.answer??test.trace?.content??'';
}
function callsOf(test){
  if(test.chats) return test.chats.map(c=>({run_id:c.run_id,tools:c.trace?.events.filter(e=>e.kind==='tool_start').map(e=>e.body),usage:c.usage}));
  return test.proposed_calls??test.trace?.calls??[];
}
function roiNote(test){
  if(test.id!=='bfcl:simple_python_150'||!roiDiagnosis)return '';
  const names={original:'原始工具说明',explicit_fraction:'仅明确要求小数比例',explicit_percent:'仅明确要求百分数数值',plain_arithmetic:'不调用工具，直接计算'};
  return `<h3>专项复核：利率单位不匹配</h3><p>原始工具说明只写“银行年利率”，没有规定 3% 应传 3 还是 0.03；模型实际传 3，而官方参考只接受 0.03。这一项评的是首轮参数，未执行真实收益计算。</p>
  <table><thead><tr><th>保持原问题的对照条件</th><th>三次结果</th></tr></thead><tbody>${roiDiagnosis.conditions.map(c=>`<tr><td>${esc(names[c.id])}</td><td>${c.id==='plain_arithmetic'?'3/3 均正确：利息 $30、本息 $1,030':esc(c.rate_values.join('、'))}</td></tr>`).join('')}</tbody></table>
  <p>证据支持参数单位约定不明确是本题的重要因素，不支持“模型不会做简单乘法”的结论。明确百分数的对照属于另一种工具契约，其结果不能用于提高原题成绩；官方失败判定保持不变。</p>
  <p class="muted">专项诊断另用 12 次模型请求、4,800 Token，未计入上方原两轮测试费用。完整数据见 diagnostics/roi-unit-diagnosis.json；本结论基于可见输出，不推断模型内部思维。</p>`;
}
const caseHtml=report.cases.map(test=>{
  const review=reviewOf(test.id);
  const ok=auditedPass(test);
  return `<details class="case ${ok?'pass':'fail'}"><summary><span class="badge">${ok?'通过':'未通过'}</span> ${esc(test.id)} · ${esc(test.name)}${ok&&!strictPass(test)?'（流程提醒）':''}</summary>
  <p class="muted">${esc(test.benchmark)} · ${esc(test.provenance?.mode)} · ${(test.duration_ms/1000).toFixed(2)} 秒</p>
  <h3>问题 / 场景</h3><pre>${typeof test.question==='string'?esc(test.question):pretty(test.question??test.name)}</pre>
  <h3>实际回答</h3><pre>${esc(answerOf(test)||'本题以工具调用计分，无最终文字回答。')}</pre>
  <h3>工具调用</h3><pre>${pretty(callsOf(test))}</pre>
  <h3>评分检查</h3><pre>${pretty(test.checks)}</pre>
  ${roiNote(test)}
  ${test.reference!==undefined?`<h3>参考答案</h3><pre>${esc(test.reference)}</pre>`:''}
  ${test.expected_tool_call||test.expected?`<h3>预期工具调用</h3><pre>${pretty(test.expected_tool_call??test.expected)}</pre>`:''}
  ${test.evaluation&&!test.passed?`<h3>官方评分器说明</h3><pre>${pretty(test.evaluation)}</pre>`:''}
  ${review?`<h3>人工复核</h3><pre>${pretty(review)}</pre>`:''}
  <h3>来源与适配</h3><pre>${pretty(test.provenance)}</pre></details>`;
}).join('\n');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tomorrow Agent · 40 题基础回归</title>
<style>body{margin:0;background:#f4f6fa;color:#202c43;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1080px;margin:40px auto;padding:0 24px 64px}h1{font-size:32px;letter-spacing:-1px}h2{font-size:22px;margin-top:32px}h3{font-size:16px;margin-bottom:8px}.muted{color:#62718a;font-size:14px}.panel,.case{background:white;border:1px solid #dfe5ee;border-radius:16px;padding:22px;margin:14px 0}.stats{display:flex;flex-wrap:wrap;gap:30px}.stats strong{display:block;font-size:30px;color:#2f52a2}table{border-collapse:collapse;width:100%}td,th{padding:12px 10px;text-align:left;border-bottom:1px solid #e8edf4}th{font-size:14px;color:#62718a}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,Consolas,monospace;background:#f7f9fc;padding:16px;border-radius:10px;max-height:600px;overflow:auto}summary{cursor:pointer;font-weight:600}a{color:#385dbb}.badge{display:inline-block;border-radius:20px;padding:2px 10px;font-size:13px;background:#e6f2ed;color:#25734d;margin-right:8px}.fail .badge{background:#fff0e8;color:#a94b24}.notice{border-left:4px solid #577dc4;padding-left:18px}@media(max-width:650px){main{padding:0 14px}td,th{padding:8px 5px;font-size:13px}.panel,.case{padding:15px}}</style>
<main><p class="muted">Tomorrow AI / Agent evaluation · ${esc(date(report.finished_at))}（北京时间）</p><h1>40 道基础回归：覆盖范围与结果</h1>
<p class="notice"><strong>本轮覆盖不足，不能据此判断完整 Agent 能力。</strong>只包含 2 道两轮用户澄清；BFCL 每题候选工具最多 4 个；Mem2Act 仅提供目标工具；没有动态工具暴露或工具发现评测。完整长历史读入也不等同于在线多轮交互。</p>
<div class="panel"><h2 style="margin-top:0">已测到哪里</h2><table><thead><tr><th>维度</th><th>本轮范围</th><th>结论边界</th></tr></thead><tbody>
<tr><td>用户多轮交互</td><td>仅 2 道两轮澄清</td><td>未覆盖长期改口、复杂分支与持续协作</td></tr>
<tr><td>候选工具选择</td><td>BFCL 最多 4 个；Mem2Act 只有目标工具</td><td>没有百级工具池选择或主动检索</td></tr>
<tr><td>动态工具暴露</td><td>未测；当前产品未接入</td><td>不能声称会按需发现、授权解锁或撤权刷新工具</td></tr>
<tr><td>有状态业务操作</td><td>固定 13 个聊天业务工具，真实数据库检查</td><td>只代表已选产品场景</td></tr>
<tr><td>长历史</td><td>完整历史随单次请求传入</td><td>不是自动长期记忆摄取与持续检索成绩</td></tr>
</tbody></table></div>
<div class="panel stats"><div><strong>${summary.audited_passed} / 40</strong>复核后任务通过；全流程 ${summary.strict_passed}/40</div><div><strong>${(report.duration_ms/1000).toFixed(1)} 秒</strong>最终一轮纯执行时间</div><div><strong>¥ ${cost.estimate.toFixed(4)}</strong>两轮合计估算费用</div></div>
<p class="notice">这是四类题目的固定小样本，测试范围不同，合计仅用于记录本轮检查。它不是官方完整榜单成绩，也不能代表自动长期记忆系统已经通过评测。</p>
<div class="panel"><table><thead><tr><th>题库</th><th>自动通过</th><th>任务通过</th><th>严格流程</th><th>测试范围</th></tr></thead><tbody>${groups.map(g=>`<tr><td>${esc(g.name)}</td><td>${g.automated_passed}/${g.total}</td><td>${g.audited_passed}/${g.total}</td><td>${g.strict_passed}/${g.total}</td><td>${esc(notes[g.name])}</td></tr>`).join('')}</tbody></table></div>
<h2>如何读这些结果</h2><ul><li>修正了两项接入配置：官方 DeepSeek Flash 上下文从旧 128K 元数据改为 1M；使 Pi 的“关闭思考”实际发送到供应商。15 项本地测试通过，并完整重跑 40 题。</li><li>ToolSandbox 的“最近计划”查询与暂停均完成正确，但遗漏系统要求的当前时间查询，因此两题严格流程检查未通过。指定星期的题目还存在虚构可选首次运行日期的操作指引。人工复核纠正了一项自动误通过和一项任务完成度误失败；自动与复核总数恰好相同，失败题目不同。</li><li>Mem2Act 的严格标签分数保留；其中两题的“家乡”和“那个演出”缺少唯一指代，应同时查看人工歧义审核，不能全部归因为模型忘记历史。</li><li>LongMemEval 保留完整历史、日期与问题，不将参考答案或证据字段放入模型输入。完整历史直接提供给 Pi core，未经过产品的自动记忆流程。</li></ul>
<h2>费用与并发</h2><p>全局并发上限 ${report.max_concurrency}，最终一轮观测峰值 ${report.peak_concurrency}。真实业务聊天另遵循当前服务的 4 并发限制；多轮题内顺序执行。</p>
<p>两轮共 ${summary.all_attempts} 次题目执行、${usage.model_requests} 次模型请求（含 8 次答案评分），总计 ${usage.total_tokens.toLocaleString('en-US')} Token。未缓存输入 ${usage.input.toLocaleString('en-US')}，缓存读取 ${usage.cache_read.toLocaleString('en-US')}，输出 ${usage.output.toLocaleString('en-US')}。按测试时段的<a href="${cost.source}">DeepSeek 官方闲时价格</a>估算 ¥${cost.estimate.toFixed(6)}；这不是账户实际账单。</p>
<details><summary>每轮费用与完整用量</summary><pre>${pretty(cost)}</pre></details>
<h2>下一轮榜单选择：近期主流模型参与（2026-10-26 核验）</h2>
<div class="panel"><table><thead><tr><th>公开榜单</th><th>已看到的模型示例</th><th>使用定位</th></tr></thead><tbody>${leaderboardSelection.boards.map(b=>`<tr><td><a href="${esc(b.url)}">${esc(b.name)}</a></td><td>${esc(b.observed_models.slice(0,6).join('、'))}</td><td>${b.priority==='primary'?'主测':'补充'}</td></tr>`).join('')}</tbody></table></div>
<p>Toolathlon 当前 Verified 表可见 2026-08-30 的评测条目；MCPMark Verified 页面更新于 2026-07-20。τ 表的 Released 是模型发布日期，不能当成评测日期。BFCL 页面最后更新为 2026-04-12，保留作专项诊断。</p>
<p>上述榜单是模型与具体执行框架共同参与的成绩。接入 Pi 时必须标明 harness、推理强度、工具暴露策略和任务版本，不能直接把已有模型行当成 Tomorrow 的成绩。大工具目录也不等于每题都暴露全部工具，更不等于已测动态发现。</p>
<h2>建议下一轮：完整交互与动态工具（尚未执行）</h2>
<p>按“近期主流模型已参评”调整后的 40 个公开任务抽样：Toolathlon-Verified 20 个、τ-bench 当前文本交互协议 12 个、MCPMark Verified 8 个。保留原环境、真实可执行工具、交互与状态评分，完整执行每个任务。BFCL 多轮/缺失工具和 ToolSandbox 原环境保留为额外诊断，不再作为主榜替代。</p>
<p>另设 20 个独立动态工具专项，工具目录分 100 / 300 / 1,000 规模；初始只提供时间与工具搜索，再按检索结果、授权与执行阶段暴露所需工具。覆盖中途撤权、工具失败/版本变化、恢复与防重复。这属于待实现的产品能力或明确标记的模拟评测，不能算成现有产品已支持。</p>
<p>每任务独立重复 3 次，报告首次成功与三次均成功的稳定率。并发上限 100，题内顺序执行；模拟用户、评分和重试均计入费用与限流。详见 advanced-evaluation-plan.json。</p>
<h2>全部 40 题</h2><p class="muted">展开可查看问题、实际回答、工具调用、检查结果、人工审核和原题出处。</p>${caseHtml}
<h2>复现与原始记录</h2><p>项目入口：scripts/Test-AgentBenchmarks.ps1；题目与版本：manifest.json；最终原始结果：results.json；首轮原始结果保存在带时间戳的 results 文件；summary.json 包含汇总和费用。测试账号的计划及记忆已清理，测试会话已退出。</p>
</main></html>`;
await writeFile(new URL('report.html',directory),html);
console.log(JSON.stringify({summary:fileURLToPath(new URL('summary.json',directory)),html:fileURLToPath(new URL('report.html',directory)),groups,audited_passed:summary.audited_passed,cost:cost.estimate,usage},null,2));

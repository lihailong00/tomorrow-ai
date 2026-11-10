/** Live-model product regression and query-rewrite A/B with isolated business fixtures. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config as dotenv } from 'dotenv';
import { cases } from './product-cases.mjs';
import { deviceTools, fixtureCall, fixtureContext, fixtureToolName, tools } from './product-fixtures.mjs';
import { fliggyCatalogPath } from './fliggy-fixtures.mjs';
import { aggregate, compareRuns, serializeReport } from './product-report.mjs';

const { values: flags, positionals } = parseArgs({
  options:{list:{type:'boolean'},regression:{type:'boolean'},baseline:{type:'string'}},
  allowPositionals:true,
});
if (flags.list) {
  for (const test of cases) {
    console.log(test.id);
    for (const {role,content} of test.messages) console.log('  '+role+'  '+content);
    console.log('  预期工具  '+(test.expected.join(' → ') || '直接回答'));
  }
  process.exit(0);
}
if (positionals.length > 1 || (flags.regression ? positionals.length > 0 : !positionals.length || flags.baseline)) {
  throw new Error('Use --regression [--baseline <report.json>], --list, or <output.json> for query-rewrite A/B.');
}
dotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
const {resolveModel} = await import('../dist/config.js');
const {executeHarness,selectHarness} = await import('../dist/harness.js');
const settings = resolveModel(process.env);
const harness = selectHarness(process.env.QUERY_EVAL_HARNESS);
if (harness === 'pi') process.env.AGENT_TOOL_SEARCH_ENABLED = 'true';
const repeats = Number(process.env.QUERY_EVAL_REPEATS ?? 2);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('QUERY_EVAL_REPEATS must be 1–5');
const selected = process.env.QUERY_EVAL_CASES?.split(',').map(id=>id.trim());
if (selected?.some(id => !cases.some(test => test.id === id))) throw new Error('Unknown scenario ID');
const envCases = selected ? cases.filter(test => selected.includes(test.id)) : cases;
const concurrency = Math.min(4,envCases.length*repeats*(flags.regression ? 1 : 2));
const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
const reportDir = fileURLToPath(new URL('../../../artifacts/product-regression/',import.meta.url));
const latestPath = join(reportDir,'latest-'+harness+'.json');
let baseline;
if (flags.regression) {
  const path = flags.baseline ? resolve(flags.baseline) : latestPath;
  try { baseline = JSON.parse(await readFile(path,'utf8')); }
  catch (error) { if (flags.baseline || error.code !== 'ENOENT') throw error; }
}

async function evaluate(test, mode, repeat) {
  const reached = new Set();
  let firstTextMs, firstExpectedToolMs, outputText = '', error, usage;
  const calls = [];
  const start = performance.now();
  const sent = new Set();
  const measured = new Map();
  let sideEffect = false;
  let toolSequence = 0;
  const hit = (id, value) => {
    reached.add(id);
    firstExpectedToolMs ??= Math.round(performance.now() - start);
    return value;
  };
  const callFixture = fixtureCall(test.id, reached, hit);
  const bridge = {
    state: async () => ({ next_sequence: toolSequence }),
    event: async event => { toolSequence = event.sequence + 1; if (event.kind === 'text_delta') firstTextMs ??= Math.round(performance.now()-start); },
    usage: async event => {
      if (event.kind === 'dispatch') sent.add(event.request_index);
      else if (event.status === 'succeeded') measured.set(event.request_index, event.measurements);
    },
    tool: async (name, rawArgs) => {
      const args = rawArgs ?? {};
      const tag = fixtureToolName(name,args);
      calls.push(tag);
      if (/(?:^|[._-])(?:create|cancel|update|save|send|book|delete|pay|submit|apply|purchase|prepare)(?:$|[._-])|投递|下单|付款/i.test(tag)) sideEffect = true;
      return callFixture(name,args,tag);
    },
  };
  try {
    const result = await executeHarness({
      run_id:randomUUID(), run_token:randomBytes(32).toString('hex'), scope:'chat', harness,
      tools:test.id.startsWith('phone-permission-') ? [...tools, ...deviceTools] : tools,
      messages:test.messages, runtime_context:fixtureContext(test.id),
    }, settings, bridge, undefined, {turns:14,tools:32,timeoutMs:90000}, undefined, harness, {queryRewrite: mode === 'current' ? undefined : mode === 'rewrite'});
    outputText = result.content;
    usage = result.usage;
  } catch (failure) { error = failure?.code ?? failure?.name ?? 'error'; }
  const found = test.expected.filter(name => reached.has(name));
  const failures = [];
  if (error) failures.push('runtime_error');
  if (sideEffect) failures.push('unexpected_write');
  if (found.length !== test.expected.length) failures.push('missing_tool');
  if (!test.answer.every(pattern => pattern.test(outputText)) || test.forbiddenAnswer?.test(outputText)) failures.push('answer_mismatch');
  if ((!test.expected.length && calls.length) || calls.some(tag => test.forbiddenCalls?.test(tag))) failures.push('unexpected_tool');
  if (test.singleCalls?.some(name => calls.filter(tag => tag === name).length !== 1)) failures.push('unexpected_call_count');
  const complete = failures.length === 0;
  const tokens = [...measured.values()].reduce((sum, item) => sum + (item.input_tokens ?? 0) + (item.output_tokens ?? 0), 0);
  return { scenario:test.id, mode, repeat, expected:test.expected, found, complete, failures, elapsed_ms:Math.round(performance.now()-start),
    first_text_ms:firstTextMs ?? null, first_expected_tool_ms:firstExpectedToolMs ?? null, model_requests:sent.size,
    tokens, calls, answer:outputText.slice(0,1700), side_effect_attempt:sideEffect, ...(error ? { error } : {}),
    runtime_reported_model_requests:usage?.model_requests ?? null };
}

const jobs = [];
for (let repeat=1; repeat<=repeats; repeat++) {
  for (const [index,test] of envCases.entries()) {
    const modes = flags.regression ? ['current'] : (repeat+index)%2 ? ['baseline','rewrite'] : ['rewrite','baseline'];
    for (const mode of modes) jobs.push({test,mode,repeat});
  }
}
const rows = Array(jobs.length);
let cursor = 0;
await Promise.all(Array.from({length:concurrency}, async () => {
  while (cursor < jobs.length) {
    const index = cursor++;
    const {test,mode,repeat} = jobs[index];
    const row = rows[index] = await evaluate(test,mode,repeat);
    console.log(JSON.stringify({ scenario:row.scenario, mode, repeat, found:row.found, complete:row.complete, elapsed_ms:row.elapsed_ms, model_requests:row.model_requests,error:row.error }));
  }
}));
const modeNames = flags.regression ? ['current'] : ['baseline','rewrite'];
const summary = Object.fromEntries(modeNames.map(mode=>[mode,aggregate(rows.filter(row=>row.mode===mode))]));
const hashFiles = async (directory, files) => {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file+'\\0').update(await readFile(join(directory,file))).update('\\0');
  return hash.digest('hex');
};
const dist = fileURLToPath(new URL('../dist/',import.meta.url));
const runtimeFiles = (await readdir(dist,{recursive:true})).filter(name=>name.endsWith('.js')&&!name.endsWith('.test.js')).sort();
const report = {
  report_schema:1, kind:flags.regression?'product_regression':'query_rewrite_ab', run_id:runId, started_at:startedAt,
  suite_sha256:await hashFiles(fileURLToPath(new URL('./',import.meta.url)),[
    'product-cases.mjs','product-fixtures.mjs','product-report.mjs','query-rewrite.mjs',
    'fliggy-fixtures.mjs','fliggy-receipts.json',fliggyCatalogPath,
  ]),
  runtime_sha256:await hashFiles(dist,runtimeFiles),
  model:settings.model.id, model_fingerprint:createHash('sha256').update(JSON.stringify(settings.model)).digest('hex'),
  harness, dynamic_tools:harness==='pi', rewrite_enabled:flags.regression?process.env.AGENT_QUERY_REWRITE_ENABLED!=='false':null,
  live_model:true, fixture_tools:true, repeats, concurrency, scenarios:envCases.map(test=>test.id),
  scoring:'Tool hit means the correct tool received valid arguments and produced the expected fixture result, including deliberate error fixtures. Completion also checks expected answer facts and forbidden operations. Failed runtime calls are excluded from latency summaries only.',
  summary, rows,
};
let output = positionals[0];
if (flags.regression) {
  report.comparison = compareRuns(report,baseline);
  await mkdir(reportDir,{recursive:true});
  output = join(reportDir,harness+'-'+runId+'.json');
}
const json = serializeReport(report);
await writeFile(output,json,flags.regression?{flag:'wx'}:undefined);
if (flags.regression && !selected && summary.current.errors===0) {
  const pending = output+'.latest.tmp';
  await writeFile(pending,json,{flag:'wx'});
  await rename(pending,latestPath);
}
console.log(JSON.stringify({output,summary,...(report.comparison?{comparison:{
  status:report.comparison.status,mismatches:report.comparison.mismatches,baseline_run:report.comparison.baseline_run,
  delta:report.comparison.delta,regressions:report.comparison.regressions,improvements:report.comparison.improvements,
}}:{})}));

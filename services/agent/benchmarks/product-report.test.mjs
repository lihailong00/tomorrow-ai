import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, compareRuns, serializeReport } from './product-report.mjs';

const row = (scenario, complete, elapsed_ms, error) => ({
  scenario,complete,elapsed_ms,error,expected:['tool'],found:complete?['tool']:[],
  model_requests:1,tokens:10,first_text_ms:100,
});
const report = (run_id, rows) => ({
  run_id,kind:'product_regression',report_schema:1,suite_sha256:'suite-v1',harness:'pi',
  model_fingerprint:'model-v1',repeats:1,concurrency:2,scenarios:['one','two'],rows,
  summary:{current:aggregate(rows)},
});

test('detects offsetting per-case regressions and improvements with the same overall score', () => {
  const before = report('baseline',[row('one',true,300),row('two',false,400)]);
  const after = report('candidate',[row('one',false,500),row('two',true,400)]);
  const difference = compareRuns(after,before);
  assert.equal(difference.delta.completed,0);
  assert.deepEqual(difference.regressions,['one']);
  assert.deepEqual(difference.improvements,['two']);
  assert.equal(difference.per_case[0].delta.elapsed_p50_ms,200);
  assert.equal(difference.baseline_run,'baseline');
});

test('rejects comparisons across different suites, models or subsets', () => {
  const before = report('baseline',[row('one',true,300),row('two',false,400)]);
  const after = {...before,scenarios:['one'],model_fingerprint:'another-model',suite_sha256:'another-suite'};
  assert.deepEqual(compareRuns(after,before),{status:'incompatible',mismatches:['suite_sha256','model_fingerprint','scenarios']});
  assert.deepEqual(compareRuns(after,undefined),{status:'no_baseline'});
});

test('counts runtime failures in completion but excludes them from latency', () => {
  const summary = aggregate([row('one',true,300),row('two',false,10000,'timeout')]);
  assert.equal(summary.runs,2);
  assert.equal(summary.errors,1);
  assert.equal(summary.completed,1);
  assert.equal(summary.elapsed_p95_ms,300);
});

test('archived and latest reports can be parsed as JSON for the next run', () => {
  const data = report('candidate',[row('one',true,300),row('two',false,400)]);
  assert.deepEqual(JSON.parse(serializeReport(data)),JSON.parse(JSON.stringify(data)));
});

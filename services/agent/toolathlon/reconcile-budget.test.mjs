import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeReconciliation } from './reconcile-budget.mjs';

function fixture() {
  const runId = 'session:finalpool/test';
  const firstUsage = { input: 10, cache_read: 20, output: 5, total_tokens: 35 };
  const secondUsage = { input: 12, cache_read: 24, output: 6, total_tokens: 42 };
  const peak = u => u.input * 2000 + u.cache_read * 40 + u.output * 8000;
  const ledger = { budget_nano: 10e9, requests: [
    { id: 'first', run_id: runId, started_at: '2026-10-26T16:00:00.000Z', status: 'settled',
      reserved_nano: 50e6, input_token_upper_bound: 1000, max_output_tokens: 100,
      usage: firstUsage, charge_upper_bound_nano: peak(firstUsage), charge_nano: peak(firstUsage) / 2 },
    { id: 'second', run_id: runId, started_at: '2026-10-26T16:00:02.000Z', status: 'transport_or_stream_failure_charge_unknown',
      reserved_nano: 50e6, input_token_upper_bound: 1000, max_output_tokens: 100 },
  ] };
  const turn = (usage, index) => ({ type: 'assistant_turn', turn: index,
    timestamp: `2026-10-26T16:00:0${index * 2 - 1}.000Z`, stop_reason: 'toolUse',
    usage: { input: usage.input, cacheRead: usage.cache_read, cacheWrite: 0,
      output: usage.output, totalTokens: usage.total_tokens } });
  const trajectory = { config: { task_dir: 'finalpool/test' }, tomorrow_pi: {
    harness: 'pi-agent-core@1.4.0', model: 'deepseek-flash', thinking_level: 'off', usage: { model_requests: 2 },
    events: [turn(firstUsage, 1), turn(secondUsage, 2)],
  } };
  return { ledger, trajectories: [{ runId, trajectory, sourcePath: 'completed-root-captured-trajectory.json' }] };
}

test('proposes exact reconciliation only after all settled anchors and request ordering agree', () => {
  const input = fixture(), before = JSON.stringify(input);
  const proposal = proposeReconciliation(input);
  assert.equal(proposal.patches.length, 1);
  assert.equal(proposal.patches[0].request_id, 'second');
  assert.equal(proposal.patches[0].proposed_fields.charge_upper_bound_nano, 72960);
  assert.equal(proposal.runs[0].settled_anchors_matched, 1);
  assert.equal(proposal.budget_nano_unchanged, 10e9);
  assert.equal(JSON.stringify(input), before, 'proposal must never mutate the live ledger');
});

test('a mismatch in any settled neighbor rejects the whole run rather than trusting only unknown turns', () => {
  const input = fixture(); input.ledger.requests[0].usage.output++;
  const result = proposeReconciliation(input);
  assert.equal(result.patches.length, 0);
  assert.equal(result.runs[0].eligible, false);
  assert.match(result.runs[0].reason, /does not match/);
});

test('a final budget rejection without a paid ledger request causes strict mapping refusal', () => {
  const input = fixture();
  const pi = input.trajectories[0].trajectory.tomorrow_pi;
  pi.events.push({ type: 'assistant_turn', turn: 3, stop_reason: 'error', error: '402 budget_exhausted',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  pi.usage.model_requests++;
  const result = proposeReconciliation(input);
  assert.equal(result.patches.length, 0);
  assert.match(result.runs[0].reason, /One-to-one mapping failed/);
});

test('incomplete usage, invalid totals, aborted responses and ambiguous timestamps are never reconciled', () => {
  for (const change of [
    input => { delete input.trajectories[0].trajectory.tomorrow_pi.events[1].usage.cacheRead; },
    input => { input.trajectories[0].trajectory.tomorrow_pi.events[1].usage.totalTokens++; },
    input => { input.trajectories[0].trajectory.tomorrow_pi.events[1].stop_reason = 'aborted'; },
    input => { input.trajectories[0].trajectory.tomorrow_pi.events[1].timestamp = '2026-10-26T15:59:00Z'; },
    input => { input.ledger.requests[1].max_output_tokens = 1; },
  ]) {
    const input = fixture(); change(input);
    assert.equal(proposeReconciliation(input).patches.length, 0);
  }
});

test('an entirely unknown run without independent settled anchors is refused', () => {
  const input = fixture();
  const row = input.ledger.requests[0]; delete row.charge_nano; delete row.charge_upper_bound_nano; delete row.usage;
  row.status = 'transport_or_stream_failure_charge_unknown';
  const result = proposeReconciliation(input);
  assert.equal(result.patches.length, 0);
  assert.match(result.runs[0].reason, /No independently settled usage anchors/);
});

test('already applied reconciliation is checked again and produces no duplicate credit', () => {
  const input = fixture(), first = proposeReconciliation(input);
  Object.assign(input.ledger.requests[1], first.patches[0].proposed_fields);
  const second = proposeReconciliation(input);
  assert.equal(second.runs[0].eligible, true);
  assert.equal(second.patches.length, 0);
  assert.equal(second.summary.reservation_released_cny, 0);
});

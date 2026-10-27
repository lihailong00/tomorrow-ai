import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NANO = 1e9;
const PEAK = { input: 2000, cache: 40, output: 8000 };
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
const KNOWN_COMPLETE = new Set(['stop', 'toolUse', 'length']);
const RECOVERABLE = new Set(['transport_or_stream_failure_charge_unknown', 'usage_missing_charge_unknown']);

function normalizedTurnUsage(turn) {
  const u = turn.usage;
  if (!u || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => safeInteger(u[key]))) {
    throw new Error(`Turn ${turn.turn} has invalid or incomplete usage`);
  }
  if (u.cacheWrite !== 0) throw new Error('DeepSeek Flash reconciliation does not infer cache-write pricing');
  if (u.totalTokens !== u.input + u.output + u.cacheRead + u.cacheWrite) throw new Error(`Turn ${turn.turn} token totals do not reconcile`);
  if (u.totalTokens === 0 || !KNOWN_COMPLETE.has(turn.stop_reason) || turn.error) throw new Error(`Turn ${turn.turn} is not a completed model response`);
  return { input: u.input, cache_read: u.cacheRead, output: u.output, total_tokens: u.totalTokens };
}

function equalUsage(a, b) {
  return ['input', 'cache_read', 'output', 'total_tokens'].every(key => a?.[key] === b?.[key]);
}

function estimatedRates(iso) {
  const date = new Date(Date.parse(iso) + 8 * 3600_000);
  const hour = date.getUTCHours(), day = date.getUTCDay();
  return day > 0 && day < 6 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    ? PEAK : { input: 1000, cache: 20, output: 4000 };
}
const charge = (usage, rates) => usage.input * rates.input + usage.cache_read * rates.cache + usage.output * rates.output;
const costBound = requests => requests.reduce((sum, row) => sum + (row.charge_upper_bound_nano ?? row.reserved_nano), 0);

/**
 * Produce reviewable accounting proposals only. Never writes a live ledger,
 * clears a reservation without evidence, changes the CNY ceiling, or calls a model.
 */
export function proposeReconciliation({ ledger, trajectories, ledgerRaw } = {}) {
  if (!Array.isArray(ledger?.requests) || !safeInteger(ledger.budget_nano) || ledger.budget_nano > 10 * NANO) {
    throw new Error('Invalid bounded experiment ledger');
  }
  const seenIds = new Set();
  for (const row of ledger.requests) {
    if (!row || typeof row.id !== 'string' || !row.id || seenIds.has(row.id) || !safeInteger(row.reserved_nano) ||
        (row.charge_upper_bound_nano !== undefined && !safeInteger(row.charge_upper_bound_nano))) {
      throw new Error('Invalid or duplicated ledger request');
    }
    seenIds.add(row.id);
  }
  const patches = [], runResults = [];
  const duplicateRunIds = new Set();
  for (const { runId } of trajectories) {
    if (duplicateRunIds.has(runId)) throw new Error('Duplicate trajectory for run');
    duplicateRunIds.add(runId);
  }
  for (const { runId, trajectory, sourcePath } of trajectories) {
    const proposed = [];
    try {
      const rows = ledger.requests.filter(row => row.run_id === runId);
      const pi = trajectory?.tomorrow_pi;
      if (!rows.length) throw new Error('No admitted model requests for this run');
      if (pi?.harness !== 'pi-agent-core@1.4.0' || pi.model !== 'deepseek-flash' || pi.thinking_level !== 'off') {
        throw new Error('Unexpected model, harness or thinking configuration');
      }
      const task = runId.slice(runId.indexOf(':') + 1);
      if (trajectory.config?.task_dir !== task) throw new Error('Trajectory belongs to another task');
      const turns = pi.events?.filter(event => event.type === 'assistant_turn') ?? [];
      if (rows.length !== turns.length || pi.usage?.model_requests !== turns.length) {
        throw new Error(`One-to-one mapping failed: ${rows.length} admitted requests versus ${turns.length} assistant turns`);
      }
      let matchedSettled = 0;
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], turn = turns[index];
        if (turn.turn !== index + 1) throw new Error('Assistant turn indices are not contiguous');
        const started = Date.parse(row.started_at), observed = Date.parse(turn.timestamp);
        const next = index + 1 < rows.length ? Date.parse(rows[index + 1].started_at) : Infinity;
        if (!Number.isFinite(started) || !Number.isFinite(observed) || observed < started || observed > next) {
          throw new Error(`Turn ${turn.turn} timestamps do not establish the request ordering`);
        }
        const usage = normalizedTurnUsage(turn);
        if (!safeInteger(row.input_token_upper_bound) || !safeInteger(row.max_output_tokens) ||
            usage.input + usage.cache_read > row.input_token_upper_bound || usage.output > row.max_output_tokens) {
          throw new Error(`Turn ${turn.turn} usage exceeds the original reservation bounds`);
        }
        const upper = charge(usage, PEAK);
        if (!safeInteger(upper) || upper > row.reserved_nano) throw new Error('Reconciled charge exceeds original reservation');
        if (row.charge_upper_bound_nano !== undefined) {
          if (!['settled', 'settled_reconciled_from_completed_pi_response'].includes(row.status) ||
              !equalUsage(row.usage, usage) || row.charge_upper_bound_nano !== upper) {
            throw new Error(`Settled request ${index + 1} does not match the corresponding captured response`);
          }
          matchedSettled++;
          continue;
        }
        if (!RECOVERABLE.has(row.status)) throw new Error(`Request ${index + 1} has an ineligible status: ${row.status}`);
        const estimate = charge(usage, estimatedRates(row.started_at));
        proposed.push({ request_id: row.id, run_id: runId, turn: turn.turn,
          before_sha256: sha256(row), before_status: row.status, reserved_nano: row.reserved_nano,
          proposed_fields: { status: 'settled_reconciled_from_completed_pi_response', usage,
            charge_upper_bound_nano: upper, charge_nano: estimate, estimated_cost_cny: estimate / NANO,
            reconciliation: { source: sourcePath ?? null, trajectory_sha256: sha256(trajectory),
              captured_turn: turn.turn, captured_at: turn.timestamp,
              evidence: 'Complete captured provider usage and finish reason; exact request/turn count, chronological ordering, and every settled neighbor usage independently match.' } },
          reservation_released_nano: row.reserved_nano - upper });
      }
      if (!matchedSettled) throw new Error('No independently settled usage anchors establish this mapping');
      patches.push(...proposed);
      runResults.push({ run_id: runId, eligible: true, requests: rows.length,
        settled_anchors_matched: matchedSettled, proposed_reconciliations: proposed.length });
    } catch (error) {
      // Reject the entire ambiguous run. Other independently proven runs may
      // still have valid proposals, which require separate human/root review.
      runResults.push({ run_id: runId, eligible: false, reason: error.message });
    }
  }
  const before = costBound(ledger.requests);
  const reduction = patches.reduce((sum, patch) => sum + patch.reservation_released_nano, 0);
  const after = before - reduction;
  if (!safeInteger(before) || !safeInteger(after) || before > ledger.budget_nano || after > ledger.budget_nano) {
    throw new Error('Proposed accounting violates the persisted ceiling');
  }
  return { schema_version: 1, mode: 'proposal_only_no_ledger_mutation',
    ledger_sha256: sha256(ledgerRaw ?? ledger), budget_nano_unchanged: ledger.budget_nano,
    runs: runResults, patches, summary: { requests_reconciled: patches.length,
      accounted_upper_bound_before_cny: before / NANO, accounted_upper_bound_after_cny: after / NANO,
      reservation_released_cny: reduction / NANO, remaining_after_cny: (ledger.budget_nano - after) / NANO } };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const position = arg.indexOf('='); return [arg.slice(2, position), arg.slice(position + 1)];
  }));
  if (!args.ledger || !args.report || !args.output) throw new Error('Usage: --ledger=shared-ledger.json --report=run/results.json --output=reconciliation-proposal.json');
  const ledgerPath = path.resolve(args.ledger), output = path.resolve(args.output);
  if (ledgerPath === output) throw new Error('Proposal output must never replace the ledger');
  const ledgerRaw = await readFile(ledgerPath, 'utf8'), ledger = JSON.parse(ledgerRaw);
  const report = JSON.parse(await readFile(args.report, 'utf8'));
  const sessionId = path.basename(path.dirname(path.resolve(args.report)));
  const trajectories = [];
  for (const task of report.tasks) {
    const filename = path.join(path.dirname(path.resolve(args.report)), 'tasks', task.source_id.split('/')[1], 'traj_log.json');
    try {
      trajectories.push({ runId: `${sessionId}:${task.source_id}`, sourcePath: filename,
        trajectory: JSON.parse(await readFile(filename, 'utf8')) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const proposed = proposeReconciliation({ ledger, trajectories, ledgerRaw });
  await writeFile(output, JSON.stringify(proposed, null, 2), { flag: 'wx' });
  process.stdout.write(JSON.stringify({ output, ...proposed.summary, runs: proposed.runs }, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Reconciliation refused: ${error.message}\n`); process.exitCode = 1; });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBudgetGateway, reserveForPayload } from './budget-gateway.mjs';

// Independent review fixtures never use a live model or real credentials.
const settings = { apiKey: 'review-upstream-secret', model: { baseUrl: 'https://api.deepseek.com' } };
const token = 'review-proxy-capability-'.repeat(3);
const payload = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'review only' }], max_tokens: 100, stream: false };
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tomorrow-budget-review-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, ledgerPath: path.join(directory, 'shared-ledger.json') };
}
const call = (gateway, body = payload) => fetch(`${gateway.baseUrl}/chat/completions`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const usageResponse = usage => new Response(JSON.stringify({ model: 'deepseek-flash', choices: [], usage }),
  { headers: { 'Content-Type': 'application/json' } });

test('settled budget ceiling uses peak-price actual-token upper bound, independently of discount estimates', async t => {
  const { ledgerPath } = await temporary(t);
  const gateway = await startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => usageResponse({ prompt_tokens: 1000, completion_tokens: 20, prompt_cache_hit_tokens: 400, total_tokens: 1020 }) });
  try {
    await (await call(gateway)).text();
    await new Promise(resolve => setTimeout(resolve, 10));
    const expectedPeak = (600 * 2000 + 400 * 40 + 20 * 8000) / 1e9;
    assert.equal(gateway.status().accounted_upper_bound_cny, expectedPeak);
    assert.equal(gateway.ledger.requests[0].charge_upper_bound_nano, expectedPeak * 1e9);
    assert.ok(gateway.status().usage_estimate_cny <= expectedPeak);
  } finally { await gateway.close(); }
});

test('unknown paid requests survive gateway restarts and prevent another allocation', async t => {
  const { ledgerPath } = await temporary(t);
  const reserve = reserveForPayload(payload).reserved_nano / 1e9;
  let paidRequests = 0;
  const first = await startBudgetGateway({ settings, token, ledgerPath, budgetCny: reserve * 1.5,
    fetchImpl: async () => { paidRequests++; throw new Error('unknown provider billing'); } });
  await (await call(first)).text();
  await first.close();
  const second = await startBudgetGateway({ settings, token, ledgerPath, budgetCny: reserve * 1.5,
    fetchImpl: async () => { paidRequests++; throw new Error('must never reach provider'); } });
  try {
    assert.equal((await call(second)).status, 402);
    assert.equal(paidRequests, 1);
    assert.equal(second.status().requests, 1);
    assert.equal(second.status().accounted_upper_bound_cny, reserve);
    assert.equal(second.ledger.requests[0].charge_upper_bound_nano, undefined);
  } finally { await second.close(); }
});

test('negative or unsafe upstream usage cannot lower the spending bound', async t => {
  const { ledgerPath } = await temporary(t);
  const gateway = await startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => usageResponse({ prompt_tokens: 0, completion_tokens: -2000, total_tokens: -2000 }) });
  try {
    await (await call(gateway)).text();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(gateway.ledger.requests[0].charge_upper_bound_nano, undefined);
    assert.equal(gateway.status().accounted_upper_bound_cny, reserveForPayload(payload).reserved_nano / 1e9);
  } finally { await gateway.close(); }
});

test('stream failure after a usage event retains the entire reservation', async t => {
  const { ledgerPath } = await temporary(t);
  let releaseFailure;
  const fail = new Promise(resolve => { releaseFailure = resolve; });
  const gateway = await startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n'));
      await fail;
      controller.error(new Error('socket interrupted after provisional usage'));
    } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  try {
    const response = await call(gateway, { ...payload, stream: true });
    releaseFailure();
    await response.text().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(gateway.ledger.requests[0].charge_upper_bound_nano, undefined);
    assert.equal(gateway.status().accounted_upper_bound_cny,
      reserveForPayload({ ...payload, stream: true }).reserved_nano / 1e9);
  } finally { releaseFailure(); await gateway.close(); }
});

test('a dead-owner lock is refused rather than stolen with a racing unlink/open pair', async t => {
  const { ledgerPath } = await temporary(t);
  await writeFile(`${ledgerPath}.lock`, JSON.stringify({ pid: 2147483647, created_at: new Date().toISOString() }));
  let paidRequests = 0;
  await assert.rejects(startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => { paidRequests++; throw new Error('must not call provider'); } }), /lock|owns|gateway/i);
  assert.equal(paidRequests, 0);
  assert.equal(JSON.parse(await readFile(`${ledgerPath}.lock`, 'utf8')).pid, 2147483647);
});

test('corrupt persisted charges fail closed before listening or admitting inference', async t => {
  const { ledgerPath } = await temporary(t);
  await writeFile(ledgerPath, JSON.stringify({ budget_nano: 10e9, requests: [{
    status: 'settled', reserved_nano: 1000, charge_nano: -1000, charge_upper_bound_nano: -1000,
  }] }));
  await assert.rejects(startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => { throw new Error('must not call provider'); } }), /ledger|budget|invalid|charge/i);
});

test('the persisted shared ledger contains no upstream or proxy credentials', async t => {
  const { ledgerPath } = await temporary(t);
  const gateway = await startBudgetGateway({ settings, token, ledgerPath,
    fetchImpl: async () => { throw new Error(`${settings.apiKey}: ${token}`); } });
  try {
    const response = await call(gateway);
    const errorBody = await response.text();
    await new Promise(resolve => setTimeout(resolve, 10));
    const saved = await readFile(ledgerPath, 'utf8');
    for (const value of [errorBody, saved]) {
      assert.ok(!value.includes(settings.apiKey)); assert.ok(!value.includes(token));
    }
  } finally { await gateway.close(); }
});

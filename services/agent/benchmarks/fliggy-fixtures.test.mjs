import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cases } from './product-cases.mjs';
import { fixtureCall, fixtureToolName } from './product-fixtures.mjs';
import { fliggyCatalog, fliggyReceipts } from './fliggy-fixtures.mjs';

test('every exposed FlyAI tool is exercised in the product suite with an official-format receipt', () => {
  assert.equal(fliggyReceipts.source, 'synthetic_official_format');
  assert.equal(fliggyCatalog.length, 8);
  assert.equal(new Set(fliggyCatalog.map(tool => tool.name)).size, 8);
  const covered = new Set();
  const runs = new Map();
  for (const sample of fliggyReceipts.samples) {
    if (!runs.has(sample.scenario)) {
      const reached = new Set();
      runs.set(sample.scenario, fixtureCall(sample.scenario, reached, (tag, value) => {
        reached.add(tag);
        return value;
      }));
    }
    const bridge = runs.get(sample.scenario);
    const request = { provider: 'fliggy', tool: sample.tool, arguments: sample.arguments };
    const tag = fixtureToolName('call_mcp_tool', request);
    assert.ok(cases.find(row => row.id === sample.scenario)?.expected.includes(tag), tag);
    assert.ok(bridge('list_mcp_tools', { provider: 'fliggy' }).items.some(tool => tool.name === sample.tool), tag);
    assert.deepEqual(bridge('call_mcp_tool', request, tag), { status: 'completed', result: sample.response }, tag);
    covered.add(sample.tool);
  }
  assert.deepEqual(covered, new Set(fliggyCatalog.map(tool => tool.name)));
});

test('wrong route, unsupported parameters, and skipping flight discovery fail replay', () => {
  const bridge = fixtureCall('trip-chain', new Set(), () => assert.fail('unexpected fixture match'));
  const call = (tool, args) => bridge('call_mcp_tool', { provider: 'fliggy', tool, arguments: args });
  const [flight, hotel] = ['fliggy_search_flight','fliggy_search_hotel'].map(
    tool => fliggyReceipts.samples.find(row => row.scenario === 'trip-chain' && row.tool === tool),
  );
  assert.equal(call(flight.tool, { ...flight.arguments, origin: '北京' }).error.code, 'fixture_not_found');
  assert.equal(call(flight.tool, { ...flight.arguments, endpoint: 'https://example.test' }).error.code, 'fixture_not_found');
  assert.equal(call(hotel.tool, hotel.arguments).error.code, 'fixture_not_found');
});

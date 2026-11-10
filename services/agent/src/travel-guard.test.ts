import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunInput } from './runtime.js';
import { travelGuard } from './travel-guard.js';

const address = '上海市青浦区星河示例花园8区2栋202号';
const home = { display_name: '星河示例花园', city: '上海市', address: '星河示例花园8区', address_all: '上海市青浦区星河示例花园', location: { lng: 121.05, lat: 31.08 } };
const wrongHome = { ...home, address_all: '上海市嘉定区星河示例花园', location: { lng: 121.26, lat: 31.39 } };
const far = { display_name: '远处地铁站', location: { lng: 121.36, lat: 31.40 } };
const near = { display_name: '附近地铁站', location: { lng: 121.06, lat: 31.08 } };
const success = (...items: object[]) => ({ status: 'completed', result: { content: [{ type: 'text', text: JSON.stringify(items) }] } });
const input = (content = '那最划算的方式是什么？我想先打一段车，再坐地铁。'): RunInput => ({
  run_id: 'fixture', run_token: 'fixture', scope: 'chat', tools: [],
  runtime_context: { server_time_utc: '2026-11-04T07:50:00Z', local_time: '2026-11-04T15:50:00+08:00',
    weekday: 'Wednesday', timezone: 'Asia/Shanghai', timezone_source: 'default', location_status: 'not_provided', travel_places: { home: address } },
  messages: [
    { role: 'user', content: '我就在家，你给我送到家吧。', created_at: '2026-11-04T07:46:00Z' },
    { role: 'user', content: '我现在打车去上班要多少钱？', created_at: '2026-11-04T07:49:00Z' },
    { role: 'assistant', content: '起点是嘉定区星河示例花园。' },
    { role: 'user', content },
  ],
});

function didi(guard: ReturnType<typeof travelGuard>, tool: string, params: object, call: (args: unknown) => Promise<unknown>) {
  return guard('call_mcp_tool', { provider: 'didi', tool, arguments: params }, call);
}

const neverCalled = async () => assert.fail('unexpected upstream call');

test('a fare question can quote without triggering a booking or unrelated map lookup', async () => {
  const guard = travelGuard(input('现在打车到陆家嘴要多少钱？'));
  for (const tool of ['taxi_create_order', 'maps_direction_driving', 'maps_place_around']) {
    assert.match(JSON.stringify(await didi(guard, tool, {}, neverCalled)), /ride_quote_only/);
  }
  assert.deepEqual(await didi(guard, 'taxi_estimate', {}, async () => success()), success());
  assert.deepEqual(await didi(travelGuard(input('报价后直接叫车')), 'taxi_create_order', {}, async () => success()), success());
  assert.deepEqual(await didi(travelGuard(input('顺便看看公交路线和打车费用')), 'maps_direction_transit', {}, async () => success()), success());
});

test('home geocoding uses the full saved address and excludes same-name POIs from other districts', async () => {
  const guard = travelGuard(input());
  const result = await didi(guard, 'maps_textsearch', { keywords: '上海市嘉定区星河示例花园', city: '上海市', location: '121.26,31.39' }, async args => {
    assert.deepEqual(args, { provider: 'didi', tool: 'maps_textsearch', arguments: { keywords: address, city: '上海市' } });
    return success(wrongHome, home);
  });
  assert.deepEqual(result, success(home));
});

test('failed home validation cannot be bypassed by using earlier coordinates', async () => {
  const guard = travelGuard(input());
  const result = await didi(guard, 'maps_textsearch', { keywords: '家' }, async () => success(wrongHome));
  assert.match(JSON.stringify(result), /route_location_unverified/);
  const around = await didi(guard, 'maps_place_around', { keywords: '地铁站', location: '121.26,31.39' }, neverCalled);
  assert.match(JSON.stringify(around), /route_location_unverified/);
});

test('a same-name address in another district explicitly requested by the user is preserved', async () => {
  const guard = travelGuard(input('我想打车去嘉定区星河示例花园。'));
  const params = { keywords: '嘉定区星河示例花园', city: '上海市' };
  assert.deepEqual(await didi(guard, 'maps_textsearch', params, async args => {
    assert.deepEqual(args, { provider: 'didi', tool: 'maps_textsearch', arguments: params });
    return success(wrongHome);
  }), success(wrongHome));
});

test('transfer search and quotes stay on the verified trip and exclude distant stations', async () => {
  const guard = travelGuard(input());
  await didi(guard, 'maps_textsearch', { keywords: '星河示例花园' }, async () => success(home));
  const nearby = await didi(guard, 'maps_place_around', { keywords: '地铁站', location: '121.05,31.08' }, async () => success(far, near));
  assert.deepEqual(nearby, success(near));
  await didi(guard, 'maps_textsearch', { keywords: '远处地铁站' }, async () => success(far));
  const quote = { from_lng: '121.05', from_lat: '31.08', to_lng: '121.36', to_lat: '31.40', to_name: '换乘点' };
  const rejected = await didi(guard, 'taxi_estimate', quote, neverCalled);
  assert.match(JSON.stringify(rejected), /route_location_unverified/);
  const accepted = await didi(guard, 'taxi_estimate', { ...quote, to_lng: '121.06', to_lat: '31.08', to_name: '附近地铁站' }, async () => ({ status: 'completed' }));
  assert.deepEqual(accepted, { status: 'completed' });
  const reversed = await didi(guard, 'maps_direction_driving', { origin: '121.06,31.08', destination: '121.05,31.08' }, neverCalled);
  assert.match(JSON.stringify(reversed), /route_location_unverified/);
});

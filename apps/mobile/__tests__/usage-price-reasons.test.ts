import { costPresentation, sumMetrics } from '../src/features/usage/model';
import { readMetrics, type UsageMetrics } from '../src/features/usage/api';
const base: UsageMetrics = { call_count:1,input_tokens:1000,output_tokens:100,cache_read_tokens:0,cache_write_tokens:0,
  audio_ms:null,image_count:null,usage_status:'complete',known_cost_cny_micros:0,estimated_cost_cny_micros:null,
  unknown_cost_call_count:1,cost_status:'unknown' };
test('distinguishes missing prices from missing measurements', () => {
  expect(costPresentation({...base,missing_price_call_count:1,missing_measurement_call_count:0}).title).toBe('缺少模型单价');
  expect(costPresentation({...base,missing_price_call_count:0,missing_measurement_call_count:1}).title).toBe('计费用量未齐');
  expect(costPresentation(base).title).toContain('暂无法估算');
});
test('new reason counts survive decoding and grouped totals, older servers stay compatible', () => {
  const current=readMetrics({...base,missing_price_call_count:1,missing_measurement_call_count:0,reconstructed_cost_call_count:0});
  expect(sumMetrics([current,current]).missing_price_call_count).toBe(2);
  expect(readMetrics(base)).toEqual(base);
  expect(() => readMetrics({...base,missing_price_call_count:-1})).toThrow();
});
test('reconstructed priced calls retain the monetary subtotal and source count', () => {
  const item: UsageMetrics={...base,estimated_cost_cny_micros:1400,known_cost_cny_micros:1400,unknown_cost_call_count:0,
    cost_status:'complete',missing_price_call_count:0,missing_measurement_call_count:0,reconstructed_cost_call_count:1};
  expect(sumMetrics([item,item])).toMatchObject({known_cost_cny_micros:2800,reconstructed_cost_call_count:2,cost_status:'complete'});
});

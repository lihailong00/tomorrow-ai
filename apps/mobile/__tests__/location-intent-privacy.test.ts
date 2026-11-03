import { needsCurrentLocation } from '../src/features/location/model';

const localHistory = [{ role: 'user', content: '我附近有什么餐厅' }, { role: 'assistant', content: '可以查附近门店。' }];

test.each([
  ['帮我写一个套餐价格计算函数', []],
  ['那你调用MCP服务查一下我们代码中的接口类型', localHistory],
  ['那你解释这个门店 API 的 Rust 类型', localHistory],
  ['苏州的麦当劳套餐推荐，预算50元', []],
  ['伦敦的麦当劳套餐推荐，预算50元', []],
])('confirmed privacy regression does not request GPS: %s', (text, previous) => {
  expect(needsCurrentLocation(text as string, previous as typeof localHistory)).toBe(false);
});

test.each(['苏州', '伦敦', '布宜诺斯艾利斯', '雷克雅未克', '深圳', '上海陆家嘴', '南京新街口', '东京涩谷', '乌鲁木齐', '攀枝花'])('named place %s supplies its own origin without a city whitelist', place => {
  for (const text of [`${place}的麦当劳套餐推荐，预算50元`, `找${place}附近的餐厅`, `那就去${place}吃`, `那你调用MCP查一下${place}门店`]) {
    expect(needsCurrentLocation(text, localHistory)).toBe(false);
  }
});

test.each(['有没有50块钱以内的麦当劳套餐？给我推荐一下呢。', '帮我推荐外卖套餐，预算30元', '麦当劳套餐多少钱',
  '写一个获取当前位置的API函数', '附近餐厅的API接口类型怎么写', 'explain the function for restaurants near me'])('generic prices and quoted location in technical work do not reveal a fix: %s', text => {
  expect(needsCurrentLocation(text, localHistory)).toBe(false);
});

test.each(['从我这个位置打车到陆家嘴', '附近有什么餐厅', '我附近有没有50元以内的套餐',
  '通过高德API查一下当前位置的天气', '用MCP查询我附近的餐厅', 'restaurants near me'])('explicit local requests remain usable even through APIs: %s', text => {
  expect(needsCurrentLocation(text)).toBe(true);
});

test.each(['那就这家，到店吃', '多少钱', '就现在', '那附近呢', '继续调用MCP查附近门店'])('short actual local continuation remains local: %s', text => {
  expect(needsCurrentLocation(text, localHistory)).toBe(true);
  expect(needsCurrentLocation(text)).toBe(false);
});

test('a bounded sequence of actual short follow-ups carries the current local intent, a new topic breaks it', () => {
  expect(needsCurrentLocation('多少钱', [...localHistory, { role: 'user', content: '那就这家，到店吃' }])).toBe(true);
  expect(needsCurrentLocation('多少钱', [...localHistory, { role: 'user', content: '解释一下Rust的类型' }])).toBe(false);
  expect(needsCurrentLocation('多少钱', [{ role: 'assistant', content: '你可以查我附近的餐厅' }])).toBe(false);
});

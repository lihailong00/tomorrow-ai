import { canReuseNearbyFix, locationInputAction, needsCurrentLocation } from '../src/features/location/model';

const localHistory = [{ role: 'user', content: '我附近有什么餐厅' }, { role: 'assistant', content: '可以查附近门店。' }];

test.each(['我现在要打车回家了。', '我现在，准备打车回家', '我今晚想要叫车回我家',
  '现在打车回家要多少钱', '打车回家多少钱？', '我想打车回我家', '回家打车多少钱', '现在回家打车要多少'])('home-bound trips still need an origin: %s', text => {
  expect(needsCurrentLocation(text)).toBe(true);
});

test.each(['从虹桥机场打车回家多少钱', '我现在要从公司打车回家', '我现在不想打车回家',
  '打车回家的费用怎么算', '打车回家的价格怎么计算', '写一个打车回家的费用计算函数', '解释自动定位接口', '请翻译“自动定位”'])('home and location words in explicit routes or technical text do not request GPS: %s', text => {
  expect(needsCurrentLocation(text)).toBe(false);
  expect(locationInputAction(text)).toBeUndefined();
});

test.each(['自动定位', '那就自动定位', '我选择自动定位', '使用当前位置', '重新定位', '已开启定位', '请自动定位一下'])('typed automatic choices are real client actions: %s', text => {
  expect(locationInputAction(text)).toBe('auto'); expect(needsCurrentLocation(text)).toBe(true);
});

test.each(['手动填写', '我选择手动填写', '手动填写出发地'])('typed manual choices open the address input: %s', text => {
  expect(locationInputAction(text)).toBe('manual'); expect(needsCurrentLocation(text)).toBe(true);
});

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

test.each(['打车到陆家嘴，要多少钱？', '帮我叫车去虹桥机场', '去陆家嘴打车要多少钱',
  '去陆家嘴怎么走', '坐地铁到虹桥机场', '今天天气怎么样'])('implicit local questions request a location: %s', text => {
  expect(needsCurrentLocation(text)).toBe(true);
});

test.each(['从张江地铁站到陆家嘴，要多少钱？', '打车从张江到陆家嘴多少钱',
  '上海到杭州打车多少钱', '北京今天天气怎么样', '写一个打车到目的地的API函数',
  '天气预报是什么意思', '天气预报的原理是什么', '今天的天气预报是怎么生成的'])('an explicit origin or technical question does not request GPS: %s', text => {
  expect(needsCurrentLocation(text)).toBe(false);
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

test('a meal price and delegated choice use a verified nearby fix across a correction', () => {
  const first = '我想吃麦当劳了，然后双人的套餐吧，你看下都多少钱？';
  const next = '又不知道选啥，你看一下，你直接给我推荐吧，两个人吃的。';
  const history = [{ role: 'user', content: first }, { role: 'assistant', content: '北京有一家门店' },
    { role: 'user', content: '为什么给我定到北京了？你看我现在在哪儿？' }];
  expect(needsCurrentLocation(first)).toBe(true);
  expect(canReuseNearbyFix(first)).toBe(true);
  expect(canReuseNearbyFix(next, history)).toBe(true);
  expect(canReuseNearbyFix(next)).toBe(false);
  expect(canReuseNearbyFix('我要点麦当劳套餐外卖，多少钱')).toBe(false);
  expect(needsCurrentLocation('我想吃麦当劳，查上海静安寺附近的双人套餐多少钱？')).toBe(false);
  expect(needsCurrentLocation('我想吃麦当劳，查一下我附近的双人套餐多少钱？')).toBe(true);
  expect(needsCurrentLocation('直接推荐虹桥机场附近的套餐吧', history)).toBe(false);
  expect(canReuseNearbyFix('有点饿了，我现在想点一份麦当劳，你推荐什么？')).toBe(true);
  expect(canReuseNearbyFix('有点饿了，我现在想点一份麦当劳')).toBe(false);
  expect(canReuseNearbyFix('有点饿了，我现在想点一份麦当劳，查静安寺附近的套餐')).toBe(false);
});

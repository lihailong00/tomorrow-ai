import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { groupedActivities, toolActivityLabel, updateActivity } from '../src/screens/chatActivity';
import { ChatActivity } from '../src/ui/ChatActivity';
import { createChatStreamController } from '../src/screens/chatStreamController';
import type { SseEvent } from '../src/api/chatSse';
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test('labels finite provider operations, preserves metadata on end, and keeps parallel start order', () => {
  let items = updateActivity([], { tool:'list_mcp_tools',tool_call_id:'1',activity:{provider:'didi',operation:'discover',address:'private'} },1,false);
  items = updateActivity(items,{tool:'call_mcp_tool',tool_call_id:'2',activity:{provider:'amap',operation:'route'}},2,false);
  items = updateActivity(items,{tool:'list_mcp_tools',tool_call_id:'1'},3,true);
  expect(items.map(x=>x.id)).toEqual(['1','2']);
  expect(items[0].label).toBe('查找滴滴出行可用的工具');
  expect(items[1].label).toBe('高德地图 · 查询路线');
  expect(JSON.stringify(items)).not.toContain('private');
  expect(toolActivityLabel('call_mcp_tool',{provider:'didi',operation:'estimate'})).toBe('滴滴出行 · 查询打车预估价');
  expect(toolActivityLabel('call_mcp_tool',{provider:'didi',operation:'已经叫车成功'})).toBe('调用已授权的应用工具');
});

test('groups repeated completed calls but preserves different apps, failures and running steps', async () => {
  let items: ReturnType<typeof updateActivity> = [];
  for(let n=0;n<3;n++) items=updateActivity(items,{tool:'list_mcp_tools',tool_call_id:String(n),activity:{provider:'didi',operation:'discover'}},n,true);
  items=updateActivity(items,{tool:'list_mcp_tools',tool_call_id:'failed',is_error:true,activity:{provider:'didi',operation:'discover'}},4,true);
  items=updateActivity(items,{tool:'list_mcp_tools',tool_call_id:'running',activity:{provider:'didi',operation:'discover'}},5,false);
  items=updateActivity(items,{tool:'list_mcp_tools',tool_call_id:'other',activity:{provider:'amap',operation:'discover'}},6,true);
  expect(groupedActivities(items).map(x=>x.count)).toEqual([3,1,1,1]);
  let tree!: ReactTestRenderer;
  await act(async()=>{tree=create(<ChatActivity items={items}/>);});
  try {
    await act(async()=>tree.root.findAll(n=>n.props.accessibilityLabel==='展开执行记录'&&typeof n.props.onPress==='function')[0].props.onPress());
    const text=JSON.stringify(tree.toJSON());
    expect(text).toContain('×3'); expect(text).toContain('未成功'); expect(text).toContain('进行中'); expect(text).toContain('高德地图');
  } finally { await act(async()=>tree.unmount()); }
});

test('distinguishes app discovery, real calls, and draft operations without inventing a provider', () => {
  expect(toolActivityLabel('list_integrations')).toBe('查看已连接的应用');
  expect(toolActivityLabel('list_mcp_connections')).toBe('查看已授权的应用服务');
  expect(toolActivityLabel('list_mcp_tools')).toBe('查找应用可用的工具');
  expect(toolActivityLabel('call_mcp_tool')).toBe('调用已授权的应用工具');
  expect(toolActivityLabel('create_task')).toBe('创建待确认的任务');
  expect(toolActivityLabel('prepare_alipay_payment')).toBe('准备待确认的付款请求');
  expect(toolActivityLabel('create_schedule')).toBe('创建计划草稿');
  const item = updateActivity([], { tool: 'call_mcp_tool', args: { provider: 'amap', token: 'secret' },
    activity: { provider: 'amap', label: '已经打车成功', arguments: 'secret' } }, 1, false)[0];
  expect(item.label).toBe('调用已授权的应用工具');
  expect(JSON.stringify(item)).not.toMatch(/secret|高德|打车成功/);
});

test('recognizes provider-qualified tools, keeps new tools identifiable, and rejects arbitrary content', () => {
  expect(toolActivityLabel('mcp_baidu_maps_maps_direction_driving_123abc')).toBe('调用百度地图工具');
  expect(toolActivityLabel('mcp_fliggy_123abc')).toBe('调用飞猪工具');
  expect(toolActivityLabel('get_train_status')).toBe('调用工具 · get_train_status');
  expect(typeof toolActivityLabel('constructor')).toBe('string');
  expect(toolActivityLabel(null)).toBe('调用未识别的工具');
  expect(toolActivityLabel('https://user:secret@example.com?key=secret')).toBe('调用未识别的工具');
});

test('keeps query/URL on completion, deduplicates replay, bounds records and ignores raw arguments', () => {
  const start = { tool: 'web_search', tool_call_id: 'search', activity: { query: '基金 官网 公告' }, args: { password: 'never show' } };
  let items = updateActivity([], start, 1, false);
  items = updateActivity(items, start, 1, false);
  items = updateActivity(items, { tool: 'web_search', tool_call_id: 'search' }, 2, true);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ detail: '基金 官网 公告', state: 'complete' });
  expect(JSON.stringify(items)).not.toContain('never show');
  for (let n = 0; n < 30; n++) items = updateActivity(items, { tool: 'web_fetch', tool_call_id: String(n), activity: { url: 'https://example.com/notice' } }, n + 3, false);
  expect(items).toHaveLength(24);
  expect(updateActivity([], { tool: 'web_fetch', activity: { url: 'https://user:secret@example.com/a?token=secret' } }, 99, false)[0].detail).toBe('');
});

test('restores current activity from a reconnect snapshot and retains completed operations after answer', async () => {
  let receive!: (event: SseEvent) => void;
  let finish!: () => void;
  const api = { chatStream: jest.fn((_intent: unknown, sink: (event: SseEvent) => void) => { receive = sink; return new Promise<void>(resolve => { finish = resolve; }); }) };
  const c = createChatStreamController({ api, intent: { message: '调查', client_request_id: 'test', conversation_id: null, remember: false, upload_ids: [] }, isCurrent: () => true, onChange: jest.fn(), onComplete: jest.fn() });
  const running = c.start();
  receive({ id: 4, event: 'snapshot', data: { content: '', tool_status: { tool: 'web_fetch', tool_call_id: 'page', status: 'tool_start', activity: { url: 'https://example.com/notice' } } } });
  expect(c.getSnapshot().activities?.[0].detail).toBe('https://example.com/notice');
  receive({ id: 5, event: 'tool_end', data: { tool: 'web_fetch', tool_call_id: 'page' } });
  receive({ id: 6, event: 'done', data: { response: { conversation_id: 'chat', message: { id: 'answer', role: 'assistant', content: '结果', created_at: '', conversation_id: 'chat' } } } });
  finish(); await running;
  expect(c.getSnapshot().activities?.[0]).toMatchObject({ detail: 'https://example.com/notice', state: 'complete' });
  c.dispose();
});

test('shows real current details and expands failed steps without claiming completion', async () => {
  let tree!: ReactTestRenderer;
  const items = updateActivity([], { tool: 'web_fetch', tool_call_id: 'page', activity: { url: 'https://example.com/notice' }, is_error: true }, 1, true);
  await act(async () => { tree = create(<ChatActivity items={items} status="这一步未完成，正在继续…" />); });
  try {
    expect(JSON.stringify(tree.toJSON())).toContain('https://example.com/notice');
    const button = tree.root.findAll(n => n.props.accessibilityLabel === '展开执行记录' && typeof n.props.onPress === 'function')[0];
    await act(async () => button.props.onPress());
    expect(JSON.stringify(tree.toJSON())).toContain('未成功');
    expect(JSON.stringify(tree.toJSON())).not.toContain('已完成');
  } finally { await act(async () => tree.unmount()); }
});

test('shows the named tool when collapsed and distinct compact steps when expanded', async () => {
  let tree!: ReactTestRenderer;
  let items = updateActivity([], { tool: 'list_mcp_connections', tool_call_id: 'connections' }, 1, true);
  items = updateActivity(items, { tool: 'list_mcp_tools', tool_call_id: 'catalog' }, 2, true);
  items = updateActivity(items, { tool: 'call_mcp_tool', tool_call_id: 'call', is_error: true }, 3, true);
  await act(async () => { tree = create(<ChatActivity items={items} />); });
  try {
    expect(JSON.stringify(tree.toJSON())).toContain('调用已授权的应用工具');
    expect(JSON.stringify(tree.toJSON())).not.toContain('查看已授权的应用服务');
    const button = tree.root.findAll(n => n.props.accessibilityLabel === '展开执行记录' && typeof n.props.onPress === 'function')[0];
    await act(async () => button.props.onPress());
    const text = JSON.stringify(tree.toJSON());
    for (const copy of ['查看已授权的应用服务', '查找应用可用的工具', '调用已授权的应用工具', '未成功']) expect(text).toContain(copy);
    expect(text).not.toContain('使用工具');
  } finally { await act(async () => tree.unmount()); }
});

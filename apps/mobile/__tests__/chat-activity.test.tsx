import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { updateActivity } from '../src/screens/chatActivity';
import { ChatActivity } from '../src/ui/ChatActivity';
import { createChatStreamController } from '../src/screens/chatStreamController';
import type { SseEvent } from '../src/api/chatSse';
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

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

import { createChatStreamController } from '../src/screens/chatStreamController';
import type { SseEvent } from '../src/api/chatSse';
import type { ChatIntent, ChatResponse } from '../src/domain/types';

const intent: ChatIntent = { message: '你好', conversation_id: null,
  client_request_id: 'same-request', remember: false, upload_ids: [] };
const response: ChatResponse = { conversation_id: 'conversation', message: {
  id: 'assistant', conversation_id: 'conversation', role: 'assistant',
  content: '完整回复', created_at: '2026-10-28T04:00:00Z',
} };
const event = (id: number, kind: string, data: Record<string, unknown>): SseEvent => ({ id, event: kind, data });

test('reattached snapshot preserves the active tool label before any answer text arrives', async () => {
  const changes: string[] = [];
  const api = { chatStream: jest.fn(async (_intent, receive) => {
    receive(event(4, 'snapshot', { status: 'running', content: '',
      tool_status: { status: 'tool_start', tool: 'web_search' } }));
    receive(event(5, 'done', { response }));
  }) };
  const controller = createChatStreamController({ api, intent, isCurrent: () => true,
    onChange: progress => changes.push(progress.status), onComplete: jest.fn() });
  await controller.start();
  expect(changes).toContain('正在搜索…');
  controller.dispose();
});

test('a missing fragment reattaches with the last complete cursor and the same immutable request', async () => {
  jest.useFakeTimers();
  try {
    const completed = jest.fn();
    const api = { chatStream: jest.fn()
      .mockImplementationOnce(async (_intent: ChatIntent, receive: (value: SseEvent) => void) => {
        receive(event(0, 'snapshot', { status: 'running', content: '' }));
        receive(event(2, 'text_delta', { delta: '缺少上一段' }));
      })
      .mockImplementationOnce(async (_intent: ChatIntent, receive: (value: SseEvent) => void) => {
        receive(event(2, 'snapshot', { status: 'running', content: '完整' }));
        receive(event(3, 'text_delta', { delta: '回复' }));
        receive(event(4, 'done', { response }));
      }) };
    const controller = createChatStreamController({ api, intent, isCurrent: () => true,
      onChange: jest.fn(), onComplete: completed });
    const running = controller.start();
    await jest.advanceTimersByTimeAsync(650);
    await running;
    expect(api.chatStream).toHaveBeenCalledTimes(2);
    expect(api.chatStream.mock.calls[1][0]).toEqual(intent);
    expect(api.chatStream.mock.calls[1][2]).toMatchObject({ lastEventId: 0, retry: false });
    expect(completed).toHaveBeenCalledWith(response);
    expect(controller.getSnapshot().content).toBe('完整回复');
    controller.dispose();
  } finally { jest.useRealTimers(); }
});

test('replayed fragments never duplicate visible text and disposal rejects all late data', async () => {
  let receive!: (value: SseEvent) => void;
  const api = { chatStream: jest.fn(async (_intent, sink) => { receive = sink; }) };
  const changes: string[] = [];
  const controller = createChatStreamController({ api, intent, isCurrent: () => true,
    onChange: progress => changes.push(progress.content), onComplete: jest.fn() });
  const running = controller.start();
  receive(event(0, 'snapshot', { status: 'running', content: '' }));
  receive(event(1, 'text_delta', { delta: '你好' }));
  receive(event(1, 'text_delta', { delta: '你好' }));
  expect(controller.getSnapshot().content).toBe('你好');
  controller.dispose();
  const count = changes.length;
  receive(event(2, 'text_delta', { delta: '别的账号的数据' }));
  await running;
  expect(changes).toHaveLength(count);
  expect(controller.getSnapshot().content).toBe('你好');
});

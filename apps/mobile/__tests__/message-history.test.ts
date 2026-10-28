import { ApiClient } from '../src/api/client';
import type { Message } from '../src/domain/types';
import { createMessageHistory, mergeMessageHistory } from '../src/screens/messageHistory';

const message = (id: string, seconds: number): Message => ({ id, conversation_id: 'chat', role: 'user', content: id, created_at: new Date(seconds * 1000).toISOString() });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('keeps legacy message URL and serializes bounded offset and stable before pages', async () => {
  const fetcher = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"items":[]}' });
  const api = new ApiClient('https://api.example.com', undefined, undefined, fetcher);
  await api.messages('chat /1');
  await api.messages('chat /1', { offset: 0, limit: 40 });
  await api.messages('chat /1', { before: 'msg /2', limit: 40 });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    'https://api.example.com/v1/conversations/chat%20%2F1/messages',
    'https://api.example.com/v1/conversations/chat%20%2F1/messages?offset=0&limit=40',
    'https://api.example.com/v1/conversations/chat%20%2F1/messages?before=msg%20%2F2&limit=40',
  ]);
});

it('loads earliest sentinel without losing current replies or loaded pages on return', async () => {
  const late = deferred<{ items: Message[]; next_offset: null }>();
  const messages = jest.fn().mockResolvedValueOnce({ items: [message('recent', 100)], next_offset: 40, next_before: 'recent' }).mockReturnValueOnce(late.promise);
  const api = { messages } as unknown as ApiClient;
  const history = createMessageHistory();
  let loaded: Message[] = [];
  const apply = (items: Message[]) => { loaded = mergeMessageHistory(items, loaded); };
  await history.ensure(api, 'chat', apply, () => true);
  const pending = history.older(api, 'chat', apply, () => true);
  loaded = mergeMessageHistory([], [...loaded, message('new reply', 200)]);
  late.resolve({ items: [message('earliest sentinel', 1), message('recent', 100)], next_offset: null });
  await pending;
  expect(loaded.map(item => item.id)).toEqual(['earliest sentinel', 'recent', 'new reply']);
  expect(messages).toHaveBeenLastCalledWith('chat', { before: 'recent', limit: 40 });
  await history.ensure(api, 'chat', apply, () => true);
  expect(messages).toHaveBeenCalledTimes(2);
  expect(history.getSnapshot().nextOffset).toBeNull();
});

it('fences a late older page when its account or route is disposed', async () => {
  const late = deferred<{ items: Message[]; next_offset: null }>();
  const messages = jest.fn().mockResolvedValueOnce({ items: [message('current', 100)], next_offset: 40 }).mockReturnValueOnce(late.promise);
  const history = createMessageHistory();
  const apply = jest.fn();
  const api = { messages } as unknown as ApiClient;
  await history.ensure(api, 'chat', apply, () => true);
  const pending = history.older(api, 'chat', apply, () => true);
  history.dispose();
  late.resolve({ items: [message('foreign late', 1)], next_offset: null });
  await pending;
  expect(apply).toHaveBeenCalledTimes(1);
  expect(history.getSnapshot().loading).toBe(false);
});

it('preserves nanosecond chronology and the current value for overlapping ids', () => {
  const early = { ...message('early', 1), created_at: '2026-10-28T00:00:00.123Z' };
  const later = { ...message('later', 1), created_at: '2026-10-28T08:00:00.123000001+08:00' };
  expect(mergeMessageHistory([later, early], [{ ...later, content: 'current' }]).map(item => item.content)).toEqual(['early', 'current']);
});

import { createMessageHistory, mergeMessageHistory } from '../src/screens/messageHistory';
import type { ApiClient } from '../src/api/client';
import type { Message } from '../src/domain/types';

const message = (id: string, seconds: number): Message => ({ id, role: 'user', content: id, conversation_id: 'c', created_at: new Date(seconds * 1000).toISOString() });

test('mutation restarts deleted cursors from the latest page and retains loaded older rows', async () => {
  const history = createMessageHistory();
  const api = { messages: jest.fn()
    .mockResolvedValueOnce({ items: [message('recent', 10)], next_offset: 40, next_before: 'deleted-cursor' })
    .mockResolvedValueOnce({ items: [message('recent', 10)], next_offset: 40, next_before: 'valid-cursor' })
    .mockResolvedValueOnce({ items: [message('older', 1)], next_offset: null }) };
  let items = [message('already-loaded', 0)];
  const apply = (page: Message[]) => { items = mergeMessageHistory(page, items); };
  await history.ensure(api as unknown as ApiClient, 'c', apply, () => true);
  await history.restart(api as unknown as ApiClient, 'c', apply, () => true);
  expect(api.messages.mock.calls[1]).toEqual(['c', { offset: 0, limit: 40 }]);
  expect(history.getSnapshot().nextBefore).toBe('valid-cursor');
  await history.older(api as unknown as ApiClient, 'c', apply, () => true);
  expect(api.messages.mock.calls[2]).toEqual(['c', { before: 'valid-cursor', limit: 40 }]);
  expect(items.map(item => item.id)).toEqual(['already-loaded', 'older', 'recent']);
});

test('a page from before mutation cannot overwrite the rebuilt cursor or restore stale rows', async () => {
  const history = createMessageHistory();
  let release!: (value: unknown) => void;
  const oldPage = new Promise(resolve => { release = resolve; });
  const api = { messages: jest.fn()
    .mockResolvedValueOnce({ items: [message('recent', 10)], next_offset: 40, next_before: 'obsolete' })
    .mockReturnValueOnce(oldPage)
    .mockResolvedValueOnce({ items: [message('recent', 10)], next_offset: 40, next_before: 'current' }) };
  const apply = jest.fn();
  await history.ensure(api as unknown as ApiClient, 'c', apply, () => true);
  const obsolete = history.older(api as unknown as ApiClient, 'c', apply, () => true);
  await history.restart(api as unknown as ApiClient, 'c', apply, () => true);
  release({ items: [message('deleted', 2)], next_offset: 80, next_before: 'obsolete-again' });
  await obsolete;
  expect(history.getSnapshot()).toMatchObject({ nextBefore: 'current', nextOffset: 40, loading: false });
  expect(apply.mock.calls.flat(2).some(item => item?.id === 'deleted')).toBe(false);
});

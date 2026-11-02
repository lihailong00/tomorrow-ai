import type { Conversation } from '../src/domain/types';
import {
  conversationPinKey,
  conversationSections,
  createConversationPinStore,
} from '../src/features/conversations/pins';

const item = (id: string, date = '2026-11-02T04:00:00Z'): Conversation => ({
  id,
  title: '对话 ' + id,
  updated_at: date,
});
function fixture() {
  const values = new Map<string, string>();
  const storage = {
    load: jest.fn(async (key: string) => values.get(key) ?? null),
    save: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  };
  return { values, storage, store: createConversationPinStore(storage) };
}
test('storage ownership separates users, URLs and server identities without using auth tokens', () => {
  const key = conversationPinKey('alice', 'https://host/', 'one');
  expect(key).toBe(conversationPinKey('alice', 'https://host', 'one'));
  expect(key).not.toBe(conversationPinKey('bob', 'https://host', 'one'));
  expect(key).not.toBe(conversationPinKey('alice', 'https://other', 'one'));
  expect(key).not.toBe(conversationPinKey('alice', 'https://host', 'two'));
  expect(conversationPinKey(undefined, 'https://host')).toBeNull();
});
test('pins survive a fresh store and remain visible outside the newest server page', async () => {
  const f = fixture();
  const owner = f.store.owner('alice');
  await owner.load();
  await owner.toggle(item('old', '2026-10-01T00:00:00Z'));
  const restarted = createConversationPinStore(f.storage).owner('alice');
  await restarted.load();
  expect(
    conversationSections([item('new')], restarted.getSnapshot().items),
  ).toEqual({
    pinned: [item('old', '2026-10-01T00:00:00Z')],
    recent: [item('new')],
  });
  expect(f.store.owner('bob').getSnapshot().items).toEqual([]);
});
test('live page metadata wins, no duplicates, unpinned conversations return to date order', () => {
  const old = item('old', '2026-10-01T00:00:00Z');
  const live = { ...old, title: '服务端的新标题' };
  const sections = conversationSections(
    [item('new'), live, item('middle', '2026-11-01T00:00:00Z')],
    [old],
    [old],
  );
  expect(sections.pinned).toEqual([live]);
  expect(sections.recent.map(row => row.id)).toEqual(['new', 'middle']);
  expect(
    conversationSections(
      [item('new'), item('middle', '2026-11-01T00:00:00Z')],
      [],
      [old],
    ).recent.map(row => row.id),
  ).toEqual(['new', 'middle', 'old']);
});
test('undo reverses only its target and preserves other pin changes', async () => {
  const f = fixture();
  const owner = f.store.owner('alice');
  await owner.load();
  const undo = await owner.toggle(item('first'));
  await owner.toggle(item('second'));
  await owner.undo(undo);
  expect(owner.getSnapshot().items.map(row => row.id)).toEqual(['second']);
  await owner.toggle(item('first'));
  const unpin = await owner.toggle(item('second'));
  await owner.undo(unpin);
  expect(owner.getSnapshot().items.map(row => row.id)).toEqual([
    'first',
    'second',
  ]);
});
test('a failed secure write rolls back optimistic pins and exposes a retryable error', async () => {
  const f = fixture();
  const owner = f.store.owner('alice');
  await owner.load();
  await owner.toggle(item('first'));
  f.storage.save.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(owner.toggle(item('second'))).rejects.toThrow('未能保存');
  expect(owner.getSnapshot()).toMatchObject({
    busy: false,
    items: [item('first')],
    error: expect.stringContaining('未能保存'),
  });
  await owner.toggle(item('second'));
  expect(owner.getSnapshot().items.map(row => row.id)).toEqual([
    'second',
    'first',
  ]);
});
test('overlapping saves are rejected so late writes cannot lose a newer operation', async () => {
  const f = fixture();
  const owner = f.store.owner('alice');
  await owner.load();
  let release!: () => void;
  f.storage.save.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
  const first = owner.toggle(item('first'));
  await expect(owner.toggle(item('second'))).rejects.toThrow('请稍候');
  release();
  await first;
  expect(f.storage.save).toHaveBeenCalledTimes(1);
  expect(owner.getSnapshot().items).toEqual([item('first')]);
});
test('a corrupt or unreadable vault is never silently overwritten and can be reloaded', async () => {
  const f = fixture();
  f.values.set('alice', 'broken');
  const owner = f.store.owner('alice');
  await owner.load();
  expect(owner.getSnapshot().ready).toBe(false);
  await expect(owner.toggle(item('new'))).rejects.toThrow();
  expect(f.storage.save).not.toHaveBeenCalled();
  f.values.set(
    'alice',
    JSON.stringify({ version: 1, items: [item('original')] }),
  );
  await owner.load();
  expect(owner.getSnapshot()).toMatchObject({
    ready: true,
    error: null,
    items: [item('original')],
  });
});
test('bounded storage and invalid metadata errors are visible without replacing valid pins', async () => {
  const f = fixture();
  const owner = f.store.owner('alice');
  f.values.set(
    'alice',
    JSON.stringify({
      version: 1,
      items: Array.from({ length: 100 }, (_, index) => item(String(index))),
    }),
  );
  await owner.load();
  await expect(owner.toggle(item('overflow'))).rejects.toThrow('100');
  expect(owner.getSnapshot().error).toContain('100');
  expect(owner.getSnapshot().items).toHaveLength(100);
  await owner.toggle(item('0'));
  await expect(owner.toggle(item('invalid', 'bad date'))).rejects.toThrow(
    '信息不完整',
  );
  expect(owner.getSnapshot().error).toContain('信息不完整');
  expect(owner.getSnapshot().items).toHaveLength(99);
});

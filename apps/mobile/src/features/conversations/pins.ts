import type { Conversation } from '../../domain/types';

export const MAX_CONVERSATION_PINS = 100;
export type PinSnapshot = {
  items: readonly Conversation[];
  loading: boolean;
  ready: boolean;
  busy: boolean;
  error: string | null;
};
export type PinUndo = { item: Conversation; index: number };
type Storage = {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
};

export function conversationPinKey(
  userId?: string,
  serverUrl?: string,
  instanceId?: string,
) {
  if (!userId || !serverUrl) return null;
  return (
    'tada.conversation-pins.v1.' +
    encodeURIComponent(
      JSON.stringify([
        serverUrl.trim().replace(/\/+$/, ''),
        instanceId ?? 'unverified',
        userId,
      ]),
    )
  );
}

function normalize(item: Conversation): Conversation {
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    item.id.length > 200 ||
    typeof item.title !== 'string' ||
    typeof item.updated_at !== 'string' ||
    !Number.isFinite(Date.parse(item.updated_at))
  )
    throw new Error('本机置顶记录无法读取，请重试。');
  return {
    id: item.id,
    title: item.title.slice(0, 500),
    updated_at: item.updated_at,
  };
}

function decode(raw: string | null): Conversation[] {
  if (!raw) return [];
  if (raw.length > 200_000) throw new Error('本机置顶记录无法读取，请重试。');
  const value = JSON.parse(raw);
  if (
    value?.version !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_CONVERSATION_PINS
  ) {
    throw new Error('本机置顶记录无法读取，请重试。');
  }
  const unique = new Map<string, Conversation>();
  value.items.forEach((item: Conversation) => {
    const row = normalize(item);
    unique.set(row.id, row);
  });
  return [...unique.values()];
}

/** One writer per account/server, shared by history and the active chat header. */
export function createConversationPinStore(storage: Storage) {
  const owners = new Map<string, ReturnType<typeof createOwner>>();
  function createOwner(key: string | null) {
    let snapshot: PinSnapshot = {
      items: [],
      loading: Boolean(key),
      ready: !key,
      busy: false,
      error: null,
    };
    let pendingLoad: Promise<void> | null = null;
    const listeners = new Set<() => void>();
    const update = (patch: Partial<PinSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach(listener => listener());
    };
    const load = () => {
      if (!key || snapshot.ready) return Promise.resolve();
      if (pendingLoad) return pendingLoad;
      update({ loading: true, error: null });
      pendingLoad = (async () => {
        try {
          update({
            items: decode(await storage.load(key)),
            ready: true,
            error: null,
          });
        } catch {
          update({ error: '本机置顶记录无法读取，请重试。' });
        } finally {
          pendingLoad = null;
          update({ loading: false });
        }
      })();
      return pendingLoad;
    };
    const change = async (next: readonly Conversation[]) => {
      if (!key || !snapshot.ready || snapshot.busy)
        throw new Error('正在读取或保存置顶记录，请稍候。');
      if (next.length > MAX_CONVERSATION_PINS) {
        const message = '最多可置顶 100 段对话，请先取消一些置顶。';
        update({ error: message });
        throw new Error(message);
      }
      const previous = snapshot.items;
      let normalized: Conversation[];
      try {
        normalized = next.map(normalize);
      } catch {
        const message = '这段对话的信息不完整，请刷新对话记录后重试。';
        update({ error: message });
        throw new Error(message);
      }
      update({ items: normalized, busy: true, error: null });
      try {
        await storage.save(
          key,
          JSON.stringify({ version: 1, items: normalized }),
        );
        update({ busy: false });
      } catch {
        update({
          items: previous,
          busy: false,
          error: '置顶记录未能保存，请重试。',
        });
        throw new Error('置顶记录未能保存，请重试。');
      }
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      load,
      async toggle(item: Conversation): Promise<PinUndo> {
        const index = snapshot.items.findIndex(row => row.id === item.id);
        const old = index >= 0 ? snapshot.items[index] : item;
        await change(
          index >= 0
            ? snapshot.items.filter(row => row.id !== item.id)
            : [item, ...snapshot.items],
        );
        return { item: old, index };
      },
      async undo(action: PinUndo) {
        const next = snapshot.items.filter(item => item.id !== action.item.id);
        if (action.index >= 0)
          next.splice(Math.min(action.index, next.length), 0, action.item);
        await change(next);
      },
    };
  }
  const signedOut = createOwner(null);
  return {
    owner(key: string | null) {
      if (!key) return signedOut;
      if (!owners.has(key)) owners.set(key, createOwner(key));
      return owners.get(key)!;
    },
  };
}

/** Cached pinned titles keep older pages reachable; live server metadata wins. */
export function conversationSections(
  items: readonly Conversation[],
  pins: readonly Conversation[],
  retained: readonly Conversation[] = [],
) {
  const all = new Map(
    [...retained, ...pins, ...items].map(item => [item.id, item]),
  );
  const ids = new Set(pins.map(item => item.id));
  return {
    pinned: pins.map(item => all.get(item.id)!),
    recent: [...all.values()]
      .filter(item => !ids.has(item.id))
      .sort(
        (left, right) =>
          (Date.parse(right.updated_at) || 0) -
            (Date.parse(left.updated_at) || 0) ||
          left.id.localeCompare(right.id),
      ),
  };
}

import type { ApiClient } from '../api/client';
import { errorMessage } from '../api/client';
import type { Message } from '../domain/types';

export const MESSAGE_HISTORY_PAGE_SIZE = 40;
type HistoryPage = Awaited<ReturnType<ApiClient['messages']>>;
type HistorySnapshot = {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  nextOffset: number | null;
  nextBefore: string | null;
};

function messageOrder(message: Message) {
  const milliseconds = Date.parse(message.created_at);
  // Preserve RFC3339 nanoseconds, which Date.parse rounds to milliseconds.
  const fraction = /\.(\d+)/.exec(message.created_at)?.[1] ?? '';
  return [Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1000) : 0,
    fraction.padEnd(9, '0').slice(0, 9)] as const;
}

/** Current turns win overlaps; adding an older page never removes a loaded page. */
export function mergeMessageHistory(history: Message[], current: Message[]) {
  const byId = new Map(history.map(message => [message.id, message]));
  current.forEach(message => byId.set(message.id, message));
  return Array.from(byId.values()).sort((left, right) => {
    const a = messageOrder(left);
    const b = messageOrder(right);
    return a[0] - b[0] || a[1].localeCompare(b[1]) || left.id.localeCompare(right.id);
  });
}

/** Navigation owns this controller, so loaded pages survive a screen remount. */
export function createMessageHistory() {
  let snapshot: HistorySnapshot = {
    initialized: false, loading: false, error: null,
    nextOffset: null, nextBefore: null,
  };
  let generation = 0;
  let owner: ApiClient | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<HistorySnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  const load = async (
    api: ApiClient,
    id: string | undefined,
    apply: (items: Message[]) => void,
    canApply: () => boolean,
    older: boolean,
  ) => {
    if (snapshot.loading || (older && snapshot.nextOffset === null)) return;
    const request = ++generation;
    owner = api;
    const current = () => request === generation && owner === api && canApply();
    update({ loading: true, error: null });
    try {
      const page: HistoryPage = id
        ? await api.messages(id, older && snapshot.nextBefore
          ? { before: snapshot.nextBefore, limit: MESSAGE_HISTORY_PAGE_SIZE }
          : { offset: older ? snapshot.nextOffset ?? 0 : 0, limit: MESSAGE_HISTORY_PAGE_SIZE })
        : { items: [] };
      if (!current()) return;
      apply(page.items);
      // A latest-page refresh preserves the older-page boundary already loaded.
      const retainBoundary = !older && snapshot.initialized;
      update({ initialized: true,
        ...(!retainBoundary ? {
          nextOffset: typeof page.next_offset === 'number' ? page.next_offset : null,
          nextBefore: typeof page.next_offset === 'number'
            ? page.next_before ?? page.items[0]?.id ?? null : null,
        } : {}),
      });
    } catch (error) {
      if (current()) update({ error: errorMessage(error) });
    } finally {
      if (current()) update({ loading: false });
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    // Native ScrollView owns prepend anchoring; retain only its reported offset for Back.
    viewport: { y: 0 },
    ensure: (api: ApiClient, id: string | undefined, apply: (items: Message[]) => void, canApply: () => boolean) =>
      snapshot.initialized ? Promise.resolve() : load(api, id, apply, canApply, false),
    refresh: (api: ApiClient, id: string | undefined, apply: (items: Message[]) => void, canApply: () => boolean) =>
      load(api, id, apply, canApply, false),
    older: (api: ApiClient, id: string | undefined, apply: (items: Message[]) => void, canApply: () => boolean) =>
      load(api, id, apply, canApply, true),
    dispose: () => {
      generation += 1;
      owner = undefined;
      update({ loading: false });
    },
  };
}

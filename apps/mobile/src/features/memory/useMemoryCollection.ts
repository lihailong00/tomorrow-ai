import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { errorMessage } from '../../api/client';
import type { Memory } from '../../domain/types';

type PageState = {
  owner: object;
  items: Memory[];
  nextOffset: number | null;
  loading: boolean;
  error: string | null;
};

export function useMemoryCollection(api: ApiClient, revision: number) {
  const owner = useMemo(
    () => ({ api, generation: 0, active: false, pending: false }),
    [api],
  );
  const current = useRef(owner);
  current.current = owner;
  const [state, setState] = useState<PageState>({
    owner,
    items: [],
    nextOffset: null,
    loading: true,
    error: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const request = useCallback(
    async (offset: number, append: boolean, version: number) => {
      const isCurrent = () =>
        owner.active &&
        current.current === owner &&
        owner.generation === version;
      if (!isCurrent()) return;
      owner.pending = true;
      setState(previous => ({
        owner,
        items: previous.owner === owner ? previous.items : [],
        nextOffset:
          append && previous.owner === owner ? previous.nextOffset : null,
        loading: true,
        error: null,
      }));
      try {
        const page = await api.memories(undefined, { offset, limit: 50 });
        if (!isCurrent()) return;
        setState(previous => {
          const unique = new Map(
            (append && previous.owner === owner ? previous.items : []).map(
              item => [item.id, item],
            ),
          );
          page.items.forEach(item => unique.set(item.id, item));
          return {
            owner,
            items: [...unique.values()],
            nextOffset: page.next_offset ?? null,
            loading: false,
            error: null,
          };
        });
      } catch (failure) {
        if (isCurrent())
          setState(previous => ({
            ...previous,
            owner,
            loading: false,
            error: errorMessage(failure),
          }));
      } finally {
        if (isCurrent()) owner.pending = false;
      }
    },
    [api, owner],
  );
  const refresh = useCallback(() => {
    request(0, false, ++owner.generation);
  }, [request, owner]);
  useEffect(() => {
    owner.active = true;
    refresh();
    return () => {
      owner.active = false;
      owner.generation += 1;
      owner.pending = false;
    };
  }, [owner, refresh, revision]);
  const loadMore = useCallback(() => {
    const previous = stateRef.current;
    if (
      previous.owner === owner &&
      previous.nextOffset !== null &&
      !owner.pending
    ) {
      request(previous.nextOffset, true, owner.generation);
    }
  }, [owner, request]);
  const updateLocal = useCallback(
    (memory: Memory | null, deletedId?: string) => {
      owner.generation += 1;
      owner.pending = false;
      setState(previous => {
        const items = previous.owner === owner ? previous.items : [];
        return {
          ...previous,
          owner,
          loading: false,
          error: null,
          items: memory
            ? [memory, ...items.filter(item => item.id !== memory.id)]
            : items.filter(item => item.id !== deletedId),
        };
      });
    },
    [owner],
  );
  const visible =
    state.owner === owner
      ? state
      : {
          owner,
          items: [],
          nextOffset: null,
          loading: true,
          error: null,
        };
  return {
    ...visible,
    refresh,
    loadMore,
    updateLocal,
    hasMore: visible.nextOffset !== null,
  };
}

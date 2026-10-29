import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../api/client';

export function useTodoList<T extends { id: string }>(
  load: (
    offset: number,
  ) => Promise<{ items: T[]; next_offset?: number | null }>,
  deps: React.DependencyList,
) {
  // A distinct scope immediately hides the previous owner's rows in render.
  const scope = useMemo(
    () => ({ load, active: false, generation: 0, pending: false }),
    // Callers explicitly key ownership and filters, not a changing loader closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  scope.load = load;
  const current = useRef(scope);
  current.current = scope;
  const [state, setState] = useState({
    scope,
    items: [] as T[],
    next: null as number | null,
    loading: true,
    error: null as string | null,
  });
  const request = useCallback(async (offset: number, append: boolean) => {
    const owner = current.current;
    if (!owner.active || (append && owner.pending)) return;
    const generation = ++owner.generation;
    owner.pending = true;
    const valid = () =>
      owner.active &&
      current.current === owner &&
      generation === owner.generation;
    setState(previous => ({
      scope: owner,
      items: previous.scope === owner ? previous.items : [],
      next: previous.scope === owner ? previous.next : null,
      loading: true,
      error: null,
    }));
    try {
      const page = await owner.load(offset);
      if (!valid()) return;
      if (!Array.isArray(page.items))
        throw new Error('暂时无法读取事项，请检查服务版本。');
      const next = page.next_offset ?? null;
      if (next !== null && (!Number.isSafeInteger(next) || next <= offset))
        throw new Error('后续事项暂时无法读取，请重新刷新。');
      setState(previous => {
        const items = new Map(
          (append && previous.scope === owner ? previous.items : []).map(
            item => [item.id, item],
          ),
        );
        page.items.forEach(item => items.set(item.id, item));
        return {
          scope: owner,
          items: [...items.values()],
          next,
          loading: false,
          error: null,
        };
      });
    } catch (error) {
      if (valid())
        setState(previous => ({
          ...previous,
          scope: owner,
          loading: false,
          error: errorMessage(error),
        }));
    } finally {
      if (valid()) owner.pending = false;
    }
  }, []);
  useEffect(() => {
    scope.active = true;
    void request(0, false);
    return () => {
      scope.active = false;
      scope.generation++;
    };
  }, [scope, request]);
  const visible =
    state.scope === scope
      ? state
      : { items: [] as T[], next: null, loading: true, error: null };
  return {
    items: visible.items,
    loading: visible.loading,
    error: visible.error,
    hasMore: visible.next !== null,
    refresh: () => {
      void request(0, false);
    },
    loadMore: () => {
      if (visible.next !== null) void request(visible.next, true);
    },
  };
}

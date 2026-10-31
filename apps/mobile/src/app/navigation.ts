import { useCallback, useEffect, useRef, useState } from 'react';
import type { Route } from './context';

type RouteEntry = {
  key: number;
  route: Route;
  // The mount key changes on return, but this entry's temporary state survives.
  state: Map<unknown, unknown>;
  disposals: Map<unknown, () => void>;
};

export type RetainedRouteScope = {
  isRetained: () => boolean;
  updateRoute: (update: (route: Route) => Route) => void;
  onDispose: (cleanup: () => void) => () => void;
};

const disposeEntry = (entry: RouteEntry) => {
  entry.disposals.forEach(dispose => dispose());
  entry.disposals.clear();
};

/** Navigation callbacks belong to the screen and account that rendered them. */
export function useRouteStack(owner: unknown) {
  const nextKey = useRef(0);
  const [entries, setEntries] = useState<RouteEntry[]>([
    { key: 0, route: { name: 'main' }, state: new Map(), disposals: new Map() },
  ]);
  const current = useRef(entries);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const lifetime = useRef({ generation: 0 });
  useEffect(() => {
    const activeLifetime = lifetime.current;
    const generation = ++activeLifetime.generation;
    return () => {
      // StrictMode replays effects without discarding the navigation entries.
      Promise.resolve().then(() => {
        if (activeLifetime.generation === generation || currentOwner.current !== owner) {
          current.current.forEach(item => item.disposals.get(owner)?.());
        }
      });
    };
  }, [owner]);
  const entry = entries[entries.length - 1];
  const commit = useCallback((next: RouteEntry[]) => {
    // Update synchronously, so two callbacks in the same render cannot both pop.
    current.current = next;
    setEntries(next);
  }, []);
  const isCurrent = useCallback(
    () =>
      currentOwner.current === owner &&
      current.current[current.current.length - 1].key === entry.key,
    [entry.key, owner],
  );
  const navigate = useCallback(
    (route: Route) => {
      if (isCurrent()) {
        commit([...current.current, { key: ++nextKey.current, route, state: new Map(), disposals: new Map() }]);
      }
    },
    [commit, isCurrent],
  );
  const back = useCallback(() => {
    if (isCurrent() && current.current.length > 1) {
      disposeEntry(current.current[current.current.length - 1]);
      const next = current.current.slice(0, -1);
      // Revealing a route mounts a fresh screen. Never reactivate callbacks from
      // the previous screen instance that occupied this stack position.
      next[next.length - 1] = {
        ...next[next.length - 1],
        key: ++nextKey.current,
      };
      commit(next);
    }
  }, [commit, isCurrent]);
  const updateRoute = useCallback(
    (update: (route: Route) => Route) => {
      if (isCurrent()) {
        const latest = current.current[current.current.length - 1];
        commit([
          ...current.current.slice(0, -1),
          { ...latest, route: update(latest.route) },
        ]);
      }
    },
    [commit, isCurrent],
  );
  const resetRoutes = useCallback(
    (routes: Route[]) => {
      current.current.forEach(disposeEntry);
      commit(routes.map(route => ({ key: ++nextKey.current, route, state: new Map(), disposals: new Map() })));
    },
    [commit],
  );
  const getEntryState = useCallback(
    <T,>(create: (scope: RetainedRouteScope) => T): T => {
      if (!entry.state.has(owner)) {
        let active = true;
        const cleanups = new Set<() => void>();
        entry.disposals.set(owner, () => {
          if (!active) return;
          active = false;
          cleanups.forEach(cleanup => cleanup());
          cleanups.clear();
          entry.state.delete(owner);
          entry.disposals.delete(owner);
        });
        const isRetained = () =>
          active &&
          currentOwner.current === owner &&
          current.current.some(item => item.state === entry.state);
        entry.state.set(owner, create({
          isRetained,
          onDispose: cleanup => {
            if (!isRetained()) {
              cleanup();
              return () => {};
            }
            cleanups.add(cleanup);
            return () => { cleanups.delete(cleanup); };
          },
          updateRoute: update => {
            if (isRetained()) {
              commit(current.current.map(item => item.state === entry.state
                ? { ...item, route: update(item.route) }
                : item));
            }
          },
        }));
      }
      return entry.state.get(owner) as T;
    },
    [commit, entry.disposals, entry.state, owner],
  );
  return {
    entry,
    depth: entries.length,
    navigate,
    back,
    updateRoute,
    resetRoutes,
    getEntryState,
  };
}

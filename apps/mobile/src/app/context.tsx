import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ApiClient, errorMessage } from '../api/client';
import type { AuthSession, Memory, Schedule, User } from '../domain/types';
import type { Preferences } from '../platform/ports';
import type { HealthReceipt } from '../domain/healthLink';

export type MainTab = 'today' | 'tasks' | 'memories' | 'capabilities';
export type Route =
  | { name: 'main' }
  | { name: 'settings' }
  | { name: 'chat'; conversationId?: string; prompt?: string }
  | { name: 'task'; id: string }
  | { name: 'newTask' }
  | { name: 'todos' }
  | { name: 'todo'; id: string }
  | { name: 'todoSources'; conversationId?: string }
  | { name: 'assistantTasks' }
  | { name: 'memory'; memory?: Memory }
  | { name: 'schedule'; schedule?: Schedule }
  | { name: 'notifications' }
  | { name: 'artifacts' }
  | { name: 'uploads' }
  | { name: 'integrations' }
  | { name: 'health'; receipt?: HealthReceipt }
  | { name: 'aiHistory' }
  | { name: 'conversations' };
export interface AppContextValue {
  api: ApiClient;
  user: User | null;
  preferences: Preferences;
  navigate: (route: Route) => void;
  back: () => void;
  signIn: (session: AuthSession) => Promise<void>;
  signOut: () => Promise<void>;
  updateUser: (user: User) => Promise<void>;
  savePreferences: (value: Preferences) => Promise<void>;
  revision: number;
  invalidate: () => void;
  formatDate: (value: string, timezone?: string) => string;
}
const AppContext = createContext<AppContextValue | null>(null);
export const AppProvider = AppContext.Provider;
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('App provider missing');
  }
  return value;
}

export function useResource<T>(
  load: () => Promise<T>,
  deps: React.DependencyList = [],
) {
  const scope = useMemo(
    () => ({ load, active: false, inFlight: false, queued: false }),
    // Callers explicitly key requests; a new loader closure alone is not a new resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  scope.load = load;
  const [state, setState] = useState(() => ({
    scope,
    value: null as T | null,
    loading: true,
    error: null as string | null,
  }));
  const refresh = useCallback(function refreshResource() {
    const request = currentScope.current;
    const isCurrent = () => request.active && currentScope.current === request;
    if (!isCurrent()) return;
    if (request.inFlight) {
      // Polling and manual refreshes share one pending revalidation. They must
      // not invalidate a slow response that still belongs to this resource.
      request.queued = true;
      return;
    }
    request.inFlight = true;
    setState(previous =>
      isCurrent()
        ? {
            scope: request,
            value: previous.scope === request ? previous.value : null,
            loading: true,
            // A queued retry may start in the same batch as the failure. Keep
            // that warning visible until this resource succeeds.
            error: previous.scope === request ? previous.error : null,
          }
        : previous,
    );
    (async () => {
      try {
        const result = await request.load();
        if (isCurrent()) {
          setState(previous =>
            isCurrent() ? { ...previous, value: result, error: null } : previous,
          );
        }
      } catch (failure) {
        if (isCurrent()) {
          setState(previous =>
            isCurrent()
              ? { ...previous, error: errorMessage(failure) }
              : previous,
          );
        }
      } finally {
        request.inFlight = false;
        if (isCurrent()) {
          setState(previous =>
            isCurrent() ? { ...previous, loading: false } : previous,
          );
          if (request.queued) {
            request.queued = false;
            refreshResource();
          }
        }
      }
    })();
  }, []);
  useEffect(() => {
    scope.active = true;
    // StrictMode may replay this effect while its first request is pending.
    if (!scope.inFlight) refresh();
    return () => {
      scope.active = false;
      scope.queued = false;
    };
  }, [scope, refresh]);
  const setValue = useCallback<React.Dispatch<React.SetStateAction<T | null>>>(
    next => {
      const request = currentScope.current;
      if (!request.active) return;
      setState(previous => {
        if (!request.active || currentScope.current !== request) return previous;
        const value = previous.scope === request ? previous.value : null;
        return {
          scope: request,
          value:
            typeof next === 'function'
              ? (next as (previous: T | null) => T | null)(value)
              : next,
          loading: previous.scope === request ? previous.loading : true,
          error: previous.scope === request ? previous.error : null,
        };
      });
    },
    [],
  );
  // Hide previous-owner data in the render that changes scope, before effects run.
  return {
    value: state.scope === scope ? state.value : null,
    loading: state.scope === scope ? state.loading : true,
    error: state.scope === scope ? state.error : null,
    refresh,
    setValue,
  };
}

export type ActionScope = { isCurrent: () => boolean };

export function useAction() {
  const app = useContext(AppContext);
  const owner = useMemo(() => ({
    api: app?.api,
    userId: app?.user?.id,
    serverUrl: app?.preferences?.serverUrl,
    instanceId: app?.preferences?.instance?.id,
  }), [app?.api, app?.user?.id, app?.preferences?.serverUrl, app?.preferences?.instance?.id]);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef<object | null>(null);
  useEffect(() => {
    mounted.current = true;
    lock.current = null;
    setBusy(false);
    setError(null);
    return () => {
      mounted.current = false;
      lock.current = null;
    };
  }, [owner]);
  const run = async (action: (scope: ActionScope) => Promise<void>) => {
    // Native confirmation dialogs may outlive the screen that opened them.
    if (!mounted.current || currentOwner.current !== owner || lock.current) {
      return;
    }
    const request = {};
    lock.current = request;
    const isCurrent = () => mounted.current && currentOwner.current === owner &&
      lock.current === request;
    setBusy(true);
    setError(null);
    try {
      await action({ isCurrent });
    } catch (failure) {
      if (isCurrent()) {
        setError(errorMessage(failure));
      }
    } finally {
      if (isCurrent()) {
        lock.current = null;
        setBusy(false);
      }
    }
  };
  return { busy, error, setError, run };
}

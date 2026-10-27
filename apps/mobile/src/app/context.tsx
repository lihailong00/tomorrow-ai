import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiClient, errorMessage } from '../api/client';
import type { AuthSession, Memory, Schedule, User } from '../domain/types';
import type { Preferences } from '../platform/ports';

export type MainTab = 'today' | 'tasks' | 'memories' | 'capabilities';
export type Route =
  | { name: 'main' }
  | { name: 'settings' }
  | { name: 'chat'; conversationId?: string; prompt?: string }
  | { name: 'task'; id: string }
  | { name: 'newTask' }
  | { name: 'memory'; memory?: Memory }
  | { name: 'schedule'; schedule?: Schedule }
  | { name: 'notifications' }
  | { name: 'artifacts' }
  | { name: 'uploads' }
  | { name: 'integrations' }
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
  const [value, setValue] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    load()
      .then(result => {
        if (current) {
          setValue(result);
        }
      })
      .catch(failure => {
        if (current) {
          setError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
    // Requests are keyed explicitly by the caller to avoid reloading on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, generation]);
  const refresh = useCallback(() => setGeneration(old => old + 1), []);
  return { value, loading, error, refresh, setValue };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) {
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

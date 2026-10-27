import { useEffect } from 'react';
import type { ApiClient } from '../api/client';
import { platform } from '../platform/ports';

/** Foreground delivery only; remote/background push remains an explicit separate capability. */
export function useForegroundNotifications(
  api: ApiClient,
  userId: string | undefined,
) {
  useEffect(() => {
    if (!userId) {
      return;
    }
    let alive = true;
    let initialized = false;
    let pending = false;
    const seen = new Set<string>();
    const check = async () => {
      if (!alive || pending || !platform.isForeground()) {
        return;
      }
      pending = true;
      try {
        const response = await api.notifications();
        if (!alive) {
          return;
        }
        if (!initialized) {
          response.items.forEach(item => seen.add(item.id));
          initialized = true;
          return;
        }
        for (const item of response.items) {
          if (!alive) {
            return;
          }
          if (seen.has(item.id)) {
            continue;
          }
          seen.add(item.id);
          if (!item.read) {
            // Never request permission here. A declined permission does not interrupt the app.
            await platform
              .showNotification(item.title, item.body)
              .catch(() => {});
          }
        }
      } catch {
        /* Offline and permission errors leave the in-app inbox available. */
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, 15000);
    const unsubscribe = platform.onForeground(() => {
      void check();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [api, userId]);
}

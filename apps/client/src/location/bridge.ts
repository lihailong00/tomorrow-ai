import type {ChatLocationContext} from '@tada/client-core';

export type LocationFailureCode = 'permission_denied' | 'services_disabled' | 'timeout' | 'unavailable' | 'unsupported' | 'insecure_context' | 'cancelled' | 'invalid_result';
export class LocationFailure extends Error {
  constructor(public readonly code: LocationFailureCode) {super(code); this.name = 'LocationFailure';}
}
export interface LocationBridge {
  current(signal: AbortSignal, silent?: boolean): Promise<ChatLocationContext>;
  canLocateSilently?(): Promise<boolean>;
  openSettings?(): Promise<void>;
}
const REQUEST_TIMEOUT = 25_000;

/** No watchPosition, IP fallback, background reads or persistence of coordinates. */
export function browserLocationBridge(): LocationBridge {
  async function canLocateSilently() {
    try {return (await navigator.permissions.query({name: 'geolocation'})).state === 'granted';}
    catch {return false;}
  }
  return {canLocateSilently, async current(signal, silent) {
    if (silent && !await canLocateSilently()) throw new LocationFailure('permission_denied');
    if (signal.aborted) return Promise.reject(new LocationFailure('cancelled'));
    if (!window.isSecureContext) return Promise.reject(new LocationFailure('insecure_context'));
    if (!navigator.geolocation) return Promise.reject(new LocationFailure('unsupported'));
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result?: ChatLocationContext, error?: LocationFailure) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(result!);
      };
      const cancel = () => finish(undefined, new LocationFailure('cancelled'));
      // Browser timeout excludes time spent at the permission prompt. Bound our UI too.
      const timer = setTimeout(() => finish(undefined, new LocationFailure('timeout')), REQUEST_TIMEOUT + 5000);
      signal.addEventListener('abort', cancel, {once: true});
      try {
        navigator.geolocation.getCurrentPosition(position => {
          if (!Number.isFinite(position.timestamp) || !Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude) || !Number.isFinite(position.coords.accuracy)) {
            finish(undefined, new LocationFailure('invalid_result')); return;
          }
          const observed = new Date(position.timestamp);
          if (!Number.isFinite(observed.valueOf())) {finish(undefined, new LocationFailure('invalid_result')); return;}
          finish({
          source: 'device', latitude: position.coords.latitude, longitude: position.coords.longitude,
          accuracy_m: position.coords.accuracy, observed_at: observed.toISOString(), coordinate_system: 'wgs84',
        });}, error => finish(undefined, new LocationFailure(error.code === 1 ? 'permission_denied' : error.code === 3 ? 'timeout' : 'unavailable')),
        {enableHighAccuracy: true, maximumAge: 60_000, timeout: REQUEST_TIMEOUT});
      } catch {finish(undefined, new LocationFailure('unavailable'));}
    });
  }};
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export function desktopLocationBridge(invoke: Invoke): LocationBridge {
  let authorized = false;
  return {
    canLocateSilently: async () => authorized || await invoke<boolean>('desktop_location_ready').catch(() => false),
    current(signal, silent = false) {
      if (signal.aborted) return Promise.reject(new LocationFailure('cancelled'));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (result?: ChatLocationContext, error?: LocationFailure) => {
          if (finished) return;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(result!);
        };
        const stop = () => {void invoke('desktop_location_cancel', {requestId}).catch(() => {});};
        const cancel = () => {stop(); finish(undefined, new LocationFailure('cancelled'));};
        const timer = setTimeout(() => {stop(); finish(undefined, new LocationFailure('timeout'));}, 60_000);
        signal.addEventListener('abort', cancel, {once: true});
        void invoke<ChatLocationContext>('desktop_location_request', silent ? {requestId, silent} : {requestId}).then(result => {
          if (!signal.aborted) authorized = true;
          finish(result);
        }, error => {
          const known: LocationFailureCode[] = ['permission_denied', 'services_disabled', 'timeout', 'unsupported', 'cancelled', 'invalid_result'];
          const code = typeof error === 'string' && known.includes(error as LocationFailureCode) ? error as LocationFailureCode : 'unavailable';
          if (code === 'permission_denied') authorized = false;
          finish(undefined, new LocationFailure(code));
        });
      });
    },
    openSettings: () => invoke<void>('desktop_location_settings'),
  };
}

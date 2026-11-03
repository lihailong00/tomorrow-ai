import type { ChatLocationContext } from '../../domain/types';
import type { DeviceCoordinates, DeviceLocationStatus } from '../../platform/deviceLocation';
import { validLocation } from './model';

export type LocationChoice = { kind: 'selected'; location: ChatLocationContext } | { kind: 'skip' | 'cancel' };
export type LocationDialog = 'startup' | 'chat' | 'edit';
type Mode = 'auto' | 'manual' | 'skip';
export type LocationSnapshot = {
  ready: boolean; mode: Mode | null; location: ChatLocationContext | null; deviceVerified: boolean; approximate: boolean; cached: boolean;
  dialog: LocationDialog | null; manual: boolean; input: string;
  busy: boolean; error: string | null; settings: 'permission' | 'services' | null;
};
export type LocationBridge = {
  status(): Promise<DeviceLocationStatus>;
  requestCurrentLocation(signal?: AbortSignal): Promise<DeviceCoordinates>;
  openSettings(reason?: 'permission' | 'services'): Promise<void>;
};
type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

const errorDetails = (error: unknown): { message: string; settings: 'permission' | 'services' | null } => {
  const code = (error as { code?: string })?.code;
  if (code === 'permission_denied') return { message: '未获得定位权限。可以重新定位，或手动填写地址。', settings: null };
  if (code === 'permission_blocked') return { message: '定位权限已关闭，请到设置中开启，或手动填写地址。', settings: 'permission' };
  if (code === 'services_disabled') return { message: '手机定位服务未开启。请打开定位服务，或手动填写地址。', settings: 'services' };
  if (code === 'timeout') return { message: '暂时没有获得位置，请重试或手动填写地址。', settings: null };
  if (code === 'unsupported') return { message: '当前设备暂不支持自动定位，请手动填写地址。', settings: null };
  if (code === 'cancelled') return { message: '定位已取消，消息仍保留在输入框。', settings: null };
  return { message: '暂时无法获取位置，请重试或手动填写地址。', settings: null };
};

/** One authenticated server/user scope. Only consent mode is persisted, never places. */
export function createLocationSession(scope: string, bridge: LocationBridge, storage: Storage) {
  const key = `tada.location.consent.v1:${scope}`;
  let state: LocationSnapshot = { ready: false, mode: null, location: null, deviceVerified: false, approximate: false, cached: false, dialog: null,
    manual: false, input: '', busy: false, error: null, settings: null };
  const listeners = new Set<() => void>();
  let alive = true;
  let foreground = true;
  let generation = 0;
  let choiceGeneration = 0;
  let request: AbortController | undefined;
  let awaitingPermission = false;
  let pending: ((choice: LocationChoice) => void) | undefined;
  const publish = (change: Partial<LocationSnapshot>) => {
    if (!alive) return;
    state = { ...state, ...change };
    listeners.forEach(listener => listener());
  };
  const abort = () => { generation++; request?.abort(); request = undefined; awaitingPermission = false; };
  const persist = (mode: Mode) => {
    // A failed preference write must not turn a successful location into an error.
    void storage.setItem(key, mode).catch(() => undefined);
  };
  const finish = (choice: LocationChoice) => {
    const resolve = pending; pending = undefined;
    publish({ dialog: null, manual: false, input: '', busy: false, error: null, settings: null });
    resolve?.(choice);
  };
  const setLocation = (location: ChatLocationContext, mode: Mode) => {
    publish({ location: Object.freeze({ ...location }), deviceVerified: mode === 'auto', mode }); persist(mode);
    finish({ kind: 'selected', location: state.location! });
  };
  const locate = async (explicit = true) => {
    if (!alive || !foreground || state.busy) return;
    if (explicit) choiceGeneration++;
    abort();
    const owner = generation;
    const controller = new AbortController(); request = controller;
    const current = () => alive && foreground && generation === owner && !controller.signal.aborted;
    publish({ busy: true, error: null, settings: null, manual: false, deviceVerified: false });
    try {
      const status = await bridge.status();
      if (!current()) return;
      if (!status.supported) throw { code: 'unsupported' };
      if (!status.services_enabled) throw { code: 'services_disabled' };
      if (status.permission === 'blocked') throw { code: 'permission_blocked' };
      // Foreground refresh can never open an OS permission prompt.
      if (!explicit && status.permission !== 'granted') throw { code: 'permission_denied' };
      if (!explicit && validLocation(state.location) && state.location.source === 'device') {
        publish({ busy: false, deviceVerified: true, approximate: status.accuracy === 'approximate' }); return;
      }
      awaitingPermission = explicit && status.permission === 'denied';
      const fix = await bridge.requestCurrentLocation(controller.signal);
      if (!current()) return;
      // The first request may have changed denied -> coarse/precise. Read the
      // actual grant after the OS sheet instead of labeling from the old status.
      const verified = await bridge.status();
      if (!current()) return;
      if (!verified.services_enabled) throw { code: 'services_disabled' };
      if (verified.permission !== 'granted') throw { code: verified.permission === 'blocked' ? 'permission_blocked' : 'permission_denied' };
      const location: ChatLocationContext = { source: 'device', latitude: fix.latitude, longitude: fix.longitude,
        accuracy_m: fix.accuracy_m, observed_at: fix.observed_at, coordinate_system: fix.coordinate_system };
      if (!validLocation(location) || !Number.isFinite(fix.age_ms) || fix.age_ms > 5 * 60 * 1000) throw { code: 'invalid_result' };
      publish({ approximate: verified.accuracy === 'approximate', cached: fix.source === 'last_known' || fix.stale });
      if (explicit) setLocation(location, 'auto');
      else publish({ location: Object.freeze(location), busy: false, deviceVerified: true });
    } catch (error) {
      if (!current()) return;
      const details = errorDetails(error);
      publish({ busy: false, deviceVerified: false, ...{ error: details.message, settings: details.settings },
        ...(state.location?.source === 'device' ? { location: null } : {}) });
    } finally {
      if (generation === owner) { request = undefined; awaitingPermission = false; }
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async initialize() {
      const owner = choiceGeneration;
      let mode: string | null = null;
      try { mode = await storage.getItem(key); } catch { /* still offer the soft choice */ }
      if (!alive) return;
      // A user can open the chat picker while storage is still loading.
      // Never let a late saved preference replace a newer manual/skip choice.
      if (choiceGeneration !== owner) { publish({ ready: true }); return; }
      const saved = mode === 'auto' || mode === 'manual' || mode === 'skip' ? mode : null;
      publish({ ready: true, mode: saved, dialog: saved ? null : 'startup' });
      if (saved === 'auto') await locate(false);
    },
    request(reason: LocationDialog = 'chat'): Promise<LocationChoice> {
      if (!alive || !foreground) return Promise.resolve({ kind: 'cancel' });
      choiceGeneration++;
      abort(); pending?.({ kind: 'cancel' });
      publish({ dialog: reason, manual: false, input: state.location?.source === 'manual' ? state.location.label ?? '' : '',
        busy: false, error: null, settings: null });
      return new Promise(resolve => { pending = resolve; });
    },
    locate: () => locate(true),
    manual() { choiceGeneration++; abort(); publish({ manual: true, busy: false, error: null, settings: null }); },
    setInput(input: string) { publish({ input, error: null }); },
    saveManual() {
      const label = state.input.trim();
      if (!label || Array.from(label).length > 200 || /[\u0000-\u001f\u007f]/u.test(label)) {
        publish({ error: '请输入 1～200 字的城市、地标或地址。' }); return;
      }
      abort();
      setLocation({ source: 'manual', label, observed_at: new Date().toISOString() }, 'manual');
    },
    skip() {
      choiceGeneration++;
      abort(); publish({ mode: 'skip', location: null, deviceVerified: false }); persist('skip'); finish({ kind: 'skip' });
    },
    dismiss() {
      abort();
      if (state.dialog === 'startup') { publish({ mode: 'skip' }); persist('skip'); }
      finish({ kind: 'cancel' });
    },
    async openSettings() {
      if (!state.settings) return;
      try { await bridge.openSettings(state.settings); }
      catch { publish({ error: '无法打开系统设置，请在手机设置中手动开启定位。' }); }
    },
    foreground(active: boolean) {
      foreground = active;
      if (!active) publish({ deviceVerified: false });
      // The Android permission sheet pauses the host before returning to it.
      // Native waits for RESUMED before sampling; don't cancel that first grant.
      if (!active && !awaitingPermission) { abort(); finish({ kind: 'cancel' }); }
      else if (state.ready && state.mode === 'auto' && !state.dialog) void locate(false);
    },
    dispose() { alive = false; abort(); pending?.({ kind: 'cancel' }); pending = undefined; listeners.clear(); state = { ...state, location: null, input: '' }; },
  };
}
export type LocationSession = ReturnType<typeof createLocationSession>;

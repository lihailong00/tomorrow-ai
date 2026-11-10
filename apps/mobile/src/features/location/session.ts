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
  purpose: 'trip' | 'location'; rememberManual: boolean; savedManualLabel: string | null;
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

/** One server/user scope. Device coordinates stay in memory; saving a manual default is opt-in. */
export function createLocationSession(scope: string, bridge: LocationBridge, storage: Storage) {
  const key = `tada.location.consent.v1:${scope}`;
  const placeKey = `tada.location.saved-place.v1:${scope}`;
  let state: LocationSnapshot = { ready: false, mode: null, location: null, deviceVerified: false, approximate: false, cached: false, dialog: null,
    manual: false, input: '', busy: false, error: null, settings: null,
    purpose: 'location', rememberManual: false, savedManualLabel: null };
  const listeners = new Set<() => void>();
  let alive = true;
  let foreground = true;
  let generation = 0;
  let choiceGeneration = 0;
  let request: AbortController | undefined;
  let awaitingPermission = false;
  let returningFromSettings = false;
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
    returningFromSettings = false;
    const resolve = pending; pending = undefined;
    publish({ dialog: null, manual: false, input: '', busy: false, error: null, settings: null });
    resolve?.(choice);
  };
  const setLocation = (location: ChatLocationContext, mode: Mode) => {
    publish({ location: Object.freeze({ ...location }), deviceVerified: mode === 'auto', mode }); persist(mode);
    if (state.dialog === 'startup') publish({ manual: false, input: '', busy: false, error: null, settings: null });
    else finish({ kind: 'selected', location: state.location! });
  };
  const locate = async (explicit = true, offerStartup = false, quietChat = false) => {
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
        publish({ approximate: status.accuracy === 'approximate' });
        if (pending && (quietChat || state.dialog === 'chat' || state.dialog === 'edit')) setLocation(state.location, 'auto');
        else publish({ busy: false, deviceVerified: true });
        return;
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
      if (explicit || quietChat || state.mode === null || state.dialog === 'startup' || ((state.dialog === 'chat' || state.dialog === 'edit') && pending)) setLocation(location, 'auto');
      else publish({ location: Object.freeze(location), busy: false, deviceVerified: true });
    } catch (error) {
      if (!current()) return;
      const details = errorDetails(error);
      const code = (error as { code?: string })?.code;
      const showSetup = offerStartup && !state.dialog && (state.mode === null ||
        code === 'permission_denied' || code === 'permission_blocked' || code === 'services_disabled');
      publish({ busy: false, deviceVerified: false, ...{ error: details.message, settings: details.settings },
        ...(quietChat ? { dialog: 'chat' as const } : showSetup ? { dialog: 'startup' as const } : {}),
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
      let savedLabel: string | null = null;
      try {
        const [savedMode, savedPlace] = await Promise.all([storage.getItem(key), storage.getItem(placeKey)]);
        mode = savedMode;
        const place = JSON.parse(savedPlace || 'null');
        if (typeof place?.label === 'string' && validLocation({ source: 'manual', label: place.label,
          observed_at: new Date().toISOString() })) savedLabel = place.label;
      } catch { /* still offer the soft choice; invalid saved places are not used */ }
      if (!alive) return;
      // A user can open the chat picker while storage is still loading.
      // Never let a late saved preference replace a newer manual/skip choice.
      if (choiceGeneration !== owner) { publish({ ready: true }); return; }
      const saved = mode === 'auto' || mode === 'manual' || mode === 'skip' ? mode : null;
      publish({ ready: true, mode: saved, savedManualLabel: savedLabel,
        ...(saved === 'manual' && savedLabel ? { location: Object.freeze({ source: 'manual' as const,
          label: savedLabel, observed_at: new Date().toISOString() }) } : {}) });
      if (saved === null || saved === 'auto') await locate(false, true);
    },
    request(reason: LocationDialog = 'chat', purpose: 'trip' | 'location' = 'location', action?: 'auto' | 'manual', reuseAutomatic = false): Promise<LocationChoice> {
      if (!alive || !foreground) return Promise.resolve({ kind: 'cancel' });
      choiceGeneration++;
      abort(); pending?.({ kind: 'cancel' });
      const choice = new Promise<LocationChoice>(resolve => { pending = resolve; });
      const quietChat = reason === 'chat' && !action && reuseAutomatic && state.mode === 'auto';
      publish({ dialog: quietChat ? null : reason, purpose, manual: false, rememberManual: false,
        input: state.location?.source === 'manual' ? state.location.label ?? '' : state.savedManualLabel ?? '',
        busy: false, error: null, settings: null });
      // A typed choice is as explicit as tapping its matching button. It must
      // not race a silent refresh that cannot request a missing permission.
      if (action === 'manual') publish({ manual: true });
      else if (action === 'auto') void locate(true);
      else if (quietChat) void locate(false, false, true);
      return choice;
    },
    completeSetup() {
      if (state.dialog !== 'startup') return;
      if (!state.mode || (state.mode === 'auto' && !state.location)) { publish({ mode: 'skip' }); persist('skip'); }
      finish({ kind: 'skip' });
    },
    locate: () => locate(true),
    async canLocateSilently() {
      if (!alive || !foreground) return false;
      const status = await bridge.status();
      return status.supported && status.services_enabled && status.permission === 'granted';
    },
    locateSilently() {
      if (state.dialog === 'chat' && !state.manual && pending) return locate(false);
    },
    async currentForMap(signal: AbortSignal, explicit: boolean) {
      const current = () => alive && foreground && !signal.aborted && state.manual;
      if (!current()) return null;
      const status = await bridge.status();
      if (!current()) return null;
      if (!status.supported) throw {code: 'unsupported'};
      if (!status.services_enabled) throw {code: 'services_disabled'};
      if (status.permission === 'blocked') throw {code: 'permission_blocked'};
      if (!explicit && status.permission !== 'granted') return null;
      if (status.permission === 'granted' && state.location?.source === 'device' && validLocation(state.location) && !explicit) return state.location;
      const waiting = explicit && status.permission === 'denied';
      if (waiting) awaitingPermission = true;
      try {
        const fix = await bridge.requestCurrentLocation(signal);
        if (!current()) return null;
        const location: ChatLocationContext = {source: 'device', latitude: fix.latitude, longitude: fix.longitude,
          accuracy_m: fix.accuracy_m, observed_at: fix.observed_at, coordinate_system: fix.coordinate_system};
        return validLocation(location) ? location : null;
      } finally {
        if (waiting) awaitingPermission = false;
      }
    },
    manual() { choiceGeneration++; abort(); publish({ manual: true, busy: false, error: null, settings: null }); },
    backToChoices() { choiceGeneration++; abort(); publish({manual: false, busy: false, error: null, settings: null}); },
    setInput(input: string) { publish({ input, error: null }); },
    rememberManual(value: boolean) { publish({ rememberManual: value }); },
    saveManual(point?: {label: string; latitude: number; longitude: number; coordinate_system: 'wgs84' | 'gcj02'}) {
      const label = (point?.label ?? state.input).trim();
      if (!label || Array.from(label).length > 200 || /[\u0000-\u001f\u007f]/u.test(label)) {
        publish({ error: '请输入 1～200 字的城市、地标或地址。' }); return;
      }
      abort();
      if (state.rememberManual) {
        publish({ savedManualLabel: label });
        void storage.setItem(placeKey, JSON.stringify({ label })).catch(() => undefined);
      }
      setLocation({ ...point, source: 'manual', label, observed_at: new Date().toISOString() }, 'manual');
    },
    skip() {
      choiceGeneration++;
      abort();
      if (state.dialog !== 'chat') { publish({ mode: 'skip', location: null, deviceVerified: false }); persist('skip'); }
      finish({ kind: 'skip' });
    },
    dismiss() {
      abort();
      if (state.dialog === 'startup' && (!state.mode || (state.mode === 'auto' && !state.location))) {
        publish({ mode: 'skip' }); persist('skip');
      }
      finish({ kind: 'cancel' });
    },
    async openSettings() {
      if (!state.settings) return;
      returningFromSettings = true;
      try { await bridge.openSettings(state.settings); }
      catch { returningFromSettings = false; publish({ error: '无法打开系统设置，请在手机设置中手动开启定位。' }); }
    },
    foreground(active: boolean) {
      foreground = active;
      if (!active) publish({ deviceVerified: false });
      // The Android permission sheet pauses the host before returning to it.
      // Native waits for RESUMED before sampling; don't cancel that first grant.
      if (!active && !awaitingPermission) {
        abort();
        if (state.dialog !== 'startup' && !returningFromSettings) finish({ kind: 'cancel' });
        else publish({ busy: false });
      }
      else if (active && returningFromSettings) { returningFromSettings = false; void locate(false); }
      else if (active && state.ready && (state.mode === 'auto' || state.mode === null) && !state.dialog) void locate(false, true);
    },
    dispose() { alive = false; abort(); pending?.({ kind: 'cancel' }); pending = undefined; listeners.clear(); state = { ...state, location: null, input: '', savedManualLabel: null }; },
  };
}
export type LocationSession = ReturnType<typeof createLocationSession>;

import {useEffect, useRef, useState} from 'react';
import type {ChatClientContext, ChatLocationContext} from '@tada/client-core';
import {browserLocationBridge, type LocationBridge} from './bridge';
import {captureClientContext, locationInputAction, needsCurrentLocation, validLocation} from './model';

type Choice = {kind: 'selected'; location: ChatLocationContext} | {kind: 'skip' | 'cancel'};
type State = {open: boolean; manual: boolean; input: string; busy: boolean; error: string; settings: boolean; countdown: boolean; location: ChatLocationContext | null; mode: 'auto' | 'manual' | null};
const initial = (): State => ({open: false, manual: false, input: '', busy: false, error: '', settings: false, countdown: false, location: null, mode: null});

export function useChatLocation(bridge: LocationBridge | undefined, scope: unknown) {
  const fallback = useRef<LocationBridge | null>(null);
  if (!fallback.current) fallback.current = browserLocationBridge();
  const port = bridge ?? fallback.current;
  const [state, setState] = useState(initial);
  const latest = useRef(state); latest.current = state;
  const active = useRef<AbortController | null>(null);
  const resolveChoice = useRef<((choice: Choice) => void) | null>(null);
  const alive = useRef(false);
  const owner = useRef(0);
  function update(change: Partial<State>) {
    if (!alive.current) return;
    latest.current = {...latest.current, ...change}; setState(latest.current);
  }
  function abort() {owner.current++; active.current?.abort(); active.current = null;}
  function finish(choice: Choice) {
    abort(); const resolve = resolveChoice.current; resolveChoice.current = null;
    update({open: false, manual: false, busy: false, error: '', settings: false, countdown: false, input: ''}); resolve?.(choice);
  }
  function reset() {finish({kind: 'cancel'}); update(initial());}
  useEffect(() => {
    alive.current = true; latest.current = initial(); setState(latest.current);
    return () => {alive.current = false; abort(); resolveChoice.current?.({kind: 'cancel'}); resolveChoice.current = null; latest.current = initial();};
  }, [scope, port]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {if (event.key === 'Escape' && latest.current.open) {event.preventDefault(); finish({kind: 'cancel'});}};
    const hidden = () => {if (document.hidden && latest.current.open) finish({kind: 'cancel'});};
    document.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', hidden);
    return () => {document.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', hidden);};
  });
  async function locate(silent = false) {
    if (latest.current.busy || !alive.current) return;
    abort(); const ticket = owner.current; const controller = new AbortController(); active.current = controller;
    update({busy: true, manual: false, countdown: false, error: '', settings: false, location: null});
    try {
      if (silent && (document.hidden || !await port.canLocateSilently?.() || controller.signal.aborted)) {
        if (ticket === owner.current) update({busy: false});
        return;
      }
      const location = await port.current(controller.signal, silent);
      if (!alive.current || ticket !== owner.current || controller.signal.aborted) return;
      if (!validLocation(location) || location.source !== 'device' || location.accuracy_m! > 100_000) throw {code: 'invalid_result'};
      update({location: Object.freeze({...location}), mode: 'auto'}); finish({kind: 'selected', location});
    } catch (error) {
      if (!alive.current || ticket !== owner.current || controller.signal.aborted) return;
      const code = (error as {code?: string})?.code;
      const message = code === 'permission_denied' ? port.openSettings ? '未获得定位权限。可打开系统设置后重试，或手动填写出发地。' : '定位权限被拒绝。请在浏览器地址栏的网站设置中允许位置访问，或手动填写出发地。'
        : code === 'services_disabled' ? '系统定位服务已关闭。请开启后重试，或手动填写出发地。'
        : code === 'insecure_context' ? '网页自动定位需要 HTTPS（本机 localhost 除外）。请使用安全地址，或手动填写出发地。'
        : code === 'unsupported' ? '当前环境不支持自动定位，请手动填写出发地。'
        : code === 'timeout' ? '获取位置超时。可重试，或手动填写出发地。'
        : code === 'invalid_result' ? '未获得有效的新位置。请重新定位，或手动填写出发地。'
        : '暂时无法获取位置。请检查系统定位服务，重试或手动填写出发地。';
      update({busy: false, error: message, settings: Boolean(port.openSettings && ['permission_denied', 'services_disabled', 'unavailable'].includes(code ?? ''))});
    } finally {if (ticket === owner.current) active.current = null;}
  }
  useEffect(() => {
    if (!state.countdown) return;
    const timer = setTimeout(() => void locate(true), 5000);
    return () => clearTimeout(timer);
  }, [state.countdown, port]);
  function request(action?: 'auto' | 'manual', resumeAuto = true): Promise<Choice> {
    if (!alive.current) return Promise.resolve({kind: 'cancel'});
    abort(); resolveChoice.current?.({kind: 'cancel'});
    const promise = new Promise<Choice>(resolve => {resolveChoice.current = resolve;});
    const ticket = owner.current;
    update({open: true, manual: action === 'manual', busy: false, error: '', settings: false, countdown: false,
      input: latest.current.location?.source === 'manual' ? latest.current.location.label ?? '' : ''});
    if (action === 'auto') void locate();
    else if (resumeAuto && !action) {
      void port.canLocateSilently?.().then(granted => {
        if (granted && ticket === owner.current && latest.current.open && !document.hidden) update({countdown: true});
      }).catch(() => {});
    }
    return promise;
  }
  return {
    state,
    capture(message: string, previous: readonly {role: string; content: string}[], timezone: string): ChatClientContext | Promise<ChatClientContext | null> {
      if (!needsCurrentLocation(message, previous)) return captureClientContext(null, timezone);
      const action = locationInputAction(message);
      // Manual places apply only in this chat session. Device fixes are read again
      // on each relevant send, so revoked permission and moving users are handled.
      if (!action && latest.current.mode === 'manual' && validLocation(latest.current.location)) return captureClientContext(latest.current.location, timezone);
      return request(action).then(result => result.kind === 'cancel' ? null : captureClientContext(result.kind === 'selected' ? result.location : null, timezone));
    },
    edit: () => {void request(undefined, false);},
    requestForServer: () => request(undefined, false),
    locate: () => locate(),
    currentForMap: async (signal: AbortSignal, explicit: boolean) => {
      if (!explicit && !await port.canLocateSilently?.()) return null;
      const fix = await port.current(signal, !explicit);
      return fix.source === 'device' && validLocation(fix) ? fix : null;
    },
    manual: () => {abort(); update({manual: true, countdown: false, busy: false, error: '', settings: false});},
    backToChoices: () => update({manual: false, countdown: false, error: '', settings: false}),
    setInput: (input: string) => update({input, error: ''}),
    saveManual(point?: {label: string; latitude: number; longitude: number; coordinate_system: 'wgs84' | 'gcj02'}) {
      const label = (point?.label ?? latest.current.input).trim(); const location: ChatLocationContext = {...point, source: 'manual', label, observed_at: new Date().toISOString()};
      if (!validLocation(location)) {update({error: '请输入 1～200 字的城市、地标或地址。'}); return;}
      update({location: Object.freeze(location), mode: 'manual'}); finish({kind: 'selected', location});
    },
    cancel: () => finish({kind: 'cancel'}),
    skip: () => {update({location: null, mode: null}); finish({kind: 'skip'});},
    clear: () => {update({location: null, mode: null});},
    reset,
    async openSettings() {
      try {await port.openSettings?.(); update({settings: false, error: '在系统设置中开启定位后，点击“重新定位”继续。'});}
      catch {update({error: '无法打开系统设置。请到系统的位置隐私设置中开启定位，或手动填写出发地。'});}
    },
  };
}

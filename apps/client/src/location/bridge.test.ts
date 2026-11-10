import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {browserLocationBridge, desktopLocationBridge} from './bridge';

let success: PositionCallback;
let failure: PositionErrorCallback;
const getCurrentPosition = vi.fn((yes: PositionCallback, no: PositionErrorCallback | null | undefined) => {success = yes; failure = no!;});
const position = () => ({coords: {latitude: 31.2, longitude: 121.5, accuracy: 45}, timestamp: Date.now()} as GeolocationPosition);
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'geolocation', {value: {getCurrentPosition}, configurable: true});
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

describe('browser location boundary', () => {
  it('reads once, preserves sample time and accuracy, never watches or calls a server', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const request = browserLocationBridge().current(new AbortController().signal);
    const sample = position(); success(sample);
    expect(await request).toEqual({source: 'device', latitude: 31.2, longitude: 121.5, accuracy_m: 45, observed_at: new Date(sample.timestamp).toISOString(), coordinate_system: 'wgs84'});
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {enableHighAccuracy: true, maximumAge: 60_000, timeout: 25_000});
    expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore(); expect(vi.getTimerCount()).toBe(0);
  });
  it('fails HTTP clearly before asking permission', async () => {
    vi.stubGlobal('isSecureContext', false);
    await expect(browserLocationBridge().current(new AbortController().signal)).rejects.toMatchObject({code: 'insecure_context'});
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });
  it('reports an unsupported environment instead of fabricating an IP fix', async () => {
    Object.defineProperty(navigator, 'geolocation', {value: undefined, configurable: true});
    await expect(browserLocationBridge().current(new AbortController().signal)).rejects.toMatchObject({code: 'unsupported'});
  });
  it.each([[1, 'permission_denied'], [2, 'unavailable'], [3, 'timeout']])('maps native browser error %s', async (code, expected) => {
    const request = browserLocationBridge().current(new AbortController().signal);
    failure({code} as GeolocationPositionError);
    await expect(request).rejects.toMatchObject({code: expected}); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a dismissed/ignored browser prompt and ignores late completion', async () => {
    const request = browserLocationBridge().current(new AbortController().signal);
    const assertion = expect(request).rejects.toMatchObject({code: 'timeout'});
    await vi.advanceTimersByTimeAsync(30_000); await assertion; success(position()); expect(vi.getTimerCount()).toBe(0);
  });
  it('aborts before start and after start without leaking a late fix', async () => {
    const early = new AbortController(); early.abort();
    await expect(browserLocationBridge().current(early.signal)).rejects.toMatchObject({code: 'cancelled'});
    expect(getCurrentPosition).not.toHaveBeenCalled();
    const controller = new AbortController(); const request = browserLocationBridge().current(controller.signal);
    controller.abort(); success(position()); await expect(request).rejects.toMatchObject({code: 'cancelled'}); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([NaN, Infinity, 1e100])('rejects invalid sample timestamps %s', async timestamp => {
    const request = browserLocationBridge().current(new AbortController().signal); success({...position(), timestamp});
    await expect(request).rejects.toMatchObject({code: 'invalid_result'});
  });
});

describe('desktop location boundary', () => {
  it('uses native location, cancels by the same ID, and ignores late native replies', async () => {
    let complete!: (value: unknown) => void;
    const invoke = vi.fn((command: string) => command === 'desktop_location_request' ? new Promise(resolve => {complete = resolve;}) : Promise.resolve());
    const controller = new AbortController(); const request = desktopLocationBridge(invoke as never).current(controller.signal);
    const id = invoke.mock.calls[0] as unknown as [string, {requestId: string}];
    controller.abort(); complete({latitude: 31.2});
    await expect(request).rejects.toMatchObject({code: 'cancelled'});
    expect(invoke).toHaveBeenLastCalledWith('desktop_location_cancel', id[1]); expect(getCurrentPosition).not.toHaveBeenCalled();
  });
  it.each(['permission_denied', 'services_disabled', 'timeout', 'unsupported'])('keeps native %s recoverable', async code => {
    const invoke = vi.fn().mockRejectedValue(code);
    await expect(desktopLocationBridge(invoke).current(new AbortController().signal)).rejects.toMatchObject({code});
  });
  it('bounds native requests and opens only the fixed system location settings command', async () => {
    const invoke = vi.fn((command: string) => command === 'desktop_location_request' ? new Promise(() => {}) : Promise.resolve());
    const bridge = desktopLocationBridge(invoke as never);
    const assertion = expect(bridge.current(new AbortController().signal)).rejects.toMatchObject({code: 'timeout'});
    await vi.advanceTimersByTimeAsync(60_000); await assertion;
    expect(invoke).toHaveBeenCalledWith('desktop_location_cancel', expect.objectContaining({requestId: expect.any(String)}));
    await bridge.openSettings?.(); expect(invoke).toHaveBeenLastCalledWith('desktop_location_settings');
  });
});

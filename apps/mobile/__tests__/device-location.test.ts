import { NativeModules } from 'react-native';
import { deviceLocation, readDeviceCoordinates } from '../src/platform/deviceLocation';

const fix = { latitude: 31.2304, longitude: 121.4737, accuracy_m: 35, observed_at: '2026-11-03T00:00:00.000Z',
  coordinate_system: 'wgs84', source: 'current', age_ms: 1000, stale: false };
beforeEach(() => {
  NativeModules.TadaDeviceLocation = { status: jest.fn().mockResolvedValue({ supported: true, permission: 'granted', accuracy: 'approximate', services_enabled: true }),
    requestCurrentLocation: jest.fn().mockResolvedValue(fix), cancelCurrentLocation: jest.fn().mockResolvedValue(undefined),
    openAppSettings: jest.fn().mockResolvedValue(undefined), openLocationSettings: jest.fn().mockResolvedValue(undefined) };
});
afterEach(() => { delete NativeModules.TadaDeviceLocation; });

it('reports unsupported bridges without requesting permission or inventing coordinates', async () => {
  delete NativeModules.TadaDeviceLocation;
  expect(await deviceLocation.status()).toEqual({ supported: false, permission: 'denied', accuracy: 'none', services_enabled: false });
  await expect(deviceLocation.requestCurrentLocation()).rejects.toMatchObject({ code: 'unsupported' });
});
it('accepts approximate permission and preserves measured WGS84 accuracy and observation metadata', async () => {
  expect(await deviceLocation.status()).toMatchObject({ accuracy: 'approximate', permission: 'granted' });
  expect(NativeModules.TadaDeviceLocation.requestCurrentLocation).not.toHaveBeenCalled();
  expect(await deviceLocation.requestCurrentLocation()).toEqual(fix);
  expect(readDeviceCoordinates({ ...fix, source: 'last_known', age_ms: 300000, stale: true })).toMatchObject({ stale: true, age_ms: 300000 });
});
it.each([{ latitude: NaN }, { longitude: Infinity }, { latitude: 91 }, { longitude: -181 }, { accuracy_m: -1 },
  { coordinate_system: 'gcj02' }, { age_ms: 300001 }, { age_ms: -1 }, { observed_at: 'invalid' },
  { observed_at: '2026-02-30T00:00:00.000Z' }, { observed_at: '1970-01-01T00:00:00.000Z' }, { stale: true },
  { source: 'last_known', stale: false }])('rejects invalid or hidden stale coordinates: %o', value => {
  expect(() => readDeviceCoordinates({ ...fix, ...value })).toThrow();
});
it('does not send a native request when a signal was already cancelled', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(deviceLocation.requestCurrentLocation(controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
  expect(NativeModules.TadaDeviceLocation.requestCurrentLocation).not.toHaveBeenCalled();
});
it('cancels the exact native request and ignores a late fix after owner/filter cleanup', async () => {
  let resolve!: (value: unknown) => void;
  NativeModules.TadaDeviceLocation.requestCurrentLocation.mockImplementation(() => new Promise(done => { resolve = done; }));
  const controller = new AbortController();
  const request = deviceLocation.requestCurrentLocation(controller.signal);
  const outcome = request.catch(error => error);
  await Promise.resolve();
  const id = NativeModules.TadaDeviceLocation.requestCurrentLocation.mock.calls[0][0];
  controller.abort();
  expect(await outcome).toMatchObject({ code: 'cancelled' });
  expect(NativeModules.TadaDeviceLocation.cancelCurrentLocation).toHaveBeenCalledWith(id);
  resolve(fix); await Promise.resolve();
});
it('maps permission, disabled-service and timeout errors without exposing native diagnostics', async () => {
  for (const [native, expected] of [['E_LOCATION_PERMISSION_BLOCKED', 'permission_blocked'], ['E_LOCATION_SERVICES_DISABLED', 'services_disabled'], ['E_LOCATION_TIMEOUT', 'timeout']]) {
    NativeModules.TadaDeviceLocation.requestCurrentLocation.mockRejectedValueOnce({ code: native, message: 'private diagnostic fixture' });
    await expect(deviceLocation.requestCurrentLocation()).rejects.toMatchObject({ code: expected });
  }
  await deviceLocation.openSettings('services');
  expect(NativeModules.TadaDeviceLocation.openLocationSettings).toHaveBeenCalledTimes(1);
  await deviceLocation.openSettings('permission');
  expect(NativeModules.TadaDeviceLocation.openAppSettings).toHaveBeenCalledTimes(1);
});

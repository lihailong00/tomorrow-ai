import { NativeModules } from 'react-native';
import { photoIndex } from '../src/platform/photoIndex';
import type { ApiClient } from '../src/api/client';

jest.mock('react-native', () => ({
  NativeModules: {
    TomorrowPhotoIndex: {
      status: jest.fn(),
      requestAccess: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn(),
      clearLocal: jest.fn(),
      scanNow: jest.fn(),
    },
  },
}));
const native = NativeModules.TomorrowPhotoIndex;
const request = jest.fn();
const api = {
  baseUrl: 'https://example.test',
  request,
} as unknown as ApiClient;
beforeEach(() => {
  jest.resetAllMocks();
  native.status.mockResolvedValue({
    deviceId: 'device-a',
    enabled: false,
    state: 'idle',
    lastSyncAt: 0,
  });
  native.requestAccess.mockResolvedValue(true);
  native.enable.mockResolvedValue({ ok: true });
  native.disable.mockResolvedValue({ ok: true });
  native.clearLocal.mockResolvedValue({ ok: true });
  request.mockResolvedValue({ enabled: true, epoch: 7 });
});

test('reading settings never requests access or starts scanning', async () => {
  expect((await photoIndex.status(api.baseUrl, 'one')).enabled).toBe(false);
  expect(native.requestAccess).not.toHaveBeenCalled();
  expect(native.enable).not.toHaveBeenCalled();
  expect(native.scanNow).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('denied permission keeps both client and server disabled', async () => {
  native.requestAccess.mockResolvedValue(false);
  await expect(photoIndex.enable(api, 'one')).rejects.toThrow(
    '未获得相册访问权限',
  );
  expect(request).not.toHaveBeenCalled();
  expect(native.enable).not.toHaveBeenCalled();
});
test('server consent must succeed before scheduling any local work', async () => {
  request.mockRejectedValue(new Error('offline'));
  await expect(photoIndex.enable(api, 'one')).rejects.toThrow('offline');
  expect(native.enable).not.toHaveBeenCalled();
});
test('explicit enable passes only identity and the new consent epoch to the platform', async () => {
  await photoIndex.enable(api, 'one');
  expect(request).toHaveBeenCalledWith('/photo-index/devices/device-a', 'PUT', {
    enabled: true,
    cloud_processing: true,
  });
  expect(native.enable).toHaveBeenCalledWith('https://example.test', 'one', 7);
  expect(native.enable.mock.invocationCallOrder[0]).toBeGreaterThan(
    request.mock.invocationCallOrder[0],
  );
});
test('native enable failure revokes newly granted server consent', async () => {
  native.enable.mockRejectedValue(new Error('permission revoked'));
  await expect(photoIndex.enable(api, 'one')).rejects.toThrow(
    'permission revoked',
  );
  expect(native.disable).toHaveBeenCalled();
  expect(request).toHaveBeenLastCalledWith(
    '/photo-index/devices/device-a',
    'PUT',
    { enabled: false },
  );
});
test('explicit provider renewal passes its displayed scope and updates the native epoch without clearing selected photos', async () => {
  request.mockResolvedValue({ enabled: true, epoch: 8 });
  await photoIndex.enable(api, 'one', { consentScope: 'image-and-text-policy' });
  expect(request).toHaveBeenCalledWith('/photo-index/devices/device-a', 'PUT', {
    enabled: true, cloud_processing: true, consent_scope: 'image-and-text-policy',
  });
  expect(native.enable).toHaveBeenCalledWith(api.baseUrl, 'one', 8);
  expect(native.clearLocal).not.toHaveBeenCalled();
  expect(native.disable).not.toHaveBeenCalled();
});
test('a rejected provider scope cannot schedule work or silently retry a new consent', async () => {
  request.mockRejectedValue(new Error('photo_cloud_consent_changed'));
  await expect(photoIndex.enable(api, 'one', { consentScope: 'old-policy' })).rejects.toThrow('photo_cloud_consent_changed');
  expect(request).toHaveBeenCalledTimes(1);
  expect(native.enable).not.toHaveBeenCalled();
  expect(native.clearLocal).not.toHaveBeenCalled();
});
test('offline disable still stops all local scanning before contacting the server', async () => {
  request.mockRejectedValue(new Error('offline'));
  await expect(photoIndex.disable(api, 'one')).rejects.toThrow(
    '本机已停止扫描',
  );
  expect(native.disable.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[0],
  );
  expect(native.enable).not.toHaveBeenCalled();
});
test('clear stops work and clears only derived data after confirmed server deletion', async () => {
  await photoIndex.clear(api, 'one');
  expect(request).toHaveBeenCalledWith(
    '/photo-index/devices/device-a',
    'DELETE',
  );
  expect(native.clearLocal).toHaveBeenCalledWith(api.baseUrl, 'one');
  expect(native.disable.mock.invocationCallOrder[0]).toBeLessThan(
    request.mock.invocationCallOrder[0],
  );
  expect(native.clearLocal.mock.invocationCallOrder[0]).toBeGreaterThan(
    request.mock.invocationCallOrder[0],
  );
});

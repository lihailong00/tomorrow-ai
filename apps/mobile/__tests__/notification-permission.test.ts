import { Linking, NativeModules } from 'react-native';
import { platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('react-native', () => ({
  NativeModules: { TomorrowPlatform: {
    notificationPermissionStatus: jest.fn(), requestNotifications: jest.fn(), openNotificationSettings: jest.fn(),
  } },
  Platform: { OS: 'android' },
  Linking: { openSettings: jest.fn() },
}));

const native = NativeModules.TomorrowPlatform;
beforeEach(() => {
  jest.clearAllMocks();
  native.notificationPermissionStatus.mockReset().mockResolvedValue('requestable');
  native.requestNotifications.mockReset().mockResolvedValue(true);
  native.openNotificationSettings.mockResolvedValue(undefined);
});

it('requests notification permission only from the explicit management action', async () => {
  expect(native.requestNotifications).not.toHaveBeenCalled();
  expect(await platform.manageNotificationPermission()).toBe('granted');
  expect(native.requestNotifications).toHaveBeenCalledTimes(1);
  expect(native.openNotificationSettings).not.toHaveBeenCalled();
});

it('opens app notification settings when Android cannot prompt again, including pre-33 blocked access', async () => {
  native.notificationPermissionStatus.mockResolvedValue('blocked');
  expect(await platform.manageNotificationPermission()).toBe('settings');
  expect(native.openNotificationSettings).toHaveBeenCalledTimes(1);
  expect(native.requestNotifications).not.toHaveBeenCalled();
});

it('distinguishes an ordinary denial from a permanent denial discovered after a request', async () => {
  native.requestNotifications.mockResolvedValue(false);
  expect(await platform.manageNotificationPermission()).toBe('denied');
  native.notificationPermissionStatus.mockResolvedValueOnce('requestable').mockResolvedValueOnce('blocked');
  expect(await platform.manageNotificationPermission()).toBe('blocked');
  expect(native.openNotificationSettings).not.toHaveBeenCalled();
});

it('uses the platform app-settings fallback when the specialized native method is unavailable', async () => {
  const open = native.openNotificationSettings;
  delete native.openNotificationSettings;
  try {
    await platform.openNotificationSettings();
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  } finally { native.openNotificationSettings = open; }
});

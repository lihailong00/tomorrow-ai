import { NativeModules } from 'react-native';
import { platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(), setItem: jest.fn(),
}));
jest.mock('react-native', () => ({
  NativeModules: { TomorrowPlatform: { getSystemFontScale: jest.fn() } },
  Platform: { OS: 'android' },
}));

const native = NativeModules.TomorrowPlatform;
beforeEach(() => { native.getSystemFontScale = jest.fn(); });

test('reads the live native scale without caching a previous value', async () => {
  native.getSystemFontScale.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
  expect(await platform.getSystemFontScale()).toBe(2);
  expect(await platform.getSystemFontScale()).toBe(1);
});

test.each([null, 0, -1, NaN, Infinity, '2'])('invalid native scale %s preserves the Dimensions fallback', async value => {
  native.getSystemFontScale.mockResolvedValue(value);
  expect(await platform.getSystemFontScale()).toBeNull();
});

test('a missing or failed adapter leaves iOS, HarmonyOS and older builds on their existing fallback', async () => {
  native.getSystemFontScale.mockRejectedValue(new Error('bridge unavailable'));
  expect(await platform.getSystemFontScale()).toBeNull();
  delete native.getSystemFontScale;
  expect(await platform.getSystemFontScale()).toBeNull();
});

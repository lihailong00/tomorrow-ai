import { NativeModules } from 'react-native';
import { platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('react-native', () => ({
  NativeModules: { TomorrowPlatform: {
    getRecordingLevel: jest.fn(), startRecording: jest.fn(), stopRecording: jest.fn(),
  } },
  Platform: { OS: 'android' },
}));
const native = NativeModules.TomorrowPlatform;
beforeEach(() => { jest.clearAllMocks(); native.getRecordingLevel = jest.fn(); });

test('metering reads the actual level and never starts, stops or uploads audio', async () => {
  native.getRecordingLevel.mockResolvedValue(0.36);
  await expect(platform.recordingLevel()).resolves.toBe(0.36);
  expect(native.getRecordingLevel).toHaveBeenCalledTimes(1);
  expect(native.startRecording).not.toHaveBeenCalled();
  expect(native.stopRecording).not.toHaveBeenCalled();
});
test.each([[2, 1], [-1, 0], [NaN, 0], [Infinity, 0], [null, 0]])(
  'invalid native level %s cannot break the recording feedback', async (value, expected) => {
    native.getRecordingLevel.mockResolvedValue(value);
    await expect(platform.recordingLevel()).resolves.toBe(expected);
  },
);
test('older native binaries and a stopped recorder degrade to silence', async () => {
  delete native.getRecordingLevel;
  await expect(platform.recordingLevel()).resolves.toBe(0);
  native.getRecordingLevel = jest.fn().mockRejectedValue(new Error('recorder stopped'));
  await expect(platform.recordingLevel()).resolves.toBe(0);
});

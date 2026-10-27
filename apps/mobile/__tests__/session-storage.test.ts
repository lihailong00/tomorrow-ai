import { NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { defaultServerUrl, platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));
jest.mock('react-native', () => ({
  NativeModules: {
    TomorrowPlatform: {
      secureGet: jest.fn(),
      secureSet: jest.fn(),
      secureRemove: jest.fn(),
    },
  },
  Platform: { OS: 'android' },
}));

beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  NativeModules.TomorrowPlatform.secureGet.mockResolvedValue(null);
  NativeModules.TomorrowPlatform.secureRemove.mockResolvedValue(undefined);
});

describe('cloud service defaults', () => {
  it('uses the HTTPS cloud service on a fresh installation', async () => {
    expect(await platform.loadPreferences()).toEqual({
      serverUrl: defaultServerUrl,
      onboarded: false,
    });
    expect(defaultServerUrl).toBe(
      'https://api.example.invalid',
    );
    expect(NativeModules.TomorrowPlatform.secureRemove).not.toHaveBeenCalled();
  });

  it.each(['http://10.0.2.2:8080', 'http://10.0.2.2:8080/v1/'])(
    'migrates the old default %s after removing its local session',
    async url => {
      (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
        JSON.stringify({ serverUrl: url, onboarded: true }),
      );
      let finishRemoval!: () => void;
      NativeModules.TomorrowPlatform.secureRemove.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            finishRemoval = resolve;
          }),
      );
      const loading = platform.loadPreferences();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(AsyncStorage.setItem).not.toHaveBeenCalled();
      finishRemoval();
      expect(await loading).toEqual({
        serverUrl: defaultServerUrl,
        onboarded: true,
      });
      expect(NativeModules.TomorrowPlatform.secureRemove).toHaveBeenCalledWith(
        'tomorrow.session.v1',
      );
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        'tomorrow.preferences.v1',
        JSON.stringify({ serverUrl: defaultServerUrl, onboarded: true }),
      );
    },
  );

  it.each([
    { serverUrl: 'https://my-service.example', onboarded: true },
    { serverUrl: 'http://192.168.1.8:8080', onboarded: true },
    {
      serverUrl: 'http://10.0.2.2:8080',
      onboarded: true,
      serverUrlCustomized: true,
    },
  ])('keeps a user service choice and its session: $serverUrl', async saved => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
      JSON.stringify(saved),
    );
    expect(await platform.loadPreferences()).toEqual(saved);
    expect(NativeModules.TomorrowPlatform.secureRemove).not.toHaveBeenCalled();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('does not persist the cloud migration if clearing local credentials fails', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
      JSON.stringify({ serverUrl: 'http://10.0.2.2:8080', onboarded: true }),
    );
    NativeModules.TomorrowPlatform.secureRemove.mockRejectedValueOnce(
      new Error('secure storage unavailable'),
    );
    await expect(platform.loadPreferences()).rejects.toThrow(
      'secure storage unavailable',
    );
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

it('finishes an old account removal before storing and reading the new session', async () => {
  const native = NativeModules.TomorrowPlatform;
  let stored: string | null = 'old-account';
  let finishOldRemoval!: () => void;
  native.secureGet.mockImplementation(async () => stored);
  native.secureSet.mockImplementation(async (_key: string, value: string) => {
    stored = value;
  });
  native.secureRemove.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finishOldRemoval = () => {
          stored = null;
          resolve();
        };
      }),
  );
  const removing = platform.removeSession();
  await Promise.resolve();
  await Promise.resolve();
  const signingIn = platform.writeSession('new-account');
  const reading = platform.readSession();
  expect(native.secureSet).not.toHaveBeenCalled();
  finishOldRemoval();
  await Promise.all([removing, signingIn]);
  expect(await reading).toBe('new-account');
});

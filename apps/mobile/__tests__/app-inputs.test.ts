jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  NativeModules: {
    TadaAppInputs: {
      getStatus: jest.fn(),
      setApps: jest.fn(),
      openNotificationSettings: jest.fn(),
      listPending: jest.fn(),
      dismiss: jest.fn(),
      clear: jest.fn(),
      openApp: jest.fn(),
      extractImageText: jest.fn(),
    },
  },
}));

let NativeModules: {TadaAppInputs: Record<string, jest.Mock>};
let Platform: {OS: string};

function load() {
  return require('../src/platform/appInputs') as typeof import('../src/platform/appInputs');
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  ({NativeModules, Platform} = require('react-native'));
  Platform.OS = 'android';
  NativeModules.TadaAppInputs.clear.mockResolvedValue(undefined);
});

it('requires a known application and deduplicates explicit opt-ins', async () => {
  const {appInputs} = load();
  await appInputs.setApps(['wechat', 'qq', 'wechat']);
  expect(NativeModules.TadaAppInputs.setApps).toHaveBeenCalledWith(['wechat', 'qq']);
  await expect(appInputs.setApps(['arbitrary.package'])).rejects.toThrow('不支持的应用');
  await expect(appInputs.openApp('arbitrary.package')).rejects.toThrow('不支持的应用');
  expect(NativeModules.TadaAppInputs.openApp).not.toHaveBeenCalled();
});

it('returns only local pending items without invoking outbound operations', async () => {
  const entry = {id: 'one', kind: 'notification', source_app: 'wechat', title: '新消息', text: '下午三点开会', created_at: '2026-10-27T08:00:00Z'};
  NativeModules.TadaAppInputs.listPending.mockResolvedValue([entry]);
  expect(await load().appInputs.listPending()).toEqual([entry]);
  expect(NativeModules.TadaAppInputs.setApps).not.toHaveBeenCalled();
  expect(NativeModules.TadaAppInputs.openApp).not.toHaveBeenCalled();
});

it('awaits local cleanup and preserves cleanup failures for the logout flow', async () => {
  let finish!: () => void;
  NativeModules.TadaAppInputs.clear.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const clearing = load().appInputs.clear();
  let resolved = false;
  void clearing.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  finish();
  await clearing;
  NativeModules.TadaAppInputs.clear.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(load().appInputs.clear()).rejects.toThrow('cleanup failed');
});

it('does not claim Android notification access on iOS', async () => {
  Platform.OS = 'ios';
  const {appInputs} = load();
  expect(await appInputs.getStatus()).toEqual({supported: false, notification_access: false, selected_apps: [], installed_apps: [], pending_count: 0});
  expect(await appInputs.listPending()).toEqual([]);
  expect(await appInputs.openApp('wechat')).toBe(false);
  await expect(appInputs.openNotificationSettings()).rejects.toThrow('此系统尚未接入');
  await appInputs.clear();
  expect(NativeModules.TadaAppInputs.getStatus).not.toHaveBeenCalled();
  expect(NativeModules.TadaAppInputs.clear).not.toHaveBeenCalled();
});

it('bounds batch dismissal before it reaches the native bridge', async () => {
  await expect(load().appInputs.dismiss(Array.from({length: 101}, (_, index) => String(index)))).rejects.toThrow('100');
  expect(NativeModules.TadaAppInputs.dismiss).not.toHaveBeenCalled();
});

it('recognizes an explicitly selected shared image without sending or deleting it', async () => {
  NativeModules.TadaAppInputs.extractImageText.mockResolvedValue('订单将于明天送达');
  const {appInputs} = load();
  expect(appInputs.hasImageTextRecognition).toBe(true);
  expect(await appInputs.extractImageText('file:///private/app-inputs/one')).toBe('订单将于明天送达');
  expect(NativeModules.TadaAppInputs.extractImageText).toHaveBeenCalledWith('file:///private/app-inputs/one');
  expect(NativeModules.TadaAppInputs.dismiss).not.toHaveBeenCalled();
  expect(NativeModules.TadaAppInputs.openApp).not.toHaveBeenCalled();
});

it('supports incoming shares without bundling a native OCR adapter', async () => {
  delete NativeModules.TadaAppInputs.extractImageText;
  NativeModules.TadaAppInputs.listPending.mockResolvedValue([]);
  const {appInputs} = load();
  expect(appInputs.supported).toBe(true);
  expect(appInputs.hasImageTextRecognition).toBe(false);
  expect(await appInputs.listPending()).toEqual([]);
  await expect(appInputs.extractImageText('file:///private/shared/image.png'))
    .rejects.toThrow('不支持图片文字识别');
  expect(NativeModules.TadaAppInputs.dismiss).not.toHaveBeenCalled();
  expect(NativeModules.TadaAppInputs.openApp).not.toHaveBeenCalled();
});

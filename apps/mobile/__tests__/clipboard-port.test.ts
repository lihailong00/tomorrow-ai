import { NativeModules } from 'react-native';
import { platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn(), setItem: jest.fn() }));
jest.mock('react-native', () => ({
  NativeModules: { TomorrowPlatform: { copyText: jest.fn() } },
  Platform: { OS: 'android' },
}));

const native = NativeModules.TomorrowPlatform;
beforeEach(() => { native.copyText = jest.fn(); delete native.prepareChatImage; });

test('copies the exact user-selected text without reading the clipboard', async () => {
  native.copyText.mockResolvedValue(undefined);
  await platform.copyText('  一段文字\n第二行 | 表格  ');
  expect(native.copyText).toHaveBeenCalledWith('  一段文字\n第二行 | 表格  ');
});

test('native copy rejection reaches the menu and cannot become a success toast', async () => {
  native.copyText.mockRejectedValue(new Error('复制失败'));
  await expect(platform.copyText('selected')).rejects.toThrow('复制失败');
});

test('an unsupported platform offers native selection instead of silently claiming a copy', async () => {
  delete native.copyText;
  await expect(platform.copyText('selected')).rejects.toThrow('选取文字');
});

test('native image normalization returns the upload copy without mutating the selected original', async () => {
  const original = { uri: 'file:///private/attachments/original', name: 'camera.jpg', mime_type: 'image/jpeg', size: 10000000 };
  const copy = { uri: 'file:///private/attachments/copy.jpg', name: 'camera.jpg', mime_type: 'image/jpeg', size: 800000 };
  native.prepareChatImage = jest.fn().mockResolvedValue(copy);
  await expect(platform.prepareChatImage(original)).resolves.toEqual(copy);
  expect(native.prepareChatImage).toHaveBeenCalledWith(original.uri, original.mime_type, original.name);
  expect(original.size).toBe(10000000);
  expect(original.uri).toBe('file:///private/attachments/original');
});

test('platforms without image normalization retain a small supported file and reject oversized inputs', async () => {
  const original = { uri: 'file:///image', name: 'image.png', mime_type: 'image/png', size: 2000 };
  await expect(platform.prepareChatImage(original)).resolves.toBe(original);
  await expect(platform.prepareChatImage({ ...original, size: 5000000 })).rejects.toThrow('4 MB');
});

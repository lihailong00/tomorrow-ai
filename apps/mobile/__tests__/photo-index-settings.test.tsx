import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { PhotoIndexSettings } from '../src/features/photo-index/PhotoIndexSettings';
import { photoIndex } from '../src/platform/photoIndex';
import { AppProvider, AppContextValue } from '../src/app/context';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/photoIndex', () => ({
  photoIndexAvailable: true,
  photoIndexPath: (device: string) => `/photo-index/devices/${device}`,
  photoIndex: {
    status: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
    clear: jest.fn(),
    scanNow: jest.fn(),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (photoIndex.status as jest.Mock).mockResolvedValue({
    deviceId: 'device',
    enabled: false,
    state: 'idle',
    lastSyncAt: 0,
  });
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function setup(
  remote: Record<string, unknown> = { enabled: false, indexed: 0 },
) {
  const request = jest.fn().mockResolvedValue(remote);
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider
        value={
          {
            api: { baseUrl: 'https://example.test', request },
            user: { id: 'user' },
          } as unknown as AppContextValue
        }
      >
        <PhotoIndexSettings />
      </AppProvider>,
    );
  });
  return {
    request,
    input: async (value: string) => {
      await act(async () =>
        tree.root.findByType(TextInput).props.onChangeText(value),
      );
    },
    button: (label: string) =>
      tree.root.findAllByType(Button).find(n => n.props.children === label)!,
    text: () =>
      tree.root
        .findAllByType(Text)
        .map(n => n.props.children)
        .join('\n'),
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}
test('opening settings and polling leaves photo access and scanning disabled', async () => {
  const app = await setup();
  await act(async () => {
    jest.advanceTimersByTime(20000);
  });
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(photoIndex.scanNow).not.toHaveBeenCalled();
  expect(app.request.mock.calls.every(call => call.length === 1)).toBe(true);
  expect(app.text()).toContain('未开启');
  await app.unmount();
});

test('natural-language search shows evidence and a clear fallback without creating memories', async () => {
  (photoIndex.status as jest.Mock).mockResolvedValue({
    deviceId: 'device',
    enabled: true,
    state: 'idle',
    lastSyncAt: 0,
  });
  const app = await setup({
    enabled: true,
    indexed: 1,
    facts_ready: 1,
    semantic_ready: 1,
    semantic_configured: true,
  });
  await app.input('去云南的机票');
  const result = {
    items: [
      {
        asset_id: 'one',
        results: [{ kind: 'description', content: '机票截图' }],
        facts: [
          {
            kind: 'location',
            value: '昆明',
            evidence: '目的地：昆明',
            needs_confirmation: true,
          },
        ],
      },
    ],
    notice: '语义服务暂不可用，已使用文字匹配',
  };
  app.request.mockResolvedValueOnce(result);
  await act(async () => app.button('查看图片索引').props.onPress());
  expect(app.request).toHaveBeenCalledWith(
    expect.stringContaining('mode=hybrid'),
  );
  expect(app.text()).toContain('目的地：昆明');
  expect(app.text()).toContain('图片中的线索');
  expect(app.text()).toContain('语义服务暂不可用');
  await act(async () => app.button('文字匹配').props.onPress());
  app.request.mockResolvedValueOnce(result);
  await act(async () => app.button('查看图片索引').props.onPress());
  expect(app.request).toHaveBeenCalledWith(
    expect.stringContaining('mode=keyword'),
  );
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(app.request.mock.calls.every(args => args.length === 1)).toBe(true);
  await app.unmount();
});
test('enable only proceeds after the user confirms the settings disclosure', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  await act(async () => app.button('开启相册索引').props.onPress());
  expect(photoIndex.enable).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0][2]!;
  expect(buttons[0].style).toBe('cancel');
  await act(async () => {
    await buttons[1].onPress?.();
  });
  expect(photoIndex.enable).toHaveBeenCalledTimes(1);
  expect(photoIndex.enable).toHaveBeenCalledWith(
    expect.objectContaining({ baseUrl: 'https://example.test' }),
    'user',
  );
  await app.unmount();
});

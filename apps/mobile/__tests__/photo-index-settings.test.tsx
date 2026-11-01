import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { PhotoIndexSettings } from '../src/features/photo-index/PhotoIndexSettings';
import { photoIndex } from '../src/platform/photoIndex';
import { AppProvider, AppContextValue } from '../src/app/context';
import { Button } from '../src/ui/components';
import { inspectInstance } from '../src/api/instance';
import { ApiError } from '../src/api/client';

jest.mock('../src/api/instance', () => ({ inspectInstance: jest.fn() }));

jest.mock('../src/platform/photoIndex', () => ({
  photoIndexAvailable: true,
  photoIndexPath: (device: string) => `/photo-index/devices/${device}`,
  photoIndex: {
    status: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
    clear: jest.fn(),
    scanNow: jest.fn(),
    manageAccess: jest.fn(),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  (photoIndex.enable as jest.Mock).mockReset().mockResolvedValue(undefined);
  (inspectInstance as jest.Mock).mockReset().mockResolvedValue({ serverUrl: 'https://example.test',
    instance: { id: 'instance', configuration_revision: 1, dataflow: { images: '阿里云百炼', embeddings: '未启用' } } });
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

const policy = (images = 'https://images.example.test/v1', embeddings: string | null = null, scope = 'scope-one') => ({
  consent_scope: scope,
  processing_destinations: {
    images: { processor: 'configured_provider', destination: images },
    embeddings: embeddings ? { processor: 'configured_provider', destination: embeddings }
      : { processor: 'not_configured', destination: null },
  },
});

async function setup(
  remote: Record<string, unknown> = { enabled: false, indexed: 0, vision_configured: true },
) {
  const request = jest.fn().mockResolvedValue({ ...policy(), ...remote });
  let context = {
    api: { baseUrl: 'https://example.test', request },
    user: { id: 'user' },
    preferences: { instance: { id: 'instance', dataflow: { images: '过期的处理去向' } } },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider
        value={context}
      >
        <PhotoIndexSettings />
      </AppProvider>,
    );
  });
  return {
    request,
    update: async (value: Partial<AppContextValue>) => {
      context = { ...context, ...value };
      await act(async () => tree.update(<AppProvider value={context}><PhotoIndexSettings /></AppProvider>));
    },
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
  expect(alert.mock.calls[0][1]).toContain('上传分析副本');
  expect(alert.mock.calls[0][1]).toContain('https://images.example.test/v1');
  expect(alert.mock.calls[0][1]).not.toContain('过期的处理去向');
  expect(buttons[0].style).toBe('cancel');
  await act(async () => {
    await buttons[1].onPress?.();
  });
  expect(photoIndex.enable).toHaveBeenCalledTimes(1);
  expect(photoIndex.enable).toHaveBeenCalledWith(
    expect.objectContaining({ baseUrl: 'https://example.test' }),
    'user',
    { consentScope: 'scope-one' },
  );
  await app.unmount();
});

const asset = (id: string) => ({ asset_id: id, results: [{ kind: 'description', content: `照片-${id}` }] });
const searchable = { enabled: true, indexed: 21, vision_configured: true, epoch: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('loads the next page using the same encoded query and mode, deduplicates, and stops at the end', async () => {
  const app = await setup(searchable);
  await app.input('机票 & 云南');
  await act(async () => app.button('文字匹配').props.onPress());
  app.request.mockResolvedValueOnce({ items: Array.from({ length: 20 }, (_, i) => asset(String(i + 1))), next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  expect(app.request).toHaveBeenLastCalledWith('/photo-index/devices/device/assets?q=%E6%9C%BA%E7%A5%A8%20%26%20%E4%BA%91%E5%8D%97&mode=keyword&offset=0');
  app.request.mockResolvedValueOnce({ items: [asset('20'), asset('21')], next_offset: null });
  await act(async () => app.button('加载更多图片索引').props.onPress());
  expect(app.request).toHaveBeenLastCalledWith(expect.stringContaining('mode=keyword&offset=20'));
  expect(app.text()).toContain('照片-21');
  expect(app.text().match(/照片-20\n/g)).toHaveLength(1);
  expect(app.button('加载更多图片索引')).toBeUndefined();
  await app.unmount();
});

test('rejects a repeated or out-of-range continuation instead of looping', async () => {
  const app = await setup(searchable);
  for (const next_offset of [0, -20, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    app.request.mockResolvedValueOnce({ items: [asset('one')], next_offset });
    await act(async () => app.button('查看图片索引').props.onPress());
    expect(app.button('加载更多图片索引')).toBeUndefined();
  }
  await app.unmount();
});

test('continues browsing beyond 50000 indexed photos without a total-count ceiling', async () => {
  const app = await setup(searchable);
  app.request.mockResolvedValueOnce({ items: [asset('50000')], next_offset: 50001 });
  await act(async () => app.button('查看图片索引').props.onPress());
  app.request.mockResolvedValueOnce({ items: [asset('50002')], next_offset: null });
  await act(async () => app.button('加载更多图片索引').props.onPress());
  expect(app.request).toHaveBeenLastCalledWith(expect.stringContaining('offset=50001'));
  expect(app.text()).toContain('照片-50002');
  await app.unmount();
});

test('a changed query discards a slow previous page and resets its continuation', async () => {
  const app = await setup(searchable);
  await app.input('old');
  app.request.mockResolvedValueOnce({ items: [asset('old-first')], next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  const pending = deferred<unknown>();
  app.request.mockReturnValueOnce(pending.promise);
  let load!: Promise<void>;
  await act(async () => { load = app.button('加载更多图片索引').props.onPress(); });
  await app.input('new');
  expect(app.text()).not.toContain('照片-old-first');
  expect(app.button('加载更多图片索引')).toBeUndefined();
  app.request.mockResolvedValueOnce({ items: [asset('new')], next_offset: null });
  await act(async () => app.button('查看图片索引').props.onPress());
  await act(async () => { pending.resolve({ items: [asset('old-late')], next_offset: 40 }); await load; });
  expect(app.text()).toContain('照片-new');
  expect(app.text()).not.toContain('照片-old-late');
  expect(app.button('加载更多图片索引')).toBeUndefined();
  await app.unmount();
});

test('a failed next page retains earlier results and can be retried without duplicate requests', async () => {
  const app = await setup(searchable);
  app.request.mockResolvedValueOnce({ items: [asset('first')], next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  const pending = deferred<unknown>();
  app.request.mockReturnValueOnce(pending.promise);
  let load!: Promise<void>;
  const before = app.request.mock.calls.length;
  await act(async () => {
    load = app.button('加载更多图片索引').props.onPress();
    app.button('加载更多图片索引').props.onPress();
  });
  expect(app.request).toHaveBeenCalledTimes(before + 1);
  await act(async () => { pending.reject(new Error('offline')); await load; });
  expect(app.text()).toContain('照片-first');
  expect(app.text()).toContain('offline');
  app.request.mockResolvedValueOnce({ items: [asset('last')], next_offset: null });
  await act(async () => app.button('加载更多图片索引').props.onPress());
  expect(app.text()).toContain('照片-last');
  await app.unmount();
});

test('mode, device, and consent epoch changes reset search pages', async () => {
  const app = await setup(searchable);
  app.request.mockResolvedValueOnce({ items: [asset('mode-old')], next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  await act(async () => app.button('文字匹配').props.onPress());
  expect(app.text()).not.toContain('照片-mode-old');
  app.request.mockResolvedValueOnce({ items: [asset('epoch-old')], next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  app.request.mockResolvedValueOnce({ ...searchable, epoch: 2 });
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(app.text()).not.toContain('照片-epoch-old');
  app.request.mockResolvedValueOnce({ items: [asset('device-old')], next_offset: 20 });
  await act(async () => app.button('查看图片索引').props.onPress());
  (photoIndex.status as jest.Mock).mockResolvedValue({ deviceId: 'other-device', enabled: true, state: 'idle', lastSyncAt: 0 });
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(app.text()).not.toContain('照片-device-old');
  expect(app.button('加载更多图片索引')).toBeUndefined();
  await app.unmount();
});

test('an account change or unmount cannot reveal a late search response', async () => {
  const app = await setup(searchable);
  const pending = deferred<unknown>();
  app.request.mockReturnValueOnce(pending.promise);
  let search!: Promise<void>;
  await act(async () => { search = app.button('查看图片索引').props.onPress(); });
  await app.update({ user: { id: 'other-user' } as AppContextValue['user'] });
  await act(async () => { pending.resolve({ items: [asset('private-old')], next_offset: 20 }); await search; });
  expect(app.text()).not.toContain('照片-private-old');
  const late = deferred<unknown>();
  app.request.mockReturnValueOnce(late.promise);
  await act(async () => { search = app.button('查看图片索引').props.onPress(); });
  await app.unmount();
  await act(async () => { late.resolve({ items: [asset('unmounted')], next_offset: 20 }); await search; });
});

test('photo permissions remain manageable after a denied first enable', async () => {
  const app = await setup();
  await act(async () => app.button('管理相册权限').props.onPress());
  expect(photoIndex.manageAccess).toHaveBeenCalledTimes(1);
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await app.unmount();
});

test('a changed processing destination or provider scope requires renewed consent before access', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  await act(async () => app.button('开启相册索引').props.onPress());
  (inspectInstance as jest.Mock).mockResolvedValue({ instance: {
    id: 'instance', configuration_revision: 2, dataflow: { images: 'new-provider.test', embeddings: '未启用' },
  } });
  app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://new-provider.test/v2', null, 'scope-two') });
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(alert.mock.calls[1][1]).toContain('new-provider.test');
  // A model/policy change can invalidate consent even when its destination stays the same.
  (inspectInstance as jest.Mock).mockResolvedValue({ instance: {
    id: 'instance', configuration_revision: 3, dataflow: { images: 'new-provider.test', embeddings: '未启用' },
  } });
  app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://new-provider.test/v2', null, 'scope-three') });
  await act(async () => alert.mock.calls[1][2]![1].onPress?.());
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await act(async () => alert.mock.calls[2][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledTimes(1);
  expect(inspectInstance).toHaveBeenCalledWith('https://example.test', expect.objectContaining({ expectedId: 'instance' }));
  await app.unmount();
});

test('failed fresh verification or a disabled destination blocks consent and photo access', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  (inspectInstance as jest.Mock).mockRejectedValueOnce(new Error('无法验证服务器'));
  await act(async () => app.button('开启相册索引').props.onPress());
  expect(alert).not.toHaveBeenCalled();
  expect(app.text()).toContain('无法验证服务器');
  (inspectInstance as jest.Mock).mockResolvedValue({ instance: { id: 'instance', dataflow: { images: '未启用' } } });
  app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: false,
    ...policy(), processing_destinations: {
      images: { processor: 'not_configured', destination: null },
      embeddings: { processor: 'not_configured', destination: null },
    } });
  await act(async () => app.button('开启相册索引').props.onPress());
  expect(alert).not.toHaveBeenCalled();
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await app.unmount();
});

test('the photo card polls the current destination instead of trusting the saved manifest', async () => {
  const app = await setup();
  expect(app.text()).toContain('https://images.example.test/v1');
  expect(app.text()).not.toContain('过期的处理去向');
  (inspectInstance as jest.Mock).mockResolvedValue({ instance: {
    id: 'instance', configuration_revision: 2, dataflow: { images: 'changed-provider.test' },
  } });
  app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://changed-provider.test/v2', null, 'scope-two') });
  await act(async () => { jest.advanceTimersByTime(10000); });
  expect(app.text()).toContain('changed-provider.test');
  expect(app.text()).not.toContain('images.example.test');
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await app.unmount();
});

test('clearing the index immediately invalidates an outstanding search page', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup(searchable);
  const pending = deferred<unknown>();
  app.request.mockReturnValueOnce(pending.promise);
  let search!: Promise<void>;
  await act(async () => { search = app.button('查看图片索引').props.onPress(); });
  await act(async () => app.button('清除已有索引').props.onPress());
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  await act(async () => { pending.resolve({ items: [asset('cleared-old')], next_offset: 20 }); await search; });
  expect(app.text()).not.toContain('照片-cleared-old');
  expect(app.button('加载更多图片索引')).toBeUndefined();
  await app.unmount();
});

test('consent discloses atomic image and separate embedding endpoints together with their exact policy', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://image-a.test/api/vision', 'https://vectors-a.test/v1/embeddings', 'composite-a') });
  await act(async () => app.button('开启相册索引').props.onPress());
  expect(alert.mock.calls[0][1]).toContain('图片分析去向：https://image-a.test/api/vision');
  expect(alert.mock.calls[0][1]).toContain('文字向量去向：https://vectors-a.test/v1/embeddings');
  expect(alert.mock.calls[0][1]).not.toContain('阿里云百炼');
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledWith(expect.anything(), 'user', { consentScope: 'composite-a' });
  await app.unmount();
});

test('an embedding-only destination change renews the visible confirmation before enabling', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://image-a.test/v1', 'https://vectors-a.test/v1', 'composite-a') });
  await act(async () => app.button('开启相册索引').props.onPress());
  // The manifest identity/revision stays the same: the atomic status is authoritative.
  app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: true,
    ...policy('https://image-a.test/v1', 'https://vectors-b.test/v2', 'composite-b') });
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(alert.mock.calls).toHaveLength(2);
  expect(alert.mock.calls[1][1]).toContain('https://vectors-b.test/v2');
  await act(async () => alert.mock.calls[1][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledWith(expect.anything(), 'user', { consentScope: 'composite-b' });
  await app.unmount();
});

test('server-paused processing offers explicit renewal while local selection remains enabled and polling never grants consent', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  (photoIndex.status as jest.Mock).mockResolvedValue({ deviceId: 'device', enabled: true, state: 'idle', lastSyncAt: 0 });
  const app = await setup({ ...searchable, cloud_processing: false, consent_required: true,
    configuration_paused: true, consent_reason: 'provider_changed',
    ...policy('https://image-b.test/v2', 'https://vectors-b.test/v2', 'paused-policy') });
  expect(app.text()).toContain('云端处理已暂停');
  expect(app.button('重新确认云端分析')).toBeDefined();
  expect(app.button('检查新增照片').props.disabled).toBe(true);
  expect(app.button('按含义查找').props.disabled).toBe(true);
  await act(async () => { jest.advanceTimersByTime(20000); });
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(photoIndex.disable).not.toHaveBeenCalled();
  expect(photoIndex.scanNow).not.toHaveBeenCalled();
  app.request.mockResolvedValueOnce({ items: [asset('retained-local')], next_offset: null });
  await act(async () => app.button('查看图片索引').props.onPress());
  expect(app.request).toHaveBeenLastCalledWith(expect.stringContaining('mode=keyword'));
  await act(async () => app.button('重新确认云端分析').props.onPress());
  expect(photoIndex.enable).not.toHaveBeenCalled();
  expect(alert.mock.calls[0][0]).toBe('重新确认云端分析');
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledWith(expect.anything(), 'user', { consentScope: 'paused-policy' });
  expect(photoIndex.clear).not.toHaveBeenCalled();
  await app.unmount();
});

test('a native worker that already paused still exposes remote provider renewal', async () => {
  const app = await setup({ ...searchable, cloud_processing: false, consent_required: true,
    configuration_paused: true, consent_reason: 'provider_changed' });
  expect(app.button('重新确认云端分析')).toBeDefined();
  expect(app.button('开启相册索引')).toBeUndefined();
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await app.unmount();
});

test('an old backend keeps indexed text accessible but cannot grant unspecified external processing', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup({ ...searchable, consent_scope: undefined, processing_destinations: undefined });
  await act(async () => app.button('开启相册索引').props.onPress());
  expect(app.text()).toContain('请更新服务器后再开启云端分析');
  expect(alert).not.toHaveBeenCalled();
  expect(photoIndex.enable).not.toHaveBeenCalled();
  app.request.mockResolvedValueOnce({ items: [asset('legacy-index')], next_offset: null });
  await act(async () => app.button('文字匹配').props.onPress());
  await act(async () => app.button('查看图片索引').props.onPress());
  expect(app.text()).toContain('照片-legacy-index');
  await app.unmount();
});

test('a backend scope race reopens disclosure and never retries cloud enable without another confirmation', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  await act(async () => app.button('开启相册索引').props.onPress());
  (photoIndex.enable as jest.Mock).mockImplementationOnce(async () => {
    app.request.mockResolvedValue({ enabled: false, indexed: 0, vision_configured: true,
      ...policy('https://image-race.test/v2', 'https://vectors-race.test/v2', 'raced-policy') });
    throw new ApiError('photo_cloud_consent_changed', 'provider changed', 409);
  });
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls).toHaveLength(2);
  expect(alert.mock.calls[1][1]).toContain('https://vectors-race.test/v2');
  await act(async () => alert.mock.calls[1][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledTimes(2);
  expect(photoIndex.enable).toHaveBeenLastCalledWith(expect.anything(), 'user', { consentScope: 'raced-policy' });
  await app.unmount();
});

test('a key-only configuration revision change with the same destinations and policy needs no additional disclosure', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  await act(async () => app.button('开启相册索引').props.onPress());
  (inspectInstance as jest.Mock).mockResolvedValue({ instance: {
    id: 'instance', configuration_revision: 2, dataflow: { images: 'same-host', embeddings: 'same-host' },
  } });
  await act(async () => alert.mock.calls[0][2]![1].onPress?.());
  expect(photoIndex.enable).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls).toHaveLength(1);
  await app.unmount();
});

test('an account change discards pending consent reads and cannot enable the former account', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const app = await setup();
  const pending = deferred<unknown>();
  (inspectInstance as jest.Mock).mockReturnValueOnce(pending.promise);
  let opening!: Promise<void>;
  await act(async () => { opening = app.button('开启相册索引').props.onPress(); });
  await app.update({ user: { id: 'other-account' } as AppContextValue['user'] });
  await act(async () => {
    pending.resolve({ instance: { id: 'instance', dataflow: { images: 'old-host' } } });
    await opening;
  });
  expect(alert).not.toHaveBeenCalled();
  expect(photoIndex.enable).not.toHaveBeenCalled();
  await app.unmount();
});

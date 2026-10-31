import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppContextValue, AppProvider } from '../src/app/context';
import { PhoneWeatherCard } from '../src/features/phone-sources/PhoneWeatherCard';
import { platform } from '../src/platform/ports';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/platform/ports', () => ({
  platform: { onForeground: jest.fn(() => jest.fn()) },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
});
async function setup() {
  const request = jest
    .fn()
    .mockResolvedValue({
      items: [
        {
          id: 'weather-310000',
          title: '上海市',
          text: '小雨 · 18℃ · 更新时间：2026-10-31 14:00',
        },
      ],
    });
  let context = {
    api: { baseUrl: 'https://selfhost.example', request },
    user: { id: 'user-one' },
    preferences: { instance: { id: 'instance-one' } },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <PhoneWeatherCard />
      </AppProvider>,
    );
  });
  return {
    tree,
    request,
    async city() {
      await act(async () => {
        tree.root
          .findAll(
            node =>
              node.props.accessibilityLabel === '天气城市上海' &&
              typeof node.props.onPress === 'function',
          )[0]
          .props.onPress();
      });
    },
    async update() {
      context = { ...context, user: { id: 'user-two' } as any };
      await act(async () =>
        tree.update(
          <AppProvider value={context}>
            <PhoneWeatherCard />
          </AppProvider>,
        ),
      );
    },
    async unmount() {
      await act(async () => tree.unmount());
    },
  };
}
it('waits for city selection and queries the current server without location permission or client credentials', async () => {
  const view = await setup();
  expect(view.request).not.toHaveBeenCalled();
  await view.city();
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/amap/read',
    'POST',
    { operation: 'weather', city: '310000' },
    expect.anything(),
  );
  expect(JSON.stringify(view.tree.toJSON())).toContain('18℃');
  const callback = (platform.onForeground as jest.Mock).mock.calls.at(-1)![0];
  await act(async () => callback());
  expect(view.request).toHaveBeenCalledTimes(1);
  await view.unmount();
});
it('shows the actual configuration failure instead of fake or zero weather', async () => {
  const view = await setup();
  view.request.mockRejectedValue(new Error('高德地图尚未配置'));
  await view.city();
  const text = JSON.stringify(view.tree.toJSON());
  expect(text).toContain('高德地图尚未配置');
  expect(text).not.toContain('18℃');
  await view.unmount();
});
it('aborts late weather from a previous account and requires a new city choice', async () => {
  let resolve!: (value: unknown) => void;
  const view = await setup();
  view.request.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  await view.city();
  await view.update();
  await act(async () =>
    resolve({ items: [{ id: 'old', title: '旧账号城市', text: '不应显示' }] }),
  );
  expect(JSON.stringify(view.tree.toJSON())).not.toContain('旧账号城市');
  expect(view.request).toHaveBeenCalledTimes(1);
  await view.unmount();
});

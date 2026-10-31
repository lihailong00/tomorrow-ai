import React from 'react';
import { Modal } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, AppContextValue } from '../src/app/context';
import { PhoneSourcesEntry } from '../src/features/phone-sources/PhoneSourcesEntry';
import {
  phoneImportText,
  recordDate,
} from '../src/features/phone-sources/model';
import { phoneSources, PhoneSource } from '../src/platform/phoneSources';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('../src/platform/phoneSources', () => ({
  phoneSourceIds: ['contacts', 'calendar', 'sms', 'photos'],
  canReadPhoneSource: (value: string) => ['granted', 'limited'].includes(value),
  phoneSources: {
    supported: true,
    status: jest.fn(),
    request: jest.fn(),
    read: jest.fn(),
    fingerprint: jest.fn(),
  },
}));
jest.mock('../src/platform/ports', () => ({
  platform: { onForeground: jest.fn(() => jest.fn()) },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.mock('../src/features/photo-index/PhotoIndexSettings', () => ({
  PhotoIndexSettings: () => null,
}));
jest.mock('../src/features/phone-sources/PhoneWeatherCard', () => ({
  PhoneWeatherCard: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
const digest = 'a'.repeat(64);
const status = {
  permissions: {
    contacts: 'granted',
    calendar: 'granted',
    sms: 'granted',
    photos: 'limited',
  },
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
};
const record = {
  id: 'record-one',
  title: '预约检查',
  text: '明天下午三点，请提前十分钟到达。',
  timestamp: 1793491200000,
};
beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (phoneSources.status as jest.Mock).mockResolvedValue(status);
  (phoneSources.request as jest.Mock).mockImplementation(
    async (source: PhoneSource) => status.permissions[source],
  );
  (phoneSources.read as jest.Mock).mockImplementation(
    async (source: PhoneSource) => ({
      source,
      readAt: Date.now(),
      permission: status.permissions[source],
      limited: false,
      items: [record],
    }),
  );
  (phoneSources.fingerprint as jest.Mock).mockResolvedValue(digest);
});
async function setup(initial?: { seen: boolean; enabled: string[] }) {
  const request = jest.fn(async (path: string) =>
    path === '/todos/extract'
      ? { items: [], created_count: 1 }
      : { id: 'saved-import' },
  );
  let context = {
    api: { baseUrl: 'https://selfhost.example', request },
    user: { id: 'owner-one' },
    preferences: { instance: { id: 'instance-one' } },
    invalidate: jest.fn(),
    navigate: jest.fn(),
  } as unknown as AppContextValue;
  if (initial)
    await AsyncStorage.setItem(
      'tada.phone.sources.v1:' +
        JSON.stringify([
          'https://selfhost.example',
          'owner-one',
          'instance-one',
        ]),
      JSON.stringify(initial),
    );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <PhoneSourcesEntry autoOpen />
      </AppProvider>,
    );
  });
  const press = async (label: string) => {
    await act(async () => {
      const button = tree.root
        .findAllByType(Button)
        .find(
          node =>
            React.Children.toArray(node.props.children).join('') === label,
        );
      if (!button) throw new Error('Missing ' + label);
      button.props.onPress();
    });
  };
  const select = async (label: string) => {
    await act(async () => {
      tree.root
        .findAll(
          node =>
            node.props.accessibilityLabel === label &&
            typeof node.props.onPress === 'function',
        )[0]
        .props.onPress();
    });
  };
  return {
    tree,
    request,
    press,
    select,
    context,
    async update(value: Partial<AppContextValue>) {
      context = { ...context, ...value };
      await act(async () =>
        tree.update(
          <AppProvider value={context}>
            <PhoneSourcesEntry autoOpen />
          </AppProvider>,
        ),
      );
    },
    async unmount() {
      await act(async () => tree.unmount());
    },
  };
}
it('opens the first-use guide without requesting permissions, reading records, or uploading anything', async () => {
  const view = await setup();
  expect(view.tree.toJSON()).toBeTruthy();
  expect(view.tree.root.findByType(Modal).props.visible).toBe(true);
  expect(phoneSources.request).not.toHaveBeenCalled();
  expect(phoneSources.read).not.toHaveBeenCalled();
  expect(view.request).not.toHaveBeenCalled();
  await view.press('稍后');
  const saved = Object.values(
    (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__,
  ).find(value => typeof value === 'string' && value.includes('"seen":true'));
  expect(saved).toBeTruthy();
  await view.unmount();
});
it('does not reopen the guide after skipping and allows reopening it from the home entry', async () => {
  const first = await setup();
  await first.press('稍后');
  await first.unmount();
  const second = await setup();
  expect(second.tree.root.findByType(Modal).props.visible).toBe(false);
  await second.select('连接与管理本机资料');
  expect(second.tree.root.findByType(Modal).props.visible).toBe(true);
  expect(phoneSources.request).not.toHaveBeenCalled();
  await second.unmount();
});
it('stops reading a deselected source and stops using contact names for SMS matching', async () => {
  const view = await setup({ seen: true, enabled: ['contacts', 'sms'] });
  await view.select('连接与管理本机资料');
  await view.select('连接联系人');
  (phoneSources.read as jest.Mock).mockClear();
  const refresh = (platform.onForeground as jest.Mock).mock.calls.at(-1)![0];
  await act(async () => refresh());
  expect(phoneSources.read).toHaveBeenCalledTimes(1);
  expect(phoneSources.read).toHaveBeenCalledWith('sms', false);
  await view.unmount();
});
it('reads selected sources sequentially, preserves partial-photo access, and stays local', async () => {
  const view = await setup();
  await view.press('授权并在本机整理');
  expect(
    (phoneSources.request as jest.Mock).mock.calls.map(call => call[0]),
  ).toEqual(['contacts', 'calendar', 'sms', 'photos']);
  expect(phoneSources.read).toHaveBeenCalledWith('sms', true);
  expect(view.request).not.toHaveBeenCalled();
  expect(JSON.stringify(view.tree.toJSON())).toContain(
    '仅访问系统允许的部分照片',
  );
  for (const value of Object.values(
    (AsyncStorage as any).__INTERNAL_MOCK_STORAGE__,
  ))
    expect(String(value)).not.toContain(record.text);
  await view.unmount();
});
it('continues to other sources after SMS is denied and never turns that failure into an empty success', async () => {
  (phoneSources.request as jest.Mock).mockImplementation(async source =>
    source === 'sms' ? 'blocked' : status.permissions[source as PhoneSource],
  );
  const view = await setup();
  await view.press('授权并在本机整理');
  expect(phoneSources.read).not.toHaveBeenCalledWith('sms', expect.anything());
  expect(phoneSources.read).toHaveBeenCalledWith('photos', false);
  expect(JSON.stringify(view.tree.toJSON())).toContain('未获得短信权限');
  await view.unmount();
});
it('refreshes only previously selected sources on foreground, without prompting again', async () => {
  const view = await setup({ seen: true, enabled: ['calendar'] });
  expect(phoneSources.request).not.toHaveBeenCalled();
  expect(phoneSources.read).toHaveBeenCalledTimes(1);
  expect(phoneSources.read).toHaveBeenCalledWith('calendar', false);
  const refresh = (platform.onForeground as jest.Mock).mock.calls.at(-1)![0];
  await act(async () => refresh());
  expect(phoneSources.read).toHaveBeenCalledTimes(2);
  await view.unmount();
});
it('uploads only explicit SMS/calendar selections and reuses import and extraction receipts after a failure', async () => {
  const view = await setup();
  await view.press('授权并在本机整理');
  // Same record title occurs for all sources; select only the calendar checkbox.
  const boxes = view.tree.root.findAll(
    node =>
      node.props.accessibilityLabel === record.title &&
      node.props.accessibilityRole === 'checkbox' &&
      typeof node.props.onPress === 'function',
  );
  await act(async () => boxes[0].props.onPress());
  view.request.mockImplementation(async (path: string) => {
    if (path === '/todos/extract') throw new Error('网络中断');
    return { id: 'saved-import' };
  });
  await view.press('将 1 条资料交给 AI 整理');
  const first = view.request.mock.calls.filter(
    call => call[0] === '/todos/extract',
  )[0] as unknown[];
  view.request.mockImplementation(async (path: string) =>
    path === '/todos/extract'
      ? { items: [], created_count: 1 }
      : { id: 'saved-import' },
  );
  await view.press('将 1 条资料交给 AI 整理');
  const calls = view.request.mock.calls as unknown as unknown[][];
  const inputs = calls.filter(call => call[0] === '/todos/extract');
  expect(inputs[1][2]).toEqual(first[2]);
  const imported = calls.find(
    call => call[0] === '/integrations/imports',
  )![2] as any;
  expect(imported.external_id).toBe('phone-sources-v1:' + digest);
  expect(imported.text).toContain('手机日历');
  expect(imported.text).not.toContain('手机联系人');
  expect(imported.text).not.toContain('手机照片');
  await view.unmount();
});
it('drops late results from the previous account before any next source or upload', async () => {
  let resolve!: (value: unknown) => void;
  (phoneSources.read as jest.Mock).mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const view = await setup();
  await view.press('授权并在本机整理');
  await view.update({ user: { id: 'owner-two' } as any });
  await act(async () =>
    resolve({
      source: 'contacts',
      items: [record],
      readAt: Date.now(),
      permission: 'granted',
    }),
  );
  expect(phoneSources.read).toHaveBeenCalledTimes(1);
  expect(view.request).not.toHaveBeenCalled();
  expect(JSON.stringify(view.tree.toJSON())).not.toContain(record.text);
  await view.unmount();
});
it('rejects uploads of contacts/photos and oversized selections instead of silently truncating them', () => {
  for (const source of ['contacts', 'photos'] as const)
    expect(() => phoneImportText([{ source, record }])).toThrow('不能');
  expect(() =>
    phoneImportText(
      Array.from({ length: 11 }, (_, index) => ({
        source: 'sms',
        record: { ...record, id: '' + index },
      })),
    ),
  ).toThrow('最多');
  expect(() =>
    phoneImportText([
      { source: 'sms', record: { ...record, text: 'x'.repeat(16000) } },
    ]),
  ).toThrow('不会截断');
  expect(() =>
    phoneImportText([
      { source: 'calendar', record: { ...record, truncated: true } },
    ]),
  ).toThrow('完整原文');
  expect(
    recordDate({ ...record, timestamp: Date.UTC(2026, 10, 1), allDay: true }),
  ).toBe('2026-11-01 全天');
});

import React from 'react';
import { Modal } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, AppContextValue } from '../src/app/context';
import { PhoneSourcesEntry } from '../src/features/phone-sources/PhoneSourcesEntry';
import {
  calendarRecordStatus,
  canUsePhoneRecordForTodo,
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
    page: jest.fn(),
    record: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
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
  (phoneSources.record as jest.Mock).mockImplementation(
    async (_source, _owner, id) => ({ ...record, id }),
  );
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
  expect(phoneSources.read).toHaveBeenCalledWith(
    'sms',
    false,
    expect.any(String),
    false,
  );
  await view.unmount();
});
it('reads selected sources sequentially, preserves partial-photo access, and stays local', async () => {
  const view = await setup();
  await view.press('授权并在本机整理');
  expect(
    (phoneSources.request as jest.Mock).mock.calls.map(call => call[0]),
  ).toEqual(['contacts', 'calendar', 'sms', 'photos']);
  expect(phoneSources.read).toHaveBeenCalledWith(
    'sms',
    true,
    expect.any(String),
    true,
  );
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
  expect(phoneSources.read).not.toHaveBeenCalledWith(
    'sms',
    expect.anything(),
    expect.any(String),
    expect.any(Boolean),
  );
  expect(phoneSources.read).toHaveBeenCalledWith(
    'photos',
    false,
    expect.any(String),
    true,
  );
  expect(JSON.stringify(view.tree.toJSON())).toContain('未获得短信权限');
  await view.unmount();
});
it('refreshes only previously selected sources on foreground, without prompting again', async () => {
  const view = await setup({ seen: true, enabled: ['calendar'] });
  expect(phoneSources.request).not.toHaveBeenCalled();
  expect(phoneSources.read).toHaveBeenCalledTimes(1);
  expect(phoneSources.read).toHaveBeenCalledWith(
    'calendar',
    false,
    expect.any(String),
    false,
  );
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

it('shows the full count, pages beyond 200 contacts, and retains only the current preview', async () => {
  (phoneSources.read as jest.Mock).mockImplementation(
    async (source: PhoneSource) => ({
      source,
      readAt: Date.now(),
      permission: status.permissions[source],
      limited: false,
      items: [{ ...record, id: 'contact-1', title: '第一页联系人' }],
      cached: 100000,
      processed: 100000,
      total: 100000,
      syncState: 'complete',
      cursor: '0',
      nextCursor: '250',
    }),
  );
  (phoneSources.page as jest.Mock).mockImplementation(
    async (source, _owner, cursor) => ({
      source,
      readAt: Date.now(),
      permission: 'granted',
      limited: false,
      items: [{ ...record, id: 'contact-251', title: '第二页联系人' }],
      cached: 100000,
      processed: 100000,
      total: 100000,
      syncState: 'complete',
      cursor,
      nextCursor: '500',
    }),
  );
  const view = await setup({ seen: true, enabled: ['contacts'] });
  await view.select('连接与管理本机资料');
  expect(JSON.stringify(view.tree.toJSON())).toContain(
    '已在本机整理 100000 条资料',
  );
  await view.press('浏览全部资料（已保存 100000 条）');
  await view.press('下一页');
  expect(phoneSources.page).toHaveBeenCalledWith(
    'contacts',
    expect.any(String),
    '250',
    false,
  );
  const rendered = JSON.stringify(view.tree.toJSON());
  expect(rendered).toContain('第二页联系人');
  expect(rendered).not.toContain('第一页联系人');
  expect(view.request).not.toHaveBeenCalled();
  await view.press('上一页');
  expect(phoneSources.page).toHaveBeenLastCalledWith(
    'contacts',
    expect.any(String),
    '0',
    false,
  );
  await view.select('连接联系人');
  expect(phoneSources.stop).toHaveBeenCalledWith(
    'contacts',
    expect.any(String),
  );
  await view.unmount();
});
it('keeps explicit selections across pages, rather than importing the entire local cache', async () => {
  (phoneSources.read as jest.Mock).mockImplementation(
    async (source: PhoneSource) => ({
      source,
      readAt: Date.now(),
      permission: 'granted',
      limited: false,
      items: [record],
      cached: 100000,
      total: 100000,
      processed: 100000,
      syncState: 'complete',
      cursor: '0',
      nextCursor: '50',
    }),
  );
  (phoneSources.page as jest.Mock).mockImplementation(
    async (source, _owner, cursor) => ({
      source,
      readAt: Date.now(),
      permission: 'granted',
      limited: false,
      items: [{ ...record, id: 'second', title: '下一页的记录' }],
      cached: 100000,
      total: 100000,
      processed: 100000,
      syncState: 'complete',
      cursor,
      nextCursor: null,
    }),
  );
  const view = await setup({ seen: true, enabled: ['calendar'] });
  await view.select('连接与管理本机资料');
  await view.select(record.title);
  await view.press('浏览全部资料（已保存 100000 条）');
  await view.press('下一页');
  await view.press('将 1 条资料交给 AI 整理');
  const imported = (view.request.mock.calls as unknown as unknown[][]).find(
    call => call[0] === '/integrations/imports',
  )![2] as any;
  expect(imported.text).toContain(record.id);
  expect(imported.text).not.toContain('下一页的记录');
  await view.unmount();
});
it('keeps sensitive SMS out of cloud discovery without excluding it from local acquisition', () => {
  expect(() =>
    phoneImportText([
      { source: 'sms', record: { ...record, eligibleForTodo: false } },
    ]),
  ).toThrow('仅保存在本机');
});

it('retains cancelled/deleted calendar history locally but excludes it from AI selections and the next-event summary', async () => {
  (phoneSources.read as jest.Mock).mockResolvedValue({
    source: 'calendar',
    readAt: Date.now(),
    permission: 'granted',
    limited: false,
    items: [
      {
        ...record,
        id: 'cancelled',
        title: '已取消的会议',
        calendarStatus: 'cancelled',
        eligibleForTodo: false,
        timestamp: Date.now() + 60000,
      },
      {
        ...record,
        id: 'deleted',
        title: '已删除的会议',
        calendarStatus: 'deleted',
        eligibleForTodo: false,
        timestamp: Date.now() + 120000,
      },
      {
        ...record,
        id: 'active',
        title: '仍需参加的会议',
        calendarStatus: 'confirmed',
        truncated: true,
        timestamp: Date.now() + 180000,
      },
    ],
  });
  const view = await setup({ seen: true, enabled: ['calendar'] });
  await view.select('连接与管理本机资料');
  const rendered = JSON.stringify(view.tree.toJSON());
  expect(rendered).toContain('已取消的会议');
  expect(rendered).toContain('已删除的会议');
  expect(rendered).toContain('已取消 · 仅保存在本机');
  expect(rendered).toContain('接下来：仍需参加的会议');
  for (const title of ['已取消的会议', '已删除的会议']) {
    expect(
      view.tree.root.findAll(
        node =>
          node.props.accessibilityLabel === title &&
          node.props.accessibilityRole === 'checkbox',
      ),
    ).toHaveLength(0);
  }
  expect(view.request).not.toHaveBeenCalled();
  await view.unmount();
});

it('rechecks a selected event before uploading if the local cache marks it cancelled after selection', async () => {
  const view = await setup({ seen: true, enabled: ['calendar'] });
  await view.select('连接与管理本机资料');
  await view.select(record.title);
  (phoneSources.record as jest.Mock).mockResolvedValue({
    ...record,
    calendarStatus: 'cancelled',
    eligibleForTodo: false,
  });
  await view.press('将 1 条资料交给 AI 整理');
  expect(phoneSources.record).toHaveBeenCalledWith(
    'calendar',
    expect.any(String),
    record.id,
  );
  expect(view.request).not.toHaveBeenCalled();
  expect(phoneSources.fingerprint).not.toHaveBeenCalled();
  expect(JSON.stringify(view.tree.toJSON())).toContain(
    '已取消、已删除或状态不明的日程',
  );
  await view.unmount();
});

it('rejects explicit inactive/raw calendar status while retaining compatibility with legacy missing-status events', () => {
  for (const value of [
    { calendarStatus: 'cancelled' as const },
    { calendarStatus: 'deleted' as const },
    { calendarStatus: 'unknown' as const },
    { raw: { eventStatus: 2, deleted: 0 } },
    { raw: { eventStatus: 1, deleted: 1 } },
    { raw: { eventStatus: 99 } },
  ]) {
    const inactive = { ...record, ...value };
    expect(canUsePhoneRecordForTodo('calendar', inactive)).toBe(false);
    expect(() =>
      phoneImportText([{ source: 'calendar', record: inactive }]),
    ).toThrow('日程仅保存在本机');
  }
  for (const value of [
    {},
    { raw: { eventStatus: null, deleted: 0 } },
    { calendarStatus: 'tentative' as const },
    { calendarStatus: 'confirmed' as const },
  ]) {
    const active = { ...record, ...value };
    expect(canUsePhoneRecordForTodo('calendar', active)).toBe(true);
    expect(() =>
      phoneImportText([{ source: 'calendar', record: active }]),
    ).not.toThrow();
  }
  expect(
    calendarRecordStatus({
      ...record,
      raw: { eventStatus: 1, deleted: 1 },
      calendarStatus: 'confirmed',
    }),
  ).toBe('deleted');
});

it('updates every active source in one poll without starving sibling sources', async () => {
  jest.useFakeTimers();
  let view: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    (phoneSources.read as jest.Mock).mockImplementation(
      async (source: PhoneSource) => ({
        source,
        readAt: Date.now(),
        permission: status.permissions[source],
        limited: false,
        items: [],
        cached: 0,
        total: 100000,
        processed: 0,
        syncState: 'queued',
        cursor: '0',
      }),
    );
    (phoneSources.page as jest.Mock).mockImplementation(
      async (source: PhoneSource) => ({
        source,
        readAt: Date.now(),
        permission: status.permissions[source],
        limited: false,
        items: [record],
        cached: 100000,
        total: 100000,
        processed: 100000,
        syncState: 'complete',
        cursor: '0',
        nextCursor: null,
      }),
    );
    view = await setup({
      seen: true,
      enabled: ['contacts', 'calendar', 'sms', 'photos'],
    });
    await act(async () => {
      jest.advanceTimersByTime(1200);
    });
    expect(
      (phoneSources.page as jest.Mock).mock.calls.map(call => call[0]),
    ).toEqual(['contacts', 'calendar', 'sms', 'photos']);
    expect(JSON.stringify(view.tree.toJSON())).toContain(
      '已在本机整理 400000 条资料',
    );
    expect(view.request).not.toHaveBeenCalled();
  } finally {
    if (view) await view.unmount();
    jest.useRealTimers();
  }
});

import { NativeModules } from 'react-native';
import { phoneSources } from '../src/platform/phoneSources';

jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Linking: { openSettings: jest.fn() },
  NativeModules: {
    TadaPhoneSources: {
      read: jest.fn(),
      page: jest.fn(),
      record: jest.fn(),
      stop: jest.fn(),
      suspend: jest.fn(),
    },
  },
}));

const native = NativeModules.TadaPhoneSources;
const owner = 'server-one:owner-one:instance-one';
const item = {
  id: 'contacts-9007199254740993',
  title: '完整联系人',
  text: '电话：13800138000',
};
const page = {
  source: 'contacts',
  readAt: 1793491200000,
  permission: 'granted',
  limited: false,
  total: 100000,
  processed: 100000,
  cached: 100000,
  syncState: 'complete',
  cursor: '0',
  nextCursor: '9007199254740993',
  items: [item],
};
beforeEach(() => jest.clearAllMocks());

it('keeps the full import count separate from a bounded preview page', async () => {
  native.read.mockResolvedValue(JSON.stringify(page));
  const result = await phoneSources.read('contacts', false, owner);
  expect(result.cached).toBe(100000);
  expect(result.items).toHaveLength(1);
  expect(native.read).toHaveBeenCalledWith('contacts', false, owner, false);
});

it('preserves 64-bit provider IDs as strings across paging without rounding', async () => {
  const cursor = '9007199254740993';
  native.page.mockResolvedValue(
    JSON.stringify({ ...page, cursor, nextCursor: '9007199254741043' }),
  );
  const result = await phoneSources.page('contacts', owner, cursor);
  expect(native.page).toHaveBeenCalledWith('contacts', owner, cursor, false);
  expect(result.items[0].id).toBe(item.id);
  expect(result.nextCursor).toBe('9007199254741043');
});

it('reads complete long records independently from abbreviated list previews', async () => {
  const complete = {
    ...item,
    text: '完整备注'.repeat(6000),
    raw: { display_name: '完整联系人' },
    data: [
      { mimetype: 'vnd.android.cursor.item/phone_v2', data1: '13800138000' },
    ],
  };
  native.record.mockResolvedValue(JSON.stringify(complete));
  const result = await phoneSources.record('contacts', owner, item.id);
  expect(result.text).toBe(complete.text);
  expect(result.data).toEqual(complete.data);
});

it('rejects malformed cursors and counts without silently returning partial success', async () => {
  await expect(phoneSources.page('contacts', owner, '-1')).rejects.toThrow(
    '游标',
  );
  expect(native.page).not.toHaveBeenCalled();
  native.read.mockResolvedValue(JSON.stringify({ ...page, total: 100000.5 }));
  await expect(phoneSources.read('contacts', false, owner)).rejects.toThrow(
    '格式异常',
  );
});

it('passes the exact owner on stop and suspends native reads at account exit', async () => {
  await phoneSources.stop('contacts', owner);
  await phoneSources.suspend();
  expect(native.stop).toHaveBeenCalledWith('contacts', owner);
  expect(native.suspend).toHaveBeenCalledTimes(1);
});

it('preserves calendar cancellation status on previews and complete locally cached records', async () => {
  const cancelled = {
    ...item,
    id: 'calendar-42',
    calendarStatus: 'cancelled',
    eligibleForTodo: false,
  };
  native.read.mockResolvedValue(
    JSON.stringify({ ...page, source: 'calendar', items: [cancelled] }),
  );
  expect(
    (await phoneSources.read('calendar', false, owner)).items[0],
  ).toMatchObject(cancelled);
  native.record.mockResolvedValue(
    JSON.stringify({ ...cancelled, raw: { eventStatus: 2, deleted: 0 } }),
  );
  expect(
    await phoneSources.record('calendar', owner, cancelled.id),
  ).toMatchObject(cancelled);
});

it('rejects malformed calendar eligibility/status fields instead of treating them as active', async () => {
  native.read.mockResolvedValue(
    JSON.stringify({
      ...page,
      source: 'calendar',
      items: [{ ...item, calendarStatus: 'unexpected' }],
    }),
  );
  await expect(phoneSources.read('calendar', false, owner)).rejects.toThrow(
    '格式异常',
  );
  native.record.mockResolvedValue(
    JSON.stringify({ ...item, eligibleForTodo: 'false' }),
  );
  await expect(phoneSources.record('calendar', owner, item.id)).rejects.toThrow(
    '格式异常',
  );
});

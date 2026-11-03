import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { alarmProposal, isAlarmRequest } from '../src/features/phone-alarms/alarmProposal';
import { PhoneAlarmCard, PhoneAlarmEditor } from '../src/features/phone-alarms/PhoneAlarmCard';
import { phoneAlarms, type PhoneAlarm } from '../src/platform/phoneAlarms';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/phoneAlarms', () => ({ phoneAlarms: {
  supported: true, list: jest.fn(), availability: jest.fn(), schedule: jest.fn(), cancel: jest.fn(),
  openExactSettings: jest.fn(), openNotificationSettings: jest.fn(), openSystemClock: jest.fn(), createSystemAlarm: jest.fn(),
} }));
jest.mock('../src/platform/ports', () => ({ platform: { requestNotifications: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
const mock = phoneAlarms as jest.Mocked<typeof phoneAlarms>;
const anchor = new Date(2026, 10, 3, 1, 0).toISOString();
const initial = { date: '2026-11-04', time: '12:00', title: '女朋友写简历', needsReview: false };
let rows: PhoneAlarm[];
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.clearAllMocks(); rows = [];
  mock.list.mockImplementation(async () => rows);
  mock.availability.mockResolvedValue({ exact: true, notifications: true, system_clock: true });
  mock.schedule.mockImplementation(async value => {
    const result = { ...value, at: 1793764800000, zone: 'Asia/Shanghai', state: 'scheduled' as const };
    rows = [result]; return result;
  });
  mock.cancel.mockImplementation(async id => { rows = rows.filter(row => row.id !== id); return true; });
  mock.openSystemClock.mockResolvedValue('opened');
});
test('tomorrow noon uses the message calendar day and keeps the reminder title', () => {
  expect(alarmProposal('给我定个手机闹铃，明天中午12点，然后提醒我女朋友写简历。', anchor)).toEqual(initial);
  expect(alarmProposal('明天下午三点半设闹钟', anchor)).toMatchObject({ date: '2026-11-04', time: '15:30' });
  expect(alarmProposal('今天00:30设闹钟', anchor)).toMatchObject({ date: '2026-11-03', time: '00:30' });
  expect(alarmProposal('00:30设闹钟', anchor)).toMatchObject({ date: '2026-11-04', time: '00:30' });
  expect(isAlarmRequest('明天中午12点提醒我写简历')).toBe(true);
  expect(isAlarmRequest('不要提醒我明天写简历')).toBe(false);
});
test.each(['明天晚上12点设闹钟', '明天上午12点设闹钟', '每周三12:00设闹钟', '明天12点和后天13点设闹钟', '2026-02-30 12:00设闹钟', '> 明天12点设闹钟', '下周三12点设闹钟', '明天下午三点一刻设闹钟', '明天12点提前10分钟设闹钟', '明天12点30秒设闹钟'])('does not guess ambiguous/repeating/invalid requests: %s', text => {
  expect(alarmProposal(text, anchor)).toMatchObject({ date: '', time: '', needsReview: true });
});
async function mount(element = <PhoneAlarmEditor initial={initial} initialId="alarm-message-one" />) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(element); });
  const button = (label: string) => tree.root.findAllByType(Button).find(node => node.props.children === label)!;
  const press = async (label: string) => { await act(async () => { button(label).props.onPress(); }); };
  const text = () => JSON.stringify(tree.toJSON());
  return { tree, button, press, text, close: async () => { await act(async () => tree.unmount()); } };
}
test('rendering a request does not schedule; explicit confirmation uses a stable ID and exact date', async () => {
  const app = await mount(<PhoneAlarmCard text="明天中午12点设闹钟，提醒我女朋友写简历。" createdAt={anchor} messageId="message-one" />);
  expect(mock.schedule).not.toHaveBeenCalled();
  expect(app.tree.root.findAllByType(TextInput)[0].props.value).toBe('2026-11-04');
  await app.press('确认设置本机闹铃');
  expect(mock.schedule).toHaveBeenCalledWith({ id: 'alarm-message-one', date: '2026-11-04', time: '12:00', title: '女朋友写简历' });
  expect(app.text()).toContain('已安排本机闹铃');
  await app.close();
});
test('permission refusal and native failure never show success', async () => {
  mock.availability.mockResolvedValue({ exact: false, notifications: true, system_clock: true });
  const blocked = await mount();
  expect(blocked.button('确认设置本机闹铃').props.disabled).toBe(true);
  expect(mock.schedule).not.toHaveBeenCalled(); await blocked.close();
  mock.availability.mockResolvedValue({ exact: true, notifications: true, system_clock: true });
  mock.schedule.mockRejectedValue(new Error('时间已过，请重新选择'));
  const app = await mount(); await app.press('确认设置本机闹铃');
  expect(app.text()).toContain('时间已过'); expect(app.text()).not.toContain('已安排本机闹铃'); await app.close();
});
test('repeated presses while scheduling execute once', async () => {
  let finish!: (value: PhoneAlarm) => void;
  mock.schedule.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const app = await mount();
  await act(async () => { app.button('确认设置本机闹铃').props.onPress(); app.button('确认设置本机闹铃').props.onPress(); });
  expect(mock.schedule).toHaveBeenCalledTimes(1);
  await act(async () => finish({ id: 'alarm-message-one', ...initial, state: 'scheduled', zone: 'Asia/Shanghai', at: 1 }));
  await app.close();
});
test('editing and deleting an existing local alarm keep the exact managed ID', async () => {
  rows = [{ id: 'alarm-original', ...initial, zone: 'Asia/Shanghai', at: 1, state: 'scheduled' }];
  const app = await mount(<PhoneAlarmEditor initial={initial} />);
  await app.press('编辑闹铃');
  await act(async () => app.tree.root.findAllByType(TextInput)[1].props.onChangeText('12:30'));
  await app.press('确认修改本机闹铃');
  expect(mock.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'alarm-original', time: '12:30' }));
  await app.press('取消闹铃'); expect(mock.cancel).toHaveBeenCalledWith('alarm-original');
  expect(rows).toEqual([]); await app.close();
});
test('opening the system clock does not claim an alarm was saved or modified', async () => {
  const app = await mount(); await app.press('打开系统闹钟');
  expect(mock.schedule).not.toHaveBeenCalled(); expect(app.text()).toContain('请在系统时钟里确认修改结果');
  expect(app.text()).not.toContain('已安排本机闹铃'); await app.close();
});

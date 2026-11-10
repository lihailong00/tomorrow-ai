import React from 'react';
import { Animated, AppState, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, type AppContextValue } from '../src/app/context';
import type { Message } from '../src/domain/types';
import { calendarRequest } from '../src/features/phone-calendar/calendarRequest';
import { calendarPreferenceKey } from '../src/features/phone-calendar/CalendarCard';
import { phoneCalendar } from '../src/platform/phoneCalendar';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/phoneCalendar', () => ({ phoneCalendar: {
  supported: true, hasAccess: jest.fn(), requestAccess: jest.fn(), calendars: jest.fn(),
  add: jest.fn(), openEditor: jest.fn(), pickDate: jest.fn(), pickTime: jest.fn(), editSavedEvent: jest.fn(),
} }));
jest.mock('../src/platform/ports', () => ({ platform: { getSystemFontScale: jest.fn().mockResolvedValue(null) } }));
jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

const reference = new Date(2026, 10, 5, 23, 10);
const previous = (content: string, role: Message['role'] = 'user'): Message => ({
  id: role, conversation_id: 'chat', role, content, created_at: reference.toISOString(),
});

test('immediate follow-up uses the user’s date, ignores an invented assistant time, and separates two events', () => {
  const request = calendarRequest('先记得，到时提醒我吧。', [
    previous('周六带猫去做体检，还要和女朋友吃一顿好的。'),
    previous('我可以设置周六上午10点的计划草稿。', 'assistant'),
  ], reference);
  expect(request?.automatic).toBe(false);
  expect(request?.drafts).toEqual([
    expect.objectContaining({ title: '带猫去做体检', date: '2026-11-07', time: '' }),
    expect.objectContaining({ title: '和女朋友吃一顿好的', date: '2026-11-07', time: '' }),
  ]);
  expect(calendarRequest('到时提醒我', [previous('明天体检'), previous('我们换个话题')], reference)?.drafts[0].date).toBe('');
});

test('a precise calendar instruction can be saved directly; alternative dates or times cannot', () => {
  expect(calendarRequest('帮我把周六上午10点带猫体检加到手机日历，提前半个小时提醒我', [], reference)).toEqual({
    automatic: true, needsReminderTime: true, drafts: [
      { title: '带猫体检', date: '2026-11-07', time: '10:00', allDay: false, duration: 30, remindBefore: 30 },
    ],
  });
  expect(calendarRequest('在手机日历添加周六或周日下午3点体检', [], reference)?.drafts[0].date).toBe('');
  expect(calendarRequest('在手机日历添加周六上午9点或10点体检', [], reference)?.drafts[0].time).toBe('');
  expect(calendarRequest('在手机日历添加周六晚上12点体检', [], reference)?.automatic).toBe(false);
  expect(calendarRequest('每天早上七点提醒我', [], reference)).toBeNull();
});

let tree: ReactTestRenderer | undefined;
const priorAppState = AppState.currentState;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(async () => {
  jest.clearAllMocks();
  (phoneCalendar.hasAccess as jest.Mock).mockResolvedValue(false);
  AppState.currentState = 'active';
  await AsyncStorage.clear();
  jest.spyOn(Animated, 'timing').mockImplementation(() => ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }));
});
afterEach(async () => {
  await act(async () => tree?.unmount());
  tree = undefined;
  AppState.currentState = priorAppState;
  jest.restoreAllMocks();
});

async function chat(messages: Message[] = []) {
  const state = createChatEntryState();
  state.update(old => ({ ...old, messages }));
  const api = { baseUrl: 'https://calendar-test.example', capabilities: jest.fn().mockResolvedValue({}), chatStream: jest.fn() };
  const value = { api, user: { id: 'calendar-user', name: 'User' }, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue;
  await act(async () => { tree = create(<AppProvider value={value}><ChatScreen entryState={state} /></AppProvider>); });
  return {
    api,
    button(label: string) {
      return (tree!.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0]
        ?? tree!.root.findAllByType(Button).find(node => node.props.children === label))!;
    },
    async send(text: string) {
      const input = tree!.root.findAllByType(TextInput).find(node => node.props.placeholder === '发消息…')!;
      await act(async () => input.props.onChangeText(text));
      const send = tree!.root.findAll(node => node.props.accessibilityLabel === '发送消息' && typeof node.props.onPress === 'function')[0];
      await act(async () => send.props.onPress());
    },
  };
}

test('chat opens a local card, denies permission safely, then writes and remembers a chosen calendar', async () => {
  const app = await chat([previous('明天带猫去做体检')]);
  (phoneCalendar.requestAccess as jest.Mock).mockResolvedValueOnce(false).mockResolvedValue(true);
  (phoneCalendar.calendars as jest.Mock).mockResolvedValue([
    { id: 'work', name: '工作', account: '工作账号' }, { id: 'local', name: '我的日历', account: '我的日历' },
  ]);
  (phoneCalendar.add as jest.Mock).mockResolvedValue({ id: 'new-event' });
  (phoneCalendar.pickTime as jest.Mock).mockResolvedValueOnce(null).mockResolvedValueOnce('10:00');
  (phoneCalendar.editSavedEvent as jest.Mock).mockResolvedValue('opened');

  await app.send('先记得，到时提醒我吧。');
  expect(JSON.stringify(tree!.toJSON())).toContain('带猫去做体检');
  expect(app.button('保存到日历')).toBeUndefined();
  expect(app.button('选择开始时间')).toBeUndefined();
  expect(phoneCalendar.requestAccess).not.toHaveBeenCalled();
  await act(async () => app.button('选择时间').props.onPress());
  await act(async () => app.button('选择开始时间').props.onPress());
  expect(phoneCalendar.pickTime).toHaveBeenCalledWith('2026-11-06', '');
  expect(app.button('保存到日历')).toBeUndefined();
  await act(async () => app.button('选择开始时间').props.onPress());
  expect(app.button('开始时').props.accessibilityState.checked).toBe(true);
  await act(async () => app.button('提前 30 分钟').props.onPress());
  await act(async () => app.button('完成').props.onPress());
  expect(JSON.stringify(tree!.toJSON())).toContain('10:00–10:30');
  await act(async () => app.button('保存到日历').props.onPress());
  expect(phoneCalendar.calendars).not.toHaveBeenCalled();
  expect(phoneCalendar.add).not.toHaveBeenCalled();

  await act(async () => app.button('保存到日历').props.onPress());
  expect(phoneCalendar.add).not.toHaveBeenCalled();
  const options = tree!.root.findAll(node => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function');
  expect(options).toHaveLength(2);
  expect(app.button('我的日历，我的日历')).toBeUndefined();
  expect(app.button('保存到日历').props.disabled).toBe(true);
  await act(async () => app.button('我的日历').props.onPress());
  await act(async () => app.button('完成').props.onPress());
  expect(app.button('选择保存日历').props.accessibilityValue.text).toBe('我的日历');
  expect(phoneCalendar.add).not.toHaveBeenCalled();
  await act(async () => app.button('保存到日历').props.onPress());
  expect(phoneCalendar.add).toHaveBeenLastCalledWith('local', expect.objectContaining({ title: '带猫去做体检', time: '10:00', remindBefore: 30 }));
  await act(async () => app.button('修改日程').props.onPress());
  expect(phoneCalendar.editSavedEvent).toHaveBeenCalledWith('new-event');
  expect(phoneCalendar.add).toHaveBeenCalledTimes(1);

  (phoneCalendar.hasAccess as jest.Mock).mockResolvedValue(true);
  await app.send('帮我在手机日历添加明天下午三点的测试日程，提前15分钟提醒我');
  expect(phoneCalendar.add).toHaveBeenCalledTimes(2);
  expect(phoneCalendar.add).toHaveBeenLastCalledWith('local', expect.objectContaining({ title: '测试日程', time: '15:00', remindBefore: 15 }));
  expect(app.api.chatStream).not.toHaveBeenCalled();
});

test('all-day mode requires only the missing date and saves without a time or reminder', async () => {
  const app = await chat();
  (phoneCalendar.requestAccess as jest.Mock).mockResolvedValue(true);
  (phoneCalendar.pickDate as jest.Mock).mockResolvedValue('2099-12-31');
  (phoneCalendar.calendars as jest.Mock).mockResolvedValue([{ id: 'local', name: '我的日历', account: '' }]);
  (phoneCalendar.add as jest.Mock).mockResolvedValue({ id: 'all-day-event' });

  await app.send('帮我把整理疫苗记录加到手机日历');
  await act(async () => app.button('选择日期').props.onPress());
  await act(async () => app.button('全天').props.onPress());
  await act(async () => app.button('选择日程日期').props.onPress());
  expect(phoneCalendar.requestAccess).not.toHaveBeenCalled();
  expect(phoneCalendar.pickTime).not.toHaveBeenCalled();
  await act(async () => app.button('完成').props.onPress());
  await act(async () => app.button('保存到日历').props.onPress());
  expect(phoneCalendar.add).toHaveBeenCalledWith('local', expect.objectContaining({
    title: '整理疫苗记录', date: '2099-12-31', time: '', allDay: true, remindBefore: -1,
  }));
  expect(JSON.stringify(tree!.toJSON())).toContain('已保存到手机日历');
});

test('an authorized draft previews the last-used calendar and hands off only confirmed edits to the system editor', async () => {
  const app = await chat([previous('明天带猫去做体检')]);
  await AsyncStorage.setItem(calendarPreferenceKey('https://calendar-test.example', undefined, 'calendar-user'), 'work');
  (phoneCalendar.hasAccess as jest.Mock).mockResolvedValue(true);
  (phoneCalendar.calendars as jest.Mock).mockResolvedValue([
    { id: 'local', name: '我的日历', account: '' },
    { id: 'work', name: '工作', account: '工作账号' },
  ]);
  (phoneCalendar.pickTime as jest.Mock).mockResolvedValue('15:30');
  (phoneCalendar.openEditor as jest.Mock).mockResolvedValue('opened');
  await app.send('先记得，到时提醒我吧。');
  expect(app.button('选择保存日历').props.accessibilityValue.text).toBe('工作');
  expect(phoneCalendar.requestAccess).not.toHaveBeenCalled();
  await act(async () => app.button('编辑日程标题').props.onPress());
  const title = tree!.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '日程名称')!;
  await act(async () => title.props.onChangeText('不保存这次修改'));
  await act(async () => app.button('编辑时间与提醒').props.onPress());
  await act(async () => app.button('选择开始时间').props.onPress());
  await act(async () => app.button('完成').props.onPress());
  await act(async () => app.button('更多日程选项').props.onPress());
  await act(async () => app.button('在系统日历中编辑').props.onPress());
  expect(phoneCalendar.openEditor).toHaveBeenCalledWith(expect.objectContaining({ title: '带猫去做体检', time: '15:30' }));
  expect(phoneCalendar.add).not.toHaveBeenCalled();
  expect(JSON.stringify(tree!.toJSON())).toContain('已打开系统日历');
});

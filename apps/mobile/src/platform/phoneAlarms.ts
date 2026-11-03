import { NativeModules, Platform } from 'react-native';

export type PhoneAlarm = {
  id: string; date: string; time: string; title: string; at: number; zone: string;
  state: 'scheduled' | 'pending' | 'fired' | 'stopped' | 'missed' | 'needs_retry';
};
export type AlarmAvailability = { exact: boolean; notifications: boolean; system_clock: boolean };
interface NativeAlarms {
  availability(): Promise<AlarmAvailability>;
  list(): Promise<PhoneAlarm[]>;
  schedule(id: string, date: string, time: string, title: string): Promise<PhoneAlarm>;
  cancel(id: string): Promise<boolean>;
  openExactAlarmSettings(): Promise<boolean>;
  openNotificationSettings(): Promise<boolean>;
  openSystemClock(): Promise<'opened'>;
  createSystemAlarm(hour: number, minute: number, title: string): Promise<'opened'>;
}
const native = NativeModules.PhoneAlarms as NativeAlarms | undefined;
function required(): NativeAlarms {
  if (!native || Platform.OS !== 'android') throw new Error('当前安装包尚未提供本机闹铃能力。');
  return native;
}
export const phoneAlarms = {
  supported: Platform.OS === 'android' && typeof native?.schedule === 'function',
  availability: () => required().availability(),
  list: () => required().list(),
  schedule: (value: Pick<PhoneAlarm, 'id' | 'date' | 'time' | 'title'>) =>
    required().schedule(value.id, value.date, value.time, value.title),
  cancel: (id: string) => required().cancel(id),
  openExactSettings: () => required().openExactAlarmSettings(),
  openNotificationSettings: () => required().openNotificationSettings(),
  openSystemClock: () => required().openSystemClock(),
  createSystemAlarm: (hour: number, minute: number, title: string) => required().createSystemAlarm(hour, minute, title),
};

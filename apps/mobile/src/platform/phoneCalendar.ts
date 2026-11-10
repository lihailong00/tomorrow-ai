import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export type CalendarEventDraft = {
  title: string; date: string; time: string; allDay: boolean; duration: number; remindBefore: number;
};
export type WritableCalendar = { id: string; name: string; account: string };
interface NativeCalendar {
  calendars(): Promise<WritableCalendar[]>;
  add(id: string, title: string, date: string, time: string, allDay: boolean, duration: number, remindBefore: number): Promise<{ id: string }>;
  openEditor(title: string, date: string, time: string, allDay: boolean, duration: number): Promise<'opened'>;
  pickDate?(date: string): Promise<string | null>;
  pickTime?(date: string, time: string): Promise<string | null>;
  editSavedEvent?(id: string): Promise<'opened'>;
}
const native = NativeModules.PhoneCalendar as NativeCalendar | undefined;
const permissions = [PermissionsAndroid.PERMISSIONS.READ_CALENDAR, PermissionsAndroid.PERMISSIONS.WRITE_CALENDAR];
const eventArgs = ({ title, date, time, allDay, duration }: CalendarEventDraft) => [title.trim(), date.trim(), time.trim(), allDay, duration] as const;

export const phoneCalendar = {
  supported: Platform.OS === 'android' && typeof native?.add === 'function',
  dateTimePickerSupported: typeof native?.pickDate === 'function' && typeof native?.pickTime === 'function',
  async hasAccess() { return (await Promise.all(permissions.map(permission => PermissionsAndroid.check(permission)))).every(Boolean); },
  async requestAccess() {
    const checks = await Promise.all(permissions.map(permission => PermissionsAndroid.check(permission)));
    const missing = permissions.filter((_permission, index) => !checks[index]);
    if (missing.length) await PermissionsAndroid.requestMultiple(missing);
    return this.hasAccess();
  },
  calendars: () => native!.calendars(),
  add: (id: string, draft: CalendarEventDraft) => native!.add(id, ...eventArgs(draft), draft.remindBefore),
  openEditor: (draft: CalendarEventDraft) => native!.openEditor(...eventArgs(draft)),
  pickDate: (date: string) => native?.pickDate?.(date),
  pickTime: (date: string, time: string) => native?.pickTime?.(date, time),
  editSavedEvent: (id: string) => native?.editSavedEvent?.(id) ??
    Promise.reject(new Error('请在系统日历中打开已保存的日程。')),
};

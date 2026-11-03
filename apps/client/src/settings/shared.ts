import {useEffect, useRef, useState} from 'react';
import {ApiError, type ApiClient, type PagedItems, type User} from '@tada/client-core';
import {errorText} from '../platform';

export function settingsError(error: unknown) {
  if (error instanceof ApiError && [404, 405, 501].includes(error.status)) return '这台服务器暂不支持此功能，请更新服务器后重试。';
  return errorText(error);
}

/** Each pane cancels its own reads and writes when leaving the account/server. */
export function useSettingsAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {active.current = true; return () => {active.current = false; controller.current?.abort();};}, []);
  async function run<T>(work: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, success = '') {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await work(current.signal);
      if (active.current && !current.signal.aborted) {accept(value); setNotice(success);}
    } catch (e) {if (active.current && !current.signal.aborted) setError(settingsError(e));}
    finally {if (controller.current === current) controller.current = null; if (active.current) setBusy(false);}
  }
  return {busy, error, notice, run, setError};
}

export function useSettingsResource<T>(api: ApiClient, path: string, parse: (value: unknown) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setLoading(true);
    api.request<unknown>(path, 'GET', undefined, controller.signal).then(parse).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(e => {if (!controller.signal.aborted) setError(settingsError(e));}).finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [api, path, parse, revision]);
  return {data, setData, error, loading, reload: () => setRevision(value => value + 1)};
}

export function profileInput(name: string, timezone: string) {
  const value = {name: name.trim(), timezone: timezone.trim()};
  if (!value.name || Array.from(value.name).length > 80) throw new Error('称呼请填写 1–80 个字符。');
  try {new Intl.DateTimeFormat('zh-CN', {timeZone: value.timezone}).format();}
  catch {throw new Error('请选择有效的时区，例如 Asia/Shanghai。');}
  if (!value.timezone) throw new Error('请选择时区。');
  return value;
}

export function readProfile(value: unknown, expectedId: string): User {
  const row = object(value);
  if (row.id !== expectedId || typeof row.email !== 'string' || typeof row.created_at !== 'string' ||
      typeof row.name !== 'string' || typeof row.timezone !== 'string' ||
      row.phone !== undefined && row.phone !== null && typeof row.phone !== 'string') throw new Error('服务器返回的账号资料不兼容，请重新读取。');
  profileInput(row.name, row.timezone);
  return row as unknown as User;
}

export interface InboxMessage {id: string; title: string; body: string; read: boolean; created_at: string}
export interface SavedUpload {id: string; name: string; mime_type: string; size: number; created_at: string}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('服务器返回的数据格式不兼容。');
  return value as Record<string, unknown>;
}
function string(row: Record<string, unknown>, field: string, limit = 20000): string {
  if (typeof row[field] !== 'string' || row[field].length > limit) throw new Error('服务器返回的数据格式不兼容。');
  return row[field];
}
function page<T>(value: unknown, read: (row: Record<string, unknown>) => T): PagedItems<T> {
  const row = object(value);
  if (!Array.isArray(row.items) || row.items.length > 500 || row.next_offset !== undefined && row.next_offset !== null &&
      (!Number.isSafeInteger(row.next_offset) || Number(row.next_offset) < 0)) throw new Error('服务器返回的分页数据不兼容。');
  return {items: row.items.map(item => read(object(item))), next_offset: row.next_offset as number | null | undefined};
}
export function readNotifications(value: unknown) {
  return page<InboxMessage>(value, row => {
    if (typeof row.read !== 'boolean') throw new Error('服务器返回的消息状态不兼容。');
    return {id: string(row, 'id', 200), title: string(row, 'title'), body: string(row, 'body'), read: row.read, created_at: string(row, 'created_at', 100)};
  });
}
export function readUploads(value: unknown) {
  return page<SavedUpload>(value, row => {
    if (!Number.isSafeInteger(row.size) || Number(row.size) < 0) throw new Error('服务器返回的文件大小不兼容。');
    return {id: string(row, 'id', 200), name: string(row, 'name', 1000), mime_type: string(row, 'mime_type', 300), size: Number(row.size), created_at: string(row, 'created_at', 100)};
  });
}
export function dateTime(value: string, timezone: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  try {return new Intl.DateTimeFormat('zh-CN', {timeZone: timezone, dateStyle: 'medium', timeStyle: 'short'}).format(date);}
  catch {return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';}
}
export function fileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

import {useState} from 'react';
import {Bell, Check, FileText, RefreshCw, Trash2} from 'lucide-react';
import type {ApiClient} from '@tada/client-core';
import {Notice} from '../Auth';
import {ResourceState, Pagination} from './elements';
import {dateTime, fileSize, readNotifications, readUploads, useSettingsAction, useSettingsResource} from './shared';

async function requireOk(work: Promise<unknown>) {
  const result = await work;
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('服务器尚未确认操作完成，请刷新后检查。');
}

export function NotificationsPane({api, timezone}: {api: ApiClient; timezone: string}) {
  const [unread, setUnread] = useState(false); const [offset, setOffset] = useState(0);
  const resource = useSettingsResource(api, `/notifications?limit=20&offset=${offset}${unread ? '&read=false' : ''}`, readNotifications);
  const action = useSettingsAction();
  return <>
    <div className="settings-pane-heading"><div><h3>消息通知</h3><p>查看服务端保存的任务动态，阅读状态与手机版同步。</p></div><button className="icon-text" disabled={resource.loading || action.busy} onClick={resource.reload}><RefreshCw size={14}/>刷新</button></div>
    <p className="settings-note">这里是消息中心。当前桌面版尚未接入系统弹窗和关闭程序后的推送。</p>
    <label className="settings-check"><input type="checkbox" checked={unread} disabled={action.busy} onChange={e => {setUnread(e.target.checked); setOffset(0);}}/><span>只看未读消息</span></label>
    <ResourceState resource={resource}/>{action.error && <Notice>{action.error}</Notice>}
    {resource.data?.items.length === 0 && <div className="settings-empty"><Bell size={23}/>{unread ? '没有未读消息。' : '还没有消息通知。'}</div>}
    <div className="settings-message-list">{resource.data?.items.map(item => <article key={item.id} className={item.read ? 'is-read' : ''}><div><h4>{!item.read && <span className="settings-unread-dot" aria-label="未读"/>}{item.title}</h4><p>{item.body}</p><time>{dateTime(item.created_at, timezone)}</time></div>{item.read ? <span className="settings-note">已读</span> : <button className="icon-text" disabled={action.busy || resource.loading} onClick={() => void action.run(signal => requireOk(api.request(`/notifications/${encodeURIComponent(item.id)}/read`, 'POST', {}, signal)), () => {
      if (unread) {setOffset(0); resource.reload();}
      else resource.setData(previous => previous && ({...previous, items: previous.items.map(row => row.id === item.id ? {...row, read: true} : row)}));
    })}><Check size={14}/>标为已读</button>}</article>)}</div>
    <Pagination offset={offset} next={resource.data?.next_offset} busy={resource.loading || action.busy} onChange={setOffset}/>
  </>;
}

export function UploadsPanel({api, timezone}: {api: ApiClient; timezone: string}) {
  const [offset, setOffset] = useState(0); const [kind, setKind] = useState<'all' | 'file' | 'audio'>('all');
  const [deleting, setDeleting] = useState<string | null>(null);
  const resource = useSettingsResource(api, `/uploads?limit=20&offset=${offset}&kind=${kind}`, readUploads);
  const action = useSettingsAction();
  return <section className="settings-subsection"><div className="settings-pane-heading"><div><h4>已上传的文件与录音</h4><p>管理当前账号已经保存在这台服务器上的资料。</p></div><button className="icon-text" disabled={resource.loading || action.busy} onClick={() => {setDeleting(null); resource.reload();}}><RefreshCw size={14}/>刷新</button></div>
    <div className="settings-periods" aria-label="资料类型">{([{id: 'all', label: '全部'}, {id: 'file', label: '文件'}, {id: 'audio', label: '录音'}] as const).map(value => <button key={value.id} aria-pressed={value.id === kind} disabled={action.busy} onClick={() => {setKind(value.id); setOffset(0); setDeleting(null);}}>{value.label}</button>)}</div>
    <ResourceState resource={resource}/>{action.error && <Notice>{action.error}</Notice>}{action.notice && <Notice tone="success">{action.notice}</Notice>}
    {resource.data?.items.length === 0 && <div className="settings-empty">还没有已上传的资料。</div>}
    <div className="settings-upload-list">{resource.data?.items.map(item => <article key={item.id}><FileText size={20}/><div className="settings-upload-info"><strong>{item.name || '未命名文件'}</strong><small>{fileSize(item.size)} · {dateTime(item.created_at, timezone)}</small>{deleting === item.id && <div className="settings-delete-confirm" role="group" aria-label={`删除确认：${item.name}`}><p>删除后无法恢复，这份资料将不再可用于读取或分析。</p><button className="secondary" disabled={action.busy} autoFocus onClick={() => setDeleting(null)}>保留文件</button><button className="danger" disabled={action.busy || resource.loading} onClick={() => void action.run(signal => requireOk(api.request(`/uploads/${encodeURIComponent(item.id)}`, 'DELETE', undefined, signal)), () => {setDeleting(null); setOffset(0); resource.reload();}, '已删除所选资料。')}>{action.busy ? '正在删除…' : '确认删除文件'}</button></div>}</div><button className="icon-button danger-text" aria-label={`删除文件：${item.name}`} disabled={action.busy || resource.loading} onClick={() => setDeleting(item.id)}><Trash2 size={16}/></button></article>)}</div>
    <Pagination offset={offset} next={resource.data?.next_offset} busy={resource.loading || action.busy} onChange={value => {setOffset(value); setDeleting(null);}}/>
  </section>;
}

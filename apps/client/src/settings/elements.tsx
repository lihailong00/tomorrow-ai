import {LoaderCircle, RefreshCw} from 'lucide-react';
import {Notice} from '../Auth';

export function ResourceState({resource}: {resource: {loading: boolean; error: string; reload(): void}}) {
  if (resource.loading) return <div className="settings-loading" role="status"><LoaderCircle className="spin" size={18}/>正在读取…</div>;
  return resource.error ? <Notice>{resource.error}<button className="inline-action" onClick={resource.reload}><RefreshCw size={14}/>重试</button></Notice> : null;
}
export function Pagination({offset, next, busy, onChange}: {offset: number; next?: number | null; busy: boolean; onChange(offset: number): void}) {
  if (offset === 0 && (next == null || next <= offset)) return null;
  return <div className="settings-pagination"><button className="secondary" disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button className="secondary" disabled={busy || next == null || next <= offset} onClick={() => {if (next != null && next > offset) onChange(next);}}>下一页</button></div>;
}

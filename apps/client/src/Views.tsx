import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowRight, CalendarDays, Check, ChevronRight, Heart, LoaderCircle, Mail, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X} from 'lucide-react';
import {newRequestId, type ApiClient, type Memory, type MemoryKind, type SaveMemory, type Task, type Today, type Todo, type TodoFilter, type TodoKind, type User} from '@tada/client-core';
import {Notice, Orb} from './Auth';
import {Markdown} from './Markdown';
import {errorText} from './platform';
import {TodoViewHost} from './plugins/TodoViewHost';

export function EmptyState({icon = 'sparkle', title, detail, children}: {icon?: 'sparkle' | 'memory' | 'todo'; title: string; detail: string; children?: React.ReactNode}) {
  return <div className="empty-state"><span>{icon === 'memory' ? <Heart size={25}/> : icon === 'todo' ? <Check size={25}/> : <Sparkles size={25}/>}</span><h3>{title}</h3><p>{detail}</p>{children}</div>;
}
function Loading({text}: {text: string}) {return <div className="section-loading"><LoaderCircle className="spin" size={20}/>{text}</div>;}
function PageHeading({eyebrow, title, detail, children}: {eyebrow: string; title: string; detail: string; children?: React.ReactNode}) {return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{detail}</p></div><div className="page-actions">{children}</div></div>;}
const terminalTask = (value: Task) => ['succeeded', 'failed', 'cancelled', 'uncertain', 'waiting_approval'].includes(value.status);

export function TodayView({api, user, onAsk, onTodos}: {api: ApiClient; user: User; onAsk(): void; onTodos(): void}) {
  const [data, setData] = useState<Today | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [task, setTask] = useState<Task | null>(null);
  const scope = useRef(0);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function load() {const current = scope.current; setLoading(true); setError(''); try {const value = await api.today(); if (current === scope.current) setData(value);} catch (e) {if (current === scope.current) setError(errorText(e));} finally {if (current === scope.current) setLoading(false);}}
  useEffect(() => {void load(); return () => {++scope.current; if (poll.current) clearTimeout(poll.current);};}, [api]);
  async function generate() {
    if (generating) return;
    const current = scope.current; setGenerating(true); setError('');
    try {
      const value = await api.briefing(); if (current !== scope.current) return; setTask(value);
      const check = async (item: Task): Promise<void> => {
        if (current !== scope.current) return;
        setTask(item);
        if (terminalTask(item)) {setGenerating(false); if (item.status === 'succeeded') await load(); else setError(item.error || item.summary || '简报未完成，请稍后查看执行结果。'); return;}
        poll.current = setTimeout(() => {api.task(item.id).then(check).catch(e => {if (current === scope.current) {setGenerating(false); setError(errorText(e));}});}, 1800);
      };
      await check(value);
    } catch (e) {if (current === scope.current) {setGenerating(false); setError(errorText(e));}}
  }
  const date = new Date().toLocaleDateString('zh-CN', {month: 'long', day: 'numeric', weekday: 'long'});
  return <div className="content-page today-page"><PageHeading eyebrow={date} title={`你好，${user.name || '朋友'}`} detail="今天，也从一件值得做的小事开始。"><button className="icon-text refresh-page" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''}/>刷新</button></PageHeading>
    {error && <Notice>{error}</Notice>}{loading && !data && <Loading text="正在查看今天的安排…"/>}{data && <>
      <div className="today-overview"><div><strong>{data.stats.active_tasks ?? data.tasks.filter(t => ['queued', 'running'].includes(t.status)).length}</strong><span>进行中的执行</span></div><div><strong>{data.stats.tasks_completed}</strong><span>已完成</span></div><div><strong>{data.stats.memory_count}</strong><span>条记忆陪着你</span></div></div>
      <section className="briefing-panel"><div className="section-heading"><h3><Sparkles size={20}/> 今日简报</h3><button className="icon-text" disabled={generating} onClick={() => void generate()}>{generating ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>} {generating ? '正在生成…' : data.briefing?.trim() ? '更新简报' : '生成简报'}</button></div>{generating && <div className="briefing-progress" role="status"><LoaderCircle className="spin" size={15}/>{task?.summary || `正在整理资料${task ? ` · ${Math.round(task.progress)}%` : ''}`}</div>}{data.briefing?.trim() ? <Markdown text={data.briefing}/> : <div className="briefing-empty"><p>把已有的事项、计划与记忆，整理成一份清晰的今日简报。</p><small>点击生成后才会调用模型；未连接的渠道不会出现在简报里。</small></div>}<div className="briefing-source"><ShieldIcon/> 基于你在当前服务器中保存的资料</div></section>
      <section className="today-section"><div className="section-heading"><h3>接下来的安排</h3><button className="icon-text" onClick={onTodos}>查看事项 <ArrowRight size={15}/></button></div>{data.schedules.filter(x => x.enabled).length ? <div className="schedule-list">{data.schedules.filter(x => x.enabled).slice(0, 8).map(x => <div key={x.id}><span className="date-icon"><CalendarDays size={18}/></span><div><strong>{x.title}</strong><small>{formatDate(x.next_run_at)}</small></div></div>)}</div> : <div className="quiet-empty">今天还没有已保存的计划，留一点空间给想做的事。</div>}</section>
      <button className="today-ask" onClick={onAsk}><Orb small/><span>有什么想一起做的？</span><ArrowRight size={19}/></button>
    </>}{!loading && !data && <button className="secondary" onClick={() => void load()}>重新加载今日</button>}</div>;
}
function ShieldIcon() {return <span aria-hidden="true">◇</span>;}

const kinds: Array<{id: TodoKind; label: string}> = [{id: 'general', label: '日常'}, {id: 'communication', label: '沟通'}, {id: 'learning', label: '学习'}, {id: 'exercise', label: '运动'}, {id: 'errand', label: '办事'}, {id: 'reading', label: '阅读'}, {id: 'expense', label: '财务'}];
const statuses: Record<string, string> = {suggested: 'AI 建议', pending: '待处理', in_progress: '进行中', waiting: '等待中', completed: '已完成', dismissed: '已忽略'};
const todoFilters: Array<{id: TodoFilter; label: string}> = [{id: 'active', label: '待处理'}, {id: 'waiting', label: '等待中'}, {id: 'suggested', label: 'AI 建议'}, {id: 'completed', label: '已完成'}, {id: 'all', label: '全部'}];

export function TodosView({api}: {api: ApiClient}) {
  const [items, setItems] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<TodoFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [next, setNext] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingTodo, setEditingTodo] = useState<Todo | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [selected, setSelected] = useState<Todo | null>(null);
  const [changing, setChanging] = useState<string | null>(null);
  const scope = useRef(0);
  async function load(offset = 0) {
    const current = scope.current; setLoading(true); setError('');
    try {const page = await api.todos({filter, scope: 'all', offset, limit: 50}); if (current !== scope.current) return; setItems(prev => offset ? [...prev, ...page.items.filter(x => !prev.some(p => p.id === x.id))] : page.items); setNext(page.next_offset ?? null);} catch (e) {if (current === scope.current) setError(errorText(e));} finally {if (current === scope.current) setLoading(false);}
  }
  useEffect(() => {++scope.current; setItems([]); setNext(null); setSelected(null); setChanging(null); setConfirmDelete(false); void load(); return () => {++scope.current;};}, [api, filter]);
  async function toggle(item: Todo) {
    if (changing) return; const current = scope.current;
    setChanging(item.id); setError('');
    try {const value = await api.updateTodo(item.id, {version: item.version, status: item.status === 'completed' ? 'pending' : 'completed'}); if (current !== scope.current) return; setSelected(prev => prev?.id === value.id ? value : prev); await load();}
    catch (e) {if (current === scope.current) setError(errorText(e));} finally {if (current === scope.current) setChanging(null);}
  }
  async function remove(item: Todo) {
    if (changing) return; const current = scope.current; setChanging(item.id); setError('');
    try {await api.deleteTodo(item.id); if (current !== scope.current) return; setSelected(null); setConfirmDelete(false); await load();}
    catch (e) {if (current === scope.current) setError(errorText(e));} finally {if (current === scope.current) setChanging(null);}
  }
  return <div className="content-page todos-page"><PageHeading eyebrow="每一步，都算数" title="事项" detail="来自对话和生活，也可以由你亲手添加。"><button className="primary" onClick={() => setAdding(true)}><Plus size={17}/>添加事项</button></PageHeading><div className="segments todo-filters">{todoFilters.map(x => <button key={x.id} className={filter === x.id ? 'active' : ''} onClick={() => setFilter(x.id)}>{x.label}</button>)}</div>{error && <Notice>{error}<button className="inline-action" onClick={() => void load()}>刷新列表</button></Notice>}
    <TodoViewHost items={items} busyId={changing} onOpen={setSelected} onToggle={item => void toggle(item)}/>
    {loading && <Loading text="正在整理事项…"/>}{!loading && !items.length && !error && <EmptyState icon="todo" title={filter === 'completed' ? '完成的每一步，都会留在这里' : '暂时没有这一类事项'} detail="可以手动添加；手机端已发现的事项也会同步到这里。"><button className="secondary" onClick={() => setAdding(true)}><Plus size={16}/>添加第一件事</button></EmptyState>}{next !== null && <button className="load-more secondary" disabled={loading} onClick={() => void load(next)}>加载更多事项</button>}
    {adding && <TodoEditor api={api} item={editingTodo} onClose={() => {setAdding(false); setEditingTodo(undefined);}} onSaved={() => {setAdding(false); setEditingTodo(undefined); void load();}}/>}
    {selected && <div className="drawer-overlay" onClick={() => {setSelected(null); setConfirmDelete(false);}}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="todo-detail-heading" onClick={e => e.stopPropagation()}><div className="drawer-top"><span className={`status-pill ${selected.status}`}>{statuses[selected.status]}</span><button className="icon-button" aria-label="关闭事项详情" onClick={() => {setSelected(null); setConfirmDelete(false);}}><X size={20}/></button></div><h2 id="todo-detail-heading">{selected.title}</h2><div className="detail-metadata"><span>{selected.source_label || '当前服务器'}</span>{selected.estimated_minutes && <span>约 {selected.estimated_minutes} 分钟</span>}{selected.due_at && <span>{formatDate(selected.due_at)}</span>}</div><div className="drawer-content"><Markdown text={selected.description || '还没有补充说明。'}/>{selected.source_excerpt && <section><h3>来源内容</h3><blockquote>{selected.source_excerpt}</blockquote></section>}{selected.draft && <section><h3>准备好的内容</h3><Markdown text={selected.draft}/></section>}{selected.progress_notes && <section><h3>进展</h3><Markdown text={selected.progress_notes}/></section>}</div><div className="todo-detail-actions"><button className="primary full-width" disabled={changing === selected.id} onClick={() => void toggle(selected)}><Check size={17}/>{selected.status === 'completed' ? '恢复为待处理' : '标记完成'}</button><button className="secondary full-width" disabled={changing === selected.id} onClick={() => {setEditingTodo(selected); setSelected(null); setAdding(true); setConfirmDelete(false);}}><Pencil size={15}/>编辑事项</button>{confirmDelete ? <div className="notice"><p>确定删除“{selected.title}”吗？</p><button className="danger" disabled={changing === selected.id} onClick={() => void remove(selected)}>确认删除事项</button><button className="secondary" disabled={changing === selected.id} onClick={() => setConfirmDelete(false)}>保留</button></div> : <button className="icon-text danger-text" disabled={changing === selected.id} onClick={() => setConfirmDelete(true)}><Trash2 size={14}/>删除事项</button>}</div></aside></div>}
  </div>;
}
function TodoEditor({api, item, onClose, onSaved}: {api: ApiClient; item?: Todo; onClose(): void; onSaved(): void}) {
  const [title, setTitle] = useState(item?.title ?? ''); const [description, setDescription] = useState(item?.description ?? ''); const [kind, setKind] = useState<TodoKind>(item?.kind ?? 'general'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const requestId = useRef(newRequestId());
  async function submit(e: FormEvent) {e.preventDefault(); if (!title.trim() || busy) return; setBusy(true); setError(''); try {if (item) await api.updateTodo(item.id, {title: title.trim(), description: description.trim(), kind, version: item.version}); else await api.createTodo({title: title.trim(), description: description.trim(), kind, client_request_id: requestId.current}); onSaved();} catch (e) {setError(errorText(e)); setBusy(false);}}
  return <div className="modal-overlay" onClick={() => {!busy && onClose();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="todo-add-heading" onClick={e => e.stopPropagation()}><div className="modal-heading"><div><div className="eyebrow">从一件小事开始</div><h2 id="todo-add-heading">{item ? '编辑事项' : '添加事项'}</h2></div><button className="icon-button" disabled={busy} aria-label="关闭事项编辑" onClick={onClose}><X size={20}/></button></div><form onSubmit={submit}><label>做什么<input aria-label="事项标题" value={title} onChange={e => setTitle(e.target.value)} placeholder="例如：读完今天的一章" maxLength={200} required autoFocus/></label><label>补充说明<textarea aria-label="事项说明" value={description} onChange={e => setDescription(e.target.value)} placeholder="想怎么做，或有什么需要留意的…" rows={4} maxLength={10000}/></label><label>分类<select aria-label="事项分类" value={kind} onChange={e => setKind(e.target.value as TodoKind)}>{kinds.map(x => <option value={x.id} key={x.id}>{x.label}</option>)}</select></label>{error && <Notice>{error}</Notice>}<button className="primary full-width" type="submit" disabled={busy || !title.trim()}>{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>} {busy ? '正在保存…' : '保存事项'}</button></form></section></div>;
}

const memoryKinds: Array<{id: MemoryKind; title: string}> = [{id: 'preference', title: '偏好'}, {id: 'person', title: '人物'}, {id: 'project', title: '项目'}, {id: 'goal', title: '目标'}, {id: 'fact', title: '事实'}];
export function MemoriesView({api}: {api: ApiClient}) {
  const [items, setItems] = useState<Memory[]>([]); const [kind, setKind] = useState<MemoryKind | ''>(''); const [query, setQuery] = useState(''); const [loading, setLoading] = useState(true); const [next, setNext] = useState<number | null>(null); const [error, setError] = useState(''); const [editing, setEditing] = useState<Memory | 'new' | null>(null); const scope = useRef(0);
  async function load(offset = 0) {const current = scope.current; setLoading(true); setError(''); try {const page = await api.memories(kind || undefined, {offset, limit: 50}); if (scope.current !== current) return; setItems(prev => offset ? [...prev, ...page.items.filter(x => !prev.some(p => p.id === x.id))] : page.items); setNext(page.next_offset ?? null);} catch (e) {if (current === scope.current) setError(errorText(e));} finally {if (current === scope.current) setLoading(false);}}
  useEffect(() => {++scope.current; setItems([]); void load(); return () => {++scope.current;};}, [api, kind]);
  const filtered = items.filter(x => `${x.title}\n${x.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="content-page memories-page"><PageHeading eyebrow="重要的事，有个地方安放" title="记忆" detail="让妥啦更懂你，也始终由你掌握。"><button className="primary" onClick={() => setEditing('new')}><Plus size={17}/>添加记忆</button></PageHeading><div className="memory-controls"><div className="segments"><button className={!kind ? 'active' : ''} onClick={() => setKind('')}>全部</button>{memoryKinds.map(x => <button key={x.id} className={kind === x.id ? 'active' : ''} onClick={() => setKind(x.id)}>{x.title}</button>)}</div><label className="search-field"><Search size={16}/><input aria-label="搜索已加载的记忆" placeholder="搜索已加载的记忆" value={query} onChange={e => setQuery(e.target.value)}/></label></div>{error && <Notice>{error}<button className="inline-action" onClick={() => void load()}>重试</button></Notice>}<div className="memory-list">{filtered.map(item => <button key={item.id} className="memory-row" onClick={() => setEditing(item)}><span className={`memory-kind-icon ${item.kind}`}><Heart size={17}/></span><div><strong>{item.title || item.content.slice(0, 36)}</strong><p>{item.content}</p><small>{memoryKinds.find(x => x.id === item.kind)?.title ?? '记忆'}<span>·</span>{sourceLabel(item.source)}<span>·</span>{formatDate(item.updated_at, true)}</small></div><ChevronRight size={17}/></button>)}</div>{loading && <Loading text="正在读取记忆…"/>}{!loading && !filtered.length && !error && <EmptyState icon="memory" title={query ? '没有找到这条记忆' : '从一件重要的事开始'} detail={query ? '尝试换个关键词，或加载更多记忆。' : '你的偏好、目标、在意的人和事，都可以记在这里。'}>{!query && <button className="secondary" onClick={() => setEditing('new')}><Plus size={16}/>添加第一条记忆</button>}</EmptyState>}{next !== null && <button className="secondary load-more" disabled={loading} onClick={() => void load(next)}>加载更多记忆</button>}{editing && <MemoryEditor api={api} item={editing} onClose={() => setEditing(null)} onSaved={() => {setEditing(null); void load();}}/>}</div>;
}
function MemoryEditor({api, item, onClose, onSaved}: {api: ApiClient; item: Memory | 'new'; onClose(): void; onSaved(): void}) {
  const existing = item === 'new' ? undefined : item;
  const [title, setTitle] = useState(existing?.title ?? ''); const [content, setContent] = useState(existing?.content ?? ''); const [kind, setKind] = useState<MemoryKind>((existing?.kind as MemoryKind) ?? 'fact'); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [confirmDelete, setConfirmDelete] = useState(false); const requestId = useRef(newRequestId());
  async function save(e: FormEvent) {e.preventDefault(); if (busy || !content.trim()) return; setBusy(true); setError(''); const input: SaveMemory = {title: title.trim(), content: content.trim(), kind, source: existing?.source ?? 'manual', ...(existing ? {version: existing.version} : {client_request_id: requestId.current})}; try {await api.saveMemory(input, existing?.id); onSaved();} catch (e) {setError(errorText(e)); setBusy(false);}}
  async function remove() {if (!existing || busy) return; setBusy(true); setError(''); try {await api.deleteMemory(existing.id); onSaved();} catch (e) {setError(errorText(e)); setBusy(false);}}
  return <div className="drawer-overlay" onClick={() => {!busy && onClose();}}><aside className="detail-drawer memory-editor" role="dialog" aria-modal="true" aria-labelledby="memory-editor-heading" onClick={e => e.stopPropagation()}><div className="drawer-top"><div className="eyebrow">{existing ? '你的记忆' : '记住一件事'}</div><button className="icon-button" aria-label="关闭记忆详情" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2 id="memory-editor-heading">{existing ? '查看与编辑' : '添加记忆'}</h2>{existing && <p className="detail-metadata">来源：{sourceLabel(existing.source)} · {formatDate(existing.updated_at, true)}</p>}<form onSubmit={save}><label>标题<input aria-label="记忆标题" value={title} onChange={e => setTitle(e.target.value)} placeholder="给这条记忆起个名字" maxLength={200}/></label><label>内容<textarea aria-label="记忆内容" value={content} onChange={e => setContent(e.target.value)} placeholder="你希望妥啦记住什么？" rows={9} maxLength={20000} required autoFocus/></label><label>分类<select aria-label="记忆分类" value={kind} onChange={e => setKind(e.target.value as MemoryKind)}>{memoryKinds.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>{error && <Notice>{error}</Notice>}<button className="primary full-width" type="submit" disabled={busy || !content.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}保存记忆</button></form>{existing && <div className="delete-memory">{confirmDelete ? <div><p>确定删除“{existing.title || '这条记忆'}”吗？</p><button className="danger" disabled={busy} onClick={() => void remove()}>确认删除</button><button className="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>保留</button></div> : <button className="icon-text danger-text" onClick={() => setConfirmDelete(true)}><Trash2 size={15}/> 删除这条记忆</button>}</div>}</aside></div>;
}
function formatDate(input: string, short = false) {const date = new Date(input); return Number.isNaN(date.getTime()) ? input : date.toLocaleString('zh-CN', short ? {month: 'numeric', day: 'numeric'} : {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});}
function sourceLabel(source: string) {return ({manual: '手动添加', user: '手动添加', conversation: '来自对话', chat: '来自对话', automatic: '经确认的记忆'} as Record<string, string>)[source] ?? source;}

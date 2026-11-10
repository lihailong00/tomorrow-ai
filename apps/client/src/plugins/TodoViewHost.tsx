import { Component, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Columns3, List, RotateCcw } from 'lucide-react';
import type { Todo } from '@tada/client-core';
import { OFFICIAL_TODO_VIEW, TodoViewRegistry, type TodoViewProps, type TodoViewItem } from './todo-contract';
import { officialTodos } from './official-todos';
import { todoBoard } from './examples/todo-board';
import './todo-plugins.css';

export const todoViews = new TodoViewRegistry(officialTodos);
let uninstallBoard = todoViews.register(todoBoard);
const preference = 'tada.todo-view.v1';
function savedView() { try { return localStorage.getItem(preference) ?? OFFICIAL_TODO_VIEW; } catch { return OFFICIAL_TODO_VIEW; } }
class ViewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
export function TodoViewHost({ items, busyId, onOpen, onToggle, registry = todoViews }: {
  items: readonly Todo[]; busyId: string | null; onOpen(item: Todo): void; onToggle(item: Todo): void; registry?: TodoViewRegistry;
}) {
  const [selected, setSelected] = useState(savedView);
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
  const plugin = registry.resolve(selected);
  const projected = useMemo(() => Object.freeze(items.map(item => Object.freeze({ id: item.id, title: item.title,
    description: item.description, kind: item.kind, status: item.status, source_kind: item.source_kind,
    source_label: item.source_label, due_at: item.due_at, estimated_minutes: item.estimated_minutes } satisfies TodoViewItem))), [items]);
  const props: TodoViewProps = { items: projected, busyId,
    onOpen(id) { const item = items.find(row => row.id === id); if (item) onOpen(item); },
    onToggle(id) { const item = items.find(row => row.id === id); if (item && !busyId) onToggle(item); },
  };
  function choose(id: string) { setSelected(id); try { localStorage.setItem(preference, id); } catch { /* View preference is optional. */ } }
  const Official = officialTodos.View; const View = plugin.View;
  return <section className="todo-view-host"><div className="todo-view-toolbar"><div className="segments" aria-label="事项显示方式">{registry.list().map(entry => <button key={entry.manifest.id} aria-pressed={plugin.manifest.id === entry.manifest.id} className={plugin.manifest.id === entry.manifest.id ? 'active' : ''} onClick={() => choose(entry.manifest.id)}>{entry.manifest.id === OFFICIAL_TODO_VIEW ? <List size={15}/> : <Columns3 size={15}/>} {entry.manifest.name}</button>)}</div>
    {registry === todoViews && plugin.manifest.id === todoBoard.manifest.id && <button className="icon-text" onClick={() => { uninstallBoard(); choose(OFFICIAL_TODO_VIEW); }}>停用示例插件</button>}
    {registry === todoViews && !registry.list().some(entry => entry.manifest.id === todoBoard.manifest.id) && <button className="icon-text" onClick={() => { uninstallBoard = todoViews.register(todoBoard); choose(todoBoard.manifest.id); }}>启用轻看板</button>}
  </div><ViewBoundary key={`${plugin.manifest.id}:${registry.snapshot()}`} fallback={<><div className="notice" role="alert">这个视图暂时无法显示，已恢复官方列表。<button className="inline-action" onClick={() => choose(OFFICIAL_TODO_VIEW)}><RotateCcw size={13}/>使用官方列表</button></div><Official {...props}/></>}><View {...props}/></ViewBoundary></section>;
}

import { Check, ChevronRight, Circle, Clock3, LoaderCircle } from 'lucide-react';
import type { TodoViewPlugin } from './todo-contract';
export const todoStatusLabels: Record<string, string> = { suggested: '待确认', pending: '待处理', in_progress: '进行中', waiting: '待跟进', completed: '已完成', dismissed: '已忽略' };
export const todoKindLabels: Record<string, string> = { general: '日常', communication: '沟通', learning: '学习', exercise: '运动', errand: '办事', reading: '阅读', expense: '支出' };
export function todoDate(input: string) { const date = new Date(input); return Number.isNaN(date.getTime()) ? input : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
export const officialTodos: TodoViewPlugin = {
  manifest: { id: 'official.todos', name: '官方列表', version: '1.0.0', apiVersion: 1, slot: 'todos.view' },
  View: ({ items, busyId, onOpen, onToggle }) => <div className="todo-table"><div className="todo-table-header"><span>事项</span><span>来源 / 分类</span><span>状态</span></div>{items.map(item => <div className={`todo-row ${item.status === 'completed' ? 'completed' : ''}`} key={item.id}>
    <button className="todo-check" aria-label={`${item.status === 'completed' ? '恢复' : '完成'}事项：${item.title}`} disabled={!!busyId} onClick={() => onToggle(item.id)}>{busyId === item.id ? <LoaderCircle className="spin" size={19}/> : item.status === 'completed' ? <Check size={17}/> : <Circle size={21}/>}</button>
    <button className="todo-main" onClick={() => onOpen(item.id)}><strong>{item.title}</strong>{item.description && <small>{item.description}</small>}{item.due_at && <span className="due-label"><Clock3 size={12}/>{todoDate(item.due_at)}</span>}</button>
    <div className="todo-origin"><span>{item.source_label || (item.source_kind === 'manual' ? '手动添加' : item.source_kind)}</span><small>{todoKindLabels[item.kind] ?? '日常'}</small></div>
    <span className={`status-pill ${item.status}`}>{todoStatusLabels[item.status] ?? item.status}</span><button className="icon-button" aria-label={`查看事项：${item.title}`} onClick={() => onOpen(item.id)}><ChevronRight size={17}/></button>
  </div>)}</div>,
};

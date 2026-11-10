import { Check, Circle, Clock3, LoaderCircle } from 'lucide-react';
import type { TodoViewPlugin } from '../todo-contract';
import { todoKindLabels, todoDate, todoStatusLabels } from '../official-todos';

/** Example replacement: the host owns fetching, mutations, pagination and detail dialogs. */
export const todoBoard: TodoViewPlugin = {
  manifest: { id: 'example.todo-board', name: '轻看板', version: '1.0.0', apiVersion: 1, slot: 'todos.view' },
  View({ items, busyId, onOpen, onToggle }) {
    const groups = [
      { id: 'ready', title: '接下来', hint: '从一件小事开始', match: (status: string) => ['pending', 'suggested'].includes(status) },
      { id: 'progress', title: '在路上', hint: '正在做，或等一个回应', match: (status: string) => ['in_progress', 'waiting'].includes(status) },
      { id: 'done', title: '已收好', hint: '每一步都有意义', match: (status: string) => ['completed', 'dismissed'].includes(status) },
    ];
    return <div className="todo-plugin-board" aria-label="轻看板事项视图">{groups.map(group => {
      const rows = items.filter(item => group.match(item.status));
      return <section key={group.id} className={`todo-board-column ${group.id}`} aria-label={group.title}>
        <header><h3>{group.title}<span>{rows.length}</span></h3><p>{group.hint}</p></header>
        {rows.map(item => <article key={item.id} className={`todo-board-card ${item.status}`}>
          <div className="todo-board-card-top"><span>{item.source_label || (item.source_kind === 'manual' ? '手动添加' : item.source_kind)}</span><small>{todoKindLabels[item.kind]}</small></div>
          <button className="todo-board-open" aria-label={`查看事项：${item.title}`} onClick={() => onOpen(item.id)}><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}</button>
          <footer><span>{item.due_at ? <><Clock3 size={12}/>{todoDate(item.due_at)}</> : todoStatusLabels[item.status]}</span><button className="todo-board-complete" aria-label={`${item.status === 'completed' ? '恢复' : '完成'}事项：${item.title}`} disabled={!!busyId} onClick={() => onToggle(item.id)}>{busyId === item.id ? <LoaderCircle className="spin" size={16}/> : item.status === 'completed' ? <Check size={16}/> : <Circle size={17}/>}</button></footer>
        </article>)}
        {!rows.length && <p className="todo-board-empty">这里暂时没有事项</p>}
      </section>;
    })}</div>;
  },
};

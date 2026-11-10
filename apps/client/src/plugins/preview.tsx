/** Isolated, synthetic preview of the same plugin host used by TodosView. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, X } from 'lucide-react';
import type { Todo } from '@tada/client-core';
import { Orb } from '../Auth';
import { TodoViewHost } from './TodoViewHost';
import '../styles.css';

const rows = [
  { title: '确认客户的新交付时间', description: '客户希望周五前收到新版方案。先核对安排，再回复一个明确的时间。', kind: 'communication', source_kind: 'email', source_label: '客户邮件', status: 'pending' },
  { title: '读懂 Rust 的借用规则', description: '花 15 分钟看完一个示例，试着用自己的话解释。', kind: 'learning', source_kind: 'conversation', source_label: '来自对话', status: 'pending', estimated_minutes: 15 },
  { title: '晚饭后走一小段路', description: '不用凑步数，出门透透气就很好。', kind: 'exercise', source_kind: 'manual', source_label: '手动添加', status: 'pending', estimated_minutes: 20 },
  { title: '整理方案里需要确认的两件事', description: '交付范围和验收口径已经记好，等客户回复。', kind: 'communication', source_kind: 'email', source_label: '客户邮件', status: 'waiting' },
  { title: '给这周的学习做个小结', description: '写下一个新理解，和一个还想弄明白的问题。', kind: 'learning', source_kind: 'conversation', source_label: '来自对话', status: 'in_progress' },
  { title: '预约周末的羽毛球场', description: '周六下午，约上老朋友。', kind: 'exercise', source_kind: 'manual', source_label: '手动添加', status: 'completed' },
].map((row, index) => ({ ...row, id: `demo-${index}`, version: 1, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z' } as Todo));
function Preview() {
  const [items, setItems] = useState(rows); const [selected, setSelected] = useState<Todo | null>(null);
  const toggle = (item: Todo) => { setItems(current => current.map(row => row.id === item.id ? { ...row, status: row.status === 'completed' ? 'pending' : 'completed' } : row)); setSelected(null); };
  return <main style={{ minHeight: '100vh', overflow: 'auto', padding: '36px clamp(20px, 5vw, 80px)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 48 }}><Orb/><strong style={{ fontSize: 24 }}>妥啦</strong><span style={{ fontSize: 12, color: '#9ba7bd' }}>事项 · 交互演示</span></div>
    <div className="page-title"><div><div className="eyebrow">让每个下一步，都清楚一点</div><h2>今天，慢慢做好几件事</h2><p>同一份事项，换一种适合你的看法。</p></div><span className="status-pill completed"><Check size={13}/> {items.filter(item => item.status === 'completed').length} 件已完成</span></div>
    <TodoViewHost items={items} busyId={null} onOpen={setSelected} onToggle={toggle}/>
    <p style={{ marginTop: 28, fontSize: 12, color: '#99a5bb' }}>这里使用演示资料。正式事项页面已接入相同视图切换，操作会保存到当前服务器。</p>
    {selected && <div className="drawer-overlay" onClick={() => setSelected(null)}><aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="事项详情" onClick={event => event.stopPropagation()}><div className="drawer-top"><div className="eyebrow">{selected.source_label}</div><button className="icon-button" aria-label="关闭事项详情" onClick={() => setSelected(null)}><X size={20}/></button></div><h2>{selected.title}</h2><p style={{ lineHeight: 1.9 }}>{selected.description}</p><button className="primary" onClick={() => toggle(selected)}><Check size={16}/>{selected.status === 'completed' ? '恢复为待处理' : '标记完成'}</button></aside></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);

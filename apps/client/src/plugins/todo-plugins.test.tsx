import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Todo } from '@tada/client-core';
import { TodoViewRegistry, type TodoViewPlugin, type TodoViewProps } from './todo-contract';
import { officialTodos } from './official-todos';
import { todoBoard } from './examples/todo-board';
import { TodoViewHost } from './TodoViewHost';

const item: Todo = { id: 'one', title: '回复客户新要求', description: '核对时间后准备回复', source_kind: 'email',
  source_label: '客户邮件', kind: 'communication', status: 'pending', version: 1,
  created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', draft: '私密草稿不直接暴露给视图', source_excerpt: '邮件原文' };
beforeEach(() => localStorage.clear());
function registry() { const value = new TodoViewRegistry(officialTodos); const disable = value.register(todoBoard); return { value, disable }; }
describe('replaceable Todo view', () => {
  it('switches renderer, opens the existing detail and completes through host actions', () => {
    const { value } = registry(); const open = vi.fn(); const toggle = vi.fn();
    const { rerender } = render(<TodoViewHost items={[item]} busyId={null} onOpen={open} onToggle={toggle} registry={value}/>);
    fireEvent.click(screen.getByRole('button', { name: '轻看板' }));
    expect(screen.getByLabelText('轻看板事项视图')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `查看事项：${item.title}` })); expect(open).toHaveBeenCalledWith(item);
    fireEvent.click(screen.getByRole('button', { name: `完成事项：${item.title}` })); expect(toggle).toHaveBeenCalledWith(item);
    rerender(<TodoViewHost items={[{ ...item, status: 'completed' }]} busyId={null} onOpen={open} onToggle={toggle} registry={value}/>);
    expect(screen.getByRole('button', { name: `恢复事项：${item.title}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '官方列表' })); expect(screen.queryByLabelText('轻看板事项视图')).toBeNull();
    expect(screen.getByText(item.title)).toBeTruthy();
  });
  it('resolves an unavailable persisted plugin to official, and cannot uninstall official', () => {
    localStorage.setItem('tada.todo-view.v1', todoBoard.manifest.id);
    const { value, disable } = registry(); disable(); disable();
    expect(value.resolve(todoBoard.manifest.id).manifest.id).toBe(officialTodos.manifest.id);
    render(<TodoViewHost items={[item]} busyId={null} onOpen={vi.fn()} onToggle={vi.fn()} registry={value}/>);
    expect(screen.getByRole('button', { name: '官方列表' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('rejects duplicate/unsupported contracts and projects immutable data without API or credentials', () => {
    const { value } = registry(); expect(() => value.register(todoBoard)).toThrow('Duplicate');
    expect(() => value.register({ ...todoBoard, manifest: { ...todoBoard.manifest, apiVersion: 2 } } as unknown as TodoViewPlugin)).toThrow('Unsupported');
    const toggle = vi.fn(); const open = vi.fn();
    const spy = vi.fn((props: TodoViewProps) => {
      expect(Object.isFrozen(props.items)).toBe(true); expect(Object.isFrozen(props.items[0])).toBe(true);
      expect(props.items[0]).not.toHaveProperty('draft'); expect(props.items[0]).not.toHaveProperty('source_excerpt');
      expect(props).not.toHaveProperty('api'); expect(props).not.toHaveProperty('token');
      return <button onClick={() => { props.onOpen('unloaded'); props.onToggle('unloaded'); props.onToggle(item.id); }}>尝试操作</button>;
    });
    value.register({ manifest: { ...todoBoard.manifest, id: 'example.inspect', name: '检查视图' }, View: spy });
    render(<TodoViewHost items={[item]} busyId={item.id} onOpen={open} onToggle={toggle} registry={value}/>);
    fireEvent.click(screen.getByRole('button', { name: '检查视图' })); fireEvent.click(screen.getByText('尝试操作'));
    expect(spy).toHaveBeenCalled(); expect(toggle).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it('a crashing plugin falls back to the functioning official view', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { value } = registry(); value.register({ manifest: { ...todoBoard.manifest, id: 'example.crash', name: '故障视图' }, View() { throw new Error('fixture'); } });
      render(<TodoViewHost items={[item]} busyId={null} onOpen={vi.fn()} onToggle={vi.fn()} registry={value}/>);
      fireEvent.click(screen.getByRole('button', { name: '故障视图' }));
      expect(screen.getByRole('alert').textContent).toContain('已恢复官方列表'); expect(screen.getByText(item.title)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '使用官方列表' })); expect(screen.queryByRole('alert')).toBeNull();
    } finally { errors.mockRestore(); }
  });
});

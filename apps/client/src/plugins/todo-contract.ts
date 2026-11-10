import type { ComponentType } from 'react';
import type { Todo } from '@tada/client-core';

export type TodoViewItem = Readonly<Pick<Todo, 'id' | 'title' | 'description' | 'kind' | 'status' | 'source_kind' | 'source_label' | 'due_at' | 'estimated_minutes'>>;
export type TodoViewProps = Readonly<{
  items: readonly TodoViewItem[];
  busyId: string | null;
  onOpen(id: string): void;
  onToggle(id: string): void;
}>;
export interface TodoViewPlugin {
  readonly manifest: Readonly<{ id: string; name: string; version: string; apiVersion: 1; slot: 'todos.view' }>;
  readonly View: ComponentType<TodoViewProps>;
}
export const OFFICIAL_TODO_VIEW = 'official.todos';

/** Only trusted bundled modules are supported. This registry is not a JS sandbox. */
export class TodoViewRegistry {
  private plugins = new Map<string, TodoViewPlugin>();
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(official: TodoViewPlugin) {
    if (official.manifest.id !== OFFICIAL_TODO_VIEW) throw new Error('Official view required');
    this.register(official);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private changed() { this.revision++; for (const listener of this.listeners) listener(); }
  register(plugin: TodoViewPlugin) {
    const m = { ...plugin.manifest };
    if (m.apiVersion !== 1 || m.slot !== 'todos.view' || !/^[a-z][a-z0-9.-]{2,80}$/.test(m.id) || !m.name.trim() || !m.version.trim()) {
      throw new Error('Unsupported todo view manifest');
    }
    if (this.plugins.has(m.id)) throw new Error('Duplicate todo view');
    const registered = Object.freeze({ manifest: Object.freeze({ ...m }), View: plugin.View });
    this.plugins.set(m.id, registered); this.changed();
    return () => {
      if (m.id === OFFICIAL_TODO_VIEW || this.plugins.get(m.id) !== registered) return;
      this.plugins.delete(m.id); this.changed();
    };
  }
  list() { return [...this.plugins.values()]; }
  resolve(id: string) { return this.plugins.get(id) ?? this.plugins.get(OFFICIAL_TODO_VIEW)!; }
}

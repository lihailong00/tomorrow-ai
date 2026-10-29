export type TodoKind =
  | 'general'
  | 'communication'
  | 'learning'
  | 'exercise'
  | 'errand'
  | 'reading'
  | 'expense';
export type TodoStatus =
  | 'suggested'
  | 'pending'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'dismissed';
export type Todo = {
  id: string;
  title: string;
  description: string;
  kind: TodoKind;
  status: TodoStatus;
  source_kind: string;
  source_label: string;
  source_id?: string | null;
  source_excerpt?: string | null;
  due_at?: string | null;
  estimated_minutes?: number | null;
  draft?: string | null;
  progress_notes?: string | null;
  linked_task_id?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  version: number;
};
export type TodoPage = { items: Todo[]; next_offset: number | null };
export type TodoFilter =
  | 'active'
  | 'waiting'
  | 'completed'
  | 'suggested'
  | 'all';
export type TodoScope = 'today' | 'all';
export type CreateTodo = {
  title: string;
  description?: string;
  kind?: TodoKind;
  due_at?: string | null;
  estimated_minutes?: number | null;
  client_request_id?: string;
};
export type UpdateTodo = Partial<
  Pick<
    Todo,
    | 'title'
    | 'description'
    | 'kind'
    | 'due_at'
    | 'estimated_minutes'
    | 'draft'
    | 'progress_notes'
    | 'status'
  >
> & { version: number };
export type ExtractTodo = {
  source_kind: 'conversation' | 'integration_import';
  source_id: string;
  client_request_id?: string;
};

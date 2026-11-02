/** Wire DTOs follow the deployed Rust v1 API; names remain snake_case. */
export interface User { id: string; email: string; phone?: string | null; name: string; timezone: string; created_at: string }
export interface AuthSession { token: string; user: User }
export interface PagedItems<T> { items: T[]; next_offset?: number | null }
export interface PageOptions { offset?: number; limit?: number }
export interface InstanceManifest {
  id: string; name: string; deployment_mode: 'official' | 'self_hosted'; api_version: 1;
  auth_methods: Array<'phone_password' | 'email_password'>;
  registration_policy: 'open' | 'invite_only' | 'closed'; public_url: string;
  dataflow: Record<string, string | { processor: string; destination: string | null }>;
  configuration_revision?: number;
}
export interface Conversation { id: string; title: string; updated_at: string }
export interface MessageAttachment { upload_id: string; name: string; mime_type: string; size: number; unavailable?: boolean }
export interface Message {
  id: string; conversation_id: string; role: string; content: string; created_at: string;
  model_mode?: string | null; attachments?: MessageAttachment[];
}
export interface MessagePage extends PagedItems<Message> { next_before?: string | null }
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max';
export interface ChatIntent {
  message: string; conversation_id: string | null; client_request_id: string;
  remember: boolean; upload_ids: readonly string[]; replace_message_id?: string;
  reasoning_effort?: ReasoningEffort;
}
export interface ChatResponse {
  conversation_id: string; message: Message; user_message?: Message | null;
  agent_run_id?: string; removed_message_ids?: string[];
}
export interface ChatStreamEvent { id: number; event: string; data: Record<string, unknown> }
export type MemoryKind = 'preference' | 'person' | 'project' | 'goal' | 'fact';
export interface Memory {
  id: string; title: string; content: string; kind: string; source: string;
  created_at: string; updated_at: string; version: number;
}
export interface SaveMemory {
  title?: string; content: string; kind: MemoryKind; source?: string;
  version?: number; client_request_id?: string;
}
export type TodoKind = 'general' | 'communication' | 'learning' | 'exercise' | 'errand' | 'reading' | 'expense';
export type TodoStatus = 'suggested' | 'pending' | 'in_progress' | 'waiting' | 'completed' | 'dismissed';
export type TodoFilter = 'active' | 'waiting' | 'completed' | 'suggested' | 'all';
export interface Todo {
  id: string; title: string; description: string; kind: TodoKind; status: TodoStatus;
  source_kind: string; source_label: string; source_id?: string | null; source_excerpt?: string | null;
  due_at?: string | null; estimated_minutes?: number | null; draft?: string | null;
  progress_notes?: string | null; linked_task_id?: string | null;
  created_at: string; updated_at: string; completed_at?: string | null; version: number;
}
export interface CreateTodo {
  title: string; description?: string; kind?: TodoKind; due_at?: string | null;
  estimated_minutes?: number | null; client_request_id?: string;
}
export type UpdateTodo = Partial<Pick<Todo, 'title' | 'description' | 'kind' | 'due_at' | 'estimated_minutes' | 'draft' | 'progress_notes' | 'status'>> & { version: number };
export interface Task {
  id: string; title: string; instruction: string; kind: string; status: string; progress: number;
  summary?: string | null; result?: string | null; error?: string | null;
  created_at: string; updated_at: string;
  steps: Array<{ id: string; title: string; status: string; detail?: string | null }>;
  model_mode: string; approval_required: boolean; approved_at?: string | null; artifact_id?: string | null;
}
export interface Today {
  date: string; greeting: string; briefing: string; tasks: Task[]; memories: Memory[];
  schedules: Array<{ id: string; title: string; next_run_at: string; enabled: boolean }>;
  notifications: Array<{ id: string; title: string; body: string; read: boolean }>;
  stats: { tasks_completed: number; active_routines: number; memory_count: number; active_tasks?: number; unread_notifications?: number };
  runtime: { agent_harness: string; model_mode: string; model_name?: string | null; scheduler_mode: string; storage_mode: string };
}

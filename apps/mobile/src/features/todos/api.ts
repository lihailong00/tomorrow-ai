import { ApiClient, ApiError } from '../../api/client';
import type {
  CreateTodo,
  ExtractTodo,
  Todo,
  TodoFilter,
  TodoPage,
  TodoScope,
  UpdateTodo,
} from './types';

// Older servers must show an explicit upgrade error, never a false empty list.
async function request<T>(
  api: ApiClient,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  try {
    return await api.request<T>(path, method, body);
  } catch (error) {
    if (error instanceof ApiError && [404, 405, 501].includes(error.status)) {
      throw new ApiError(
        'todos_unsupported',
        '当前服务暂不支持这项事项操作，请更新服务后重试。',
        error.status,
      );
    }
    throw error;
  }
}
const path = (id: string) => '/todos/' + encodeURIComponent(id);
export function listTodos(
  api: ApiClient,
  input: {
    filter: TodoFilter;
    scope: TodoScope;
    offset: number;
    limit?: number;
  },
) {
  return request<TodoPage>(
    api,
    '/todos?' +
      Object.entries({ ...input, limit: input.limit ?? 50 })
        .map(([k, v]) => k + '=' + encodeURIComponent(v))
        .join('&'),
  );
}
export const getTodo = (api: ApiClient, id: string) =>
  request<Todo>(api, path(id));
export const createTodo = (api: ApiClient, input: CreateTodo) =>
  request<Todo>(api, '/todos', 'POST', input);
export const updateTodo = (api: ApiClient, id: string, input: UpdateTodo) =>
  request<Todo>(api, path(id), 'PATCH', input);
export const prepareTodo = (
  api: ApiClient,
  id: string,
  client_request_id: string,
) => request<Todo>(api, path(id) + '/prepare', 'POST', { client_request_id });
export const extractTodos = (api: ApiClient, input: ExtractTodo) =>
  request<{ items: Todo[]; created_count: number }>(
    api,
    '/todos/extract',
    'POST',
    input,
  );

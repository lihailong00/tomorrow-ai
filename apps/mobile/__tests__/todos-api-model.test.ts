import { ApiClient } from '../src/api/client';
import {
  createTodo,
  extractTodos,
  listTodos,
  prepareTodo,
  updateTodo,
} from '../src/features/todos/api';
import {
  localDue,
  nextAction,
  parseDue,
  validateMinutes,
} from '../src/features/todos/model';
import type { Todo } from '../src/features/todos/types';

const response = (data: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
  } as Response);
it('serializes bounded account-scoped todo pages, explicit null patches and real source ids', async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue(response({ items: [], next_offset: null }));
  const api = new ApiClient(
    'https://api.example.com',
    'owner-token',
    undefined,
    fetcher,
  );
  await listTodos(api, {
    filter: 'active',
    scope: 'today',
    offset: 100,
    limit: 50,
  });
  await createTodo(api, {
    title: '跑步',
    kind: 'exercise',
    client_request_id: 'one-intent',
  });
  await updateTodo(api, 'id/a', {
    version: 2,
    due_at: null,
    draft: null,
    progress_notes: '实际进展',
  });
  await prepareTodo(api, 'id/a', 'prepare-one');
  await extractTodos(api, {
    source_kind: 'integration_import',
    source_id: 'real-import',
    client_request_id: 'extract-one',
  });
  expect(fetcher.mock.calls[0][0]).toBe(
    'https://api.example.com/v1/todos?filter=active&scope=today&offset=100&limit=50',
  );
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe(
    'Bearer owner-token',
  );
  expect(fetcher.mock.calls[2][0]).toBe(
    'https://api.example.com/v1/todos/id%2Fa',
  );
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({
    version: 2,
    due_at: null,
    draft: null,
    progress_notes: '实际进展',
  });
  expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual({
    source_kind: 'integration_import',
    source_id: 'real-import',
    client_request_id: 'extract-one',
  });
});
it('reports unsupported old servers instead of presenting an empty list', async () => {
  const api = new ApiClient(
    'https://api.example.com',
    undefined,
    undefined,
    jest.fn().mockResolvedValue(response({}, 404)),
  );
  await expect(
    listTodos(api, { filter: 'active', scope: 'all', offset: 0 }),
  ).rejects.toMatchObject({
    code: 'todos_unsupported',
    message: expect.stringContaining('更新服务'),
  });
});
it('allows a slow real extraction up to the 120 second deadline without retry', async () => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const fetcher = jest.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(response({ items: [], created_count: 0 })),
          90000,
        );
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const api = new ApiClient(
      'https://api.example.com',
      undefined,
      undefined,
      fetcher,
    );
    const result = extractTodos(api, {
      source_kind: 'conversation',
      source_id: 'stored-conversation',
    });
    await jest.advanceTimersByTimeAsync(21000);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(69000);
    await expect(result).resolves.toEqual({ items: [], created_count: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
it('round trips account-local due times across time zones and rejects impossible dates', () => {
  expect(parseDue('2026-10-29 19:00', 'Asia/Shanghai')).toBe(
    '2026-10-29T11:00:00.000Z',
  );
  expect(localDue('2026-10-29T11:00:00Z', 'Asia/Shanghai')).toBe(
    '2026-10-29 19:00',
  );
  expect(() => parseDue('2026-03-08 02:30', 'America/New_York')).toThrow();
});
it('rejects invalid duration and never presents a prepared communication as sent', () => {
  expect(validateMinutes('')).toBeNull();
  expect(validateMinutes('360')).toBe(360);
  for (const invalid of ['0', '361', '1000', '1.5', '-1', '3a'])
    expect(() => validateMinutes(invalid)).toThrow('1–360');
  const todo = {
    kind: 'communication',
    status: 'pending',
    draft: '真实草稿',
  } as Todo;
  expect(nextAction(todo)).toBe('审阅');
  expect(() => parseDue('2026-02-30 09:00', 'UTC')).toThrow();
});

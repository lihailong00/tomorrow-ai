import { ApiClient } from '../src/api/client';

const response = (data: unknown) => ({
  ok: true, status: 200, text: async () => JSON.stringify(data),
} as Response);

test('image preparation allows a real slow vision response and never retries automatically', async () => {
  jest.useFakeTimers();
  try {
    let requestSignal!: AbortSignal;
    const fetcher = jest.fn((_url, init) => {
      requestSignal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(response({ upload_id: 'photo', name: '日程.png', text: '九点读书', model: 'test-vision' })), 85000);
        requestSignal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    });
    const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
    const result = api.analyzeImage('photo');
    await jest.advanceTimersByTimeAsync(21000);
    expect(requestSignal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(64000);
    await expect(result).resolves.toMatchObject({ upload_id: 'photo', text: '九点读书' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://self.example/v1/uploads/photo/analyze');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

test('switching servers disposes a pending analysis without retrying on another host', async () => {
  const fetcher = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  const result = api.analyzeImage('photo').catch(error => error);
  api.dispose();
  expect(await result).toMatchObject({ code: 'connection_changed' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('explicit image preparation cancellation is distinct from a timeout', async () => {
  const controller = new AbortController();
  const fetcher = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  const result = api.analyzeImage('photo', controller.signal).catch(error => error);
  controller.abort();
  expect(await result).toMatchObject({ code: 'cancelled' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('deleting a turn encodes both IDs and returns the actual removed IDs', async () => {
  const fetcher = jest.fn().mockResolvedValue(response({ removed_message_ids: ['u', 'a'] }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  await expect(api.deleteMessage('chat/a', 'msg b')).resolves.toEqual({ removed_message_ids: ['u', 'a'] });
  expect(fetcher.mock.calls[0][0]).toBe('https://self.example/v1/conversations/chat%2Fa/messages/msg%20b');
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
});

test('ordinary sends retain the old wire shape; edited sends carry an explicit target', async () => {
  const fetcher = jest.fn().mockResolvedValue(response({ conversation_id: 'c', message: {} }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  await api.chat('hello', 'c', 'new', []);
  await api.chat('edited', 'c', 'edit', ['photo'], 'original-user');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ message: 'hello', conversation_id: 'c', client_request_id: 'new', remember: false, upload_ids: [] });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ replace_message_id: 'original-user', client_request_id: 'edit', upload_ids: ['photo'] });
});

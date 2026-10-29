import { ApiClient } from '../src/api/client';

it('waits for bounded MCP validation beyond the general deadline and never retries the credential request', async () => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const fetcher = jest.fn((_url: RequestInfo, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, status: 200,
          text: async () => JSON.stringify({ status: 'connected' }) } as Response), 31000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    });
    const api = new ApiClient('https://api.example.test', 'session', undefined, fetcher);
    const pending = api.request('/personal-mcp/didi/connect', 'POST', { token: 'synthetic-test-only' });
    await jest.advanceTimersByTimeAsync(21000);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(10000);
    await expect(pending).resolves.toEqual({ status: 'connected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

it('times out a lost MCP confirmation once without an automatic second execution', async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest.fn((_url: RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const api = new ApiClient('https://api.example.test', 'session', undefined, fetcher);
    const pending = api.request('/personal-mcp/actions/action/confirm', 'POST', {}).catch(error => error);
    await jest.advanceTimersByTimeAsync(50000);
    expect(await pending).toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

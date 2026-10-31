import { ApiClient } from '../src/api/client';

it.each(['sync', 'finalize'])('allows bounded health %s to finish after general request timeout', async operation => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const fetcher = jest.fn((_url: RequestInfo, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, status: 200,
          text: async () => JSON.stringify({ connected: true }) } as Response), 75000);
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    });
    const api = new ApiClient('https://own.test', 'session', undefined, fetcher);
    const pending = api.request('/health/connections/huawei/' + operation, 'POST', {});
    await jest.advanceTimersByTimeAsync(21000);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(54000);
    await expect(pending).resolves.toEqual({ connected: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

it('a lost health confirmation times out once and never automatically retries a consumed receipt', async () => {
  jest.useFakeTimers();
  try {
    const fetcher = jest.fn((_url: RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const api = new ApiClient('https://own.test', 'session', undefined, fetcher);
    const pending = api.request('/health/connections/xiaomi/finalize', 'POST', {}).catch(error => error);
    await jest.advanceTimersByTimeAsync(85000);
    expect(await pending).toMatchObject({ code: 'timeout' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { jest.clearAllTimers(); jest.useRealTimers(); }
});

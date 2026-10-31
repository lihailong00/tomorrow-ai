import { ApiClient } from '../src/api/client';
import { createInstanceIdentityGuard, inspectInstance } from '../src/api/instance';
import type { InstanceManifest } from '../src/domain/instance';

const manifest: InstanceManifest = {
  id: 'original-instance', name: '私有测试服务器', deployment_mode: 'self_hosted', api_version: 1,
  auth_methods: ['email_password'], registration_policy: 'open', public_url: '',
  dataflow: { conversation: '当前服务器', voice: '未启用', images: '未启用', files: '当前服务器' },
};
const response = (data: unknown, extra = {}) => ({
  ok: true, status: 200, redirected: false, url: 'https://own.test/v1/instance',
  text: async () => JSON.stringify(data), ...extra,
} as Response);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function setup(fetcher: typeof fetch) {
  const guard = createInstanceIdentityGuard('https://own.test', { expectedId: manifest.id, fetcher });
  const accounts = jest.fn().mockResolvedValue(response({ items: [], ok: true }));
  const api = new ApiClient('https://own.test', 'synthetic-session', undefined, accounts, guard.verify);
  return { guard, accounts, api };
}

describe('fresh instance identity guard', () => {
  it('keeps the exact identity URL through the actual React Native fetch Request polyfill', async () => {
    const { Request: NativeRequest } = require('whatwg-fetch') as { Request: typeof Request };
    const fetcher = jest.fn(async (url: string, init: RequestInit) => {
      const nativeRequest = new NativeRequest(url, init);
      expect(nativeRequest.headers.get('cache-control')).toBe('no-cache, no-store');
      expect(nativeRequest.headers.get('authorization')).toBeNull();
      return response(manifest, { url: nativeRequest.url });
    });
    const result = await inspectInstance('https://own.test', { expectedId: manifest.id, fetcher: fetcher as typeof fetch });
    expect(result.instance.id).toBe(manifest.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares only the in-flight anonymous check and rechecks later polling and commands', async () => {
    const pending = deferred<Response>();
    let current = manifest;
    const fetcher = jest.fn().mockImplementationOnce(() => pending.promise)
      .mockImplementation(async () => response(current));
    const { api, accounts } = setup(fetcher);
    const poll = api.notifications();
    const command = api.createTask('synthetic task', true, 'synthetic-action');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(accounts).not.toHaveBeenCalled();
    pending.resolve(response(manifest));
    await Promise.all([poll, command]);
    expect(accounts).toHaveBeenCalledTimes(2);
    await api.notifications();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(accounts).toHaveBeenCalledTimes(3);

    // The URL is unchanged, but a fresh process/database has another ID.
    current = { ...manifest, id: 'replacement-instance' };
    const rejected = await Promise.allSettled([
      api.notifications(), api.createTask('queued synthetic task', true, 'another-action'),
      api.login('synthetic@example.test', 'synthetic-password'),
    ]);
    expect(rejected.every(result => result.status === 'rejected' &&
      result.reason.message.includes('身份已变化'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(accounts).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetcher.mock.calls) {
      expect(url).toBe('https://own.test/v1/instance');
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' } });
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  });

  it('invalidates an old background check before foreground work, even if fetch ignores abort', async () => {
    const oldCheck = deferred<Response>();
    const fetcher = jest.fn().mockImplementationOnce(() => oldCheck.promise)
      .mockResolvedValue(response({ ...manifest, id: 'replacement-instance' }));
    const { api, accounts, guard } = setup(fetcher);
    const queued = api.createTask('synthetic queued task', true, 'queued-action').catch(error => error);
    const oldSignal = fetcher.mock.calls[0][1].signal as AbortSignal;
    // App's foreground listener invalidates before its notification listener.
    guard.invalidate();
    expect(oldSignal.aborted).toBe(true);
    await expect(api.notifications()).rejects.toThrow('身份已变化');
    // A late original-instance reply must not release the pre-background command.
    oldCheck.resolve(response(manifest));
    expect(await queued).toMatchObject({ message: '服务器连接已变化，请重新操作。' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(accounts).not.toHaveBeenCalled();
  });

  it('clears a failed check so reconnection is checked again without any credential fallback', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(response(manifest));
    const { api, accounts } = setup(fetcher);
    await expect(api.notifications()).rejects.toThrow('不会切换');
    expect(accounts).not.toHaveBeenCalled();
    await api.notifications();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(accounts).toHaveBeenCalledTimes(1);
  });

  it.each([
    { redirected: true },
    { url: 'https://other.test/v1/instance' },
    { url: 'https://own.test/v1/instance/other' },
    { status: 302, ok: false },
    { status: 307, ok: false },
  ])('blocks a redirected identity response before sending credentials: %j', async extra => {
    const fetcher = jest.fn().mockResolvedValue(response(manifest, extra));
    const { api, accounts } = setup(fetcher);
    await expect(api.login('synthetic@example.test', 'synthetic-password')).rejects.toBeInstanceOf(Error);
    expect(accounts).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });

  it('does not send a request disposed while waiting for identity verification', async () => {
    const pending = deferred<Response>();
    const { api, accounts } = setup(jest.fn().mockReturnValue(pending.promise));
    const queued = api.notifications();
    api.dispose();
    pending.resolve(response(manifest));
    await expect(queued).rejects.toMatchObject({ code: 'connection_changed' });
    expect(accounts).not.toHaveBeenCalled();
  });

  it('does not send an upload cancelled before or during identity verification', async () => {
    const pending = deferred<Response>();
    const fetcher = jest.fn().mockReturnValue(pending.promise);
    const { api, accounts } = setup(fetcher);
    const controller = new AbortController();
    const queued = api.request('/uploads', 'POST', { synthetic: true }, controller.signal);
    controller.abort();
    pending.resolve(response(manifest));
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' });
    await expect(api.request('/uploads', 'POST', {}, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(accounts).not.toHaveBeenCalled();
  });

  it('cannot reuse a disposed guard, including a late native response', async () => {
    const pending = deferred<Response>();
    const { api, accounts, guard } = setup(jest.fn().mockReturnValue(pending.promise));
    const queued = api.notifications();
    guard.dispose();
    pending.resolve(response(manifest));
    await expect(queued).rejects.toThrow('连接已变化');
    await expect(api.notifications()).rejects.toThrow('连接已变化');
    expect(accounts).not.toHaveBeenCalled();
  });

  it('keeps the anonymous inspector independent from account fetch defaults', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(manifest));
    await inspectInstance('https://own.test', { expectedId: manifest.id, fetcher });
    expect(Object.keys(fetcher.mock.calls[0][1].headers).sort()).toEqual(['Accept', 'Cache-Control', 'Pragma']);
  });
});

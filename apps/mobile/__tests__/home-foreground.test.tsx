import React from 'react';
import { Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { createInstanceIdentityGuard } from '../src/api/instance';
import { AppContextValue, AppProvider } from '../src/app/context';
import type { InstanceManifest } from '../src/domain/instance';
import type { Today } from '../src/domain/types';
import { platform } from '../src/platform/ports';
import { HomeScreen } from '../src/screens/Main';
import { ErrorNotice, Loading } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: { onForeground: jest.fn() },
}));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));

const listeners = new Set<() => void>();
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  listeners.clear();
  jest.mocked(platform.onForeground).mockImplementation(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
});

const manifest: InstanceManifest = {
  id: 'home-original-instance',
  name: 'Home recovery test server',
  deployment_mode: 'self_hosted',
  api_version: 1,
  auth_methods: ['email_password'],
  registration_policy: 'open',
  public_url: '',
  dataflow: {
    conversation: '当前服务器',
    voice: '未启用',
    images: '未启用',
    files: '当前服务器',
  },
};
const today: Today = {
  date: '2026-10-30',
  greeting: '你好',
  briefing: '重新校验后读取的今日简报',
  tasks: [],
  schedules: [],
  memories: [],
  notifications: [],
  stats: {
    tasks_completed: 0,
    active_routines: 0,
    memory_count: 0,
    active_tasks: 0,
    unread_notifications: 0,
  },
  runtime: {
    model_mode: 'local',
    scheduler_mode: 'local',
    storage_mode: 'sqlite',
  },
};
function response(data: unknown, path = '/instance'): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: 'https://home.test/v1' + path,
    text: async () => JSON.stringify(data),
  } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const errors = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(ErrorNotice)
    .map(node => node.props.message)
    .filter(Boolean);
const text = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .map(node => [node.props.children].flat().join(''))
    .join(' ');
async function mount(
  anonymous: typeof fetch,
  accounts: typeof fetch,
  invalidateFirst = true,
) {
  const guard = createInstanceIdentityGuard('https://home.test', {
    expectedId: manifest.id,
    fetcher: anonymous,
  });
  // Exercise both parent-first and child-first effect subscription orders.
  let unsubscribe = invalidateFirst
    ? platform.onForeground(guard.invalidate)
    : () => {};
  const api = new ApiClient(
    'https://home.test',
    'synthetic-home-session',
    undefined,
    accounts,
    guard.verify,
  );
  const value = {
    api,
    revision: 0,
    user: { id: 'home-owner', name: 'Home', timezone: 'UTC' },
    preferences: { serverUrl: api.baseUrl, instance: manifest },
    navigate: jest.fn(),
    invalidate: jest.fn(),
    formatDate: () => '',
  } as unknown as AppContextValue;
  const render = (context: AppContextValue) => (
    <AppProvider value={context}>
      <HomeScreen onTasks={jest.fn()} />
    </AppProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(value));
  });
  if (!invalidateFirst) unsubscribe = platform.onForeground(guard.invalidate);
  return {
    tree,
    value,
    updateContext: (context: AppContextValue) => tree.update(render(context)),
    close: async () => {
      await act(async () => tree.unmount());
      unsubscribe();
      guard.dispose();
      api.dispose();
    },
  };
}

test('foreground queues a Home GET after its aborted cold-start anonymous check, then validates the same instance again', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const anonymous = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts);
  try {
    expect(anonymous).toHaveBeenCalledTimes(1);
    expect(accounts).not.toHaveBeenCalled();
    const oldSignal = anonymous.mock.calls[0][1].signal as AbortSignal;
    await act(async () => {
      listeners.forEach(listener => listener());
      first.reject(
        Object.assign(new Error('native fetch aborted'), {
          name: 'AbortError',
        }),
      );
    });
    expect(oldSignal.aborted).toBe(true);
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(accounts).not.toHaveBeenCalled();
    expect(errors(app.tree)).toEqual([]);
    expect(app.tree.root.findByType(Loading).props.label).toBe(
      '正在查看今天的安排…',
    );
    await act(async () => second.resolve(response(manifest)));
    expect(text(app.tree)).toContain(today.briefing);
    expect(errors(app.tree)).toEqual([]);
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(accounts.mock.calls[0]).toEqual([
      'https://home.test/v1/today',
      expect.objectContaining({ method: 'GET' }),
    ]);
    for (const [url, init] of anonymous.mock.calls) {
      expect(url).toBe('https://home.test/v1/instance');
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.body).toBeUndefined();
    }
  } finally {
    await app.close();
  }
  expect(listeners.size).toBe(0);
});

test('foreground Home recovery still rejects a replacement instance before sending account credentials', async () => {
  const first = deferred<Response>();
  const anonymous = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(response({ ...manifest, id: 'replacement-home' }));
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts);
  try {
    await act(async () => {
      listeners.forEach(listener => listener());
      first.reject(
        Object.assign(new Error('native fetch aborted'), {
          name: 'AbortError',
        }),
      );
    });
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(errors(app.tree).join(' ')).toContain('服务器身份已变化');
    expect(accounts).not.toHaveBeenCalled();
    expect(text(app.tree)).not.toContain(today.briefing);
  } finally {
    await app.close();
  }
});

test('a real network failure on the new foreground check stays visible and does not invent a successful Home read', async () => {
  const first = deferred<Response>();
  const anonymous = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockRejectedValue(new TypeError('network remains offline'));
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts);
  try {
    await act(async () => {
      listeners.forEach(listener => listener());
      first.reject(
        Object.assign(new Error('native fetch aborted'), {
          name: 'AbortError',
        }),
      );
    });
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(errors(app.tree).join(' ')).toContain('暂时无法验证这台服务器');
    expect(app.tree.root.findAllByType(Loading)).toHaveLength(0);
    expect(accounts).not.toHaveBeenCalled();
    expect(text(app.tree)).not.toContain(today.briefing);
    await act(async () => {
      await Promise.resolve();
    });
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(errors(app.tree).join(' ')).toContain('暂时无法验证这台服务器');
  } finally {
    await app.close();
  }
});

test('foreground refreshes only Home reads and never automatically replays an uncertain briefing write', async () => {
  const anonymous = jest.fn().mockResolvedValue(response(manifest));
  const accounts = jest.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'POST')
      throw new TypeError('response lost after submit');
    return response(today, '/today');
  });
  const app = await mount(anonymous, accounts as typeof fetch);
  try {
    await act(async () =>
      app.tree.root
        .findByProps({ accessibilityLabel: '更新今日简报' })
        .props.onPress(),
    );
    expect(
      accounts.mock.calls.filter(call => call[1].method === 'POST'),
    ).toHaveLength(1);
    await act(async () => listeners.forEach(listener => listener()));
    expect(accounts.mock.calls.map(call => call[1].method)).toEqual([
      'GET',
      'POST',
      'GET',
    ]);
    expect(anonymous).toHaveBeenCalledTimes(3);
    expect(text(app.tree)).toContain(today.briefing);
  } finally {
    await app.close();
  }
});

test('foreground recovery also works when the child Home subscribes before the parent guard invalidation', async () => {
  const anonymous = jest.fn().mockResolvedValue(response(manifest));
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts, false);
  try {
    expect(accounts).toHaveBeenCalledTimes(1);
    await act(async () => listeners.forEach(listener => listener()));
    expect(accounts).toHaveBeenCalledTimes(2);
    expect(anonymous).toHaveBeenCalledTimes(2);
    expect(errors(app.tree)).toEqual([]);
    expect(text(app.tree)).toContain(today.briefing);
  } finally {
    await app.close();
  }
});

test('unmounting before the scheduled foreground microtask prevents any new Home read', async () => {
  const anonymous = jest.fn().mockResolvedValue(response(manifest));
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts, false);
  try {
    act(() => {
      listeners.forEach(listener => listener());
      app.tree.unmount();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(anonymous).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
  expect(listeners.size).toBe(0);
});

test('changing account and API before the scheduled microtask cancels the old refresh rather than revalidating the new owner twice', async () => {
  const anonymous = jest.fn().mockResolvedValue(response(manifest));
  const accounts = jest.fn().mockResolvedValue(response(today, '/today'));
  const app = await mount(anonymous, accounts, false);
  const nextAnonymous = jest.fn().mockResolvedValue(response(manifest));
  const nextAccounts = jest
    .fn()
    .mockResolvedValue(
      response({ ...today, briefing: '新账号简报' }, '/today'),
    );
  const nextGuard = createInstanceIdentityGuard('https://home.test', {
    expectedId: manifest.id,
    fetcher: nextAnonymous,
  });
  const nextApi = new ApiClient(
    'https://home.test',
    'synthetic-next-session',
    undefined,
    nextAccounts,
    nextGuard.verify,
  );
  try {
    act(() => {
      listeners.forEach(listener => listener());
      app.updateContext({
        ...app.value,
        api: nextApi,
        user: { ...app.value.user!, id: 'next-home-owner' },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(anonymous).toHaveBeenCalledTimes(1);
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(nextAnonymous).toHaveBeenCalledTimes(1);
    expect(nextAccounts).toHaveBeenCalledTimes(1);
    expect(text(app.tree)).toContain('新账号简报');
    expect(text(app.tree)).not.toContain(today.briefing);
  } finally {
    await app.close();
    nextGuard.dispose();
    nextApi.dispose();
  }
});

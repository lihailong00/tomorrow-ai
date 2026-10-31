import React from 'react';
import { RefreshControl, Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider, useResource } from '../src/app/context';
import { Task, Today } from '../src/domain/types';
import { TaskDetailScreen } from '../src/screens/Details';
import { HomeScreen } from '../src/screens/Main';
import { ErrorNotice } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {} }));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function task(status: Task['status']): Task {
  return {
    id: 'task',
    title: 'Polling task',
    instruction: 'Finish the work',
    kind: 'general',
    status,
    progress: status === 'succeeded' ? 100 : 0,
    result: status === 'succeeded' ? 'Delivered slow response' : null,
    created_at: '',
    updated_at: '',
    steps: [],
    model_mode: 'local',
    approval_required: false,
  };
}

function today(active: number): Today {
  return {
    date: '2026-10-28',
    greeting: 'Hello',
    briefing: active ? 'Queued briefing' : 'Completed briefing',
    tasks: [task(active ? 'queued' : 'succeeded')],
    schedules: [],
    memories: [],
    notifications: [],
    stats: {
      tasks_completed: active ? 0 : 1,
      active_routines: 0,
      memory_count: 0,
      active_tasks: active,
      unread_notifications: 0,
    },
    runtime: {
      model_mode: 'local',
      scheduler_mode: 'local',
      storage_mode: 'sqlite',
    },
  };
}

const text = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(node => node.props.children).join('\n');

async function renderScreen(api: object, page: React.ReactNode) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider
        value={{
          api,
          revision: 0,
          user: { id: 'owner', name: 'QA', timezone: 'UTC' },
          preferences: { serverUrl: 'https://test' },
          navigate: jest.fn(),
          invalidate: jest.fn(),
          formatDate: () => '',
        } as unknown as AppContextValue}
      >
        {page}
      </AppProvider>,
    );
  });
  return tree;
}

it('renders task completion when a 4s response outlasts the real 2.5s poll', async () => {
  const read = jest.fn().mockResolvedValueOnce(task('queued')).mockImplementation(
    () => new Promise<Task>(resolve => setTimeout(() => resolve(task('succeeded')), 4000)),
  );
  const tree = await renderScreen({ task: read }, <TaskDetailScreen id="task" />);
  expect(text(tree)).toContain('排队中');
  await act(async () => jest.advanceTimersByTime(2500));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(2500));
  // The next poll queues revalidation without starting a concurrent request.
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(1500));
  expect(text(tree)).toContain('已完成');
  expect(text(tree)).toContain('Delivered slow response');
  expect(text(tree)).not.toContain('排队中');
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => jest.advanceTimersByTime(20000));
  expect(read).toHaveBeenCalledTimes(3);
  expect(tree.root.findByType(RefreshControl).props.refreshing).toBe(false);
  await act(async () => tree.unmount());
});

it('renders Home completion when a 9s response outlasts its real 8s poll', async () => {
  const read = jest.fn().mockResolvedValueOnce(today(1)).mockImplementation(
    () => new Promise<Today>(resolve => setTimeout(() => resolve(today(0)), 9000)),
  );
  const tree = await renderScreen({ today: read }, <HomeScreen onTasks={jest.fn()} />);
  await act(async () => jest.advanceTimersByTime(8000));
  await act(async () => jest.advanceTimersByTime(8000));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(1000));
  expect(text(tree)).toContain('Completed briefing');
  expect(text(tree)).not.toContain('排队中');
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => jest.advanceTimersByTime(24000));
  expect(read).toHaveBeenCalledTimes(3);
  await act(async () => tree.unmount());
});

it('commits slow polling failures while retries are pending and clears them on success', async () => {
  const message = 'Synthetic slow task read503';
  let recover = false;
  let inFlight = 0;
  let maxInFlight = 0;
  const read = jest.fn().mockResolvedValueOnce(task('queued')).mockImplementation(() => {
    const fail = !recover;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<Task>((resolve, reject) => {
      setTimeout(() => {
        if (fail) reject(new Error(message));
        else resolve(task('succeeded'));
      }, 4000);
    }).finally(() => { inFlight--; });
  });
  const errors = (page: ReactTestRenderer) => page.root.findAllByType(ErrorNotice)
    .map(node => node.props.message).filter(Boolean);
  const committedErrors: string[][] = [];
  let tree: ReactTestRenderer | undefined;
  tree = await renderScreen({ task: read }, (
    <React.Profiler id="slow-errors" onRender={() => {
      if (tree) committedErrors.push(errors(tree));
    }}>
      <TaskDetailScreen id="task" />
    </React.Profiler>
  ));
  const page = tree;
  await act(async () => jest.advanceTimersByTime(2500));
  await act(async () => jest.advanceTimersByTime(2500));
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => jest.advanceTimersByTime(1500));
  expect(read).toHaveBeenCalledTimes(3);
  expect(errors(page)).toContain(message);
  expect(text(page)).toContain('排队中');
  expect(page.root.findByType(RefreshControl).props.refreshing).toBe(true);
  expect(committedErrors.some(messages => messages.includes(message))).toBe(true);

  await act(async () => jest.advanceTimersByTime(2500));
  expect(errors(page)).toContain(message);
  recover = true;
  await act(async () => jest.advanceTimersByTime(1500));
  expect(read).toHaveBeenCalledTimes(4);
  expect(errors(page)).toContain(message);
  // A manual pull joins the queued retry without hiding the last failure.
  await act(async () => page.root.findByType(RefreshControl).props.onRefresh());
  expect(errors(page)).toContain(message);
  await act(async () => jest.advanceTimersByTime(4000));
  expect(text(page)).toContain('已完成');
  expect(errors(page)).not.toContain(message);
  expect(read).toHaveBeenCalledTimes(5);
  expect(maxInFlight).toBe(1);
  await act(async () => jest.advanceTimersByTime(8000));
  expect(read).toHaveBeenCalledTimes(5);
  expect(page.root.findByType(RefreshControl).props.refreshing).toBe(false);
  await act(async () => page.unmount());
});

async function hookHarness(
  load: () => Promise<string>,
  deps: React.DependencyList = [],
  strict = false,
) {
  let resource!: ReturnType<typeof useResource<string>>;
  const renders: Array<string | null> = [];
  const errors: Array<string | null> = [];
  function Screen(props: { loader: () => Promise<string>; keys: React.DependencyList }) {
    resource = useResource(props.loader, props.keys);
    renders.push(resource.value);
    errors.push(resource.error);
    return <Text>{resource.value ?? 'loading'}</Text>;
  }
  const screen = (loader: () => Promise<string>, keys: React.DependencyList) => {
    const page = <Screen loader={loader} keys={keys} />;
    return strict ? <React.StrictMode>{page}</React.StrictMode> : page;
  };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(screen(load, deps));
  });
  return {
    tree,
    renders,
    errors,
    current: () => resource,
    update: async (loader: () => Promise<string>, keys: React.DependencyList) => {
      await act(async () => tree.update(screen(loader, keys)));
    },
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

it('coalesces repeated polls and manual refreshes into one queued read', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const third = deferred<string>();
  const load = jest.fn().mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  const app = await hookHarness(load);
  const refresh = app.current().refresh;
  const setValue = app.current().setValue;
  await act(async () => {
    for (let index = 0; index < 20; index++) refresh();
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve('valid slow result'));
  expect(app.current().value).toBe('valid slow result');
  expect(load).toHaveBeenCalledTimes(2);
  expect(app.current().loading).toBe(true);
  await act(async () => {
    app.current().setValue(value => `${value} + optimistic`);
  });
  expect(app.current().value).toBe('valid slow result + optimistic');
  expect(app.current().refresh).toBe(refresh);
  expect(app.current().setValue).toBe(setValue);
  await act(async () => second.resolve('revalidated'));
  expect(app.current().value).toBe('revalidated');
  expect(app.current().loading).toBe(false);
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => refresh());
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => third.resolve('manual update'));
  expect(app.current().value).toBe('manual update');
  await app.close();
});

it.each([
  { key: 'record', oldDeps: ['task-a'], newDeps: ['task-b'] },
  { key: 'api', oldDeps: [{ client: 'a' }], newDeps: [{ client: 'b' }] },
  { key: 'account', oldDeps: ['api', 'user-a'], newDeps: ['api', 'user-b'] },
  { key: 'server', oldDeps: ['https://old'], newDeps: ['https://new'] },
  { key: 'filter', oldDeps: ['api', 'queued'], newDeps: ['api', 'succeeded'] },
  { key: 'revision', oldDeps: ['api', 'record', 0], newDeps: ['api', 'record', 1] },
])(
  'immediately fences $key changes and uses the new loader before the old read finishes',
  async ({ oldDeps, newDeps }) => {
    const oldRead = deferred<string>();
    const newRead = deferred<string>();
    const oldLoader = jest.fn().mockResolvedValueOnce('old visible data')
      .mockReturnValue(oldRead.promise);
    const newLoader = jest.fn().mockReturnValue(newRead.promise);
    const app = await hookHarness(oldLoader, oldDeps);
    expect(app.current().value).toBe('old visible data');
    await act(async () => {
      app.current().refresh();
      app.current().refresh();
    });
    const start = app.renders.length;
    await app.update(newLoader, newDeps);
    expect(newLoader).toHaveBeenCalledTimes(1);
    expect(app.renders.slice(start)).not.toContain('old visible data');
    expect(app.current().value).toBeNull();
    expect(app.current().loading).toBe(true);
    await act(async () => oldRead.reject(new Error('old owner error')));
    expect(oldLoader).toHaveBeenCalledTimes(2);
    expect(app.current().error).toBeNull();
    expect(app.current().loading).toBe(true);
    await act(async () => newRead.resolve('new owner data'));
    expect(app.current().value).toBe('new owner data');
    expect(app.current().loading).toBe(false);
    await app.close();
  },
);

it('rejects a stale success after the current resource has completed', async () => {
  const oldRead = deferred<string>();
  const app = await hookHarness(() => oldRead.promise, ['old']);
  await app.update(() => Promise.resolve('new result'), ['new']);
  await act(async () => oldRead.resolve('stale result'));
  expect(app.current().value).toBe('new result');
  await app.close();
});

it('hides the previous scope failure immediately while the new scope is loading', async () => {
  const pending = deferred<string>();
  const app = await hookHarness(() => Promise.reject(new Error('old account failure')), ['old']);
  expect(app.current().error).toBe('old account failure');
  const start = app.errors.length;
  await app.update(() => pending.promise, ['new']);
  expect(app.current().loading).toBe(true);
  expect(app.current().error).toBeNull();
  expect(app.errors.slice(start)).not.toContain('old account failure');
  await act(async () => pending.resolve('new account result'));
  expect(app.current().value).toBe('new account result');
  expect(app.current().error).toBeNull();
  await app.close();
});

it('uses explicit deps for identity and the latest closure for a queued refresh', async () => {
  const first = deferred<string>();
  const original = jest.fn().mockReturnValue(first.promise);
  const latest = jest.fn().mockResolvedValue('latest closure');
  const app = await hookHarness(original, ['same']);
  await app.update(latest, ['same']);
  expect(latest).not.toHaveBeenCalled();
  await act(async () => app.current().refresh());
  await act(async () => first.resolve('first result'));
  expect(original).toHaveBeenCalledTimes(1);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(app.current().value).toBe('latest closure');
  await app.close();
});

it('reuses a pending read through StrictMode effect replay and drops queued work on unmount', async () => {
  const pending = deferred<string>();
  const load = jest.fn().mockReturnValue(pending.promise);
  const app = await hookHarness(load, [], true);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve('strict result'));
  expect(app.current().value).toBe('strict result');
  await app.close();

  const abandoned = deferred<string>();
  const unmountedLoad = jest.fn().mockReturnValue(abandoned.promise);
  const unmounted = await hookHarness(unmountedLoad);
  const refresh = unmounted.current().refresh;
  await act(async () => refresh());
  await unmounted.close();
  const renderCount = unmounted.renders.length;
  await act(async () => {
    abandoned.resolve('after unmount');
    refresh();
    unmounted.current().setValue('after unmount');
  });
  expect(unmountedLoad).toHaveBeenCalledTimes(1);
  expect(unmounted.renders).toHaveLength(renderCount);
});

it('recovers after a rejected or synchronously throwing loader', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementationOnce(() => { throw new Error('synchronous failure'); })
    .mockResolvedValueOnce('recovered');
  const app = await hookHarness(load);
  expect(app.current().error).toBe('temporary failure');
  expect(app.current().loading).toBe(false);
  await act(async () => app.current().refresh());
  expect(app.current().error).toBe('synchronous failure');
  expect(app.current().loading).toBe(false);
  await act(async () => app.current().refresh());
  expect(app.current().value).toBe('recovered');
  expect(app.current().error).toBeNull();
  expect(app.current().loading).toBe(false);
  await app.close();
});

it('starts the one queued retry after a failed read', async () => {
  const pending = deferred<string>();
  const load = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue('retry result');
  const app = await hookHarness(load);
  await act(async () => {
    app.current().refresh();
    app.current().refresh();
    pending.reject(new Error('initial failure'));
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(app.current().value).toBe('retry result');
  expect(app.current().error).toBeNull();
  await app.close();
});

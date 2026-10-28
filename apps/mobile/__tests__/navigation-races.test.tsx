import React from 'react';
import { Alert, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider, useAction } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import type { RetainedRouteScope } from '../src/app/navigation';
import {
  MemoryEditor,
  NewTaskScreen,
  ScheduleEditor,
} from '../src/screens/Details';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { platform } from '../src/platform/ports';
import { Button, ErrorNotice } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({ platform: {
  pickDocument: jest.fn().mockResolvedValue({
    uri: 'file:///draft.txt', name: 'draft.txt', mime_type: 'text/plain', size: 42,
  }),
  startRecording: jest.fn().mockResolvedValue(undefined),
  stopRecording: jest.fn().mockResolvedValue(null),
} }));
jest.mock('../src/ui/visuals', () => ({
  AssistantOrb: () => null,
  Icon: () => null,
}));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function setup(api: object) {
  let navigation!: ReturnType<typeof useRouteStack>;
  const invalidate = jest.fn();
  function Harness({ client }: { client: object }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    const page =
      route.name === 'memory' ? (
        <MemoryEditor memory={route.memory} />
      ) : route.name === 'schedule' ? (
        <ScheduleEditor schedule={route.schedule} />
      ) : route.name === 'newTask' ? (
        <NewTaskScreen />
      ) : route.name === 'chat' ? (
        <ChatScreen
          conversationId={route.conversationId}
          prompt={route.prompt}
          entryState={navigation.getEntryState(scope =>
            createChatEntryState(route.conversationId, route.prompt, scope))}
          onConversationCreated={conversationId =>
            navigation.updateRoute(current =>
              current.name === 'chat'
                ? { ...current, conversationId, prompt: undefined }
                : current,
            )
          }
        />
      ) : (
        <Text>{route.name}</Text>
      );
    return (
      <AppProvider
        value={
          {
            api: client,
            preferences: {
              serverUrl: 'https://test',
              instance: { id: 'test' },
            },
            user: { id: 'user' },
            navigate: navigation.navigate,
            back: navigation.back,
            invalidate,
            formatDate: () => '',
          } as unknown as AppContextValue
        }
      >
        <React.Fragment key={navigation.entry.key}>{page}</React.Fragment>
      </AppProvider>
    );
  }
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<Harness client={api} />);
  });
  const field = (index: number) => tree.root.findAllByType(TextInput)[index];
  return {
    tree,
    invalidate,
    navigation: () => navigation,
    route: () => navigation.entry.route,
    input: async (index: number, value: string) => {
      await act(async () => field(index).props.onChangeText(value));
    },
    value: (index: number) => field(index).props.value,
    labelled: (label: string) => tree.root.findAll(n =>
      n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0],
    text: () => tree.root.findAllByType(Text)
      .flatMap(node => [node.props.children].flat(Infinity)).join(''),
    press: async (label: string, wait = true) => {
      await act(async () => {
        const operation = tree.root
          .findAllByType(Button)
          .find(n => n.props.children === label)!
          .props.onPress();
        if (wait) await operation;
      });
    },
    navigate: async (route: Parameters<typeof navigation.navigate>[0]) => {
      await act(async () => navigation.navigate(route));
    },
    back: async () => {
      await act(async () => navigation.back());
    },
    reset: async () => {
      await act(async () => navigation.resetRoutes([{ name: 'main' }]));
    },
    changeOwner: async (client: object) => {
      await act(async () => tree.update(<Harness client={client} />));
    },
    close: async () => {
      await act(async () => tree.unmount());
    },
  };
}

test('a deferred memory save cannot close a new editor or overwrite its draft', async () => {
  const old = deferred<void>();
  const api = {
    saveMemory: jest
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(undefined),
  };
  const app = await setup(api);
  await app.navigate({ name: 'memory' });
  await app.input(0, 'Old memory');
  await app.input(1, 'Original request');
  await app.press('保存记忆', false);
  const oldBack = app.navigation().back;
  await app.back();
  await app.navigate({ name: 'memory' });
  await app.input(0, 'New draft');
  await app.input(1, 'Keep this unsaved content');
  await act(async () => {
    old.resolve();
  });
  // Also protects callers outside useAction that retained a route callback.
  await act(async () => oldBack());
  expect(app.route().name).toBe('memory');
  expect(app.value(0)).toBe('New draft');
  expect(app.value(1)).toBe('Keep this unsaved content');
  expect(app.invalidate).not.toHaveBeenCalled();
  await app.press('保存记忆');
  expect(app.route().name).toBe('main');
  expect(app.invalidate).toHaveBeenCalledTimes(1);
  expect(api.saveMemory).toHaveBeenCalledTimes(2);
  await app.close();
});

test.each(['schedule', 'newTask'] as const)(
  'a stale %s result cannot navigate away from a newer form',
  async name => {
    const old = deferred<any>();
    const api = {
      saveSchedule: jest.fn().mockReturnValue(old.promise),
      createTask: jest.fn().mockReturnValue(old.promise),
    };
    const app = await setup(api);
    await app.navigate({ name });
    await app.input(0, 'Original title or instruction');
    if (name === 'schedule') await app.input(1, 'Original instruction');
    await app.press(name === 'schedule' ? '保存并开始' : '开始任务', false);
    await app.back();
    await app.navigate({ name: 'memory' });
    await app.input(0, 'New draft');
    await act(async () => {
      old.resolve({ id: 'old-task' });
    });
    expect(app.route().name).toBe('memory');
    expect(app.value(0)).toBe('New draft');
    expect(app.invalidate).not.toHaveBeenCalled();
    await app.close();
  },
);

test('returning to a route never reactivates callbacks from its previous mounted screen', async () => {
  const app = await setup({});
  await app.navigate({ name: 'memory' });
  const previousNavigate = app.navigation().navigate;
  await app.navigate({ name: 'settings' });
  await app.back();
  await act(async () => previousNavigate({ name: 'task', id: 'stale-result' }));
  expect(app.route().name).toBe('memory');
  await app.close();
});

test('a native deletion confirmation from an unmounted editor cannot start work', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const api = { deleteMemory: jest.fn() };
  const app = await setup(api);
  await app.navigate({
    name: 'memory',
    memory: {
      id: 'm',
      title: 'Saved memory',
      content: 'content',
      kind: 'fact',
      source: 'user',
      created_at: '',
      updated_at: '',
      version: 1,
    },
  });
  await app.press('删除这条记忆');
  const confirm = alert.mock.calls[0][2]!.find(
    button => button.style === 'destructive',
  )!.onPress!;
  await app.back();
  await app.navigate({ name: 'memory' });
  await act(async () => {
    confirm();
  });
  expect(api.deleteMemory).not.toHaveBeenCalled();
  expect(app.route().name).toBe('memory');
  await app.close();
  alert.mockRestore();
});

test('an account or instance change invalidates an old request and its navigation callbacks', async () => {
  const old = deferred<void>();
  const app = await setup({
    saveMemory: jest.fn().mockReturnValue(old.promise),
  });
  await app.navigate({ name: 'memory' });
  await app.input(1, 'Old owner content');
  await app.press('保存记忆', false);
  const oldNavigate = app.navigation().navigate;
  await app.changeOwner({ saveMemory: jest.fn().mockResolvedValue(undefined) });
  await app.input(0, 'New owner draft');
  await act(async () => {
    old.resolve();
    oldNavigate({ name: 'task', id: 'old-owner-task' });
  });
  expect(app.route().name).toBe('memory');
  expect(app.value(0)).toBe('New owner draft');
  expect(app.invalidate).not.toHaveBeenCalled();
  await app.close();
});

test('an old action cannot clear the loading state or error of a new owner request', async () => {
  const old = deferred<void>();
  const fresh = deferred<void>();
  let run!: ReturnType<typeof useAction>['run'];
  function Action() {
    const action = useAction();
    run = action.run;
    return (
      <>
        <Text>{action.busy ? 'busy' : 'ready'}</Text>
        <ErrorNotice message={action.error} />
      </>
    );
  }
  const ownerA = {};
  const ownerB = {};
  const screen = (api: object) => (
    <AppProvider value={{ api } as AppContextValue}>
      <Action />
    </AppProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(screen(ownerA));
  });
  await act(async () => {
    void run(() => old.promise);
  });
  await act(async () => tree.update(screen(ownerB)));
  await act(async () => {
    void run(() => fresh.promise);
  });
  await act(async () => old.reject(new Error('Old account failure')));
  expect(tree.root.findByType(Text).props.children).toBe('busy');
  expect(tree.root.findByType(ErrorNotice).props.message).toBeNull();
  await act(async () => fresh.reject(new Error('Current failure')));
  expect(tree.root.findByType(ErrorNotice).props.message).toBe(
    'Current failure',
  );
  await act(async () => tree.unmount());
});

test('a created chat keeps its route identity and loaded messages after history then back', async () => {
  const reply = {
    id: 'reply',
    conversation_id: 'created',
    role: 'assistant',
    content: 'First reply',
    created_at: '',
  };
  const api = {
    capabilities: jest
      .fn()
      .mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    chat: jest
      .fn()
      .mockResolvedValueOnce({ conversation_id: 'created', message: reply })
      .mockResolvedValue({
        conversation_id: 'created',
        message: { ...reply, id: 'second-reply' },
      }),
    messages: jest.fn().mockResolvedValue({ items: [reply] }),
  };
  const app = await setup(api);
  await app.navigate({ name: 'chat', prompt: 'First prompt' });
  const key = app.navigation().entry.key;
  const send = async () => {
    await act(async () => {
      await app.tree.root
        .findAll(
          n =>
            n.props.accessibilityLabel === '发送消息' &&
            typeof n.props.onPress === 'function',
        )[0]
        .props.onPress();
    });
  };
  await send();
  expect(app.route()).toEqual({
    name: 'chat',
    conversationId: 'created',
    prompt: undefined,
  });
  expect(app.navigation().entry.key).toBe(key);
  expect(api.messages).not.toHaveBeenCalled();
  expect(app.value(0)).toBe('');
  await app.navigate({ name: 'conversations' });
  await app.back();
  expect(api.messages).not.toHaveBeenCalled();
  expect(
    app.tree.root
      .findAllByType(Text)
      .map(n => n.props.children)
      .join('\n'),
  ).toContain('First reply');
  expect(app.value(0)).toBe('');
  await app.input(0, 'Continue this thread');
  await send();
  expect(api.chat).toHaveBeenLastCalledWith(
    'Continue this thread',
    'created',
    expect.any(String),
    [],
  );
  await app.close();
});

function chatApi(overrides: object = {}) {
  return {
    capabilities: jest.fn().mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    messages: jest.fn().mockResolvedValue({ items: [] }),
    upload: jest.fn().mockResolvedValue({
      id: 'draft-upload', name: 'draft.txt', mime_type: 'text/plain', size: 42,
    }),
    chat: jest.fn().mockResolvedValue(chatResult('created')),
    ...overrides,
  };
}

function chatResult(conversationId: string) {
  return {
    conversation_id: conversationId,
    user_message: {
      id: 'new-user', conversation_id: conversationId, role: 'user',
      content: 'Draft to send', created_at: '',
    },
    message: {
      id: 'new-reply', conversation_id: conversationId, role: 'assistant',
      content: 'New successful reply', created_at: '',
    },
  };
}

test('an unsent route preserves its draft and local attachment through history and a different chat', async () => {
  const api = chatApi();
  const app = await setup(api);
  await app.navigate({ name: 'chat' });
  await app.input(0, 'Keep this unsent text');
  await act(async () => app.labelled('选择附件').props.onPress());
  await app.navigate({ name: 'conversations' });
  await app.navigate({ name: 'chat', conversationId: 'different' });
  expect(app.value(0)).toBe('');
  expect(app.text()).not.toContain('draft.txt');
  await app.back();
  await app.back();
  expect(app.value(0)).toBe('Keep this unsent text');
  expect(app.text()).toContain('draft.txt');
  expect(app.text()).toContain('仅保存在本机，尚未上传');
  expect(api.chat).not.toHaveBeenCalled();
  await app.reset();
  await app.navigate({ name: 'chat' });
  expect(app.value(0)).toBe('');
  expect(app.text()).not.toContain('draft.txt');
  await app.close();
});

test('uploaded attachment state returns without another upload and is consumed by a successful send', async () => {
  const api = chatApi();
  const app = await setup(api);
  await app.navigate({ name: 'chat' });
  await app.input(0, 'Draft to send');
  await act(async () => app.labelled('选择附件').props.onPress());
  await app.press('上传附件　↑');
  await app.navigate({ name: 'conversations' });
  await app.back();
  expect(app.text()).toContain('已保存到服务');
  await act(async () => app.labelled('发送消息').props.onPress());
  expect(api.upload).toHaveBeenCalledTimes(1);
  expect(api.chat).toHaveBeenCalledWith('Draft to send', undefined, expect.any(String), ['draft-upload']);
  expect(app.value(0)).toBe('');
  await app.navigate({ name: 'conversations' });
  await app.back();
  expect(app.value(0)).toBe('');
  expect(app.text()).not.toContain('draft.txt');
  await app.close();
});

test.each([undefined, 'existing'])(
  'a pending chat for %s survives history/back and publishes its result once into the same entry',
  async conversationId => {
    const pending = deferred<any>();
    const api = chatApi({ chat: jest.fn().mockReturnValue(pending.promise) });
    const app = await setup(api);
    await app.navigate({ name: 'chat', conversationId });
    await app.input(0, 'Draft to send');
    await act(async () => { void app.labelled('发送消息').props.onPress(); });
    await app.navigate({ name: 'conversations' });
    await app.back();
    expect(app.value(0)).toBe('Draft to send');
    expect(app.labelled('发送消息').props.disabled).toBe(true);
    expect(app.text()).toContain('正在整理思路');
    await act(async () => app.labelled('发送消息').props.onPress());
    expect(api.chat).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(chatResult(conversationId ?? 'created')));
    expect(app.value(0)).toBe('');
    expect(app.text()).toContain('New successful reply');
    expect(app.text()).not.toContain('正在整理思路');
    expect(app.route()).toMatchObject({ name: 'chat', conversationId: conversationId ?? 'created' });
    await app.navigate({ name: 'conversations' });
    await app.back();
    expect(app.value(0)).toBe('');
    expect(api.chat).toHaveBeenCalledTimes(1);
    await app.close();
  },
);

test('a hidden completion updates its retained route without changing another chat draft', async () => {
  const pending = deferred<any>();
  const api = chatApi({ chat: jest.fn().mockReturnValue(pending.promise) });
  const app = await setup(api);
  await app.navigate({ name: 'chat' });
  await app.input(0, 'Draft to send');
  await act(async () => { void app.labelled('发送消息').props.onPress(); });
  await app.navigate({ name: 'conversations' });
  await app.navigate({ name: 'chat', conversationId: 'different' });
  await app.input(0, 'Other thread draft');
  await act(async () => pending.resolve(chatResult('created')));
  expect(app.route()).toMatchObject({ conversationId: 'different' });
  expect(app.value(0)).toBe('Other thread draft');
  expect(app.text()).not.toContain('New successful reply');
  await app.back();
  await app.back();
  expect(app.route()).toMatchObject({ conversationId: 'created' });
  expect(app.value(0)).toBe('');
  await app.close();
});

test('a lost response keeps its draft and request id through history/back before retry', async () => {
  const pending = deferred<any>();
  const api = chatApi({ chat: jest.fn().mockReturnValueOnce(pending.promise)
    .mockResolvedValue(chatResult('created')) });
  const app = await setup(api);
  await app.navigate({ name: 'chat' });
  await app.input(0, 'Draft to send');
  await act(async () => { void app.labelled('发送消息').props.onPress(); });
  const firstRequest = api.chat.mock.calls[0][2];
  await app.navigate({ name: 'conversations' });
  await act(async () => pending.reject(new Error('Response lost')));
  await app.back();
  expect(app.value(0)).toBe('Draft to send');
  expect(app.text()).toContain('Response lost');
  await act(async () => app.labelled('发送消息').props.onPress());
  expect(api.chat.mock.calls[1][2]).toBe(firstRequest);
  expect(app.value(0)).toBe('');
  await app.close();
});

test.each(['pop', 'reset', 'owner'] as const)(
  'a %s invalidates retained chat completion and prevents its draft reaching a fresh entry',
  async reason => {
    const pending = deferred<any>();
    const api = chatApi({ chat: jest.fn().mockReturnValue(pending.promise) });
    const app = await setup(api);
    await app.navigate({ name: 'chat' });
    await app.input(0, 'Draft to send');
    await act(async () => { void app.labelled('发送消息').props.onPress(); });
    if (reason === 'pop') await app.back();
    else if (reason === 'reset') await app.reset();
    else await app.changeOwner(chatApi());
    if (reason !== 'owner') await app.navigate({ name: 'chat' });
    expect(app.value(0)).toBe('');
    await app.input(0, 'New owner or entry');
    await act(async () => pending.resolve(chatResult('old-created')));
    expect(app.value(0)).toBe('New owner or entry');
    expect(app.text()).not.toContain('New successful reply');
    expect(app.route()).not.toHaveProperty('conversationId', 'old-created');
    expect(app.invalidate).not.toHaveBeenCalled();
    await app.close();
  },
);

test('a delayed initial history snapshot cannot erase a successful newer turn', async () => {
  const oldHistory = deferred<any>();
  const api = chatApi({ messages: jest.fn().mockReturnValue(oldHistory.promise) });
  const app = await setup(api);
  await app.navigate({ name: 'chat', conversationId: 'existing' });
  await app.input(0, 'Draft to send');
  await act(async () => app.labelled('发送消息').props.onPress());
  expect(app.text()).toContain('New successful reply');
  await act(async () => oldHistory.resolve({ items: [{
    id: 'old-reply', conversation_id: 'existing', role: 'assistant',
    content: 'Older historical reply', created_at: '',
  }] }));
  expect(app.text()).toContain('Older historical reply');
  expect(app.text()).toContain('New successful reply');
  expect(app.value(0)).toBe('');
  expect(api.chat).toHaveBeenCalledTimes(1);
  await app.close();
});

test('leaving a chat stops recording and a late picker cannot change its retained attachment', async () => {
  const app = await setup(chatApi());
  await app.navigate({ name: 'chat' });
  (platform.stopRecording as jest.Mock).mockClear();
  await act(async () => app.labelled('开始录音').props.onPress());
  await app.navigate({ name: 'conversations' });
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  await app.back();
  expect(app.text()).not.toContain('正在录音');
  const picked = deferred<any>();
  (platform.pickDocument as jest.Mock).mockReturnValueOnce(picked.promise);
  await act(async () => { void app.labelled('选择附件').props.onPress(); });
  await app.navigate({ name: 'conversations' });
  await app.back();
  await act(async () => picked.resolve({ uri: 'late', name: 'late.txt', mime_type: 'text/plain' }));
  expect(app.text()).not.toContain('late.txt');
  await app.close();
});

test('retained route disposal survives StrictMode replay and fires once on removal or owner change', async () => {
  const disposed = jest.fn();
  let navigation!: ReturnType<typeof useRouteStack>;
  let scope!: RetainedRouteScope;
  function Harness({ owner }: { owner: object }) {
    navigation = useRouteStack(owner);
    scope = navigation.getEntryState(lifetime => {
      lifetime.onDispose(disposed);
      return lifetime;
    });
    return <Text>{navigation.entry.route.name}</Text>;
  }
  const owner = {};
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<React.StrictMode><Harness owner={owner} /></React.StrictMode>); });
  const original = scope;
  expect(original.isRetained()).toBe(true);
  expect(disposed).not.toHaveBeenCalled();
  await act(async () => navigation.navigate({ name: 'conversations' }));
  const pushed = scope;
  expect(original.isRetained()).toBe(true);
  await act(async () => navigation.back());
  expect(pushed.isRetained()).toBe(false);
  expect(original.isRetained()).toBe(true);
  expect(disposed).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(<React.StrictMode><Harness owner={{}} /></React.StrictMode>));
  expect(original.isRetained()).toBe(false);
  expect(scope.isRetained()).toBe(true);
  expect(disposed).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
  expect(scope.isRetained()).toBe(false);
  expect(disposed).toHaveBeenCalledTimes(3);
});

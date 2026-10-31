import { addChatStreamMock } from '../test/chatStreamMock';
import React from 'react';
import { Keyboard, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { ChatVoiceOverlay } from '../src/ui/ChatVoiceOverlay';
import { AppProvider, AppContextValue } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: {
    hasRecorder: true,
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest
      .fn()
      .mockResolvedValue({
        uri: 'file:///voice.m4a',
        name: 'voice.m4a',
        mime_type: 'audio/mp4',
        size: 1000,
      }),
  },
}));
jest.mock('../src/ui/visuals', () => ({
  AssistantOrb: () => null,
  Icon: () => null,
}));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function setup() {
  const api = {
    capabilities: jest
      .fn()
      .mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    messages: jest.fn().mockResolvedValue({ items: [] }),
    upload: jest
      .fn()
      .mockResolvedValue({ id: 'voice-upload', name: 'voice.m4a' }),
    transcribe: jest.fn().mockResolvedValue({ text: '明天下午提醒我开会。' }),
    deleteUpload: jest.fn().mockResolvedValue({ ok: true }),
    chat: jest
      .fn()
      .mockResolvedValue({
        conversation_id: 'c',
        message: {
          id: 'reply',
          role: 'assistant',
          content: '收到',
          created_at: '',
        },
      }),
  };
  addChatStreamMock(api);
  let navigation!: ReturnType<typeof useRouteStack>;
  function Harness({ client }: { client: typeof api }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    return (
      <AppProvider value={{ api: client, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue}>
        <React.Fragment key={navigation.entry.key}>
          {route.name === 'chat' ? <ChatScreen
            conversationId={route.conversationId}
            prompt={route.prompt}
            entryState={navigation.getEntryState(scope =>
              createChatEntryState(route.conversationId, route.prompt, scope))}
          /> : <Text>{route.name}</Text>}
        </React.Fragment>
      </AppProvider>
    );
  }
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(<Harness client={api} />);
  });
  await act(async () => navigation.navigate({ name: 'chat' }));
  const node = (label: string) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0];
  return {
    api,
    tree: () => tree,
    value: () => tree.root.findByType(TextInput).props.value,
    text: () =>
      tree.root
        .findAllByType(Text)
        .map(n => n.props.children)
        .join('\n'),
    input: async (text: string) => {
      await act(async () =>
        tree.root.findByType(TextInput).props.onChangeText(text),
      );
    },
    press: async (label: string) => {
      if (label === '开始录音' && !node(label)) {
        await act(async () => node('切换语音输入').props.onPress());
      }
      await act(async () => {
        await node(label).props.onPress();
      });
    },
    start: async (label: string) => {
      await act(async () => {
        void node(label).props.onPress();
      });
    },
    button: async (label: string) => {
      await act(async () => {
        await tree.root
          .findAllByType(Button)
          .find(n => n.props.children === label)!
          .props.onPress();
      });
    },
    buttonLabels: () => tree.root.findAllByType(Button).map(n => n.props.children),
    history: async () => {
      await act(async () => navigation.navigate({ name: 'conversations' }));
    },
    back: async () => { await act(async () => navigation.back()); },
    reset: async () => {
      await act(async () => navigation.resetRoutes([{ name: 'main' }]));
      await act(async () => navigation.navigate({ name: 'chat' }));
    },
    anotherChat: async () => {
      await act(async () => navigation.navigate({ name: 'chat', conversationId: 'another' }));
    },
    owner: async () => {
      await act(async () => tree.update(<Harness client={{ ...api }} />));
    },
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}


const gestureNode = (app: Awaited<ReturnType<typeof setup>>) => app.tree().root.findAll(n => n.props.testID === 'chat-hold-to-talk' && typeof n.props.onResponderGrant === 'function')[0];
const event = (pageY: number) => ({ nativeEvent: { pageY } });
async function hold(app: Awaited<ReturnType<typeof setup>>) {
  await app.press('切换语音输入');
  await act(async () => gestureNode(app).props.onResponderGrant(event(200)));
}

test('hold release transcribes once to a draft and never auto-sends', async () => {
  const app = await setup(); await hold(app);
  await act(async () => { gestureNode(app).props.onResponderRelease(); });
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('明天下午提醒我开会。');
  expect(app.api.chat).not.toHaveBeenCalled(); await app.unmount();
});

test('release before native permission/start resolves still stops and transcribes only once', async () => {
  let resolve!: () => void;
  (platform.startRecording as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { resolve=r; }));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(platform.stopRecording).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('明天下午提醒我开会。'); await app.unmount();
});

test.each(['slide','touch-cancel'])('cancelled hold %s discards audio without upload or ASR', async kind => {
  const app = await setup(); await hold(app);
  await act(async () => {
    if (kind === 'slide') { gestureNode(app).props.onResponderMove(event(100)); gestureNode(app).props.onResponderRelease(); }
    else { gestureNode(app).props.onTouchCancel(); gestureNode(app).props.onResponderRelease(); }
  });
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled();
  expect(app.value()).toBe(''); await app.unmount();
});

test('cancel while start is pending stops the eventual recorder without uploading', async () => {
  let resolve!: () => void;
  (platform.startRecording as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { resolve=r; }));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onTouchCancel());
  await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled(); await app.unmount();
});

test.each([true,false])('unmount stops a hold with pending start=%s without ASR', async pending => {
  let resolve!: () => void;
  if (pending) (platform.startRecording as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { resolve=r; }));
  const app = await setup(); await hold(app); await app.unmount();
  if (pending) await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled();
});

test('native start failure exits gesture and does not stop or upload unrelated audio', async () => {
  (platform.startRecording as jest.Mock).mockRejectedValueOnce(new Error('microphone denied'));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(platform.stopRecording).not.toHaveBeenCalled(); expect(app.api.upload).not.toHaveBeenCalled();
  expect(app.text()).toContain('microphone denied'); await app.unmount();
});

test('leaving the press rectangle is not release; a later upward swipe cancels', async () => {
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onPressOut?.());
  expect(platform.stopRecording).not.toHaveBeenCalled(); expect(app.api.upload).not.toHaveBeenCalled();
  await act(async () => { gestureNode(app).props.onResponderMove(event(100)); gestureNode(app).props.onResponderRelease(); });
  expect(platform.stopRecording).toHaveBeenCalledTimes(1); expect(app.api.upload).not.toHaveBeenCalled(); await app.unmount();
});

test('pending native start stays mutually exclusive after early touch release', async () => {
  let resolve!: () => void;
  (platform.startRecording as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { resolve=r; }));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  const button=app.tree().root.findAll(n => n.props.accessibilityLabel === '开始录音' && typeof n.props.onPress === 'function')[0];
  expect(button.props.disabled).toBe(true);
  await act(async () => { button.props.onPress(); gestureNode(app).props.onResponderGrant(event(200)); });
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1); await app.unmount();
});

test('time limit closes the gesture once, so touch release cannot stop or upload twice', async () => {
  const app = await setup(); await hold(app);
  await act(async () => { jest.advanceTimersByTime(115000); });
  expect(platform.stopRecording).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await act(async () => { gestureNode(app)?.props.onResponderRelease(); });
  expect(platform.stopRecording).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1); await app.unmount();
});

test('unmount during stop shares the native stop and never transcribes late audio', async () => {
  let resolve!: (value: any) => void;
  (platform.stopRecording as jest.Mock).mockImplementationOnce(() => new Promise(r => { resolve=r; }));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  await app.unmount();
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ uri:'file:///late.m4a', name:'late.m4a', mime_type:'audio/mp4' }));
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled();
});

test('parent responder termination discards captured speech without upload', async () => {
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderTerminate());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled(); await app.unmount();
});

test('stop failure does not leave the current route microphone locked', async () => {
  (platform.stopRecording as jest.Mock).mockRejectedValueOnce(new Error('short recording failed'));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.upload).not.toHaveBeenCalled();
  await act(async () => gestureNode(app).props.onResponderGrant(event(200)));
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(platform.startRecording).toHaveBeenCalledTimes(2);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1); await app.unmount();
});

test('stop rejection on unmount releases the microphone for a new chat', async () => {
  (platform.stopRecording as jest.Mock).mockRejectedValueOnce(new Error('native finalize failed'));
  const first = await setup(); await hold(first); await first.unmount();
  const second = await setup(); await hold(second);
  expect(platform.startRecording).toHaveBeenCalledTimes(2);
  await act(async () => gestureNode(second).props.onResponderRelease());
  expect(first.api.upload).not.toHaveBeenCalled();
  expect(second.api.transcribe).toHaveBeenCalledTimes(1); await second.unmount();
});

test('API owner replacement on the same Chat component resets capture UI and can record again', async () => {
  const app = await setup(); await app.unmount();
  const api = app.api; let tree!: ReactTestRenderer;
  const content = (client: typeof api) => <AppProvider value={{ api:client, invalidate:jest.fn(),formatDate:()=>'' } as unknown as AppContextValue}><ChatScreen /></AppProvider>;
  await act(async () => { tree=create(content(api)); });
  const node = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  const touch = () => tree.root.findAll(n => n.props.testID === 'chat-hold-to-talk' && typeof n.props.onResponderGrant === 'function')[0];
  await act(async () => node('切换语音输入').props.onPress());
  await act(async () => node('开始录音').props.onPress());
  await act(async () => tree.update(content({ ...api })));
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  await act(async () => touch().props.onResponderGrant(event(200)));
  expect(platform.startRecording).toHaveBeenCalledTimes(2);
  await act(async () => touch().props.onResponderRelease());
  expect(api.upload).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('voice mode blurs and dismisses the keyboard; returning to text focuses the same draft input', async () => {
  const app = await setup();
  const input = app.tree().root.findByType(TextInput);
  const native = input.instance as TextInput;
  const blur = jest.spyOn(native, 'blur').mockImplementation(() => {});
  const focus = jest.spyOn(native, 'focus').mockImplementation(() => {});
  const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  await app.input('Keep this editable draft.');
  await act(async () => input.props.onFocus());
  await app.press('切换语音输入');
  expect(blur).toHaveBeenCalledTimes(1); expect(dismiss).toHaveBeenCalledTimes(1);
  expect(focus).not.toHaveBeenCalled(); expect(app.value()).toBe('Keep this editable draft.');
  await app.press('切换文字输入');
  expect(focus).toHaveBeenCalledTimes(1);
  expect(app.tree().root.findByType(TextInput)).toBe(input);
  expect(app.value()).toBe('Keep this editable draft.');
  expect(platform.startRecording).not.toHaveBeenCalled();
  await app.unmount();
  blur.mockRestore(); focus.mockRestore(); dismiss.mockRestore();
});

test('cancelled hold cannot label a later accessible tap recording as cancelled', async () => {
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderMove(event(100)));
  expect(app.tree().root.findByType(ChatVoiceOverlay).props.cancelled).toBe(true);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled();
  await app.press('开始录音');
  expect(app.tree().root.findByType(ChatVoiceOverlay).props.cancelled).toBe(false);
  expect(app.text()).toContain('正在聆听'); expect(app.text()).not.toContain('这段录音不会发送');
  expect(app.text()).toContain('点击结束转文字'); expect(app.text()).not.toContain('松开转文字，上滑取消');
  await app.press('结束录音');
  expect(platform.stopRecording).toHaveBeenCalledTimes(2);
  expect(app.api.upload).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('明天下午提醒我开会。'); expect(app.api.chat).not.toHaveBeenCalled();
  await app.unmount();
});

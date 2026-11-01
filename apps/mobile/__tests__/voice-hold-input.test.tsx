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
    pickDocument: jest.fn().mockResolvedValue({ uri: 'file:///receipt.png', name: 'receipt.png', mime_type: 'image/png', size: 128 }),
    prepareChatImage: jest.fn(async (file: any) => file),
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
    analyzeImage: jest.fn().mockResolvedValue({ upload_id: 'image-upload', text: '一张测试收据', model: 'synthetic-vision' }),
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
  let chatState!: ReturnType<typeof createChatEntryState>;
  function Harness({ client }: { client: typeof api }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    return (
      <AppProvider value={{ api: client, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue}>
        <React.Fragment key={navigation.entry.key}>
          {route.name === 'chat' ? <ChatScreen
            conversationId={route.conversationId}
            prompt={route.prompt}
            entryState={chatState = navigation.getEntryState(scope =>
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
        (typeof n.props.onPress === 'function' || typeof n.props.onAccessibilityAction === 'function'),
    )[0];
  return {
    api,
    state: () => chatState,
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
      if (label === '按住说话' && !node(label)) {
        await act(async () => node('切换语音输入').props.onPress());
      }
      await act(async () => {
        const control = node(label);
        if (control.props.onAccessibilityAction) control.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        else await control.props.onPress();
      });
    },
    start: async (label: string) => {
      await act(async () => {
        const control = node(label);
        if (control.props.onAccessibilityAction) control.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        else void control.props.onPress();
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

test('hold release transcribes once and automatically sends its text once', async () => {
  const app = await setup(); await hold(app);
  await act(async () => { gestureNode(app).props.onResponderRelease(); });
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('明天下午提醒我开会。', undefined, expect.any(String), []);
  expect(app.text()).not.toContain('voice.m4a'); await app.unmount();
});

test('voice mode has one accessible central control and no legacy recorder or send buttons', async () => {
  const app = await setup(); await app.press('切换语音输入');
  let control = gestureNode(app);
  expect(control.props.accessible).toBe(true);
  expect(control.props.accessibilityRole).toBe('button');
  expect(control.props.accessibilityLabel).toBe('按住说话');
  for (const label of ['开始录音', '结束录音', '发送消息']) {
    expect(app.tree().root.findAll(node => node.props.accessibilityLabel === label)).toHaveLength(0);
  }
  await act(async () => control.props.onAccessibilityTap());
  control = gestureNode(app);
  expect(control.props.accessibilityLabel).toBe('松开发送');
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  await act(async () => control.props.onAccessibilityTap());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1); expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe(''); expect(app.text()).not.toContain('voice.m4a');
  await app.unmount();
});

test('a selected image uses the prepared local analysis copy while voice sends only text plus image ID', async () => {
  const app = await setup();
  const prepared = { uri: 'file:///prepared.jpg', name: 'prepared.jpg', mime_type: 'image/jpeg', size: 64 };
  (platform.prepareChatImage as jest.Mock).mockResolvedValueOnce(prepared);
  app.api.upload.mockImplementation(async (file: any) => ({ id: file.mime_type.startsWith('image/') ? 'image-upload' : 'voice-upload', name: file.name }));
  await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(platform.prepareChatImage).toHaveBeenCalledTimes(1);
  expect(app.api.upload).toHaveBeenCalledWith(prepared, expect.any(AbortSignal));
  expect(app.api.chat).toHaveBeenCalledWith('明天下午提醒我开会。', undefined, expect.any(String), ['image-upload']);
  await app.unmount();
});

test('removing the image during native preparation prevents its late upload and any partial auto-send', async () => {
  const app = await setup(); let finish!: (file: any) => void;
  (platform.prepareChatImage as jest.Mock).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  await app.press('移除附件');
  await act(async () => finish({ uri: 'file:///late.jpg', name: 'late.jpg', mime_type: 'image/jpeg', size: 64 }));
  expect(app.api.upload.mock.calls.every(([file]: any[]) => !file.mime_type.startsWith('image/'))).toBe(true);
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.value()).toContain('明天下午提醒我开会。'); await app.unmount();
});

test('an image picked before speech is prepared and sent with the recognized question, never the audio ID', async () => {
  const app = await setup();
  app.api.upload.mockImplementation(async (file: any) => ({ id: file.mime_type.startsWith('image/') ? 'image-upload' : 'voice-upload', name: file.name }));
  await app.input('请看这张图。');
  await app.press('选择附件');
  await hold(app);
  await act(async () => { gestureNode(app).props.onResponderRelease(); });
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('请看这张图。\n明天下午提醒我开会。', undefined, expect.any(String), ['image-upload']);
  expect(app.api.upload).toHaveBeenCalledTimes(2);
  expect(app.value()).toBe('');
  await app.unmount();
});

const useImageUploads = (app: Awaited<ReturnType<typeof setup>>) => app.api.upload.mockImplementation(async (file: any) =>
  ({ id: file.mime_type.startsWith('image/') ? 'image-upload' : 'voice-upload', name: file.name }));

test('sending a picture and then a new voice turn keeps audio out of both immutable chat intents', async () => {
  const app = await setup(); useImageUploads(app);
  await app.press('选择附件');
  await app.press('发送消息');
  expect(app.api.chat).toHaveBeenNthCalledWith(1, '请描述这张图片的内容。', undefined, expect.any(String), ['image-upload']);
  expect(app.api.analyzeImage).toHaveBeenCalledTimes(1);
  await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).toHaveBeenNthCalledWith(2, '明天下午提醒我开会。', 'c', expect.any(String), []);
  expect(app.api.chat).toHaveBeenCalledTimes(2);
  expect(app.api.upload).toHaveBeenCalledTimes(2);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.text()).not.toContain('voice.m4a');
  await app.unmount();
});

test('an already uploaded picture still needs image analysis, never audio transcription of the picture', async () => {
  const app = await setup(); useImageUploads(app);
  await app.press('选择附件');
  await act(async () => app.state().update(old => ({ ...old, attachment: old.attachment && {
    ...old.attachment, upload: { id: 'image-upload', name: 'receipt.png', mime_type: 'image/png', size: 128, uri: '', created_at: '' },
  } })));
  await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.analyzeImage).toHaveBeenCalledWith('image-upload', expect.anything());
  expect(app.api.transcribe).toHaveBeenCalledWith('voice-upload', expect.anything());
  expect(app.api.chat).toHaveBeenCalledWith('明天下午提醒我开会。', undefined, expect.any(String), ['image-upload']);
  await app.unmount();
});

test('ASR failure keeps the picture and typed draft; explicit retry reuses recording upload and sends once', async () => {
  const app = await setup(); useImageUploads(app);
  app.api.transcribe.mockRejectedValueOnce(new Error('ASR unavailable'));
  await app.input('已有文字'); await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.api.analyzeImage).not.toHaveBeenCalled();
  expect(app.value()).toBe('已有文字'); expect(app.state().getSnapshot().attachment?.file.name).toBe('receipt.png');
  expect(app.text()).toContain('ASR unavailable'); expect(app.text()).not.toContain('voice.m4a');
  await app.button('重试识别并发送');
  expect(app.api.upload).toHaveBeenCalledTimes(2); expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('已有文字\n明天下午提醒我开会。', undefined, expect.any(String), ['image-upload']);
  await app.unmount();
});

test('image analysis failure preserves recognized speech; retry reuses both uploads and does not pay for another ASR', async () => {
  const app = await setup(); useImageUploads(app);
  app.api.analyzeImage.mockRejectedValueOnce(new Error('Vision unavailable'));
  await app.input('已有文字'); await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.value()).toBe('已有文字');
  expect(app.text()).toContain('已识别：'); expect(app.text()).toContain('明天下午提醒我开会。');
  expect(app.state().getSnapshot().attachment?.upload?.id).toBe('image-upload');
  await app.button('重试发送');
  expect(app.api.upload).toHaveBeenCalledTimes(2); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.analyzeImage).toHaveBeenCalledTimes(2); expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('已有文字\n明天下午提醒我开会。', undefined, expect.any(String), ['image-upload']);
  await app.unmount();
});

test('image upload failure keeps the successful ASR and retries only the missing picture upload', async () => {
  const app = await setup(); useImageUploads(app);
  app.api.upload.mockResolvedValueOnce({ id: 'voice-upload', name: 'voice.m4a' }).mockRejectedValueOnce(new Error('Picture upload failed'));
  await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.text()).toContain('Picture upload failed');
  await app.button('重试发送');
  expect(app.api.upload).toHaveBeenCalledTimes(3); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledTimes(1); await app.unmount();
});

test('a changed draft during recognition retains both texts instead of automatically sending the edited draft', async () => {
  const app = await setup(); let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await app.input('Original'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  await app.input('User edited');
  await act(async () => resolve({ text: 'Recognized speech' }));
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.value()).toBe('User edited\nRecognized speech');
  expect(app.text()).toContain('输入内容已变化'); await app.unmount();
});

test('removing the image during analysis never sends the picture or silently sends speech without it', async () => {
  const app = await setup(); useImageUploads(app); let resolve!: (value: any) => void;
  app.api.analyzeImage.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  await app.press('移除附件');
  await act(async () => resolve({ text: 'Late image result' }));
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.value()).toBe('明天下午提醒我开会。');
  expect(app.state().getSnapshot().attachment).toBeNull(); await app.unmount();
});

test('a retained hold ASR completing in history becomes a draft and never sends from the detached view', async () => {
  const app = await setup(); let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await hold(app); await act(async () => gestureNode(app).props.onResponderRelease());
  await app.history(); await act(async () => resolve({ text: 'Speech retained offscreen' }));
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.back(); expect(app.value()).toBe('Speech retained offscreen');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1); await app.unmount();
});

test('owner replacement during hold ASR cannot send late speech to either account', async () => {
  const app = await setup(); let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await hold(app); await act(async () => gestureNode(app).props.onResponderRelease());
  await app.owner(); await act(async () => resolve({ text: 'Old account speech' }));
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.text()).not.toContain('Old account speech');
  await app.unmount();
});

test('cancel after hold release aborts recognition and cannot revive a late automatic send', async () => {
  const app = await setup(); let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await hold(app); await act(async () => gestureNode(app).props.onResponderRelease());
  await app.press('取消语音转写');
  expect((app.api.transcribe.mock.calls[0] as unknown as [string, AbortSignal])[1].aborted).toBe(true);
  await act(async () => resolve({ text: 'Must not send' }));
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.value()).toBe(''); await app.unmount();
});

test('empty speech does not send the selected image as an unintended image-only turn', async () => {
  const app = await setup(); useImageUploads(app); app.api.transcribe.mockResolvedValueOnce({ text: '  ' });
  await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.api.analyzeImage).not.toHaveBeenCalled();
  expect(app.state().getSnapshot().attachment?.file.name).toBe('receipt.png');
  expect(app.text()).toContain('未听清语音'); await app.unmount();
});

test('a failed send retries the existing chat request rather than recording or recognizing again', async () => {
  const app = await setup(); app.api.chat.mockRejectedValueOnce(new Error('Network lost'));
  await hold(app); await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.chat).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  const requestId = app.api.chat.mock.calls[0][2];
  await app.button('重试');
  expect(app.api.chat).toHaveBeenCalledTimes(2);
  expect(app.api.chat.mock.calls[1][2]).toBe(requestId);
  expect(app.api.upload).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('release before native permission/start resolves stops without transcribing or sending empty audio', async () => {
  let resolve!: () => void;
  (platform.startRecording as jest.Mock).mockImplementationOnce(() => new Promise<void>(r => { resolve=r; }));
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(platform.stopRecording).not.toHaveBeenCalled();
  await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).not.toHaveBeenCalled();
  expect(app.api.chat).not.toHaveBeenCalled();
  expect(app.value()).toBe(''); await app.unmount();
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
  const button=gestureNode(app);
  expect(button.props.accessibilityState.disabled).toBe(true);
  await act(async () => { button.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }); gestureNode(app).props.onResponderGrant(event(200)); });
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1); expect(app.api.transcribe).not.toHaveBeenCalled(); await app.unmount();
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
  await act(async () => touch().props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
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

test('cancelled hold cannot label a later accessible activation as cancelled and the central control still sends', async () => {
  const app = await setup(); await hold(app);
  await act(async () => gestureNode(app).props.onResponderMove(event(100)));
  expect(app.tree().root.findByType(ChatVoiceOverlay).props.cancelled).toBe(true);
  expect(gestureNode(app).props.accessibilityLabel).toBe('松开取消');
  expect(gestureNode(app).props.accessibilityActions[0].label).toBe('取消这段录音');
  expect(gestureNode(app).props.accessibilityHint).toBe('再次激活取消这段录音。');
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.api.upload).not.toHaveBeenCalled(); expect(app.api.transcribe).not.toHaveBeenCalled();
  await app.press('按住说话');
  expect(app.tree().root.findByType(ChatVoiceOverlay).props.cancelled).toBe(false);
  expect(app.text()).toContain('正在聆听'); expect(app.text()).not.toContain('这段录音不会发送');
  expect(app.text()).toContain('松开发送，上滑取消'); expect(app.text()).not.toContain('点击结束转文字');
  await app.press('松开发送');
  expect(platform.stopRecording).toHaveBeenCalledTimes(2);
  expect(app.api.upload).toHaveBeenCalledTimes(1); expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe(''); expect(app.api.chat).toHaveBeenCalledTimes(1);
  await app.unmount();
});

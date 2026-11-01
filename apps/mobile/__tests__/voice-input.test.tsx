import { addChatStreamMock } from '../test/chatStreamMock';
import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
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
        (typeof n.props.onPress === 'function' || typeof n.props.onAccessibilityAction === 'function'),
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

test('two screen-reader activations of the central control transcribe and send text without an audio attachment', async () => {
  const app = await setup();
  await app.press('按住说话');
  await app.press('松开发送');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledWith(
    'voice-upload',
    expect.anything(),
  );
  expect(app.value()).toBe('');
  expect(app.text()).not.toContain('voice.m4a');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith(
    '明天下午提醒我开会。',
    undefined,
    expect.any(String),
    [],
  );
  await app.unmount();
});

test('dictation appends to text typed while recognition is pending', async () => {
  const app = await setup();
  let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      }),
  );
  await app.press('按住说话');
  await app.start('松开发送');
  await app.input('这是我原先写的内容。');
  await act(async () => resolve({ text: '语音补充。' }));
  expect(app.value()).toBe('这是我原先写的内容。\n语音补充。');
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.unmount();
});

test('transcription failure retains the recording and retry reuses its upload', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('识别暂时失败'));
  await app.press('按住说话');
  await app.press('松开发送');
  expect(app.value()).toBe('');
  expect(app.text()).toContain('识别暂时失败');
  await app.button('重试识别并发送');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('cancelled recognition cannot insert late text or send it', async () => {
  const app = await setup();
  let resolve!: (value: { text: string }) => void;
  app.api.transcribe.mockImplementationOnce(
    () =>
      new Promise(r => {
        resolve = r;
      }),
  );
  await app.press('按住说话');
  await app.start('松开发送');
  await app.press('取消语音转写');
  const signal = (
    app.api.transcribe.mock.calls as unknown as [string, AbortSignal][]
  )[0][1];
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ text: '不应插入的内容' }));
  expect(app.value()).toBe('');
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.unmount();
});

test('oversized combined draft preserves recognized text without paying for another transcription', async () => {
  const app = await setup();
  await app.input('字'.repeat(20000));
  await app.press('按住说话');
  await app.press('松开发送');
  expect(app.value()).toHaveLength(20000);
  await app.input('');
  await app.button('填入文字');
  expect(app.value()).toBe('明天下午提醒我开会。');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a failed transcription survives history/back with its upload and an explicit retry', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('ASR unavailable'));
  await app.input('Keep typed draft');
  await app.press('按住说话');
  await app.press('松开发送');
  await app.history();
  await app.back();
  expect(app.value()).toBe('Keep typed draft');
  expect(app.text()).toContain('ASR unavailable');
  expect(app.buttonLabels()).toContain('重试识别并发送');
  expect(app.text()).not.toContain('正在转成文字');
  expect(app.text()).toContain('转写未完成');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.deleteUpload).not.toHaveBeenCalled();
  await app.button('重试识别并发送');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledWith('Keep typed draft\n明天下午提醒我开会。', undefined, expect.any(String), []);
  expect(app.text()).not.toContain('ASR unavailable');
  await app.unmount();
});

test('a retained ASR continues once through history/back and appends to the current returned draft', async () => {
  const app = await setup();
  const pending = deferred<{ text: string }>();
  app.api.transcribe.mockReturnValueOnce(pending.promise);
  await app.press('按住说话');
  await app.start('松开发送');
  const signal = (app.api.transcribe.mock.calls as unknown as [string, AbortSignal][])[0][1];
  const oldCancel = app.tree().root.findAll(n =>
    n.props.accessibilityLabel === '取消语音转写' && typeof n.props.onPress === 'function')[0].props.onPress;
  await app.history();
  expect(signal.aborted).toBe(false);
  await app.back();
  expect(app.text()).toContain('正在转成文字');
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await act(async () => oldCancel());
  expect(signal.aborted).toBe(false);
  expect(app.text()).toContain('正在转成文字');
  await app.input('Edited after returning');
  await act(async () => pending.resolve({ text: 'Single authorized response' }));
  expect(app.value()).toBe('Edited after returning\nSingle authorized response');
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('an aborted earlier ASR cannot delete the upload or replace a newer retry phase', async () => {
  const app = await setup();
  const old = deferred<{ text: string }>();
  const fresh = deferred<{ text: string }>();
  app.api.transcribe.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  app.api.upload.mockResolvedValueOnce({ id: 'old-upload', name: 'old.m4a' })
    .mockResolvedValueOnce({ id: 'new-upload', name: 'new.m4a' });
  await app.press('按住说话');
  await app.start('松开发送');
  await app.history();
  await app.back();
  await app.press('取消语音转写');
  await app.press('按住说话');
  await app.start('松开发送');
  expect(app.text()).toContain('正在转成文字');
  await act(async () => old.resolve({ text: 'Old response' }));
  expect(app.value()).toBe('');
  expect(app.text()).toContain('正在转成文字');
  expect(app.api.deleteUpload).not.toHaveBeenCalledWith('new-upload');
  await act(async () => fresh.resolve({ text: 'Fresh response' }));
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledWith('Fresh response', undefined, expect.any(String), []);
  expect(app.api.upload).toHaveBeenCalledTimes(2);
  expect(app.api.deleteUpload).toHaveBeenCalledWith('new-upload');
  await app.unmount();
});

test('an upload already in progress finishes into its retained recording without another upload', async () => {
  const app = await setup();
  const old = deferred<{ id: string; name: string }>();
  app.api.upload.mockReturnValueOnce(old.promise);
  await app.press('按住说话');
  await app.start('松开发送');
  const signal = (app.api.upload.mock.calls as unknown as [unknown, AbortSignal][])[0][1];
  await app.history();
  await app.back();
  expect(signal.aborted).toBe(false);
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  expect(app.api.transcribe).not.toHaveBeenCalled();
  await act(async () => old.resolve({ id: 'orphan-old-upload', name: 'voice.m4a' }));
  expect(app.api.deleteUpload).toHaveBeenCalledWith('orphan-old-upload');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('明天下午提醒我开会。');
  await app.unmount();
});

test('recognized text that exceeds draft capacity survives navigation and inserts without another ASR', async () => {
  const app = await setup();
  await app.input('字'.repeat(19990));
  await app.press('按住说话');
  await app.press('松开发送');
  expect(app.buttonLabels()).toContain('填入文字');
  await app.history();
  await app.back();
  expect(app.value()).toHaveLength(19990);
  expect(app.buttonLabels()).toContain('填入文字');
  expect(app.text()).toContain('文字已识别');
  expect(app.text()).not.toContain('转写已暂停');
  expect(app.api.deleteUpload).not.toHaveBeenCalled();
  await app.input('Shortened draft');
  await app.button('填入文字');
  expect(app.value()).toBe('Shortened draft\n明天下午提醒我开会。');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
  await app.history();
  await app.back();
  expect(app.buttonLabels()).not.toContain('填入文字');
  expect(app.text()).not.toContain('文字已识别');
  await app.unmount();
});

test('cancelling a restored voice clears its phase and late ASR cannot revive it', async () => {
  const app = await setup();
  const old = deferred<{ text: string }>();
  app.api.transcribe.mockReturnValueOnce(old.promise);
  await app.press('按住说话');
  await app.start('松开发送');
  await app.history();
  await app.back();
  await app.press('取消语音转写');
  await act(async () => old.resolve({ text: 'Cancelled old text' }));
  expect(app.value()).toBe('');
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  expect(app.text()).not.toContain('转写已暂停');
  expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
  await app.press('按住说话');
  await app.press('松开发送');
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.text()).not.toContain('Cancelled old text');
  await app.unmount();
});

test.each(['pop', 'reset', 'owner'] as const)(
  '%s discards the old voice and late ASR cannot alter a fresh owner or entry',
  async reason => {
    const app = await setup();
    const old = deferred<{ text: string }>();
    app.api.transcribe.mockReturnValueOnce(old.promise);
    await app.press('按住说话');
    await app.start('松开发送');
    if (reason === 'pop') {
      await app.back();
      await app.anotherChat();
    } else if (reason === 'reset') await app.reset();
    else await app.owner();
    await app.input('New draft');
    await act(async () => old.resolve({ text: 'Previous owner text' }));
    expect(app.value()).toBe('New draft');
    expect(app.buttonLabels()).not.toContain('重试识别并发送');
    expect(app.text()).not.toContain('Previous owner text');
    expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
    await app.unmount();
  },
);

test('a different chat does not inherit the recording and active recording still stops on navigation', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('Retain this voice'));
  await app.press('按住说话');
  await app.press('松开发送');
  await app.history();
  await app.anotherChat();
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  await app.press('按住说话');
  const stopped = (platform.stopRecording as jest.Mock).mock.calls.length;
  await app.back();
  expect(platform.stopRecording).toHaveBeenCalledTimes(stopped + 1);
  await app.back();
  expect(app.buttonLabels()).toContain('重试识别并发送');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('a retained ASR can complete while history is visible and returns its final editable text', async () => {
  const app = await setup();
  const pending = deferred<{ text: string }>();
  app.api.transcribe.mockReturnValueOnce(pending.promise);
  await app.press('按住说话');
  await app.start('松开发送');
  await app.history();
  await act(async () => pending.resolve({ text: 'Completed while hidden' }));
  await app.back();
  expect(app.value()).toBe('Completed while hidden');
  expect(app.buttonLabels()).not.toContain('重试识别并发送');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('a pending ASR checks the latest returned draft capacity and preserves overflow for manual insertion', async () => {
  const app = await setup();
  const pending = deferred<{ text: string }>();
  app.api.transcribe.mockReturnValueOnce(pending.promise);
  await app.press('按住说话');
  await app.start('松开发送');
  await app.history();
  await app.back();
  await app.input('字'.repeat(19999));
  await act(async () => pending.resolve({ text: 'Recognized text' }));
  expect(app.value()).toHaveLength(19999);
  expect(app.buttonLabels()).toContain('填入文字');
  await app.input('Shortened');
  await app.button('填入文字');
  expect(app.value()).toBe('Shortened\nRecognized text');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test.each(['reset', 'owner'] as const)(
  '%s disposes a hidden retained ASR even when its chat screen is already unmounted',
  async reason => {
    const app = await setup();
    const pending = deferred<{ text: string }>();
    app.api.transcribe.mockReturnValueOnce(pending.promise);
    await app.press('按住说话');
    await app.start('松开发送');
    const signal = (app.api.transcribe.mock.calls as unknown as [string, AbortSignal][])[0][1];
    await app.history();
    expect(signal.aborted).toBe(false);
    if (reason === 'reset') await app.reset();
    else { await app.owner(); await app.back(); }
    expect(signal.aborted).toBe(true);
    await app.input('Fresh owner draft');
    await act(async () => pending.resolve({ text: 'Disposed result' }));
    expect(app.value()).toBe('Fresh owner draft');
    expect(app.text()).not.toContain('Disposed result');
    expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
    await app.unmount();
  },
);

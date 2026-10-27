import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatScreen } from '../src/screens/Chat';
import { AppProvider, AppContextValue } from '../src/app/context';
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
  let tree: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider
        value={
          {
            api,
            invalidate: jest.fn(),
            formatDate: () => '',
          } as unknown as AppContextValue
        }
      >
        <ChatScreen />
      </AppProvider>,
    );
  });
  const node = (label: string) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0];
  return {
    api,
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
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}

test('stopping recording automatically transcribes to an editable draft, without sending audio or chat', async () => {
  const app = await setup();
  await app.press('开始录音');
  await app.press('结束录音');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledWith(
    'voice-upload',
    expect.anything(),
  );
  expect(app.value()).toBe('明天下午提醒我开会。');
  expect(app.text()).not.toContain('voice.m4a');
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.press('发送消息');
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
  await app.press('开始录音');
  await app.start('结束录音');
  await app.input('这是我原先写的内容。');
  await act(async () => resolve({ text: '语音补充。' }));
  expect(app.value()).toBe('这是我原先写的内容。\n语音补充。');
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.unmount();
});

test('transcription failure retains the recording and retry reuses its upload', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('识别暂时失败'));
  await app.press('开始录音');
  await app.press('结束录音');
  expect(app.value()).toBe('');
  expect(app.text()).toContain('识别暂时失败');
  await app.button('重试转写');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.value()).toBe('明天下午提醒我开会。');
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
  await app.press('开始录音');
  await app.start('结束录音');
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
  await app.press('开始录音');
  await app.press('结束录音');
  expect(app.value()).toHaveLength(20000);
  await app.input('');
  await app.button('填入文字');
  expect(app.value()).toBe('明天下午提醒我开会。');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

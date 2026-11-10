import { addChatStreamMock } from '../test/chatStreamMock';
import React from 'react';
import { Keyboard, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { ChatVoiceOverlay } from '../src/ui/ChatVoiceOverlay';
import { AppProvider, AppContextValue } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';
import { ApiError } from '../src/api/client';
import { ChatVoiceRecovery } from '../src/ui/ChatVoiceRecovery';

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

async function setup(preferences: { reviewVoiceTranscript?: boolean } = { reviewVoiceTranscript: false }) {
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
  const { chatStream } = addChatStreamMock(api);
  let navigation!: ReturnType<typeof useRouteStack>;
  let chatState!: ReturnType<typeof createChatEntryState>;
  function Harness({ client }: { client: typeof api }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    return (
      <AppProvider value={{ api: client, preferences, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue}>
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
    chatStream,
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
      if (label === '选择附件') {
        await act(async () => node('选择文件').props.onPress());
      }
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
        const control = tree.root
          .findAllByType(Button)
          .find(n => n.props.children === label) ?? tree.root.findAll(n =>
            n.props.accessibilityLabel === (label === '重试' ? '重试回复' : label) && typeof n.props.onPress === 'function')[0];
        await control.props.onPress();
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

test('by default hold release transcribes once and automatically sends its text once', async () => {
  const app = await setup({}); await hold(app);
  await act(async () => { gestureNode(app).props.onResponderRelease(); });
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('明天下午提醒我开会。', undefined, expect.any(String), []);
  expect(app.text()).not.toContain('voice.m4a'); await app.unmount();
});

test.each(['语音', '图片'])('%s发出后，AI 仍在回答时可以修改原消息', async source => {
  const app = await setup();
  let finish!: () => void;
  const reply = new Promise<void>(resolve => { finish = resolve; });
  app.chatStream.mockImplementationOnce(async (intent, receive) => {
    const question = { id: 'submitted', conversation_id: 'c', role: 'user',
      content: intent.message, created_at: '2026-11-09T05:57:00Z' };
    receive({ id: 1, event: 'accepted', data: { conversation_id: 'c', user_message: question, message_id: 'reply' } });
    receive({ id: 2, event: 'text_delta', data: { delta: '正在生成的回复' } });
    await reply;
  });
  const measure = jest.spyOn(View.prototype, 'measureInWindow').mockImplementation(callback => callback(160, 400, 200, 50));
  try {
    if (source === '语音') {
      await hold(app);
      await act(async () => { gestureNode(app).props.onResponderRelease(); });
    } else {
      await app.input('帮我看看图片');
      await app.press('选择附件');
      await app.start('发送消息');
    }
    const snapshot = app.state().getSnapshot();
    expect(snapshot.sending).toBe(true);
    const sent = snapshot.messages.find(message => message.id === 'submitted')!;
    const bubble = app.tree().root.findAll(n =>
      n.props.testID === `chat-message-${sent.client_key}` && typeof n.props.onLongPress === 'function')[0];
    await act(async () => bubble.props.onLongPress({ nativeEvent: { pageX: 340, pageY: 620 } }));
    const edit = app.tree().root.findAll(n => n.props.accessibilityLabel === '修改' && typeof n.props.onPress === 'function')[0];
    expect(edit.props.disabled).toBe(false);
    await app.press('修改');
    expect(app.value()).toBe(sent.content);
    await app.input('更正后的问题');
    expect(app.value()).toBe('更正后的问题');
    expect(app.state().getSnapshot().sending).toBe(true);
    expect(app.chatStream).toHaveBeenCalledTimes(1);
  } finally {
    await app.unmount();
    finish();
    measure.mockRestore();
  }
});

test('the review preference fills a long transcript for correction before sending', async () => {
  const app = await setup({ reviewVoiceTranscript: true }); await hold(app);
  expect(gestureNode(app).props.accessibilityLabel).toBe('松开转文字');
  const transcript = '我想把这段转写完整地保留在输入框里，检查清楚之后再点击发送。';
  app.api.transcribe.mockResolvedValueOnce({ text: transcript });
  await act(async () => { gestureNode(app).props.onResponderRelease(); });
  expect(app.value()).toBe(transcript);
  expect(StyleSheet.flatten(app.tree().root.findByType(TextInput).props.style).width).toBe('100%');
  expect(app.api.chat).not.toHaveBeenCalled();
  await app.input('明天上午提醒我开会。');
  await app.press('发送消息');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('明天上午提醒我开会。', undefined, expect.any(String), []);
  await app.unmount();
});

test('compact recording hides secondary tools without remounting the held control or losing the draft', async () => {
  const app = await setup();
  await app.input('已有草稿');
  await app.press('切换语音输入');
  const beforeHold = gestureNode(app);
  const input = app.tree().root.findByType(TextInput);
  await act(async () => beforeHold.props.onResponderGrant(event(200)));
  expect(gestureNode(app)).toBe(beforeHold);
  expect(app.tree().root.findByType(TextInput)).toBe(input);
  const secondary = app.tree().root.findAll(n => n.props.testID === 'chat-composer-secondary')[0];
  expect(StyleSheet.flatten(secondary.props.style).display).toBe('none');
  for (const label of ['拍照', '选择附件', '切换文字输入']) {
    const tool = app.tree().root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
    expect(tool).toBeUndefined();
  }
  const composer = app.tree().root.findAllByType(ScrollView).find(n => n.props.testID === 'chat-composer-scroll')!;
  expect(composer.props.scrollEnabled).toBe(false);
  await act(async () => composer.props.onLayout({ nativeEvent: { layout: { height: 78 } } }));
  expect(app.tree().root.findByType(ChatVoiceOverlay).props.composerHeight).toBe(78);
  const overlay = app.tree().root.findAll(n => n.props.testID === 'chat-voice-overlay')[0];
  expect(StyleSheet.flatten(overlay.props.style).bottom).toBe(0);
  const bar = app.tree().root.findAll(n => n.props.testID === 'unified-input-bar')[0];
  expect(StyleSheet.flatten(bar.props.style)).toMatchObject({ backgroundColor: 'transparent', elevation: 0 });
  await act(async () => gestureNode(app).props.onResponderMove(event(100)));
  await act(async () => gestureNode(app).props.onResponderRelease());
  expect(app.value()).toBe('已有草稿');
  expect(app.tree().root.findByType(TextInput)).toBe(input);
  expect(gestureNode(app)).toBe(beforeHold);
  expect(app.api.transcribe).not.toHaveBeenCalled();
  expect(app.tree().root.findAllByType(ScrollView).find(n => n.props.testID === 'chat-composer-scroll')!.props.scrollEnabled).toBe(true);
  await app.press('切换文字输入');
  for (const label of ['拍照', '选择附件', '切换语音输入', '发送消息']) {
    const tool = app.tree().root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
    expect(tool.props.disabled).toBe(false);
  }
  expect(app.tree().root.findByType(TextInput)).toBe(input);
  expect(app.value()).toBe('已有草稿');
  await app.unmount();
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

test('ASR quota recovery stays outside clipped support and allows an explicit quota recheck after admin changes', async () => {
  const app = await setup(); useImageUploads(app);
  jest.setSystemTime(new Date('2026-11-01T14:20:00Z'));
  app.api.transcribe.mockRejectedValueOnce(new ApiError('asr_user_daily_limit', 'quota message from server', 429, 3600));
  await app.input('已有文字'); await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  const card = app.tree().root.findByType(ChatVoiceRecovery);
  const ancestors: string[] = [];
  let ancestor = card.parent;
  while (ancestor) { if (ancestor.props.testID) ancestors.push(ancestor.props.testID); ancestor = ancestor.parent; }
  expect(ancestors).toContain('chat-composer-content');
  expect(ancestors).not.toContain('chat-composer-support');
  expect(card.findAllByType(Button)).toHaveLength(1);
  expect(app.text()).toContain('你的语音识别额度暂时用完了');
  expect(app.text()).toContain('预计额度恢复');
  expect(app.text()).not.toContain('quota message from server');
  expect(app.state().getSnapshot().draft).toBe('已有文字');
  expect(app.state().getSnapshot().attachment?.file.name).toBe('receipt.png');
  expect(app.state().getSnapshot().voice?.upload?.id).toBe('voice-upload');
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(120000));
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.chat).not.toHaveBeenCalled();
  // Advisory reset time does not block an administrator's immediate quota fix.
  await app.button('重新检查额度');
  expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.api.transcribe.mock.calls.every(call => call[0] === 'voice-upload')).toBe(true);
  expect(app.api.upload).toHaveBeenCalledTimes(2); // Original recording plus image, not another recording.
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.tree().root.findAllByType(ChatVoiceRecovery)).toHaveLength(0);
  await app.unmount();
});

test.each([
  ['asr_busy', 503], ['asr_in_progress', 429], ['asr_retry_required', 409],
  ['asr_provider_auth', 502], ['asr_provider_quota', 502], ['asr_provider_rate_limited', 503],
  ['asr_provider_unavailable', 503], ['asr_timeout', 504], ['network', 0], ['rate_limited', 429],
])('ASR %s never automatically posts again and preserves the uploaded recording', async (code, status) => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new ApiError(String(code), 'provider response must not be repeated', Number(status), 2));
  await hold(app); await act(async () => gestureNode(app).props.onResponderRelease());
  await act(async () => jest.advanceTimersByTime(180000));
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.state().getSnapshot().voice?.upload?.id).toBe('voice-upload');
  expect(app.api.chat).not.toHaveBeenCalled();
  expect(app.text()).not.toContain('provider response must not be repeated');
  expect(app.tree().root.findByType(ChatVoiceRecovery).findAllByType(Button)).toHaveLength(1);
  await app.unmount();
});

test('discard after an ASR failure deletes only its recording once and immediately unblocks typed text plus the image', async () => {
  const app = await setup(); useImageUploads(app);
  app.api.transcribe.mockRejectedValueOnce(new ApiError('asr_global_daily_limit', 'global quota', 429, 3600));
  await app.input('继续发这段文字'); await app.press('选择附件'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  await app.press('取消语音转写');
  expect(app.api.deleteUpload).toHaveBeenCalledTimes(1);
  expect(app.api.deleteUpload).toHaveBeenCalledWith('voice-upload');
  expect(app.state().getSnapshot().voice).toBeNull();
  expect(app.value()).toBe('继续发这段文字');
  expect(app.state().getSnapshot().attachment?.file.name).toBe('receipt.png');
  await app.press('发送消息');
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  expect(app.api.chat).toHaveBeenCalledWith('继续发这段文字', undefined, expect.any(String), ['image-upload']);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  await app.unmount();
});

test('quota recovery survives History without a new upload or an automatic retry', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new ApiError('asr_user_daily_limit', 'quota', 429, 60));
  await app.input('保留草稿'); await hold(app);
  await act(async () => gestureNode(app).props.onResponderRelease());
  const retryAt = app.state().getSnapshot().voiceFailure?.retryAt;
  await app.history(); await act(async () => jest.advanceTimersByTime(30000)); await app.back();
  expect(app.state().getSnapshot().voiceFailure?.retryAt).toBe(retryAt);
  expect(app.value()).toBe('保留草稿');
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.tree().root.findAllByType(ChatVoiceRecovery)).toHaveLength(1);
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
  const node = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && (typeof n.props.onPress === 'function' || typeof n.props.onAccessibilityTap === 'function'))[0];
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

import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { MemoryCaptureEditor } from '../src/features/memory/MemoryCaptureEditor';
import { UnifiedInputBar } from '../src/ui/UnifiedInputBar';
import { ErrorNotice } from '../src/ui/components';
import { platform } from '../src/platform/ports';
import { recordingSession } from '../src/platform/recordingSession';
import type { Memory } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({
  platform: {
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest.fn().mockResolvedValue({
      uri: 'file:///voice.m4a',
      name: 'voice.m4a',
      mime_type: 'audio/mp4',
    }),
    capturePhoto: jest.fn().mockResolvedValue({
      uri: 'file:///photo.jpg',
      name: 'photo.jpg',
      mime_type: 'image/jpeg',
    }),
    pickImage: jest.fn().mockResolvedValue({
      uri: 'file:///image.png',
      name: 'image.png',
      mime_type: 'image/png',
    }),
    pickDocument: jest.fn().mockResolvedValue({
      uri: 'file:///note.txt',
      name: 'note.txt',
      mime_type: 'text/plain',
    }),
    prepareChatImage: jest.fn(async file => file),
    readTextFile: jest.fn().mockResolvedValue('每周运动三次。'),
  },
}));
jest.mock('../src/ui/visuals', () => ({
  Icon: () => null,
  AssistantOrb: () => null,
}));
jest.setTimeout(30000);
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.clearAllMocks());
const trees: ReactTestRenderer[] = [];
afterEach(async () => {
  await act(async () => {
    trees.splice(0).forEach(t => t.unmount());
  });
});
const sample = (content = '上午更适合专注工作。', version = 4): Memory => ({
  id: 'm',
  title: '工作习惯',
  content,
  kind: 'preference',
  version,
  source: '用户主动添加',
  created_at: '',
  updated_at: '',
});
const event = (pageY: number) => ({ nativeEvent: { pageY } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { resolve, promise };
}
async function setup(memory?: Memory) {
  let serial = 0;
  const api = {
    upload: jest.fn().mockResolvedValue({ id: 'upload' }),
    transcribe: jest.fn().mockResolvedValue({ text: '重要工作尽量放在上午。' }),
    analyzeImage: jest
      .fn()
      .mockResolvedValue({ text: '我不喝咖啡，更喜欢清淡的茶。' }),
    deleteUpload: jest.fn().mockResolvedValue({ ok: true }),
    saveMemory: jest.fn(async (payload: any, id?: string) => ({
      ...sample(),
      ...payload,
      id: id ?? 'new-' + ++serial,
      version: (payload.version ?? 0) + 1,
    })),
    deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
  };
  const done = jest.fn(),
    invalidate = jest.fn();
  const render = (client: object) => (
    <AppProvider
      value={{ api: client, invalidate } as unknown as AppContextValue}
    >
      <MemoryCaptureEditor memory={memory} onSaved={done} />
    </AppProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(render(api));
  });
  trees.push(tree);
  const find = (label: string) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0];
  const press = async (label: string) => {
    await act(async () => {
      await find(label).props.onPress();
    });
  };
  const type = async (text: string) => {
    if (tree.root.findByType(UnifiedInputBar).props.voiceMode)
      await press('切换文字输入');
    await act(async () =>
      tree.root.findByType(TextInput).props.onChangeText(text),
    );
  };
  const touch = () =>
    tree.root.findAll(
      n => n.props.testID === 'memory-hold-to-talk' && n.props.onResponderGrant,
    )[0];
  const begin = async () => {
    if (!tree.root.findByType(UnifiedInputBar).props.voiceMode)
      await press('切换语音输入');
    await act(async () => touch().props.onResponderGrant(event(200)));
  };
  return {
    tree,
    api,
    done,
    invalidate,
    press,
    type,
    begin,
    touch,
    value: () => tree.root.findByType(TextInput).props.value,
    release: async (cancel = false) => {
      await act(async () =>
        cancel
          ? touch().props.onResponderTerminate()
          : touch().props.onResponderRelease(),
      );
    },
    owner: async (next: object) => {
      await act(async () => tree.update(render(next)));
    },
  };
}

test('one sentence replaces category and title fields; successful save waits for Done', async () => {
  const app = await setup();
  expect(app.tree.root.findAllByType(TextInput)).toHaveLength(1);
  expect(app.tree.root.findByType(UnifiedInputBar).props.voiceMode).toBe(true);
  await app.type('我更喜欢先看到结论。');
  await app.press('记住这件事');
  expect(app.api.saveMemory).toHaveBeenCalledWith(
    expect.objectContaining({
      content: '我更喜欢先看到结论。',
      kind: 'preference',
      title: '我更喜欢先看到结论。',
    }),
    undefined,
  );
  expect(app.done).not.toHaveBeenCalled();
  await app.press('完成记忆保存');
  expect(app.done).toHaveBeenCalledTimes(1);
});

test('hold release uses real upload/transcription contract and never auto-saves memory', async () => {
  const app = await setup();
  await app.begin();
  await app.release();
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledWith('upload', expect.anything());
  expect(app.value()).toBe('重要工作尽量放在上午。');
  expect(app.api.saveMemory).not.toHaveBeenCalled();
  expect(app.api.deleteUpload).toHaveBeenCalledWith('upload');
});

test('slide cancellation keeps typed content and never uploads discarded audio', async () => {
  const app = await setup();
  await app.type('原来的内容');
  await app.begin();
  await act(async () => app.touch().props.onResponderMove(event(100)));
  await app.release();
  expect(app.value()).toBe('原来的内容');
  expect(app.api.upload).not.toHaveBeenCalled();
  expect(recordingSession.active).toBeNull();
});

test('cancelling a pending microphone permission stops late recording without uploading it', async () => {
  const pending = deferred<void>();
  (platform.startRecording as jest.Mock).mockReturnValueOnce(pending.promise);
  const app = await setup();
  await app.begin();
  await app.press('取消识别');
  expect(recordingSession.active).not.toBeNull();
  await act(async () => pending.resolve());
  expect(platform.stopRecording).toHaveBeenCalledTimes(1);
  expect(app.api.upload).not.toHaveBeenCalled();
  expect(recordingSession.active).toBeNull();
});

test('speech failure keeps input and retry reuses uploaded recording', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('ASR 暂时不可用'));
  await app.type('原来的内容');
  await app.begin();
  await app.release();
  expect(app.value()).toBe('原来的内容');
  const error = app.tree.root
    .findAllByType(ErrorNotice)
    .find(n => n.props.message === 'ASR 暂时不可用')!;
  expect(error).toBeDefined();
  await act(async () => error.props.retry());
  expect(app.api.upload).toHaveBeenCalledTimes(1);
  expect(app.api.transcribe).toHaveBeenCalledTimes(2);
  expect(app.value()).toBe('原来的内容\n重要工作尽量放在上午。');
  expect(app.api.saveMemory).not.toHaveBeenCalled();
});

test('camera and text files become reviewable text through the same input bar', async () => {
  const app = await setup();
  await app.press('拍照');
  expect(platform.capturePhoto).toHaveBeenCalledTimes(1);
  expect(app.api.analyzeImage).toHaveBeenCalledWith(
    'upload',
    expect.anything(),
  );
  expect(app.value()).toContain('不喝咖啡');
  await app.press('选择附件');
  await app.press('选择文件');
  expect(platform.readTextFile).toHaveBeenCalledTimes(1);
  expect(app.value()).toContain('每周运动三次');
  expect(app.api.saveMemory).not.toHaveBeenCalled();
});

test('rapid duplicate camera actions open the native camera only once', async () => {
  const app = await setup();
  await act(async () => {
    const bar = app.tree.root.findByType(UnifiedInputBar);
    bar.props.onCamera();
    bar.props.onCamera();
  });
  expect(platform.capturePhoto).toHaveBeenCalledTimes(1);
  expect(app.api.analyzeImage).toHaveBeenCalledTimes(1);
});

test('account replacement ignores late transcription and unlocks a clean input', async () => {
  const late = deferred<{ text: string }>();
  const app = await setup();
  app.api.transcribe.mockReturnValueOnce(late.promise);
  await app.begin();
  await app.release();
  const next = { ...app.api };
  await app.owner(next);
  await act(async () => late.resolve({ text: '旧账号的私有内容' }));
  expect(app.value()).toBe('');
  expect(app.tree.root.findByType(UnifiedInputBar).props.toolsDisabled).toBe(
    false,
  );
  expect(app.api.saveMemory).not.toHaveBeenCalled();
});

test('microphone lease prevents a second input from starting while another owns recording', async () => {
  const first = await setup();
  const second = await setup();
  await first.begin();
  await second.begin();
  expect(platform.startRecording).toHaveBeenCalledTimes(1);
  await first.release(true);
  await second.begin();
  expect(platform.startRecording).toHaveBeenCalledTimes(2);
  await second.release(true);
  expect(recordingSession.active).toBeNull();
});

test('undo and edit use the latest server version and do not create duplicates', async () => {
  const app = await setup(sample());
  await app.type('下午更专注。');
  await app.press('保存修改');
  expect(app.api.saveMemory.mock.calls[0][0]).toEqual(
    expect.objectContaining({ version: 4 }),
  );
  await app.press('撤销这次保存');
  expect(app.api.saveMemory.mock.calls[1][0]).toEqual(
    expect.objectContaining({ version: 5, content: sample().content }),
  );
  await app.type('周五下午复盘。');
  await app.press('保存修改');
  expect(app.api.saveMemory.mock.calls[2][0]).toEqual(
    expect.objectContaining({ version: 6 }),
  );
  expect(app.api.saveMemory.mock.calls.every(call => call[1] === 'm')).toBe(
    true,
  );
});

test('undo creation starts a new creation intent only after deletion succeeds', async () => {
  const app = await setup();
  await app.type('我上午更专注。');
  await app.press('记住这件事');
  const firstId = app.api.saveMemory.mock.calls[0][0].client_request_id;
  await app.press('撤销这次保存');
  await app.press('记住这件事');
  expect(app.api.deleteMemory).toHaveBeenCalledWith('new-1');
  expect(app.api.saveMemory.mock.calls[1][0].client_request_id).not.toBe(
    firstId,
  );
});

test('leaving after failed recognition removes the temporary uploaded recording', async () => {
  const app = await setup();
  app.api.transcribe.mockRejectedValueOnce(new Error('暂时不可用'));
  await app.begin();
  await app.release();
  expect(app.api.deleteUpload).not.toHaveBeenCalled();
  await act(async () => app.tree.unmount());
  trees.splice(trees.indexOf(app.tree), 1);
  expect(app.api.deleteUpload).toHaveBeenCalledWith('upload');
});

test('an overlong combined draft can reuse recognized text without another paid transcription', async () => {
  const app = await setup();
  await app.type('原'.repeat(10000));
  await app.begin();
  await app.release();
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toHaveLength(10000);
  await app.type('缩短后的内容');
  const error = app.tree.root
    .findAllByType(ErrorNotice)
    .find(n => n.props.retry)!;
  await act(async () => error.props.retry());
  expect(app.api.transcribe).toHaveBeenCalledTimes(1);
  expect(app.value()).toBe('缩短后的内容\n重要工作尽量放在上午。');
});

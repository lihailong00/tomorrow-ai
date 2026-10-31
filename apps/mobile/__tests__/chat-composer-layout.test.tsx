import { addChatStreamMock } from '../test/chatStreamMock';
import React from 'react';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { ChatScreen } from '../src/screens/Chat';
import { platform } from '../src/platform/ports';

jest.mock('../src/platform/ports', () => ({
  platform: {
    getSystemFontScale: jest.fn().mockResolvedValue(null),
    pickDocument: jest.fn().mockResolvedValue({
      uri: 'file:///note.txt',
      name: 'note.txt',
      mime_type: 'text/plain',
      size: 42,
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
const mountedTrees = new Set<ReactTestRenderer>();
beforeEach(() => {
  (platform.getSystemFontScale as jest.Mock).mockReset().mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => {
    mountedTrees.forEach(tree => tree.unmount());
  });
  mountedTrees.clear();
});

const reply = {
  conversation_id: 'conversation',
  message: {
    id: 'reply',
    conversation_id: 'conversation',
    role: 'assistant',
    content: 'Received',
    created_at: '',
  },
};

async function setup(fontScale = 1) {
  await act(async () => {
    Dimensions.set({
      window: { width: 360, height: 640, scale: 2.75, fontScale },
    });
  });
  const api = {
    capabilities: jest
      .fn()
      .mockResolvedValue({ runtime: { model_mode: 'local' } }),
    chat: jest.fn().mockResolvedValue(reply),
  };
  addChatStreamMock(api);
  let tree!: ReactTestRenderer;
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
  mountedTrees.add(tree);
  const input = () => tree.root.findByType(TextInput);
  const control = (label: string) =>
    tree.root.findAll(
      node =>
        node.props.accessibilityLabel === label &&
        typeof node.props.onPress === 'function',
    )[0];
  return {
    api,
    input,
    control,
    composer: () =>
      tree.root
        .findAllByType(ScrollView)
        .find(node => node.props.testID === 'chat-composer-scroll')!,
    composerContent: () =>
      tree.root
        .findAllByType(View)
        .find(node => node.props.testID === 'chat-composer-content')!,
    messagePane: () => tree.root.findAllByType(ScrollView)[0],
    inputStyle: () => StyleSheet.flatten(input().props.style),
    async changeOwner() {
      await act(async () => tree.update(
        <AppProvider value={{ api: { ...api }, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue}>
          <ChatScreen />
        </AppProvider>,
      ));
    },
    async layout(height: number) {
      await act(async () => {
        tree.root
          .findAllByType(View)
          .find(node => node.props.onLayout)!
          .props.onLayout({ nativeEvent: { layout: { width: 360, height } } });
      });
    },
    async dimensions(width: number, height: number, nextFontScale: number) {
      await act(async () => {
        Dimensions.set({
          window: { width, height, scale: 2.75, fontScale: nextFontScale },
        });
      });
    },
    async type(text: string) {
      await act(async () => input().props.onChangeText(text));
    },
    async press(label: string) {
      await act(async () => control(label).props.onPress());
    },
    async close() {
      await act(async () => tree.unmount());
      mountedTrees.delete(tree);
    },
  };
}

test.each([
  [1, 44],
  [2, 64],
])(
  'small-phone keyboard viewport keeps a complete single line at font scale %s',
  async (fontScale, minimum) => {
    const app = await setup(fontScale);
    // The keyboard leaves a short chat viewport on the 360 x 640 dp phone.
    await app.layout(180);
    await app.type('Agjpqy TEST');

    expect(app.inputStyle().minHeight).toBe(minimum);
    expect(app.inputStyle().maxHeight).toBeGreaterThanOrEqual(minimum);
    expect(app.input().props.value).toBe('Agjpqy TEST');
    expect(app.inputStyle().fontSize).toBe(16);
    expect(app.inputStyle().lineHeight).toBeUndefined();
    expect(app.inputStyle().includeFontPadding).toBe(true);
    for (const label of ['选择附件', '切换语音输入', '发送消息']) {
      const button = app.control(label);
      expect(button.props.disabled).toBe(false);
      expect(StyleSheet.flatten(button.props.style)).toMatchObject({
        width: 44,
        height: 44,
      });
    }
    await app.close();
  },
);

test('font, keyboard, and rotation changes resize the composer without replacing its draft', async () => {
  const app = await setup();
  await app.layout(180);
  await app.type('Keep this draft while changing display settings.');
  expect(app.inputStyle().maxHeight).toBe(44);

  // A font-only Dimensions event must take effect without a new root layout.
  await app.dimensions(360, 640, 2);
  expect(app.inputStyle().minHeight).toBe(64);
  expect(app.inputStyle().maxHeight).toBe(64);
  await app.layout(500);
  expect(app.inputStyle().maxHeight).toBe(110);
  await app.dimensions(640, 360, 2);
  await app.layout(160);
  expect(app.inputStyle().maxHeight).toBe(64);
  await app.dimensions(640, 360, 1);
  expect(app.inputStyle().minHeight).toBe(44);
  expect(app.inputStyle().maxHeight).toBe(44);
  expect(app.input().props.value).toBe(
    'Keep this draft while changing display settings.',
  );
  await app.close();
});

test('large-font multiline drafts scroll in a bounded input and send every line', async () => {
  const app = await setup(2);
  await app.layout(180);
  expect(app.control('发送消息').props.disabled).toBe(true);
  const draft = Array.from(
    { length: 6 },
    (_, index) => `Line ${index + 1}: Agjpqy TEST 这是需要完整发送的内容。`,
  ).join('\n');
  await app.type(draft);
  expect(app.input().props).toMatchObject({
    value: draft,
    multiline: true,
    scrollEnabled: true,
    editable: true,
  });
  expect(app.inputStyle().maxHeight).toBe(64);
  expect(app.control('发送消息').props.disabled).toBe(false);

  let finish!: (value: typeof reply) => void;
  let sending!: Promise<void>;
  app.api.chat.mockReturnValueOnce(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  await act(async () => {
    sending = app.control('发送消息').props.onPress();
  });
  expect(app.api.chat).toHaveBeenCalledWith(
    draft,
    undefined,
    expect.any(String),
    [],
  );
  expect(app.input().props.value).toBe('');
  expect(app.input().props.editable).toBe(true);
  expect(app.inputStyle().maxHeight).toBe(64);
  for (const label of ['选择附件', '发送消息']) {
    expect(app.control(label).props.disabled).toBe(true);
  }
  // Changing presentation is safe during a reply; actually starting a recorder
  // must remain blocked through both gesture and accessible button paths.
  await app.press('切换语音输入');
  const hold = app.composer().findAll(node => node.props.testID === 'chat-hold-to-talk')[0];
  expect(hold.props.onStartShouldSetResponder()).toBe(false);
  expect(app.control('开始录音').props.disabled).toBe(true);
  await app.press('切换文字输入');
  await act(async () => {
    finish(reply);
    await sending;
  });
  expect(app.input().props.value).toBe('');
  expect(app.input().props.editable).toBe(true);
  expect(app.control('发送消息').props.disabled).toBe(true);
  expect(app.control('选择附件').props.disabled).toBe(false);
  expect(app.control('切换语音输入').props.disabled).toBe(false);
  await app.close();
});

test('a viewport shorter than the composer keeps its actions and attachments in the same keyboard-safe scroll region', async () => {
  const app = await setup(2);
  await app.type('Keep this draft in the tiny landscape viewport.');
  await app.dimensions(568, 320, 2);
  await app.layout(37);

  const composer = app.composer();
  expect(composer.props.keyboardShouldPersistTaps).toBe('handled');
  expect(composer.props.nestedScrollEnabled).toBe(true);
  expect(StyleSheet.flatten(composer.props.style)).toMatchObject({
    flexShrink: 1,
    minHeight: 0,
  });
  expect(
    StyleSheet.flatten(composer.props.contentContainerStyle),
  ).toMatchObject({
    flexShrink: 0,
  });
  // History can still scroll independently while the entire composer overflows.
  expect(app.messagePane()).not.toBe(composer);
  expect(app.messagePane().findAllByType(TextInput)).toHaveLength(0);
  expect(composer.findAllByType(TextInput)).toHaveLength(1);
  expect(app.inputStyle().minHeight).toBe(64);
  for (const label of ['选择附件', '切换语音输入', '发送消息']) {
    expect(
      composer.findAll(node => node.props.accessibilityLabel === label).length,
    ).toBeGreaterThan(0);
    expect(app.control(label).props.disabled).toBe(false);
  }

  await app.press('选择附件');
  expect(app.control('发送消息').props.disabled).toBe(true);
  expect(
    app.composer().findAll(node => node.props.accessibilityLabel === '移除附件')
      .length,
  ).toBeGreaterThan(0);
  await app.press('移除附件');
  expect(app.control('发送消息').props.disabled).toBe(false);
  expect(app.input().props.value).toBe(
    'Keep this draft in the tiny landscape viewport.',
  );
  await app.press('发送消息');
  expect(app.api.chat).toHaveBeenCalledWith(
    'Keep this draft in the tiny landscape viewport.',
    undefined,
    expect.any(String),
    [],
  );
  await app.close();
});

test('live viewport changes reveal the focused input without taking scroll control after blur', async () => {
  const app = await setup(2);
  const scrollTo = app.composer().instance.scrollTo as jest.Mock;
  await act(async () => {
    app.composerContent().props.onLayout({
      nativeEvent: { layout: { y: 73 } },
    });
    app.input().props.onFocus();
  });
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 73, animated: false });
  scrollTo.mockClear();
  await app.dimensions(568, 320, 2);
  await app.layout(37);
  await act(async () => app.composer().props.onLayout());
  expect(scrollTo).toHaveBeenCalledWith({ y: 73, animated: false });
  await act(async () => {
    app.composerContent().props.onLayout({
      nativeEvent: { layout: { y: 9 } },
    });
  });
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 9, animated: false });
  scrollTo.mockClear();
  await act(async () => {
    app.input().props.onBlur();
    app.composer().props.onLayout();
  });
  expect(scrollTo).not.toHaveBeenCalled();
  await app.close();
});

test('live native font changes resize the existing six-line input even while JS dimensions stay stale', async () => {
  const readScale = platform.getSystemFontScale as jest.Mock;
  readScale.mockResolvedValue(1);
  const app = await setup(1);
  await app.dimensions(568, 320, 1);
  await app.layout(37);
  const draft = 'Agjpqy TEST\nA12 2 Agjpqy\nA12 3 Agjpqy\nA12 4 Agjpqy\nA12 5 Agjpqy\nA12 6 Agjpqy';
  await app.type(draft);
  const originalInput = app.input().instance;
  expect(app.inputStyle().minHeight).toBe(44);

  // Android has applied a live font-only configuration change, without host
  // resume or a corresponding DeviceInfo Dimensions update.
  readScale.mockResolvedValue(2);
  await act(async () => app.input().props.onContentSizeChange({
    nativeEvent: { contentSize: { width: 350, height: 230 } },
  }));
  expect(Dimensions.get('window').fontScale).toBe(1);
  expect(app.inputStyle().minHeight).toBe(64);
  expect(app.inputStyle().maxHeight).toBe(64);
  expect(app.inputStyle().lineHeight).toBeUndefined();
  expect(app.inputStyle().includeFontPadding).toBe(true);
  expect(app.input().instance).toBe(originalInput);
  expect(app.input().props).toMatchObject({ value: draft, editable: true, multiline: true, scrollEnabled: true });

  readScale.mockResolvedValue(1);
  await act(async () => app.input().props.onContentSizeChange({
    nativeEvent: { contentSize: { width: 350, height: 125 } },
  }));
  expect(app.inputStyle().minHeight).toBe(44);
  expect(app.input().props.value).toBe(draft);
  for (const label of ['选择附件', '切换语音输入', '发送消息']) {
    expect(app.control(label).props.disabled).toBe(false);
    expect(app.composer().findAll(node => node.props.accessibilityLabel === label).length).toBeGreaterThan(0);
  }
  await app.close();
});

test('native font reads coalesce focus and content reflow bursts instead of feeding a layout loop', async () => {
  let complete!: (value: number) => void;
  const readScale = platform.getSystemFontScale as jest.Mock;
  readScale.mockImplementationOnce(() => new Promise<number>(resolve => { complete = resolve; }));
  readScale.mockResolvedValue(2);
  const app = await setup(1);
  await act(async () => {
    app.input().props.onFocus();
    app.input().props.onContentSizeChange();
    app.input().props.onContentSizeChange();
    app.input().props.onFocus();
  });
  expect(readScale).toHaveBeenCalledTimes(1);
  await act(async () => complete(2));
  expect(readScale).toHaveBeenCalledTimes(2);
  expect(app.inputStyle().minHeight).toBe(64);
  await act(async () => {});
  expect(readScale).toHaveBeenCalledTimes(2);
  await app.close();
});

test('a delayed native font result cannot resize the next account or route owner', async () => {
  let completeOld!: (value: number) => void;
  const readScale = platform.getSystemFontScale as jest.Mock;
  readScale.mockImplementationOnce(() => new Promise<number>(resolve => { completeOld = resolve; }));
  readScale.mockResolvedValue(1);
  const app = await setup(1);
  await app.layout(37);
  await app.changeOwner();
  await app.type('New owner draft');
  await act(async () => completeOld(2));
  expect(app.inputStyle().minHeight).toBe(44);
  expect(app.input().props.value).toBe('New owner draft');
  await app.close();
});

test('font-read failure falls back to the current platform dimensions without changing the draft', async () => {
  (platform.getSystemFontScale as jest.Mock).mockRejectedValue(new Error('native unavailable'));
  const app = await setup(2);
  await app.layout(37);
  await app.type('Keep this draft');
  await act(async () => app.input().props.onFocus());
  expect(app.inputStyle().minHeight).toBe(64);
  expect(app.input().props.value).toBe('Keep this draft');
  await app.close();
});

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

jest.mock('../src/platform/ports', () => ({
  platform: {
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
  [1, 51],
  [2, 68],
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
    expect(app.inputStyle().fontSize).toBe(14);
    expect(app.inputStyle().lineHeight).toBe(23);
    for (const label of ['选择附件', '开始录音', '发送消息']) {
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
  expect(app.inputStyle().maxHeight).toBe(51);

  // A font-only Dimensions event must take effect without a new root layout.
  await app.dimensions(360, 640, 2);
  expect(app.inputStyle().minHeight).toBe(68);
  expect(app.inputStyle().maxHeight).toBe(68);
  await app.layout(500);
  expect(app.inputStyle().maxHeight).toBe(110);
  await app.dimensions(640, 360, 2);
  await app.layout(160);
  expect(app.inputStyle().maxHeight).toBe(68);
  await app.dimensions(640, 360, 1);
  expect(app.inputStyle().minHeight).toBe(51);
  expect(app.inputStyle().maxHeight).toBe(51);
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
  expect(app.inputStyle().maxHeight).toBe(68);
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
  expect(app.inputStyle().maxHeight).toBe(68);
  for (const label of ['选择附件', '开始录音', '发送消息']) {
    expect(app.control(label).props.disabled).toBe(true);
  }
  await act(async () => {
    finish(reply);
    await sending;
  });
  expect(app.input().props.value).toBe('');
  expect(app.input().props.editable).toBe(true);
  expect(app.control('发送消息').props.disabled).toBe(true);
  expect(app.control('选择附件').props.disabled).toBe(false);
  expect(app.control('开始录音').props.disabled).toBe(false);
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
  expect(app.inputStyle().minHeight).toBe(68);
  for (const label of ['选择附件', '开始录音', '发送消息']) {
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

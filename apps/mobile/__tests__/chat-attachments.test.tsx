import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { ChatScreen } from '../src/screens/Chat';
import { Button } from '../src/ui/components';
import type { Message } from '../src/domain/types';

jest.mock('../src/platform/ports', () => ({
  platform: {
    pickDocument: jest
      .fn()
      .mockResolvedValue({
        uri: 'file:///client.txt',
        name: 'client-original.txt',
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

const attachment = {
  upload_id: 'upload-a',
  name: 'server-upload.txt',
  mime_type: 'text/plain',
  size: 42,
  unavailable: false,
};
const userMessage: Message = {
  id: 'saved-user-message',
  conversation_id: 'c',
  role: 'user',
  content: 'Server canonical text',
  created_at: '',
  attachments: [attachment],
};
async function setup(
  history: Message[] = [],
  existing = false,
  authoritative = true,
) {
  const api = {
    messages: jest.fn().mockResolvedValue({ items: history }),
    capabilities: jest
      .fn()
      .mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    upload: jest
      .fn()
      .mockResolvedValue({
        id: 'upload-a',
        name: 'server-upload.txt',
        mime_type: 'text/plain',
        size: 42,
      }),
    chat: jest
      .fn()
      .mockResolvedValue({
        conversation_id: 'c',
        user_message: authoritative ? userMessage : undefined,
        message: {
          id: 'assistant',
          role: 'assistant',
          conversation_id: 'c',
          content: 'Received',
          created_at: '',
        },
      }),
  };
  const onConversationCreated = jest.fn();
  const context = {
    api,
    invalidate: jest.fn(),
    formatDate: () => '',
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  const render = (conversationId?: string) => (
    <AppProvider value={context}>
      <ChatScreen
        conversationId={conversationId}
        onConversationCreated={onConversationCreated}
      />
    </AppProvider>
  );
  await act(async () => {
    tree = create(render(existing ? 'c' : undefined));
  });
  const labelled = (label: string) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0];
  return {
    api,
    tree,
    onConversationCreated,
    text: () =>
      tree.root
        .findAllByType(Text)
        .flatMap(node => [node.props.children].flat(Infinity))
        .join(''),
    async input(value: string) {
      await act(async () =>
        tree.root.findByType(TextInput).props.onChangeText(value),
      );
    },
    async press(label: string) {
      await act(async () => labelled(label).props.onPress());
    },
    async upload() {
      await act(async () =>
        tree.root
          .findAllByType(Button)
          .find(node => String(node.props.children).startsWith('上传附件'))!
          .props.onPress(),
      );
    },
    async adoptConversation() {
      await act(async () => tree.update(render('c')));
    },
    async close() {
      await act(async () => tree.unmount());
    },
  };
}

test('restored history shows saved filenames and deleted state while old messages stay readable', async () => {
  const app = await setup(
    [
      userMessage,
      {
        ...userMessage,
        id: 'deleted',
        content: 'Earlier source',
        attachments: [
          {
            ...attachment,
            upload_id: 'deleted-upload',
            name: 'deleted-note.txt',
            unavailable: true,
          },
        ],
      },
      {
        ...userMessage,
        id: 'legacy',
        content: 'Legacy plain message',
        attachments: undefined,
      },
    ],
    true,
  );
  expect(app.text()).toContain('附件：server-upload.txt');
  expect(app.text()).toContain('附件：deleted-note.txt（已删除或不可用）');
  expect(app.text()).toContain('Legacy plain message');
  await app.close();
}, 30000);

test.each([true, false])(
  'attachment send uses server metadata with older-backend fallback=%s',
  async authoritative => {
    const app = await setup([], false, authoritative);
    await app.input('Typed text');
    await app.press('选择附件');
    await app.upload();
    await app.press('发送消息');
    expect(app.api.chat).toHaveBeenCalledWith(
      'Typed text',
      undefined,
      expect.any(String),
      ['upload-a'],
    );
    expect(app.text()).toContain(
      authoritative ? 'Server canonical text' : 'Typed text',
    );
    expect(app.text()).toContain('附件：server-upload.txt');
    expect(app.text()).not.toContain('client-original.txt');
    expect(app.onConversationCreated).toHaveBeenCalledWith('c');
    await app.adoptConversation();
    expect(app.api.messages).not.toHaveBeenCalled();
    expect(app.text()).toContain('附件：server-upload.txt');
    await app.close();
  },
  30000,
);

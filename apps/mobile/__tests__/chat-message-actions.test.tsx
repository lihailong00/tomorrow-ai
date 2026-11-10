import React from 'react';
import { Text, TextInput, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatScreen, createChatEntryState, quoteMessageText } from '../src/screens/Chat';
import { ChatDeleteConfirmation, ChatMessageActions, ChatTextSelection, messageMenuPosition } from '../src/ui/ChatMessageActions';
import { platform } from '../src/platform/ports';
import type { ChatIntent, Message } from '../src/domain/types';
import { Button } from '../src/ui/components';
import { ChatTransportError } from '../src/api/chatSse';
import { ResultText } from '../src/ui/ResultText';
import { ChatReplyMemory } from '../src/ui/ChatReplyMemory';
import { ConversationShareSheet } from '../src/features/conversation-share/ConversationShareSheet';

jest.mock('../src/platform/ports', () => ({ platform: { hasRecorder: true, hasDocumentPicker: true,
  copyText: jest.fn().mockResolvedValue(undefined), share: jest.fn().mockResolvedValue(undefined),
  startRecording: jest.fn().mockResolvedValue(undefined), stopRecording: jest.fn().mockResolvedValue(null) } }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null, AmbientBackground: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.clearAllMocks();
  (View as any).prototype.measureInWindow.mockImplementation((callback: (...values: number[]) => void) => callback(160, 400, 200, 50));
});

const question: Message = { id: 'u1', conversation_id: 'c', role: 'user', content: '客户的新要求\n明天回复', created_at: '2026-11-01T01:02:00Z',
  attachments: [{ upload_id: 'image1', name: 'requirements.png', mime_type: 'image/png', size: 128 }] };
const answer: Message = { id: 'a1', conversation_id: 'c', role: 'assistant', content: '旧回复', created_at: '2026-11-01T01:02:01Z' };
const later: Message = { id: 'u2', conversation_id: 'c', role: 'user', content: '后续问题', created_at: '2026-11-01T02:02:00Z' };
const laterAnswer: Message = { id: 'a2', conversation_id: 'c', role: 'assistant', content: '后续回复', created_at: '2026-11-01T02:02:01Z' };
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function setup(options: { items?: Message[]; older?: boolean } = {}) {
  const initial = options.items ?? [question, answer, later, laterAnswer];
  const state = createChatEntryState('c');
  const navigate = jest.fn();
  const invalidate = jest.fn();
  const api = {
    capabilities: jest.fn().mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    messages: jest.fn().mockResolvedValue({ items: initial, ...(options.older ? { next_offset: 4, next_before: 'u1' } : {}) }),
    deleteMessage: jest.fn().mockResolvedValue({ removed_message_ids: ['u1', 'a1'] }),
    chatStream: jest.fn(async (intent: ChatIntent, receive: (event: any) => void) => {
      const edited = Boolean(intent.replace_message_id);
      receive({ id: 1, event: 'done', data: { response: { conversation_id: 'c',
        user_message: { ...question, id: edited ? question.id : 'u3', content: intent.message,
          attachments: edited ? question.attachments : [] },
        message: { ...answer, id: 'a3', content: '新回复' },
        ...(edited ? { removed_message_ids: ['u1', 'a1'] } : {}) } } });
    }),
  };
  let tree!: ReactTestRenderer;
  const render = (client: typeof api, userId = 'owner') => <AppProvider value={{ api: client, navigate, invalidate,
    formatDate: (value: string) => `日期:${value}`, user: { id: userId }, preferences: { serverUrl: 'https://one.test' } } as unknown as AppContextValue}>
    <ChatScreen conversationId="c" entryState={state} />
  </AppProvider>;
  await act(async () => { tree = create(render(api)); });
  const node = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  return { api, state, navigate, invalidate, tree: () => tree,
    text: () => tree.root.findAllByType(Text).map(n => n.props.children).join('\n'),
    node,
    input: async (value: string) => { await act(async () => tree.root.findByType(TextInput).props.onChangeText(value)); },
    longpress: async (id = 'u1') => {
      const key = state.getSnapshot().messages.find(message => message.id === id)?.client_key ?? id;
      await act(async () => tree.root.findAll(n => n.props.testID === `chat-message-${key}` && typeof n.props.onLongPress === 'function')[0].props.onLongPress({ nativeEvent: { pageX: 340, pageY: 620 } }));
    },
    press: async (label: string) => { await act(async () => { await node(label).props.onPress(); }); },
    action: async (name: string) => { await act(async () => { await tree.root.findByType(ChatMessageActions).props.onAction(name); }); },
    owner: async () => { await act(async () => tree.update(render({ ...api }, 'other'))); },
    unmount: async () => { await act(async () => tree.unmount()); },
  };
}

test('menu is anchored and clamped within the screen, including expanded content and edges', () => {
  for (const anchor of [{ x: -200, y: -100, width: 20, height: 20 }, { x: 900, y: 760, width: 500, height: 100 }]) {
    const position = messageMenuPosition(anchor, 390, 844, true);
    expect(position.left).toBeGreaterThanOrEqual(16);
    expect(position.left + position.width).toBeLessThanOrEqual(374);
    expect(position.top).toBeGreaterThanOrEqual(24);
    expect(position.top + 408).toBeLessThanOrEqual(820);
  }
});

test('sent user long press opens dated native menu; share seeds exact selected question without sending', async () => {
  const app = await setup();
  await app.longpress();
  expect(app.tree().root.findByType(ChatMessageActions).props.timestamp).toBe(`日期:${question.created_at}`);
  await app.action('copy'); expect(platform.copyText).toHaveBeenCalledWith(question.content);
  await app.longpress(); await app.action('share');
  expect(app.tree().root.findByType(ConversationShareSheet).props.initialSelectedId).toBe(question.id);
  expect(platform.share).not.toHaveBeenCalled();
  expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('copy failures are reported instead of claiming success', async () => {
  const app = await setup(); (platform.copyText as jest.Mock).mockRejectedValueOnce(new Error('剪贴板不可用'));
  await app.longpress(); await app.action('copy'); expect(app.text()).toContain('剪贴板不可用'); await app.unmount();
});

test('select opens real native selectable text, which can be closed', async () => {
  const app = await setup(); await app.longpress(); await app.action('select');
  expect(app.tree().root.findByType(ChatTextSelection).props.text).toBe(question.content);
  const native = app.tree().root.findAll(n => n.props.testID === 'chat-selectable-message' && n.props.selectable === true);
  expect(native.length).toBeGreaterThan(0);
  await app.press('完成文字选择'); expect(app.tree().root.findAllByType(ChatTextSelection)).toHaveLength(0);
  await app.unmount();
});

test('followup preserves the draft and sends the exact quoted original context once', async () => {
  const app = await setup(); await app.input('帮我准备回复'); await app.longpress(); await app.action('quote');
  expect(app.state.getSnapshot().draft).toBe('帮我准备回复');
  expect(app.tree().root.findAll(n => n.props.testID === 'chat-quote-context').length).toBeGreaterThan(0);
  await app.press('发送消息');
  expect(app.api.chatStream).toHaveBeenCalledTimes(1);
  expect(app.api.chatStream.mock.calls[0][0].message).toBe(quoteMessageText(question, '帮我准备回复'));
  expect(app.state.getSnapshot().quoting).toBeNull(); await app.unmount();
});

test('remove quote keeps user typed text; branch carries a draft without auto-sending', async () => {
  const app = await setup(); await app.input('我的草稿'); await app.longpress(); await app.action('quote');
  await app.press('取消引用消息'); expect(app.state.getSnapshot().draft).toBe('我的草稿');
  await app.longpress(); await app.action('branch');
  expect(app.navigate).toHaveBeenCalledWith({ name: 'chat', prompt: question.content });
  expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('cancel edit restores pre-existing draft and does not call a destructive API', async () => {
  const app = await setup(); await app.input('未发送草稿'); await app.longpress(); await app.action('edit');
  expect(app.state.getSnapshot().draft).toBe(question.content);
  await app.input('编辑中的文本'); await app.press('取消修改消息');
  expect(app.state.getSnapshot().draft).toBe('未发送草稿');
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(app.api.deleteMessage).not.toHaveBeenCalled(); expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('editing replaces its turn in place after confirmed done, keeps attachments, and never deletes first', async () => {
  const app = await setup(); await app.longpress(); await app.action('edit'); await app.input('更正后的要求');
  await app.press('提交修改');
  const intent = app.api.chatStream.mock.calls[0][0];
  expect(intent.replace_message_id).toBe('u1'); expect(intent.upload_ids).toEqual(['image1']);
  expect(app.api.deleteMessage).not.toHaveBeenCalled();
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a3', 'u2', 'a2']);
  expect(app.state.getSnapshot().messages[0].content).toBe('更正后的要求');
  expect(app.state.getSnapshot().messages.filter(m => m.id === 'u1')).toHaveLength(1);
  await app.unmount();
});

test('editing shows the original attachment and removes it only after an explicit action', async () => {
  const app = await setup(); await app.longpress(); await app.action('edit');
  expect(app.node('移除原附件：requirements.png')).toBeTruthy();
  await app.press('移除原附件：requirements.png'); await app.input('只保留文字'); await app.press('提交修改');
  expect(app.api.chatStream.mock.calls[0][0].upload_ids).toEqual([]); await app.unmount();
});

test('failed edit restores original turn and draft; explicit retry reuses immutable request ID', async () => {
  const app = await setup();
  app.api.chatStream.mockRejectedValueOnce(new ChatTransportError('invalid_response', '模型失败'));
  await app.longpress(); await app.action('edit'); await app.input('修订内容'); await app.press('提交修改');
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(app.state.getSnapshot().messages[0].content).toBe(question.content);
  expect(app.state.getSnapshot().draft).toBe('修订内容'); expect(app.text()).toContain('修改未完成');
  const originalIntent = app.api.chatStream.mock.calls[0][0];
  const retry = app.tree().root.findAllByType(Button).find(n => n.props.children === '重试修改')!;
  await act(async () => { await retry.props.onPress(); });
  expect(app.api.chatStream.mock.calls[1][0]).toEqual(originalIntent);
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a3', 'u2', 'a2']); await app.unmount();
});

test('delete requires native confirmation, waits for persistence, and removes only returned turn IDs', async () => {
  const app = await setup(); const pending = deferred<{ removed_message_ids: string[] }>();
  app.api.deleteMessage.mockReturnValueOnce(pending.promise);
  await app.longpress(); await app.action('delete');
  expect(app.api.deleteMessage).not.toHaveBeenCalled();
  expect(app.tree().root.findByType(ChatDeleteConfirmation)).toBeTruthy();
  await act(async () => { void app.node('确认删除消息').props.onPress(); });
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  await act(async () => pending.resolve({ removed_message_ids: ['u1', 'a1'] }));
  expect(app.api.deleteMessage).toHaveBeenCalledWith('c', 'u1', expect.any(AbortSignal));
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u2', 'a2']); await app.unmount();
});

test('failed delete keeps the turn and offers a retry in the confirmation', async () => {
  const app = await setup(); app.api.deleteMessage.mockRejectedValueOnce(new Error('服务暂不可用'));
  await app.longpress(); await app.action('delete'); await app.press('确认删除消息');
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(app.tree().root.findByType(ChatDeleteConfirmation).props.error).toContain('服务暂不可用');
  await app.press('确认删除消息'); expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u2', 'a2']); await app.unmount();
});

test('a history page already in flight cannot resurrect a deleted turn', async () => {
  const app = await setup({ older: true }); const page = deferred<any>(); app.api.messages.mockReturnValueOnce(page.promise);
  await act(async () => { void app.tree().root.findAllByType(Button).find(n => n.props.children === '加载更早消息')!.props.onPress(); });
  await app.longpress(); await app.action('delete'); await app.press('确认删除消息');
  await act(async () => page.resolve({ items: [question, answer], next_offset: null }));
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u2', 'a2']); await app.unmount();
});

test('stale menu callback and late deletion result cannot mutate a different account owner', async () => {
  const app = await setup(); await app.longpress();
  const staleAction = app.tree().root.findByType(ChatMessageActions).props.onAction;
  await app.owner(); await act(async () => staleAction('edit'));
  expect(app.state.getSnapshot().editing).toBeNull(); expect(platform.copyText).not.toHaveBeenCalled(); await app.unmount();
  const second = await setup(); const pending = deferred<any>(); second.api.deleteMessage.mockReturnValueOnce(pending.promise);
  await second.longpress(); await second.action('delete');
  await act(async () => { void second.node('确认删除消息').props.onPress(); });
  await second.owner(); await act(async () => pending.resolve({ removed_message_ids: ['u1', 'a1'] }));
  expect(second.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']); await second.unmount();
});

test('the just-sent message can be edited locally while its reply streams, then submitted explicitly', async () => {
  const app = await setup();
  const pending = deferred<void>();
  const sent = { ...later, id: 'u3', content: '新问题' };
  const result = { ...laterAnswer, id: 'a4', content: '原问题的回复' };
  app.api.chatStream.mockImplementationOnce(async (_intent, receive) => {
    receive({ id: 1, event: 'accepted', data: { conversation_id: 'c', user_message: sent, message_id: result.id } });
    receive({ id: 2, event: 'text_delta', data: { delta: '原问题的' } });
    await pending.promise;
    receive({ id: 3, event: 'done', data: { response: { conversation_id: 'c', user_message: sent, message: result } } });
  });
  await app.input('新问题'); await act(async () => { void app.node('发送消息').props.onPress(); });
  await app.input('保留这条未发送草稿');
  await app.longpress('u3');
  expect(app.node('修改').props.disabled).toBe(false);
  expect(app.node('追问').props.disabled).toBe(true);
  await app.action('delete'); expect(app.tree().root.findAllByType(ChatDeleteConfirmation)).toHaveLength(0);
  await app.press('修改'); expect(app.state.getSnapshot().draft).toBe(sent.content);
  await app.input('暂时改一下');
  await app.press('取消修改消息');
  expect(app.state.getSnapshot().draft).toBe('保留这条未发送草稿');
  await app.longpress('u3'); await app.press('修改'); await app.input('更正的新问题');
  expect(app.node('提交修改').props.disabled).toBe(true);
  await app.press('提交修改'); // Even a stale tap cannot submit early.
  expect(app.api.chatStream).toHaveBeenCalledTimes(1);
  expect(app.state.getSnapshot().messages.find(message => message.id === 'u3')?.content).toBe(sent.content);
  await act(async () => pending.resolve());
  expect(app.state.getSnapshot().draft).toBe('更正的新问题');
  expect(app.node('提交修改').props.disabled).toBe(false);
  expect(app.api.chatStream).toHaveBeenCalledTimes(1);
  app.api.chatStream.mockImplementationOnce(async (intent, receive) => {
    receive({ id: 1, event: 'done', data: { response: { conversation_id: 'c', user_message: { ...sent, content: intent.message },
      message: { ...result, id: 'a5' }, removed_message_ids: ['u3', 'a4'] } } });
  });
  await app.press('提交修改');
  expect(app.api.chatStream).toHaveBeenCalledTimes(2);
  expect(app.api.chatStream.mock.calls[1][0]).toMatchObject({ replace_message_id: 'u3', message: '更正的新问题' });
  expect(app.state.getSnapshot().draft).toBe('保留这条未发送草稿');
  await app.unmount();
});

test('failed or still-sending user messages cannot open the sent-message menu', async () => {
  for (const delivery of ['sending', 'failed'] as const) {
    const app = await setup({ items: [{ ...question, delivery }] }); await app.longpress();
    expect(app.tree().root.findAllByType(ChatMessageActions)).toHaveLength(0); await app.unmount();
  }
});

test('an interleaved reply is preserved; server linkage determines which reply is replaced', async () => {
  const b = { ...later, created_at: '2026-11-01T01:02:01Z' };
  const a = { ...answer, created_at: '2026-11-01T01:02:02Z' };
  const ba = { ...laterAnswer, created_at: '2026-11-01T01:02:03Z' };
  const app = await setup({ items: [question, b, a, ba] });
  app.api.chatStream.mockImplementationOnce(async (intent, receive) => {
    receive({ id: 1, event: 'accepted', data: { conversation_id: 'c', user_message: { ...b, content: intent.message },
      message_id: 'b-new', removed_message_ids: ['u2', 'a2'] } });
    receive({ id: 2, event: 'done', data: { response: { conversation_id: 'c', user_message: { ...b, content: intent.message },
      message: { ...ba, id: 'b-new', content: 'B的新回复' }, removed_message_ids: ['u2', 'a2'] } } });
  });
  await app.longpress('u2'); await app.action('edit'); await app.input('修改B'); await app.press('提交修改');
  expect(app.state.getSnapshot().messages.map(m => m.id)).toEqual(['u1', 'u2', 'a1', 'b-new']);
  expect(app.state.getSnapshot().messages.find(m => m.id === 'a1')?.content).toBe('旧回复'); await app.unmount();
});

test('oversize quoted context is rejected before clearing the draft or starting an immutable request', async () => {
  const source = { ...question, content: '甲'.repeat(19980) };
  const app = await setup({ items: [source, answer] });
  await app.input('请把这条消息重新整理一下'); await app.longpress(); await app.action('quote'); await app.press('发送消息');
  expect(app.api.chatStream).not.toHaveBeenCalled();
  expect(app.state.getSnapshot().draft).toBe('请把这条消息重新整理一下');
  expect(app.state.getSnapshot().quoting?.id).toBe('u1'); expect(app.text()).toContain('引用后的消息超过'); await app.unmount();
});

test('an unchanged failed edit with a replacement image retries the same request and upload IDs', async () => {
  const app = await setup(); app.api.chatStream.mockRejectedValueOnce(new ChatTransportError('invalid_response', '连接中断'));
  await app.longpress(); await app.action('edit'); await app.input('看看这张新图片');
  const selected = { file: { uri: 'file:///new.png', name: 'new.png', mime_type: 'image/png' },
    upload: { id: 'replacement-image', name: 'new.png', mime_type: 'image/png', size: 128, uri: '', created_at: '' }, imageText: '测试图片' };
  await act(async () => app.state.update(old => ({ ...old, attachment: selected })));
  await app.press('提交修改'); expect(app.state.getSnapshot().attachment).toBe(selected);
  const first = app.api.chatStream.mock.calls[0][0];
  await app.press('提交修改'); expect(app.api.chatStream.mock.calls[1][0]).toEqual(first);
  expect(first.upload_ids).toEqual(['replacement-image']); await app.unmount();
});

test('history arriving during an edit uses the server reply timestamp and keeps the question before its reply', async () => {
  const app = await setup({ older: true }); const page = deferred<any>(); const stream = deferred<void>();
  app.api.messages.mockReturnValueOnce(page.promise);
  await act(async () => { void app.tree().root.findAllByType(Button).find(n => n.props.children === '加载更早消息')!.props.onPress(); });
  app.api.chatStream.mockImplementationOnce(async (intent, receive) => {
    receive({ id: 1, event: 'accepted', data: { conversation_id: 'c', user_message: { ...question, content: intent.message },
      message_id: 'streaming-answer', message_created_at: answer.created_at, removed_message_ids: ['u1', 'a1'] } });
    await stream.promise;
  });
  await app.longpress(); await app.action('edit'); await app.input('改写问题');
  await act(async () => { void app.node('提交修改').props.onPress(); });
  await act(async () => page.resolve({ items: [question, answer], next_offset: null }));
  const items = app.state.getSnapshot().messages;
  expect(items.find(m => m.id === 'streaming-answer')?.created_at).toBe(answer.created_at);
  expect(items.findIndex(m => m.id === 'u1')).toBeLessThan(items.findIndex(m => m.id === 'streaming-answer'));
  expect(items.some(m => m.id === 'a1')).toBe(false);
  await app.unmount(); await act(async () => stream.resolve());
});

test('assistant reply long press opens its own action menu; sharing seeds exact reply and text selection stays intact', async () => {
  const app = await setup(); await app.longpress('a1');
  expect(app.tree().root.findByType(ChatMessageActions).props.role).toBe('assistant');
  expect(app.node('在新对话中继续')).toBeTruthy();
  expect(app.node('保存到记忆')).toBeTruthy();
  expect(app.node('从对话发现待办')).toBeTruthy();
  expect(app.node('修改')).toBeUndefined();
  expect(app.node('删除')).toBeUndefined();
  await app.action('copy'); expect(platform.copyText).toHaveBeenCalledWith(answer.content);
  await app.longpress('a1'); await app.action('share');
  expect(app.tree().root.findByType(ConversationShareSheet).props.initialSelectedId).toBe(answer.id);
  expect(platform.share).not.toHaveBeenCalled();
  await app.press('取消分享');
  await app.longpress('a1'); await app.action('select');
  expect(app.tree().root.findByType(ChatTextSelection).props.text).toBe(answer.content);
  expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('sharing a finished reply during a later stream preserves the draft and excludes partial/failed messages', async () => {
  const app = await setup(); await app.input('尚未发送的草稿');
  await act(async () => app.state.update(old => ({ ...old, sending: true,
    messages: [...old.messages, { ...answer, id: 'partial', content: '未完成内容', stream_status: '回答中' },
      { ...answer, id: 'failed', content: '失败内容', stream_error: '中断' }] })));
  await app.press('分享这条回复');
  const sheet = app.tree().root.findByType(ConversationShareSheet);
  expect(sheet.props.initialSelectedId).toBe(laterAnswer.id);
  expect(sheet.props.candidates.map((item: { id: string }) => item.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  expect(app.state.getSnapshot().draft).toBe('尚未发送的草稿');
  await app.press('取消分享'); expect(app.state.getSnapshot().draft).toBe('尚未发送的草稿');
  expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('an old row share callback cannot reopen sharing under a replacement account/server owner', async () => {
  const app = await setup(); const share = app.node('分享这条回复').props.onPress;
  await app.owner(); await act(async () => share());
  expect(app.tree().root.findAllByType(ConversationShareSheet)).toHaveLength(0);
  expect(platform.share).not.toHaveBeenCalled(); await app.unmount();
});

test('long pressing the actual AI text opens the menu instead of native text selection', async () => {
  const app = await setup();
  const result = app.tree().root.findAllByType(ResultText).find(n => n.props.content === answer.content)!;
  const native = result.findAllByType(Text).find(n => n.props.children === answer.content)!;
  expect(native.props.selectable).toBe(false);
  expect(typeof native.props.onLongPress).toBe('function');
  await act(async () => native.props.onLongPress({ nativeEvent: { pageX: 150, pageY: 420 } }));
  expect(app.tree().root.findByType(ChatMessageActions).props.role).toBe('assistant');
  await app.unmount();
});

test('assistant quote keeps the draft, while branch and todo actions navigate without submitting', async () => {
  const app = await setup(); await app.input('请解释一下');
  await app.longpress('a1'); await app.action('quote');
  expect(app.state.getSnapshot().quoting?.id).toBe('a1');
  expect(app.state.getSnapshot().draft).toBe('请解释一下');
  await app.longpress('a1'); await app.action('branch');
  expect(app.navigate).toHaveBeenCalledWith({ name: 'chat', prompt: answer.content });
  await app.longpress('a1'); await app.action('todos');
  expect(app.navigate).toHaveBeenCalledWith({ name: 'todoSources', conversationId: 'c' });
  expect(app.api.chatStream).not.toHaveBeenCalled(); await app.unmount();
});

test('assistant edit/delete are rejected, and saving opens an editable confirmation without an API call', async () => {
  const app = await setup(); await app.longpress('a1'); await app.action('edit');
  expect(app.state.getSnapshot().editing).toBeNull();
  await app.action('delete'); expect(app.api.deleteMessage).not.toHaveBeenCalled();
  expect(app.tree().root.findAllByType(ChatDeleteConfirmation)).toHaveLength(0);
  await app.action('memory');
  expect(app.tree().root.findByType(ChatReplyMemory).props.content).toBe(answer.content);
  expect(app.api.chatStream).not.toHaveBeenCalled();
  await app.press('取消保存回复'); expect(app.tree().root.findAllByType(ChatReplyMemory)).toHaveLength(0);
  await app.unmount();
});

test('assistant streaming, empty content and stale owner callbacks cannot open or change a reply', async () => {
  for (const item of [{ ...answer, stream_status: '正在回复…' }, { ...answer, content: '' }]) {
    const app = await setup({ items: [question, item] }); await app.longpress('a1');
    expect(app.tree().root.findAllByType(ChatMessageActions)).toHaveLength(0); await app.unmount();
  }
  const app = await setup(); await app.longpress('a1');
  const stale = app.tree().root.findByType(ChatMessageActions).props.onAction;
  await app.owner(); await act(async () => stale('memory'));
  expect(app.tree().root.findAllByType(ChatReplyMemory)).toHaveLength(0); await app.unmount();
});

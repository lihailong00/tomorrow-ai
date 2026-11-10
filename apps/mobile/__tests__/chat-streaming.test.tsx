import { FlashList } from '@shopify/flash-list';
jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
import React from 'react';
import { NativeModules, Platform, Text, TextInput, View } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { AppContextValue, AppProvider } from '../src/app/context';
import { useRouteStack } from '../src/app/navigation';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { mergeMessageHistory } from '../src/screens/messageHistory';
import { Button } from '../src/ui/components';
import { ChatReplyFailure } from '../src/ui/ChatReplyFailure';
import type { ChatResponse, Message } from '../src/domain/types';
import { phoneAlarms } from '../src/platform/phoneAlarms';

jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
class NativeStream {
  static all: NativeStream[] = [];
  readyState = 0; status = 200; responseText = ''; responseURL = '';
  headers: Record<string, string> = {}; body = ''; aborted = false;
  withCredentials = true; timeout = 0;
  onprogress: (() => void) | null = null; onreadystatechange: (() => void) | null = null;
  onload: (() => void) | null = null; onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null; onabort: (() => void) | null = null;
  constructor() { NativeStream.all.push(this); }
  open() { this.readyState = 1; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  getResponseHeader() { return 'text/event-stream'; }
  send(body: string) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  event(id: number, kind: string, data: unknown) {
    this.readyState = 3;
    this.responseText += `id: ${id}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    this.onprogress?.();
  }
  drop() { this.onerror?.(); }
}
const originalXhr = globalThis.XMLHttpRequest;
const mounted = new Set<ReactTestRenderer>();
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.useFakeTimers(); NativeStream.all = []; (globalThis as any).XMLHttpRequest = NativeStream; });
afterEach(async () => {
  await act(async () => { mounted.forEach(tree => tree.unmount()); });
  mounted.clear(); jest.clearAllTimers(); jest.useRealTimers(); globalThis.XMLHttpRequest = originalXhr;
});
const savedUser: Message = { id: 'server-user', role: 'user', content: 'original intent',
  conversation_id: 'server-conversation', created_at: new Date(Date.now()).toISOString() };
const response: ChatResponse = { conversation_id: 'server-conversation', user_message: savedUser,
  message: { id: 'server-assistant', role: 'assistant', content: '第一段\n\n最终回复',
    conversation_id: 'server-conversation', created_at: new Date(Date.now() + 1).toISOString() } };
const accepted = { conversation_id: 'server-conversation', user_message: savedUser, message_id: 'server-assistant', agent_run_id: 'same-run' };

test('sending an explicit relative alarm hands it to Android without starting a chat request', async () => {
  const capability = jest.replaceProperty(phoneAlarms, 'supportsDirectSystemAlarm', true);
  const setAlarm = jest.spyOn(phoneAlarms, 'setNextSystemAlarm').mockResolvedValue('requested');
  try {
    jest.setSystemTime(new Date(2026, 10, 4, 4, 31));
    const app = await setup();
    await app.type('我要睡了，给我定个八个小时后的闹铃吧。');
    const { pending } = await app.begin();
    await pending;
    expect(setAlarm).toHaveBeenCalledTimes(1);
    expect(setAlarm).toHaveBeenCalledWith('2026-11-04', '12:31', '妥啦闹铃');
    expect(NativeStream.all).toHaveLength(0);
    expect(app.entry().getSnapshot().draft).toBe('');
    expect(app.entry().getSnapshot().alarmFeedback?.text).toContain('已交给系统闹钟');
  } finally {
    setAlarm.mockRestore();
    capability.restore();
  }
});

async function setup(existing?: string, initial: Message[] = [], appPermissionTool = false) {
  const fetcher = jest.fn().mockImplementation(async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ items: [], runtime: { model_mode: 'pi' }, app_permission_tool: appPermissionTool, device_settings_tools: appPermissionTool }) }));
  const api = new ApiClient('https://synthetic.test', 'synthetic-only', undefined, fetcher, jest.fn().mockResolvedValue(undefined));
  api.messages = jest.fn().mockResolvedValue({ items: initial, next_offset: null });
  let navigation!: ReturnType<typeof useRouteStack>;
  let entry!: ReturnType<typeof createChatEntryState>;
  const invalidate = jest.fn();
  function Harness({ client }: { client: ApiClient }) {
    navigation = useRouteStack(client);
    const route = navigation.entry.route;
    if (route.name === 'chat') entry = navigation.getEntryState(scope => createChatEntryState(route.conversationId, undefined, scope));
    return <AppProvider value={{ api: client, invalidate, formatDate: () => '', user: { id: client === api ? 'one' : 'two' } } as unknown as AppContextValue}>
      <React.Fragment key={navigation.entry.key}>{route.name === 'chat'
        ? <ChatScreen conversationId={route.conversationId} entryState={entry} /> : <Text>{route.name}</Text>}</React.Fragment>
    </AppProvider>;
  }
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<Harness client={api} />); }); mounted.add(tree);
  await act(async () => navigation.navigate({ name: 'chat', conversationId: existing }));
  const control = (label: string) => tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
  return { api, tree, invalidate, entry: () => entry, control,
    list: () => tree.root.findByType(FlashList), input: () => tree.root.findByType(TextInput),
    text: () => tree.root.findAllByType(Text).map(node => node.props.children).join('\n'),
    type: async (text: string) => { await act(async () => tree.root.findByType(TextInput).props.onChangeText(text)); },
    begin: async () => { let pending!: Promise<void>; await act(async () => { pending = control('发送消息').props.onPress(); }); return { pending }; },
    event: async (id: number, kind: string, data: unknown, xhr = NativeStream.all.at(-1)!) => { await act(async () => xhr.event(id, kind, data)); },
    history: async () => { await act(async () => navigation.navigate({ name: 'conversations' })); },
    back: async () => { await act(async () => navigation.back()); },
    replaceOwner: async () => {
      const other = new ApiClient('https://synthetic.test', 'other-synthetic-only', undefined, fetcher);
      other.messages = jest.fn().mockResolvedValue({ items: [] });
      await act(async () => tree.update(<Harness client={other} />));
    },
    retry: async () => { let pending!: Promise<void>; await act(async () => {
      pending = control('重试回复').props.onPress();
    }); return { pending }; },
  };
}

test.each([false, true])('renders the permission report with or without server support (supported=%s)', async appPermissionTool => {
  const previousPlatform = Platform.OS;
  Platform.OS = 'android';
  const firstReport = {
    scanned: 4, flagged: 1, unavailable: [],
    findings: [{ name: '测试手电筒', packageName: 'test.only.device', grants: ['通讯录'], reasons: ['需核查权限用途'] }],
  };
  const scan = jest.fn().mockResolvedValueOnce(firstReport).mockResolvedValueOnce({ ...firstReport, scanned: 5 });
  const openDeviceSettings = jest.fn().mockResolvedValue('requested');
  const scanPermissions = jest.fn().mockResolvedValue({ scanned: 1, flagged: 0, matched: 1, unavailable: [],
    findings: [{ name: '测试手电筒', packageName: 'test.only.device', grants: [], reasons: [] }] });
  NativeModules.TadaAppPermissionInspection = { scan, openDeviceSettings, scanPermissions };
  try {
    const app = await setup(undefined, [], appPermissionTool);
    const request = jest.spyOn(app.api, 'request');
    const pressText = async (text: string) => {
      const button = app.tree.root.findAll(node => node.props.children === text && typeof node.props.onPress === 'function').at(-1)!;
      await act(async () => { await button.props.onPress(); });
    };
    await app.type(appPermissionTool ? '我担心这部设备上有跟踪程序，能替我确认一下吗？' : '你看看我手机上有没有疑似监控我的软件');
    const { pending } = await app.begin();
    if (appPermissionTool) {
      expect(JSON.parse(NativeStream.all[0].body)).toMatchObject({ app_permission_tool_supported: true, device_settings_supported: true,
        device_inspection_context: { has_report: false, has_selected_app: false } });
      await app.event(1, 'accepted', accepted);
      await app.event(1, 'interaction', { card: {
        kind: 'app_permission_inspection', inspection: 'permissions', mode: 'check', run_id: 'same-run', id: 'permission-1',
        expires_at: Math.floor(Date.now() / 1000) + 90,
      } });
      expect(scan).not.toHaveBeenCalled();
      expect(app.text()).toContain('开始本机检查');
      await pressText('开始本机检查');
      expect(request).toHaveBeenCalledWith('/chat/interactions/same-run/permission-1', 'POST',
        { kind: 'app_permission_inspection', result: { status: 'completed', scanned: 4, flagged: 1 } }, expect.anything());
      await app.event(2, 'done', { response });
    } else {
      expect(NativeStream.all).toHaveLength(0);
      expect(request.mock.calls.some(([path]) => path.startsWith('/chat'))).toBe(false);
      expect(scan).not.toHaveBeenCalled();
      await pressText('开始本机检查');
    }
    await pending;
    expect(scan).toHaveBeenCalledTimes(1);
    expect(app.text()).toContain('测试手电筒');
    expect(app.text()).toContain('已授予：通讯录');
    await app.type('那你看看我手机上这些软件，哪些软件获取了不应该有的权限，也就是说它过度获取了权限。');
    await (await app.begin()).pending;
    expect(scan).toHaveBeenCalledTimes(1);
    expect(NativeStream.all).toHaveLength(appPermissionTool ? 1 : 0);
    await pressText('开始本机检查');
    expect(scan).toHaveBeenCalledTimes(2);
    expect(app.text()).toContain('检查了 5 个系统可见的第三方 App。');
    await pressText('查看权限设置');
    expect(openDeviceSettings).toHaveBeenCalledWith('selected_app', 'test.only.device');
    expect(scanPermissions).not.toHaveBeenCalled();
    await pressText('重新检查此 App');
    expect(scanPermissions).toHaveBeenCalledWith(null, 'test.only.device');
    expect(app.text()).toContain('复查后已不再授予：通讯录');
    await app.type('昨晚谁用了我的麦克风');
    const history = await app.begin();
    if (appPermissionTool) {
      await app.event(1, 'accepted', accepted);
      await app.event(1, 'interaction', { card: { kind: 'system_settings', destination: 'privacy', run_id: 'same-run',
        id: 'privacy-1', expires_at: Math.floor(Date.now() / 1000) + 90 } });
    }
    expect(openDeviceSettings).toHaveBeenCalledTimes(1);
    await pressText('打开系统设置');
    if (appPermissionTool) {
      expect(request).toHaveBeenCalledWith('/chat/interactions/same-run/privacy-1', 'POST',
        { kind: 'system_settings', status: 'opened' }, expect.anything());
      await app.event(2, 'done', { response });
    }
    await history.pending;
    expect(openDeviceSettings).toHaveBeenLastCalledWith('privacy', null);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scanPermissions).toHaveBeenCalledTimes(1);
  } finally {
    delete NativeModules.TadaAppPermissionInspection;
    Platform.OS = previousPlatform;
  }
});

test('a long research turn preserves one native request and its optimistic rows beyond the old150s deadline', async () => {
  const app = await setup();
  await app.type('original intent');
  const { pending } = await app.begin();
  const xhr = NativeStream.all[0];
  const originalBody = xhr.body;
  await app.event(1, 'accepted', accepted);
  await app.event(2, 'tool_start', { tool: 'web_search', tool_call_id: 'research-search' });
  const before = app.entry().getSnapshot().messages;
  await act(async () => { await jest.advanceTimersByTimeAsync(151000); });
  expect(app.entry().getSnapshot().sending).toBe(true);
  expect(app.text()).toContain('正在搜索网页…');
  expect(app.entry().getSnapshot().messages).toBe(before);
  expect(NativeStream.all).toHaveLength(1);
  expect(xhr.aborted).toBe(false);
  await act(async () => { await jest.advanceTimersByTimeAsync(1049000); });
  await app.event(3, 'text_delta', { delta: '第一段\n\n最终回复', turn: 0 });
  await app.event(4, 'done', { response });
  await pending;
  expect(app.entry().getSnapshot().sending).toBe(false);
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  expect(NativeStream.all).toHaveLength(1);
  expect(xhr.body).toBe(originalBody);
  expect(JSON.parse(xhr.body)).toMatchObject({ message: 'original intent' });
  expect(app.text()).toContain('最终回复');
});

test('send clears immediately, shows one optimistic turn before HTTP completes, and real timed bytes reach the same row before final', async () => {
  const app = await setup(); await app.type('original intent');
  const { pending } = await app.begin();
  expect(NativeStream.all).toHaveLength(1);
  expect(app.input().props).toMatchObject({ value: '', editable: true });
  expect(app.text()).toContain('发送中…');
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  const userKey = app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'user'));
  const assistantKey = app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'assistant'));
  const userView = app.tree.root.findAllByType(View).find(node => node.props.testID === `chat-message-${userKey}`);
  const assistantView = app.tree.root.findAllByType(View).find(node => node.props.testID === `chat-message-${assistantKey}`);
  await app.type('new draft while replying');
  await app.event(1, 'accepted', accepted);
  const userAfterAccepted = app.entry().getSnapshot().messages.find(message => message.role === 'user');
  setTimeout(() => NativeStream.all[0].event(2, 'text_delta', { delta: '第一段', turn: 0 }), 40);
  setTimeout(() => NativeStream.all[0].event(3, 'tool_start', { tool: 'search_memories', tool_call_id: 'real-call' }), 80);
  await act(async () => { await jest.advanceTimersByTimeAsync(40); });
  expect(app.text()).toContain('第一段');
  expect(app.entry().getSnapshot().sending).toBe(true);
  expect(app.entry().getSnapshot().messages.find(message => message.role === 'user')).toBe(userAfterAccepted);
  expect(app.tree.root.findAllByType(View).find(node => node.props.testID === `chat-message-${userKey}`)).toBe(userView);
  expect(app.tree.root.findAllByType(View).find(node => node.props.testID === `chat-message-${assistantKey}`)).toBe(assistantView);
  await act(async () => { await jest.advanceTimersByTimeAsync(40); });
  expect(app.text()).toContain('正在查找相关记忆…');
  await app.event(4, 'tool_end', { tool: 'search_memories', tool_call_id: 'real-call', is_error: false });
  await app.event(5, 'text_start', { turn: 1 });
  expect(app.text()).toContain('第一段');
  await app.event(6, 'text_delta', { delta: '\n\n最终回复', turn: 1 });
  await app.event(6, 'text_delta', { delta: 'duplicate must be ignored', turn: 1 });
  await app.event(7, 'tool_start', { tool: 'save_memory', tool_call_id: 'real-save' });
  expect(app.text()).toContain('正在保存记忆…');
  await app.event(8, 'tool_end', { tool: 'save_memory', tool_call_id: 'real-save', is_error: false });
  await app.event(9, 'tool_start', { tool: 'create_task', tool_call_id: 'real-task' });
  expect(app.text()).toContain('正在创建待确认的任务…');
  await app.event(10, 'tool_end', { tool: 'create_task', tool_call_id: 'real-task', is_error: false });
  await app.event(11, 'done', { response }); await pending;
  expect(app.entry().getSnapshot().messages.map(message => message.content)).toEqual(['original intent', '第一段\n\n最终回复']);
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  expect(app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'user'))).toBe(userKey);
  expect(app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'assistant'))).toBe(assistantKey);
  expect(app.input().props.value).toBe('new draft while replying');
  expect(app.invalidate).toHaveBeenCalledTimes(1);
});

test('network drop keeps partial, reattaches the identical null-conversation intent and finalizes cached snapshot without duplicate rows', async () => {
  const app = await setup(); await app.type('original intent'); const { pending } = await app.begin();
  const first = NativeStream.all[0]; const payload = first.body;
  await app.event(1, 'accepted', accepted); await app.event(2, 'text_delta', { delta: '第一段' });
  await app.type('keep this unsent draft');
  await act(async () => first.drop());
  expect(app.text()).toContain('第一段'); expect(app.text()).toContain('正在重新连接');
  await act(async () => { await jest.advanceTimersByTimeAsync(600); });
  const second = NativeStream.all[1];
  expect(second.body).toBe(payload); expect(JSON.parse(second.body).conversation_id).toBeNull();
  expect(second.headers['Last-Event-ID']).toBe('2'); expect(second.headers['X-Chat-Retry']).toBeUndefined();
  await app.event(7, 'snapshot', { sequence: 7, status: 'succeeded', content: response.message.content, ...accepted, response });
  await pending;
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  expect(app.entry().getSnapshot().sending).toBe(false);
  expect(app.input().props.value).toBe('keep this unsent draft');
  expect(second.aborted).toBe(true);
});

test('terminal failure offers in-place retry with original IDs/attachments and preserves a newer draft and attachment', async () => {
  const app = await setup();
  const original = { file: { uri: 'file:///one.txt', name: 'one.txt', mime_type: 'text/plain', size: 2 },
    upload: { id: 'original-upload', name: 'one.txt', mime_type: 'text/plain', size: 2, uri: '', created_at: '' } };
  await act(async () => app.entry().update(old => ({ ...old, attachment: original })));
  await app.type('original intent'); const { pending } = await app.begin(); const first = NativeStream.all[0];
  await app.event(1, 'accepted', accepted); await app.event(2, 'text_delta', { delta: 'partial retained' });
  await app.event(3, 'error', { message: '回复中断', partial: true, retryable: false, attempt: 1 }); await pending;
  expect(app.text()).toContain('partial retained'); expect(app.text()).toContain('重试');
  const deliveredQuestion = app.entry().getSnapshot().messages.find(message => message.role === 'user');
  expect(deliveredQuestion?.delivery).toBe('sent');
  expect(deliveredQuestion?.stream_error).toBeUndefined();
  expect(app.tree.root.findAllByType(ChatReplyFailure)).toHaveLength(1);
  const questionBubble = app.tree.root.findAll(node => node.props.accessibilityLabel === '你的消息：original intent')[0];
  expect(questionBubble.findAllByType(Text).map(node => node.props.children).join(' ')).not.toContain('中断');
  const userKey = app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'user'));
  await app.type('new draft must survive retry');
  const newer = { ...original, file: { ...original.file, name: 'two.txt' } };
  await act(async () => app.entry().update(old => ({ ...old, attachment: newer })));
  const { pending: retried } = await app.retry(); const second = NativeStream.all[1];
  expect(second.body).toBe(first.body); expect(second.headers['X-Chat-Retry']).toBe('1');
  expect(JSON.parse(second.body)).toMatchObject({ conversation_id: null, upload_ids: ['original-upload'], remember: false });
  await app.event(4, 'snapshot', { sequence: 4, status: 'running', attempt: 2, content: 'partial retained', ...accepted });
  expect(app.text()).toContain('partial retained');
  await app.event(5, 'text_start', { turn: 0, attempt: 2 });
  expect(app.text()).toContain('partial retained');
  await app.event(6, 'text_delta', { delta: 'new reply', turn: 0, attempt: 2, replace: true });
  expect(app.entry().getSnapshot().messages.at(-1)?.content).toBe('new reply');
  await app.event(7, 'done', { response: { ...response, message: { ...response.message, content: 'new reply' } } }); await retried;
  expect(app.entry().getSnapshot().messages).toHaveLength(2); expect(app.list().props.keyExtractor(app.list().props.data.find((message: Message) => message.role === 'user'))).toBe(userKey);
  expect(app.input().props.value).toBe('new draft must survive retry'); expect(app.entry().getSnapshot().attachment).toBe(newer);
});

test('a retained hidden entry receives real chunks and tool/read status across History/Back; pop and owner changes reject stale bytes', async () => {
  const app = await setup(); await app.type('original intent'); const { pending } = await app.begin();
  const old = app.entry(); const first = NativeStream.all[0];
  await app.event(1, 'accepted', accepted); await app.history();
  await app.event(2, 'text_delta', { delta: 'hidden partial' });
  await app.event(3, 'tool_start', { tool: 'read_upload', tool_call_id: 'real-read' });
  expect(old.getSnapshot().messages.at(-1)?.content).toBe('hidden partial');
  await app.back(); expect(app.entry()).toBe(old); expect(app.text()).toContain('hidden partial'); expect(app.text()).toContain('正在读取上传的附件…');
  await app.back(); expect(first.aborted).toBe(true);
  first.event(4, 'text_delta', { delta: 'foreign stale chunk' }); await pending;
  expect(old.getSnapshot().messages.at(-1)?.content).toBe('hidden partial');
  const other = await setup(); await other.type('original intent'); const { pending: otherPending } = await other.begin();
  const previous = other.entry(); const latest = NativeStream.all.at(-1)!;
  await other.replaceOwner(); latest.event(1, 'text_delta', { delta: 'foreign owner chunk' }); await otherPending;
  expect(previous.getSnapshot().messages.at(-1)?.content).toBe(''); expect(latest.aborted).toBe(true);
});

test('a late older history page merges accepted server IDs once and keeps every previously loaded row object during streaming', async () => {
  const initial = Array.from({ length: 1004 }, (_, index): Message => ({ id: `old-${index}`, role: 'user', content: `old ${index}`,
    conversation_id: 'existing', created_at: new Date(index * 1000).toISOString() }));
  const app = await setup('existing', initial);
  await app.type('original intent'); const { pending } = await app.begin();
  await app.event(1, 'accepted', accepted); await app.event(2, 'text_delta', { delta: 'real partial' });
  const preserved = app.entry().getSnapshot().messages.find(message => message.id === 'old-500');
  expect(preserved).toBe(initial[500]); expect(app.list().props.data).toHaveLength(1006);
  // The adapter double renders every row; native/recycler window bounds require
  // the real engine and device qualification, not this stream-controller test.
  expect(app.list().props.getItemLayout).toBeUndefined();
  expect(app.list().props.keyExtractor(preserved)).toBe('old-500');
  app.api.messages = jest.fn().mockResolvedValue({ items: [savedUser], next_offset: null });
  await act(async () => app.entry().history.refresh(app.api, 'existing', items => app.entry().update(old => ({ ...old,
    messages: mergeMessageHistory(items, old.messages) })), () => true));
  expect(app.entry().getSnapshot().messages.filter(message => message.id === savedUser.id)).toHaveLength(1);
  await app.event(3, 'done', { response }); await pending;
  expect(app.entry().getSnapshot().messages).toHaveLength(1006); expect(app.entry().getSnapshot().messages.find(message => message.id === 'old-500')).toBe(preserved);
});


test('an initial turn failed before acceptance keeps the new draft editable but gates another conversation until its same-ID Retry resolves', async () => {
  const app = await setup(); await app.type('original intent'); const { pending } = await app.begin();
  const first = NativeStream.all[0];
  await app.event(1, 'error', { message: '尚未确认会话', partial: true, retryable: false }); await pending;
  await app.type('a newer unsent draft');
  expect(app.input().props.editable).toBe(true);
  expect(app.control('发送消息').props.disabled).toBe(true);
  expect(app.text()).toContain('请先重试这条消息');
  await act(async () => app.control('发送消息').props.onPress());
  expect(NativeStream.all).toHaveLength(1);
  const { pending: retry } = await app.retry();
  expect(NativeStream.all[1].body).toBe(first.body);
  await app.event(2, 'snapshot', { sequence: 2, status: 'running', content: '', ...accepted });
  await app.event(3, 'done', { response }); await retry;
  expect(app.entry().getSnapshot().id).toBe('server-conversation');
  expect(app.input().props.value).toBe('a newer unsent draft');
  expect(app.control('发送消息').props.disabled).toBe(false);
  const { pending: second } = await app.begin();
  expect(JSON.parse(NativeStream.all[2].body).conversation_id).toBe('server-conversation');
  await app.event(1, 'error', { message: 'stop synthetic test', partial: true, retryable: false }); await second;
});


test('a history response arriving before accepted reconciles canonical IDs into the original optimistic rows without reordering the turn', async () => {
  const app = await setup('existing'); await app.type('original intent'); const { pending } = await app.begin();
  const originalKeys = app.entry().getSnapshot().messages.map(message => message.client_key);
  await act(async () => app.entry().update(old => ({ ...old,
    messages: mergeMessageHistory([savedUser, response.message], old.messages) })));
  expect(app.entry().getSnapshot().messages).toHaveLength(4);
  await app.event(1, 'accepted', accepted);
  expect(app.entry().getSnapshot().messages.map(message => message.role)).toEqual(['user', 'assistant']);
  expect(app.entry().getSnapshot().messages.map(message => message.client_key)).toEqual(originalKeys);
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  await app.event(2, 'snapshot', { sequence: 2, status: 'succeeded', content: response.message.content, ...accepted, response });
  await pending;
  expect(app.entry().getSnapshot().messages).toHaveLength(2);
  expect(app.entry().getSnapshot().messages.map(message => message.client_key)).toEqual(originalKeys);
});

test('repeated network failures stop automatic reattachment, retain partial text and offer one explicit same-intent Retry', async () => {
  const app = await setup(); await app.type('original intent'); const { pending } = await app.begin();
  await app.event(1, 'accepted', accepted); await app.event(2, 'text_delta', { delta: 'kept across every drop' });
  const originalBody = NativeStream.all[0].body;
  for (const delay of [600, 1200, 1800]) {
    await act(async () => NativeStream.all.at(-1)!.drop());
    await act(async () => { await jest.advanceTimersByTimeAsync(delay); });
  }
  expect(NativeStream.all).toHaveLength(4);
  await act(async () => NativeStream.all.at(-1)!.drop()); await pending;
  expect(app.text()).toContain('kept across every drop'); expect(app.text()).toContain('重试');
  expect(app.entry().getSnapshot().sending).toBe(false);
  await act(async () => { await jest.advanceTimersByTimeAsync(10000); });
  expect(NativeStream.all).toHaveLength(4);
  const { pending: retry } = await app.retry();
  expect(NativeStream.all.at(-1)!.headers['X-Chat-Retry']).toBe('1');
  expect(NativeStream.all.every(xhr => xhr.body === originalBody)).toBe(true);
  await app.event(3, 'snapshot', { sequence: 3, status: 'succeeded', content: response.message.content, ...accepted, response });
  await retry; expect(app.entry().getSnapshot().messages).toHaveLength(2);
});

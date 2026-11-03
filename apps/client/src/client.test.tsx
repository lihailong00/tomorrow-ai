import {StrictMode} from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiClient, type AuthSession, type ChatIntent, type InstanceManifest, type Todo} from '@tada/client-core';
import {App} from './App';
import {Chat, shouldSendOnEnter} from './Chat';
import {CopyButton, Markdown} from './Markdown';
import {ServerDialog} from './Auth';
import {TodosView} from './Views';
import {createPlatform, OFFICIAL_SERVER, serviceLabel, type Platform} from './platform';

vi.mock('./platform', async importOriginal => ({...await importOriginal<typeof import('./platform')>(), createPlatform: vi.fn()}));
vi.mock('@tanstack/react-virtual', () => ({useVirtualizer: (options: {count: number}) => ({
  getTotalSize: () => options.count * 100, scrollToIndex: vi.fn(), measureElement: vi.fn(),
  getVirtualItems: () => Array.from({length: options.count}, (_, i) => ({key: i, index: i, start: i * 100, size: 100})),
})}));
const manifest: InstanceManifest = {id: 'instance-test', name: '测试服务', deployment_mode: 'self_hosted', api_version: 1, auth_methods: ['phone_password'], registration_policy: 'open', public_url: 'http://127.0.0.1:19483', dataflow: {}};
const session: AuthSession = {token: 'synthetic-session-secret', user: {id: 'user-test', name: '测试用户', phone: '+8613800000000', email: '', timezone: 'Asia/Shanghai', created_at: '2026-11-02T00:00:00Z'}};
const fakePlatform = (): Platform => ({desktop: true, transport: {request: vi.fn()}, readSession: vi.fn(async () => null), writeSession: vi.fn(async () => {})});
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {resolve, reject, promise};}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(createPlatform).mockResolvedValue(fakePlatform());
  vi.spyOn(ApiClient.prototype, 'inspectInstance').mockResolvedValue(manifest);
  vi.spyOn(ApiClient.prototype, 'request').mockImplementation(async (path: string) => {
    if (path === '/auth/phone/login') return session;
    if (path === '/me') return session.user;
    if (path.startsWith('/conversations')) return {items: [], next_offset: null};
    if (path === '/auth/logout') return {ok: true};
    throw new Error(`Unexpected request ${path}`);
  });
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: vi.fn(async () => {})}, configurable: true});
});
afterEach(() => {vi.restoreAllMocks();});

describe('输入与富文本', () => {
  it('中文输入法 Enter、229 和 Shift+Enter 不触发发送', () => {
    expect(shouldSendOnEnter({key: 'Enter', shiftKey: false})).toBe(true);
    expect(shouldSendOnEnter({key: 'Enter', shiftKey: true})).toBe(false);
    expect(shouldSendOnEnter({key: 'Enter', shiftKey: false, nativeEvent: {isComposing: true}})).toBe(false);
    expect(shouldSendOnEnter({key: 'Enter', shiftKey: false, nativeEvent: {keyCode: 229}})).toBe(false);
    expect(shouldSendOnEnter({key: 'a', shiftKey: false})).toBe(false);
  });
  it('渲染标题表格和连续代码块，不请求外部图片或注入 HTML', () => {
    const {container} = render(<Markdown text={'# 简报\n\n| 项目 | 状态 |\n| --- | --- |\n| 桌面 | 开发中 |\n\n```rust\nfn main() {\n  println!("ok");\n}\n```\n\n![追踪](https://tracker.invalid/pixel)\n\n<script>alert(1)</script>\n\n[危险](javascript:alert(1))'}/>);
    expect(screen.getByRole('heading', {name: '简报'})).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByLabelText('rust代码块').querySelectorAll('pre')).toHaveLength(1);
    expect(screen.getByLabelText('rust代码块').textContent).toContain('fn main()');
    expect(container.querySelectorAll('img,script')).toHaveLength(0);
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
  });
  it('复制的是原始代码，保留换行与缩进', async () => {
    const code = 'fn main() {\n  println!("ok");\n}';
    render(<Markdown text={'```rust\n' + code + '\n```'}/>);
    fireEvent.click(screen.getByRole('button', {name: '复制代码'}));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code));
  });
  it('无剪贴板权限时显示可恢复提示，不抛异常', async () => {
    Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
    render(<CopyButton text="hello"/>);
    fireEvent.click(screen.getByRole('button', {name: '复制'}));
    expect(screen.getByText('复制失败，请选中文字')).toBeTruthy();
  });
  it('长代码折叠后可展开且不会丢失末行', () => {
    render(<Markdown text={'```rust\n' + Array.from({length: 30}, (_, i) => `let line_${i} = ${i};`).join('\n') + '\n```'}/>);
    expect(screen.queryByText(/let line_29/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: /展开全部 30 行/}));
    expect(screen.getByLabelText('rust代码块').textContent).toContain('let line_29 = 29;');
  });
});

describe('聊天真实事件与重试', () => {
  it('首事件之前失败也能复用原请求重连，用户消息不重复', async () => {
    const attempts: Array<{intent: ChatIntent; cursor: number | undefined}> = [];
    const api = {chatStream: vi.fn(async (intent, onEvent, options) => {
      attempts.push({intent, cursor: options.lastEventId});
      if (attempts.length === 1) throw new Error('网络已中断');
      onEvent({id: 1, event: 'accepted', data: {conversation_id: 'conv-1'}});
      onEvent({id: 2, event: 'text_delta', data: {delta: '真实回复'}});
      onEvent({id: 3, event: 'done', data: {response: {conversation_id: 'conv-1', message: {id: 'assistant-1', role: 'assistant', content: '真实回复', created_at: '', conversation_id: 'conv-1'}}}});
    })} as unknown as ApiClient;
    render(<Chat api={api} conversationId={null} user={session.user} onConversation={vi.fn()} onDone={vi.fn()}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '测试问题'}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    expect(screen.getByLabelText('你发送的消息').textContent).toContain('测试问题');
    await screen.findByText('网络已中断');
    fireEvent.click(screen.getByRole('button', {name: /继续接收/}));
    await screen.findByText('真实回复');
    expect(attempts).toHaveLength(2);
    expect(attempts[1].intent.client_request_id).toBe(attempts[0].intent.client_request_id);
    expect(attempts[1].cursor).toBeUndefined();
    expect(screen.getAllByLabelText('你发送的消息')).toHaveLength(1);
  });
  it('停止接收保留内容，重试从已接收的序号恢复', async () => {
    const cursors: Array<number | undefined> = [];
    const api = {chatStream: vi.fn(async (_intent, onEvent, options) => {
      cursors.push(options.lastEventId);
      if (cursors.length === 1) {
        onEvent({id: 1, event: 'text_delta', data: {delta: '先收到一半'}});
        await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {once: true}));
      } else {
        onEvent({id: 2, event: 'snapshot', data: {content: '先收到一半，然后完成', status: 'done', response: {conversation_id: 'conv-2', message: {id: 'a-2', role: 'assistant', content: '先收到一半，然后完成', created_at: '', conversation_id: 'conv-2'}}}});
      }
    })} as unknown as ApiClient;
    render(<Chat api={api} conversationId={null} user={session.user} onConversation={vi.fn()} onDone={vi.fn()}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '继续测试'}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    await screen.findByText('先收到一半');
    fireEvent.click(screen.getByRole('button', {name: '停止接收回复'}));
    await screen.findByText(/已停止接收/);
    expect(screen.getByText('先收到一半')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '继续接收'}));
    await screen.findByText('先收到一半，然后完成');
    expect(cursors).toEqual([undefined, 1]);
  });
  it('StrictMode 重挂载带历史会话时不永久停留在加载态', async () => {
    const api = {messages: vi.fn(async () => ({items: [{id: 'old-message', role: 'assistant', conversation_id: 'old-conversation', content: '已有的历史消息', created_at: ''}], next_before: null}))} as unknown as ApiClient;
    render(<StrictMode><Chat api={api} conversationId="old-conversation" user={session.user} onConversation={vi.fn()} onDone={vi.fn()}/></StrictMode>);
    await screen.findByText('已有的历史消息');
    expect(screen.queryByText('正在打开对话…')).toBeNull();
  });
});

describe('服务选择与账号隔离', () => {
  it('自定义地址即使清单声称 official，也不会显示官方服务标识', () => {
    expect(serviceLabel('https://private.example.com', {...manifest, deployment_mode: 'official'})).toBe('自定义服务');
    expect(serviceLabel(manifest.public_url, manifest)).toBe('自建服务');
  });
  it('仅已验证的官方地址显示官方服务，容忍正常化后的尾部 /v1', () => {
    expect(serviceLabel(OFFICIAL_SERVER, manifest)).toBe('官方服务');
    expect(serviceLabel(`${OFFICIAL_SERVER}/v1`, manifest)).toBe('官方服务');
  });
  it('尚未验证时不以官方服务作为默认状态', () => {
    expect(serviceLabel(OFFICIAL_SERVER, null)).toBe('正在验证服务');
    expect(serviceLabel('https://private.example.com', null)).toBe('正在验证服务');
  });
  it('检查期间锁定地址，旧检查不会覆盖用户另一个地址', async () => {
    const pending = deferred<InstanceManifest>();
    vi.mocked(ApiClient.prototype.inspectInstance).mockReturnValue(pending.promise);
    const choose = vi.fn();
    render(<ServerDialog platform={fakePlatform()} current={{url: 'http://127.0.0.1:19483'}} onClose={vi.fn()} onChoose={choose}/>);
    fireEvent.click(screen.getByRole('button', {name: '检查连接'}));
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', {name: /自建服务器/}) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(manifest));
    fireEvent.click(screen.getByRole('button', {name: '确认使用这台服务器'}));
    await waitFor(() => expect(choose).toHaveBeenCalledWith(expect.objectContaining({url: 'http://127.0.0.1:19483', instanceId: 'instance-test'}), manifest));
  });
  it('损坏的旧地址显示可恢复设置入口，不白屏或静默切回官方', async () => {
    localStorage.setItem('tada.client.server.v1', JSON.stringify({url: 'bad-old-url'}));
    render(<App/>);
    await screen.findByRole('button', {name: '检查服务地址'});
    expect(screen.getByText('bad-old-url')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '检查服务地址'}));
    expect((screen.getByLabelText('服务地址') as HTMLInputElement).value).toBe('bad-old-url');
  });
  it('同地址实例变化时不读取系统中的旧凭据', async () => {
    const platform = fakePlatform(); vi.mocked(createPlatform).mockResolvedValue(platform);
    localStorage.setItem('tada.client.server.v1', JSON.stringify({url: manifest.public_url, instanceId: 'previous-instance', autoRestore: true}));
    render(<App/>);
    await screen.findByText(/服务器实例身份已变化/);
    expect(platform.readSession).not.toHaveBeenCalled();
    expect((screen.getByRole('button', {name: '请先检查服务器'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('凭据库与远端退出都失败时，退出墓碑仍阻止重启自动登录', async () => {
    const platform = fakePlatform(); vi.mocked(createPlatform).mockResolvedValue(platform);
    localStorage.setItem('tada.client.server.v1', JSON.stringify({url: manifest.public_url, instanceId: manifest.id}));
    const view = render(<App/>);
    await screen.findByRole('textbox', {name: '手机号'});
    fireEvent.change(screen.getByRole('textbox', {name: '手机号'}), {target: {value: '13800000000'}});
    fireEvent.change(screen.getByLabelText('登录密码'), {target: {value: 'synthetic-password'}});
    fireEvent.click(screen.getByRole('button', {name: '登录'}));
    await screen.findByRole('heading', {name: /有什么想聊的/});
    await waitFor(() => expect(JSON.parse(localStorage.getItem('tada.client.server.v1')!).autoRestore).toBe(true));
    vi.mocked(platform.writeSession).mockRejectedValue(new Error('keyring unavailable'));
    vi.mocked(ApiClient.prototype.request).mockImplementation(async (path: string) => {if (path === '/auth/logout') throw new Error('offline'); return {items: []};});
    fireEvent.click(screen.getByRole('button', {name: /测试用户/}));
    fireEvent.click(await screen.findByRole('button', {name: '退出登录'}));
    fireEvent.click(await screen.findByRole('button', {name: '确认退出登录'}));
    await screen.findByText(/系统凭据清理和远端会话撤销尚未确认/);
    expect(JSON.parse(localStorage.getItem('tada.client.server.v1')!).autoRestore).toBe(false);
    view.unmount();
    render(<App/>);
    await screen.findByRole('textbox', {name: '手机号'});
    expect(platform.readSession).not.toHaveBeenCalled();
    expect(localStorage.getItem('tada.client.server.v1')).not.toContain(session.token);
  });
});

describe('事项操作切换范围', () => {
  it('编辑事项携带当前版本号，保留编辑后的内容', async () => {
    const todo: Todo = {id: 'todo-edit', title: '原事项', description: '原说明', kind: 'general', status: 'pending', source_kind: 'manual', source_label: '手动添加', created_at: '', updated_at: '', version: 7};
    const api = {todos: vi.fn(async () => ({items: [todo], next_offset: null})), updateTodo: vi.fn(async () => ({...todo, title: '更新后的事项', version: 8}))} as unknown as ApiClient;
    render(<TodosView api={api}/>);
    fireEvent.click(await screen.findByRole('button', {name: '查看事项：原事项'}));
    fireEvent.click(screen.getByRole('button', {name: '编辑事项'}));
    expect((screen.getByLabelText('事项标题') as HTMLInputElement).value).toBe('原事项');
    fireEvent.change(screen.getByLabelText('事项标题'), {target: {value: '更新后的事项'}});
    fireEvent.click(screen.getByRole('button', {name: '保存事项'}));
    await waitFor(() => expect(api.updateTodo).toHaveBeenCalledWith('todo-edit', {title: '更新后的事项', description: '原说明', kind: 'general', version: 7}));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('删除事项需要明确确认，点击保留不发送删除请求', async () => {
    const todo: Todo = {id: 'todo-delete', title: '可以删除的合成事项', description: '', kind: 'general', status: 'pending', source_kind: 'manual', source_label: '手动添加', created_at: '', updated_at: '', version: 1};
    const api = {todos: vi.fn(async () => ({items: [todo], next_offset: null})), deleteTodo: vi.fn(async () => ({ok: true}))} as unknown as ApiClient;
    render(<TodosView api={api}/>);
    fireEvent.click(await screen.findByRole('button', {name: '查看事项：可以删除的合成事项'}));
    fireEvent.click(screen.getByRole('button', {name: '删除事项'}));
    expect(api.deleteTodo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '保留'}));
    expect(api.deleteTodo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '删除事项'}));
    fireEvent.click(screen.getByRole('button', {name: '确认删除事项'}));
    await waitFor(() => expect(api.deleteTodo).toHaveBeenCalledWith('todo-delete'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('更新过程中切换筛选不会让其他事项永久不能完成', async () => {
    const todo: Todo = {id: 'todo-1', title: '合成事项', description: '', kind: 'general', status: 'pending', source_kind: 'manual', source_label: '手动添加', created_at: '', updated_at: '', version: 1};
    const update = deferred<Todo>();
    const api = {todos: vi.fn(async () => ({items: [todo], next_offset: null})), updateTodo: vi.fn().mockReturnValueOnce(update.promise).mockResolvedValue({...todo, status: 'completed', version: 2})} as unknown as ApiClient;
    render(<TodosView api={api}/>);
    fireEvent.click(await screen.findByRole('button', {name: '完成事项：合成事项'}));
    fireEvent.click(screen.getByRole('button', {name: '全部'}));
    await waitFor(() => expect(api.todos).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', {name: '完成事项：合成事项'}));
    expect(api.updateTodo).toHaveBeenCalledTimes(2);
    await act(async () => update.resolve({...todo, status: 'completed', version: 2}));
  });
});

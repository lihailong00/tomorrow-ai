import {useRef} from 'react';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ApiClient, ChatIntent, User} from '@tada/client-core';
import {Chat} from './Chat';
import {composeFollowUpMessage, TextSelectionActions} from './TextSelectionActions';

vi.mock('@tanstack/react-virtual', () => ({useVirtualizer: (options: {count: number}) => ({
  getTotalSize: () => options.count * 100, scrollToIndex: vi.fn(), measureElement: vi.fn(),
  getVirtualItems: () => Array.from({length: options.count}, (_, index) => ({key: index, index, start: index * 100, size: 100})),
})}));

function Harness({onFollowUp = vi.fn(), resetKey = 'one', disabled = false}: {onFollowUp?: (text: string) => void; resetKey?: string; disabled?: boolean}) {
  const viewport = useRef<HTMLDivElement>(null);
  return <><div ref={viewport} data-testid="viewport"><div data-selection-content>这里每一个 <code>pubkey</code> 就是业务公钥</div><div data-selection-content>另一条消息</div><textarea aria-label="草稿"/></div><p>消息区之外</p><TextSelectionActions containerRef={viewport} onFollowUp={onFollowUp} resetKey={resetKey} followUpDisabled={disabled}/></>;
}
function select(element: HTMLElement, rect = {left: 100, top: 200, bottom: 220, width: 260, height: 20, right: 360, x: 100, y: 200, toJSON: () => {}}) {
  const range = document.createRange(); range.selectNodeContents(element);
  Object.defineProperty(range, 'getBoundingClientRect', {value: () => rect});
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return range;
}
function message() {return screen.getByText('pubkey').closest<HTMLElement>('[data-selection-content]')!;}
function releaseSelection(element = message()) {select(element); fireEvent.pointerUp(element, {button: 0});}

beforeEach(() => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  Object.defineProperty(navigator, 'clipboard', {value: {writeText: vi.fn(async () => {})}, configurable: true});
});
afterEach(() => {window.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('消息文字选择操作', () => {
  it('拖选期间不打断选择，松开后显示复制、朗读、追问', () => {
    render(<Harness/>); fireEvent.pointerDown(message(), {button: 0}); select(message());
    fireEvent(document, new Event('selectionchange'));
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.pointerUp(message(), {button: 0});
    expect(screen.getByRole('toolbar', {name: '选中文字操作'}).querySelectorAll('button')).toHaveLength(3);
    expect(screen.getByRole('button', {name: '复制'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '朗读'})).toBeTruthy();
    expect(screen.getByRole('button', {name: '追问'})).toBeTruthy();
  });
  it('复制保留原选区的文本，跨行和代码不丢失，也不触发追问', async () => {
    const ask = vi.fn(); render(<Harness onFollowUp={ask}/>); releaseSelection();
    const selected = window.getSelection()?.toString();
    fireEvent.click(screen.getByRole('button', {name: '复制'}));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(selected));
    expect(ask).not.toHaveBeenCalled(); expect(screen.getByRole('status').textContent).toContain('已复制');
  });
  it('右键仅显示复制，并复制选中文字，不出现朗读或追问', async () => {
    render(<Harness/>); select(message());
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 210, clientY: 260});
    fireEvent(message(), event); expect(event.defaultPrevented).toBe(true);
    const menu = screen.getByRole('menu', {name: '消息右键菜单'});
    expect(menu.querySelectorAll('button')).toHaveLength(1);
    expect(screen.queryByRole('button', {name: '朗读'})).toBeNull();
    expect(screen.queryByRole('button', {name: '追问'})).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', {name: '复制'}));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('这里每一个 pubkey 就是业务公钥'));
  });
  it('无选区时右键复制当前消息，输入框保留系统原有菜单', async () => {
    render(<Harness/>);
    fireEvent.contextMenu(screen.getByText('另一条消息'), {clientX: 10, clientY: 20});
    fireEvent.click(screen.getByRole('menuitem', {name: '复制'}));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('另一条消息'));
    const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
    fireEvent(screen.getByRole('textbox'), event); expect(event.defaultPrevented).toBe(false);
  });
  it('点击外部输入框关闭且不抢焦点，Escape、滚动也能关闭', async () => {
    const user = userEvent.setup(); render(<Harness/>); releaseSelection();
    await user.click(screen.getByRole('textbox'));
    expect(screen.queryByRole('toolbar')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('textbox'));
    releaseSelection(); fireEvent.keyDown(document, {key: 'Escape'}); expect(screen.queryByRole('toolbar')).toBeNull();
    releaseSelection(); fireEvent.scroll(screen.getByTestId('viewport')); expect(screen.queryByRole('toolbar')).toBeNull();
  });
  it('键盘选择可显示，消息区域之外的选中文字不显示', () => {
    render(<Harness/>); select(message()); fireEvent.keyUp(message(), {key: 'ArrowRight', shiftKey: true});
    expect(screen.getByRole('toolbar')).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('消息区之外'), {button: 0});
    select(screen.getByText('消息区之外')); fireEvent.pointerUp(screen.getByText('消息区之外'), {button: 0});
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
  it('外部点击或输入框的快捷键不会用残留选区重新打开浮条', () => {
    render(<Harness/>); releaseSelection();
    const outside = screen.getByText('消息区之外');
    fireEvent.pointerDown(outside, {button: 0}); fireEvent.pointerUp(outside, {button: 0});
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.keyUp(screen.getByRole('textbox'), {key: 'ArrowRight', shiftKey: true});
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.keyUp(document, {key: 'Tab', shiftKey: true});
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
  it('选区横跨两条消息时不误引用另一条，禁用追问时仍可复制', () => {
    render(<Harness disabled/>); releaseSelection();
    expect((screen.getByRole('button', {name: '追问'}) as HTMLButtonElement).disabled).toBe(true);
    const range = document.createRange(); range.setStart(message().firstChild!, 0); range.setEnd(screen.getByText('另一条消息').firstChild!, 3);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    fireEvent.pointerUp(message(), {button: 0}); expect(screen.queryByRole('toolbar')).toBeNull();
  });
  it('复制权限失败时保留浮条并提示重试', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('denied'));
    render(<Harness/>); releaseSelection(); fireEvent.click(screen.getByRole('button', {name: '复制'}));
    await screen.findByText('复制失败，请重试或使用 Ctrl+C'); expect(screen.getByRole('toolbar')).toBeTruthy();
  });
  it('朗读使用选中文字和系统语音；切换会话或点击停止会取消', () => {
    class Utterance {text: string; onend: (() => void) | null = null; onerror = null; constructor(text: string) {this.text = text;}}
    const voice = {lang: 'zh-CN', localService: true, name: '合成系统语音'};
    const speech = {getVoices: vi.fn(() => [voice]), speak: vi.fn(), cancel: vi.fn()};
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance); vi.stubGlobal('speechSynthesis', speech);
    const view = render(<Harness/>); releaseSelection(); fireEvent.click(screen.getByRole('button', {name: '朗读'}));
    expect(speech.speak).toHaveBeenCalledTimes(1);
    expect(speech.speak.mock.calls[0][0]).toMatchObject({text: '这里每一个 pubkey 就是业务公钥', voice});
    expect(screen.getByText('正在朗读')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', {name: '停止朗读'})[0]); expect(speech.cancel).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '朗读'}));
    view.rerender(<Harness resetKey="two"/>); expect(speech.cancel).toHaveBeenCalledTimes(2); expect(screen.queryByText('正在朗读')).toBeNull();
  });
  it('没有系统语音能力时说明失败，仍可复制和追问', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    render(<Harness/>); releaseSelection(); fireEvent.click(screen.getByRole('button', {name: '朗读'}));
    expect(screen.getByRole('status').textContent).toContain('当前系统不支持朗读');
    expect(screen.getByRole('button', {name: '复制'})).toBeTruthy(); expect(screen.getByRole('button', {name: '追问'})).toBeTruthy();
  });
  it('追问保留草稿并展示引用；只有发送才将选中内容和问题传给模型', async () => {
    const user: User = {id: 'synthetic-user', name: '合成用户', email: '', timezone: 'Asia/Shanghai', created_at: ''};
    const intents: ChatIntent[] = [];
    const api = {messages: vi.fn(async () => ({items: [{id: 'm1', conversation_id: 'c1', role: 'assistant', content: '这里的 pubkey 就是业务公钥', created_at: ''}]})), chatStream: vi.fn(async (intent: ChatIntent) => {intents.push(intent); throw new Error('合成断线');})} as unknown as ApiClient;
    render(<Chat api={api} conversationId="c1" user={user} onConversation={vi.fn()} onDone={vi.fn()}/>);
    await screen.findByText('这里的 pubkey 就是业务公钥');
    const input = screen.getByRole('textbox', {name: '发送消息'}) as HTMLTextAreaElement;
    fireEvent.change(input, {target: {value: '这是什么意思？'}});
    releaseSelection(screen.getByText('这里的 pubkey 就是业务公钥').closest<HTMLElement>('[data-selection-content]')!);
    fireEvent.click(screen.getByRole('button', {name: '追问'}));
    expect(screen.getByText('追问这段内容')).toBeTruthy(); expect(input.value).toBe('这是什么意思？'); expect(document.activeElement).toBe(input);
    expect(intents).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    await waitFor(() => expect(intents).toHaveLength(1));
    expect(intents[0].message).toBe('针对以下引用内容：\n> 这里的 pubkey 就是业务公钥\n\n这是什么意思？');
    expect(screen.queryByText('追问这段内容')).toBeNull();
  });
  it('追问文本保留换行；普通发送不添加引用包装', () => {
    expect(composeFollowUpMessage('问题', null)).toBe('问题');
    expect(composeFollowUpMessage('为什么？', 'line1\r\n  line2')).toBe('针对以下引用内容：\n> line1\n>   line2\n\n为什么？');
  });
});

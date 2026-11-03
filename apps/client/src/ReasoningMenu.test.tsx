import {useState} from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ApiClient, ChatIntent, ReasoningEffort, User} from '@tada/client-core';
import {ReasoningMenu} from './ReasoningMenu';
import {Chat} from './Chat';

vi.mock('@tanstack/react-virtual', () => ({useVirtualizer: (options: {count: number}) => ({
  getTotalSize: () => options.count * 100, scrollToIndex: vi.fn(), measureElement: vi.fn(),
  getVirtualItems: () => Array.from({length: options.count}, (_, index) => ({key: index, index, start: index * 100, size: 100})),
})}));
afterEach(() => vi.restoreAllMocks());
function Controlled({initial = 'off'}: {initial?: ReasoningEffort}) {
  const [value, setValue] = useState(initial);
  return <><ReasoningMenu value={value} onChange={setValue}/><button>其他位置</button></>;
}

describe('思考浮层', () => {
  it('按钮显示当前模式；浮层包含四个有说明的单选项和当前勾选', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="high"/>);
    const trigger = screen.getByRole('button', {name: '思考模式：深度思考'});
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    const menu = screen.getByRole('menu', {name: '思考模式'});
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(4);
    expect(screen.getByRole('menuitemradio', {name: /深度思考/}).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', {name: /尽力思考/}).textContent).toContain('可能需要更久');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', {name: /深度思考/}));
  });
  it('选择后更新模式、关闭浮层，并将焦点还给按钮', async () => {
    const user = userEvent.setup(); render(<Controlled/>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    await user.click(screen.getByRole('menuitemradio', {name: /轻度思考/}));
    expect(screen.queryByRole('menu')).toBeNull();
    const trigger = screen.getByRole('button', {name: '思考模式：轻度思考'});
    expect(document.activeElement).toBe(trigger);
  });
  it('方向键循环移动，Home/End 跳到首末项，Enter 确认', async () => {
    const user = userEvent.setup(); render(<Controlled/>);
    screen.getByRole('button', {name: '思考模式：思考关闭'}).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', {name: /思考关闭/}));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', {name: /尽力思考/}));
    await user.keyboard('{Home}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitemradio', {name: /轻度思考/}));
    await user.keyboard('{End}{Enter}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', {name: '思考模式：尽力思考'}));
  });
  it('Space 可展开并确认模式，不提交外层表单', async () => {
    const user = userEvent.setup(); const submit = vi.fn((event: React.FormEvent) => event.preventDefault()); const change = vi.fn();
    render(<form onSubmit={submit}><ReasoningMenu value="off" onChange={change}/></form>);
    screen.getByRole('button', {name: '思考模式：思考关闭'}).focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown} ');
    expect(change).toHaveBeenCalledWith('low');
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('Escape 取消，不改变模式，并还原焦点', async () => {
    const user = userEvent.setup(); const change = vi.fn(); render(<ReasoningMenu value="low" onChange={change}/>);
    await user.click(screen.getByRole('button', {name: '思考模式：轻度思考'}));
    await user.keyboard('{ArrowDown}{Escape}');
    expect(change).not.toHaveBeenCalled(); expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', {name: '思考模式：轻度思考'}));
  });
  it('点击说明区域失焦至 BODY 后，文档 Escape 仍关闭菜单并恢复按钮焦点', async () => {
    const user = userEvent.setup(); const change = vi.fn(); render(<ReasoningMenu value="low" onChange={change}/>);
    const trigger = screen.getByRole('button', {name: '思考模式：轻度思考'});
    await user.click(trigger);
    await user.click(screen.getByText('按问题选择，随时切换'));
    const previousTabIndex = document.body.getAttribute('tabindex');
    try {
      document.body.setAttribute('tabindex', '-1'); document.body.focus();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document, {key: 'Escape', code: 'Escape'});
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(change).not.toHaveBeenCalled();
    } finally {if (previousTabIndex === null) document.body.removeAttribute('tabindex'); else document.body.setAttribute('tabindex', previousTabIndex);}
  });
  it('点击外部关闭，点击内部说明不会误关闭或提交', async () => {
    const user = userEvent.setup(); const change = vi.fn(); render(<ReasoningMenu value="off" onChange={change}/>);
    const trigger = screen.getByRole('button', {name: '思考模式：思考关闭'});
    await user.click(trigger);
    await user.click(screen.getByText('按问题选择，随时切换'));
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull(); expect(change).not.toHaveBeenCalled();
  });
  it('点击外部输入框会关闭，并保留被点击输入框的焦点', async () => {
    const user = userEvent.setup(); render(<><ReasoningMenu value="off" onChange={vi.fn()}/><input aria-label="外部输入框"/></>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    const input = screen.getByRole('textbox', {name: '外部输入框'});
    await user.click(input);
    expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(input);
  });
  it('Tab 关闭并进入后一个控件，Shift+Tab 正常进入前一个控件', async () => {
    const user = userEvent.setup(); render(<><button>前一个控件</button><ReasoningMenu value="off" onChange={vi.fn()}/><button>后一个控件</button></>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', {name: '后一个控件'}));
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(screen.getByRole('button', {name: '前一个控件'}));
  });
  it('禁用时不能展开；发送过程中切为禁用会关闭已打开的浮层', async () => {
    const user = userEvent.setup(); const change = vi.fn();
    const view = render(<ReasoningMenu value="off" onChange={change} disabled/>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    expect(screen.queryByRole('menu')).toBeNull();
    view.rerender(<ReasoningMenu value="off" onChange={change}/>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    expect(screen.getByRole('menu')).toBeTruthy();
    view.rerender(<ReasoningMenu value="off" onChange={change} disabled/>);
    expect(screen.queryByRole('menu')).toBeNull(); expect(change).not.toHaveBeenCalled();
  });
  it('窄窗口下限制宽度并向上定位，缩放引发 resize 后重算', async () => {
    const user = userEvent.setup();
    const originalWidth = Object.getOwnPropertyDescriptor(document.documentElement, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', {value: 360, configurable: true});
    const rect = {left: 320, top: 480, right: 430, bottom: 511, width: 110, height: 31, x: 320, y: 480, toJSON: () => {}};
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    try {
      render(<Controlled/>); await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
      const menu = screen.getByRole('menu');
      expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(48);
      expect(Number.parseFloat(menu.style.width)).toBe(300);
      expect(Number.parseFloat(menu.style.top)).toBeLessThan(480);
      rect.top = 230;
      act(() => window.dispatchEvent(new Event('resize')));
      expect(Number.parseFloat(menu.style.maxHeight)).toBe(210);
      expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(10);
    } finally {if (originalWidth) Object.defineProperty(document.documentElement, 'clientWidth', originalWidth); else delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;}
  });
  it('选择 high 后真实聊天请求仍传 reasoning_effort:high，浮层不发送消息', async () => {
    const user = userEvent.setup(); const intent: ChatIntent[] = [];
    const api = {chatStream: vi.fn(async (input: ChatIntent) => {intent.push(input); throw new Error('合成断线');})} as unknown as ApiClient;
    const account: User = {id: 'synthetic-user', name: '合成用户', email: '', timezone: 'Asia/Shanghai', created_at: ''};
    render(<Chat api={api} conversationId={null} user={account} onConversation={vi.fn()} onDone={vi.fn()}/>);
    await user.click(screen.getByRole('button', {name: '思考模式：思考关闭'}));
    await user.click(screen.getByRole('menuitemradio', {name: /深度思考/}));
    expect(api.chatStream).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '合成问题'}});
    await user.click(screen.getByRole('button', {name: '发送'}));
    await waitFor(() => expect(intent[0]?.reasoning_effort).toBe('high'));
    expect(intent[0].message).toBe('合成问题');
  });
});

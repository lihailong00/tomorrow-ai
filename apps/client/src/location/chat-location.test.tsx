import {StrictMode} from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import type {ApiClient, ChatIntent, ChatLocationContext, User} from '@tada/client-core';
import {Chat} from '../Chat';
import {LocationFailure, type LocationBridge} from './bridge';
import {needsCurrentLocation, locationInputAction, validLocation} from './model';

vi.mock('@tanstack/react-virtual', () => ({useVirtualizer: (options: {count: number}) => ({
  getTotalSize: () => options.count * 100, scrollToIndex: vi.fn(), measureElement: vi.fn(),
  getVirtualItems: () => Array.from({length: options.count}, (_, index) => ({key: index, index, start: index * 100, size: 100})),
})}));
const user: User = {id: 'synthetic-location-user', name: '测试', email: '', timezone: 'Asia/Shanghai', created_at: ''};
const fix = (): ChatLocationContext => ({source: 'device', latitude: 31.2, longitude: 121.5, accuracy_m: 30, observed_at: new Date().toISOString(), coordinate_system: 'wgs84'});
function setup(bridge: LocationBridge = {current: vi.fn(async () => fix())}) {
  const intents: ChatIntent[] = [];
  const api = {messages: vi.fn(async () => ({items: []})), request: vi.fn(async () => ({items: []})), chatStream: vi.fn(async (intent: ChatIntent, event: (value: unknown) => void) => {
    intents.push(intent); event({id: 1, event: 'done', data: {response: {conversation_id: 'location-chat', message: {id: 'a', conversation_id: 'location-chat', role: 'assistant', content: '已使用提供的位置', created_at: ''}}}});
  })} as unknown as ApiClient;
  const props = {api, conversationId: null, user, locationBridge: bridge, onConversation: vi.fn(), onDone: vi.fn()};
  const view = render(<StrictMode><Chat {...props}/></StrictMode>);
  function send(text = '现在打车回家多少钱，多久能到？如果明显不划算，再给我一个地铁方案。') {
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: text}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
  }
  return {...view, api, bridge, intents, send, props};
}

describe('chat location flow', () => {
  it('confirms the current Didi card exactly once in the desktop conversation', async () => {
    const app = setup();
    let finish!: () => void;
    const done = new Promise<void>(resolve => {finish = resolve;});
    vi.mocked(app.api.chatStream).mockImplementation(async (intent, receive) => {
      expect(intent.didi_order_confirmation_supported).toBe(true);
      receive({id: 0, event: 'snapshot', data: {status: 'running'}});
      receive({id: 0, event: 'interaction', data: {card: {kind: 'didi_order', id: 'order-card',
        run_id: 'ride-run', expires_at: Math.floor(Date.now() / 1000) + 120, from: '上海站', to: '虹桥站',
        products: [{name: '经济型', price: '42 元'}], sandbox: true, phone_suffix: '1234'}}});
      await done;
      receive({id: 1, event: 'done', data: {response: {conversation_id: 'ride-chat',
        message: {id: 'a', role: 'assistant', content: '已收到模拟订单回执', created_at: ''}}}});
    });
    app.send('从上海站打车到虹桥站。');
    const confirm = await screen.findByRole('button', {name: '确认叫车'});
    expect(screen.getByText('上海站', {selector: 'dd'})).toBeTruthy();
    expect(screen.getByText('经济型 · 42 元')).toBeTruthy();
    await act(async () => {fireEvent.click(confirm); fireEvent.click(confirm);});
    expect(app.api.request).toHaveBeenCalledTimes(1);
    expect(app.api.request).toHaveBeenCalledWith('/chat/interactions/ride-run/order-card', 'POST', {kind: 'confirm_didi_order'});
    await act(async () => finish());
    expect(await screen.findByText('已收到模拟订单回执')).toBeTruthy();
  });
  it('puts the outgoing bubble above the countdown and only then sends the authorized fix', async () => {
    vi.useFakeTimers();
    const bridge = {current: vi.fn(async () => fix()), canLocateSilently: vi.fn(async () => true)};
    const app = setup(bridge);
    try {
      app.send('打车去上班。');
      await act(async () => {await vi.advanceTimersByTimeAsync(0);});
      const bubble = screen.getByText('打车去上班。');
      const picker = screen.getByRole('dialog', {name: '选择当前位置'});
      expect(bubble.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByText('5 秒后使用当前位置')).toBeTruthy();
      expect((screen.getByRole('textbox', {name: '发送消息'}) as HTMLTextAreaElement).value).toBe('');
      expect(app.intents).toHaveLength(0);
      await act(async () => {await vi.advanceTimersByTimeAsync(4999);});
      expect(bridge.current).not.toHaveBeenCalled();
      await act(async () => {await vi.advanceTimersByTimeAsync(1);});
      expect(bridge.current).toHaveBeenCalledWith(expect.any(AbortSignal), true);
      expect(app.intents).toHaveLength(1);
    } finally {app.unmount(); vi.useRealTimers();}
  });
  it('shows the current-position dot when manual selection interrupts the countdown', async () => {
    const bridge = {current: vi.fn(async () => fix()), canLocateSilently: vi.fn(async () => true)};
    const app = setup(bridge);
    app.send('打车去上班。');
    await screen.findByText('5 秒后使用当前位置');
    fireEvent.click(screen.getByRole('button', {name: /^手动填写/}));
    expect(await screen.findByLabelText('当前位置')).toBeTruthy();
    expect(screen.getByText('当前位置附近 · 5 公里内')).toBeTruthy();
    expect(app.intents).toHaveLength(0);
    expect(screen.queryByText(/秒后使用当前位置/)).toBeNull();
  });
  it('offers real choices before a location-dependent send, then continues the original question once', async () => {
    const test = setup(); test.send();
    expect(screen.getByRole('dialog', {name: '选择当前位置'})).toBeTruthy();
    expect(test.api.chatStream).not.toHaveBeenCalled(); expect(test.bridge.current).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: /^自动定位/}));
    await waitFor(() => expect(test.intents).toHaveLength(1));
    expect(test.intents[0].client_context?.location).toMatchObject({latitude: 31.2, longitude: 121.5, accuracy_m: 30, coordinate_system: 'wgs84'});
    expect(test.intents[0].message).toContain('地铁方案'); expect(test.intents[0].message).not.toContain('自动定位');
    expect(screen.getAllByLabelText('你发送的消息')).toHaveLength(1);
    expect((screen.getByRole('textbox', {name: '发送消息'}) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByRole('button', {name: /自动定位 · 约30米/})).toBeTruthy();
  });
  it('typed 自动定位 requests actual OS permission, not an ordinary empty-context model call', async () => {
    const test = setup(); test.send('自动定位');
    await waitFor(() => expect(test.intents).toHaveLength(1));
    expect(test.bridge.current).toHaveBeenCalledTimes(1); expect(test.intents[0].client_context?.location?.source).toBe('device');
  });
  it('denied permission offers settings/retry/manual without losing the original draft', async () => {
    const bridge = {current: vi.fn().mockRejectedValue(new LocationFailure('permission_denied')), openSettings: vi.fn(async () => {})};
    const test = setup(bridge); test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/}));
    await screen.findByRole('alert'); expect(test.api.chatStream).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '打开系统设置'})); await waitFor(() => expect(bridge.openSettings).toHaveBeenCalledTimes(1));
    bridge.current.mockResolvedValueOnce(fix()); fireEvent.click(screen.getByRole('button', {name: /^重新定位/}));
    await waitFor(() => expect(test.intents).toHaveLength(1)); expect(test.intents[0].client_context?.location?.source).toBe('device');
  });
  it('browser denial points to site permissions and still allows manual input', async () => {
    const test = setup({current: vi.fn().mockRejectedValue(new LocationFailure('permission_denied'))}); test.send();
    fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); await screen.findByText(/浏览器地址栏的网站设置/);
    fireEvent.click(screen.getByRole('button', {name: /^手动填写/}));
    fireEvent.change(screen.getByLabelText('城市、地标或地址'), {target: {value: '上海虹桥火车站'}});
    fireEvent.click(screen.getByRole('button', {name: '使用这个位置'}));
    await waitFor(() => expect(test.intents).toHaveLength(1));
    expect(test.intents[0].client_context?.location).toMatchObject({source: 'manual', label: '上海虹桥火车站'});
    expect(test.intents[0].client_context?.location?.latitude).toBeUndefined();
  });
  it('skip continues without coordinates; cancel preserves the message instead of sending', async () => {
    const test = setup(); test.send(); fireEvent.keyDown(document, {key: 'Escape'});
    await waitFor(() => expect((screen.getByRole('button', {name: '发送'}) as HTMLButtonElement).disabled).toBe(false));
    expect(test.api.chatStream).not.toHaveBeenCalled();
    expect((screen.getByRole('textbox', {name: '发送消息'}) as HTMLTextAreaElement).value).toContain('打车回家');
    fireEvent.click(screen.getByRole('button', {name: '发送'})); fireEvent.click(screen.getByRole('button', {name: '暂不提供'}));
    await waitFor(() => expect(test.intents).toHaveLength(1)); expect(test.intents[0].client_context?.location).toBeUndefined();
  });
  it('an unrelated next question never reuses a previous precise location', async () => {
    const test = setup(); test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/}));
    await waitFor(() => expect(test.intents).toHaveLength(1));
    test.send('解释 Rust 的所有权'); await waitFor(() => expect(test.intents).toHaveLength(2));
    expect(test.intents[1].client_context?.location).toBeUndefined(); expect(test.bridge.current).toHaveBeenCalledTimes(1);
  });
  it('moving users refresh the fix for a new relevant question', async () => {
    const bridge = {current: vi.fn().mockImplementation(async () => fix())}; const test = setup(bridge);
    test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); await waitFor(() => expect(test.intents).toHaveLength(1));
    bridge.current.mockImplementation(async () => ({...fix(), latitude: 31.3})); test.send('附近有什么餐厅');
    fireEvent.click(screen.getByRole('button', {name: /^自动定位/}));
    await waitFor(() => expect(test.intents).toHaveLength(2)); expect(bridge.current).toHaveBeenCalledTimes(2);
    expect(test.intents[0].client_context?.location?.latitude).toBe(31.2); expect(test.intents[1].client_context?.location?.latitude).toBe(31.3);
  });
  it('a transport retry keeps the same request ID and original location snapshot', async () => {
    const test = setup(); vi.mocked(test.api.chatStream).mockImplementation(async intent => {test.intents.push(intent); throw new Error('合成断线');});
    test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); await screen.findByText('合成断线');
    const first = JSON.stringify(test.intents[0]); fireEvent.click(screen.getByRole('button', {name: /继续接收/}));
    await waitFor(() => expect(test.intents).toHaveLength(2)); expect(JSON.stringify(test.intents[1])).toBe(first); expect(test.bridge.current).toHaveBeenCalledTimes(1);
  });
  it('closing/switching chats cancels pending location and ignores late results', async () => {
    let complete!: (value: ChatLocationContext) => void; let signal!: AbortSignal;
    const bridge = {current: vi.fn((value: AbortSignal) => {signal = value; return new Promise<ChatLocationContext>(resolve => {complete = resolve;});})};
    const test = setup(bridge); test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/}));
    test.rerender(<StrictMode><Chat {...test.props} conversationId="another-chat"/></StrictMode>);
    await act(async () => complete(fix())); expect(signal.aborted).toBe(true); expect(test.api.chatStream).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', {name: '选择当前位置'})).toBeNull();
  });
  it('account/service unmount cancels native work and never persists coordinates', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem'); let complete!: (value: ChatLocationContext) => void; let signal!: AbortSignal;
    const bridge = {current: vi.fn((value: AbortSignal) => {signal = value; return new Promise<ChatLocationContext>(resolve => {complete = resolve;});})};
    const test = setup(bridge); test.send(); fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); test.unmount();
    await act(async () => complete(fix())); expect(signal.aborted).toBe(true); expect(test.api.chatStream).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  });
  it.each(['timeout', 'services_disabled', 'unsupported', 'insecure_context'])('keeps %s recoverable without a model request', async code => {
    const test = setup({current: vi.fn().mockRejectedValue(new LocationFailure(code as never))}); test.send();
    fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); await screen.findByRole('alert');
    expect(test.api.chatStream).not.toHaveBeenCalled(); expect(screen.getByRole('button', {name: /^手动填写/})).toBeTruthy();
  });
  it('rejects expired/invalid fixes and overlong manual locations before sending', async () => {
    const test = setup({current: vi.fn(async () => ({...fix(), observed_at: new Date(Date.now() - 300_001).toISOString()}))}); test.send();
    fireEvent.click(screen.getByRole('button', {name: /^自动定位/})); await screen.findByText(/未获得有效的新位置/);
    fireEvent.click(screen.getByRole('button', {name: /^手动填写/})); fireEvent.change(screen.getByLabelText('城市、地标或地址'), {target: {value: '甲'.repeat(201)}});
    fireEvent.click(screen.getByRole('button', {name: '使用这个位置'})); await screen.findByText(/请输入 1～200 字/); expect(test.api.chatStream).not.toHaveBeenCalled();
  });
});

describe('location intent privacy', () => {
  it.each(['现在打车回家多少钱', '打车到陆家嘴，要多少钱', '我现在在哪', '我选择自动定位', '附近有什么餐厅', '今天的天气'])('requests location for %s', text => expect(needsCurrentLocation(text)).toBe(true));
  it.each(['从上海虹桥到陆家嘴打车多少钱', '解释自动定位的 API 代码', '打车回家的费用怎么算', '有没有50元以内的套餐', '北京天气', '自动定位这个词是什么意思'])('does not attach location to %s', text => expect(needsCurrentLocation(text)).toBe(false));
  it('never treats quoted choices as user permission', () => {expect(locationInputAction('“自动定位”')).toBeUndefined(); expect(locationInputAction('我选择自动定位')).toBe('auto');});
  it('preserves real observation time and rejects fabricated coordinate/precision values', () => {
    expect(validLocation(fix())).toBe(true); expect(validLocation({...fix(), latitude: NaN})).toBe(false);
    expect(validLocation({...fix(), observed_at: 'invalid'})).toBe(false);
  });
});

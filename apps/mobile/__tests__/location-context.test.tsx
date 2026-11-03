import React from 'react';
import { AppState, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { captureClientContext, DEVICE_LOCATION_TTL, MANUAL_LOCATION_TTL, locationCaption, needsCurrentLocation, validLocation } from '../src/features/location/model';
import { createLocationSession } from '../src/features/location/session';
import { LocationChoiceSheet, LocationProvider } from '../src/features/location/LocationProvider';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatScreen, createChatEntryState } from '../src/screens/Chat';
import { deviceLocation } from '../src/platform/deviceLocation';
import type { ChatIntent } from '../src/domain/types';
import type { SseEvent } from '../src/api/chatSse';
import { Button } from '../src/ui/components';
import { ChatVoiceRecovery } from '../src/ui/ChatVoiceRecovery';
import { createChatStreamController } from '../src/screens/chatStreamController';

jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/platform/ports', () => ({ platform: { share: jest.fn() } }));
jest.mock('../src/platform/deviceLocation', () => ({ deviceLocation: { status: jest.fn(), requestCurrentLocation: jest.fn(), openSettings: jest.fn() } }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));

const fixedNow = new Date('2026-11-03T03:00:00.000Z').valueOf();
const fix = () => ({ latitude: 31.2, longitude: 121.5, accuracy_m: 800, observed_at: new Date().toISOString(),
  coordinate_system: 'wgs84' as const, source: 'current' as const, age_ms: 0, stale: false });
const granted = { supported: true, permission: 'granted' as const, accuracy: 'approximate' as const, services_enabled: true };
const manual = () => ({ source: 'manual' as const, label: '上海张江地铁站', observed_at: new Date().toISOString() });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const trees = new Set<ReactTestRenderer>();
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(async () => {
  jest.useFakeTimers(); jest.setSystemTime(fixedNow); jest.clearAllMocks(); await AsyncStorage.clear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
  (deviceLocation.status as jest.Mock).mockResolvedValue(granted);
  (deviceLocation.requestCurrentLocation as jest.Mock).mockImplementation(async () => fix());
});
afterEach(async () => { await act(async () => { trees.forEach(tree => tree.unmount()); }); trees.clear(); jest.clearAllTimers(); jest.useRealTimers(); });

test.each([
  ['从我这个位置打车到陆家嘴，普通车', true], ['从我这里到陆家嘴怎么走', true], ['附近有什么餐厅', true],
  ['找附近的酒店', true], ['当前位置的天气', true], ['hotels near me', true], ['route from here', true],
  ['附近有什么好玩的', true], ['我这里下雨了吗', true], ['我现在在哪', true],
  ['那你把我们当前的地址，你设置到麦当劳那边呗，他就知道附近有哪些店了呀。', true],
  // A meal budget alone is not consent to attach the device's position.
  ['有没有50块钱以内的麦当劳套餐？给我推荐一下呢。', false],
  ['附近有哪些门店', true], ['上海的麦当劳套餐推荐', false], ['麦当劳的历史是什么', false],
  ['我这里的代码为什么报错', false], ['上海陆家嘴附近的酒店', false], ['你好，讲一下Rust', false],
])('location intent %s => %s', (text, expected) => expect(needsCurrentLocation(text)).toBe(expected));

test('local follow-up uses only the current conversation and an unrelated question does not inherit location', () => {
  const history = [{ role: 'user', content: '我附近有什么餐厅' }, { role:'assistant', content:'可以查附近门店。' }];
  expect(needsCurrentLocation('那就这家，到店吃', history)).toBe(true);
  expect(needsCurrentLocation('帮我解释这个Rust函数', history)).toBe(false);
  expect(needsCurrentLocation('那就这家，到店吃', [])).toBe(false);
  expect(needsCurrentLocation('你不是可以调用麦当劳的工具吗？为什么你调用网页搜索却不调用它的MCP服务呢？',
    [{role:'user',content:'我附近有没有50块钱以内的麦当劳套餐？给我推荐一下呢。'}])).toBe(true);
  expect(needsCurrentLocation('你不是可以调用麦当劳的工具吗？为什么你调用网页搜索却不调用它的MCP服务呢？',
    [{role:'user',content:'有没有50块钱以内的麦当劳套餐？给我推荐一下呢。'}])).toBe(false);
});

test('freshness uses observation, invalid/future points and expired manual labels are rejected', () => {
  expect(validLocation(manual())).toBe(true);
  expect(validLocation({ ...manual(), observed_at: new Date(fixedNow - MANUAL_LOCATION_TTL - 1).toISOString() })).toBe(false);
  const point = { ...fix(), source: 'device' as const };
  expect(validLocation(point)).toBe(true);
  expect(validLocation({ ...point, observed_at: new Date(fixedNow + 1).toISOString() })).toBe(false);
  expect(validLocation({ ...point, latitude: 91 })).toBe(false);
  expect(validLocation({ ...point, observed_at: new Date(fixedNow - DEVICE_LOCATION_TTL - 1).toISOString() })).toBe(false);
});

test('captured location and timezone are frozen copies rather than mutable session state', () => {
  const selected = manual(); const context = captureClientContext(selected);
  selected.label = 'changed';
  expect(context.location?.label).toBe('上海张江地铁站');
  expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.location)).toBe(true);
  expect(() => new Intl.DateTimeFormat('en', { timeZone: context.timezone })).not.toThrow();
});

function sessionSetup(saved: string | null = null) {
  const bridge = { status: jest.fn().mockResolvedValue(granted), requestCurrentLocation: jest.fn().mockImplementation(async () => fix()), openSettings: jest.fn().mockResolvedValue(undefined) };
  const storage = { getItem: jest.fn().mockResolvedValue(saved), setItem: jest.fn().mockResolvedValue(undefined) };
  return { bridge, storage, session: createLocationSession('server/instance/user', bridge, storage) };
}
test('first authenticated startup is soft, skip is persisted without coordinates and never requests OS permission', async () => {
  const { session, bridge, storage } = sessionSetup(); await session.initialize();
  expect(session.getSnapshot().dialog).toBe('startup'); expect(bridge.status).not.toHaveBeenCalled();
  session.skip(); expect(storage.setItem).toHaveBeenCalledWith(expect.stringContaining('server/instance/user'), 'skip');
  session.foreground(false); session.foreground(true); expect(bridge.requestCurrentLocation).not.toHaveBeenCalled(); session.dispose();
});
test('approximate automatic choice is accepted and foreground cache waits for permission revalidation', async () => {
  const { session, bridge } = sessionSetup('auto'); await session.initialize();
  expect(session.getSnapshot().deviceVerified).toBe(true); expect(bridge.requestCurrentLocation).toHaveBeenCalledTimes(1);
  session.foreground(false); const probe = deferred<typeof granted>(); bridge.status.mockReturnValueOnce(probe.promise);
  session.foreground(true); expect(session.getSnapshot().deviceVerified).toBe(false);
  probe.resolve(granted); await Promise.resolve(); await Promise.resolve();
  expect(session.getSnapshot().deviceVerified).toBe(true); expect(bridge.requestCurrentLocation).toHaveBeenCalledTimes(1); session.dispose();
});
test('revoked permissions clear a cached device point, automatic refresh never asks again', async () => {
  const { session, bridge } = sessionSetup('auto'); await session.initialize(); session.foreground(false);
  bridge.status.mockResolvedValueOnce({ ...granted, permission: 'denied' as never, accuracy: 'none' as never }); session.foreground(true);
  await Promise.resolve(); await Promise.resolve();
  expect(session.getSnapshot().location).toBeNull(); expect(session.getSnapshot().deviceVerified).toBe(false);
  expect(bridge.requestCurrentLocation).toHaveBeenCalledTimes(1); session.dispose();
});
test('manual selection aborts an in-flight automatic fix and a late fix cannot overwrite it', async () => {
  const { session, bridge, storage } = sessionSetup('skip'); await session.initialize();
  const delayed = deferred<ReturnType<typeof fix>>(); bridge.requestCurrentLocation.mockReturnValueOnce(delayed.promise);
  const choice = session.request('chat'); const locating = session.locate(); await Promise.resolve();
  session.manual(); session.setInput('上海张江地铁站'); session.saveManual();
  const result = await choice; expect(result).toMatchObject({ kind: 'selected', location: { source: 'manual', label: '上海张江地铁站' } });
  delayed.resolve(fix()); await locating;
  expect(session.getSnapshot().location?.source).toBe('manual');
  expect(JSON.stringify(storage.setItem.mock.calls)).not.toContain('张江'); session.dispose();
});
test('scope disposal cancels a pending picker and never leaks an old request into another scope', async () => {
  const one = sessionSetup('skip'); await one.session.initialize(); const choice = one.session.request('chat');
  one.session.dispose(); expect(await choice).toEqual({ kind: 'cancel' }); expect(one.session.getSnapshot().location).toBeNull();
  const two = createLocationSession('different-server/user', one.bridge, one.storage); await two.initialize();
  expect(two.getSnapshot().location).toBeNull(); two.dispose();
});
test('late saved auto consent never replaces a manual choice made while preferences load', async () => {
  const { bridge, storage } = sessionSetup(); const saved = deferred<string>(); storage.getItem.mockReturnValueOnce(saved.promise);
  const session = createLocationSession('late-server/user', bridge, storage); const initialization = session.initialize();
  const choice = session.request('chat'); session.manual(); session.setInput('上海张江地铁站'); session.saveManual(); await choice;
  saved.resolve('auto'); await initialization;
  expect(session.getSnapshot()).toMatchObject({ ready: true, mode: 'manual', location: manual() });
  expect(bridge.requestCurrentLocation).not.toHaveBeenCalled(); session.dispose();
});
test('background during preference load preserves saved automatic mode and refreshes on resume', async () => {
  const { bridge, storage } = sessionSetup(); const saved = deferred<string>(); storage.getItem.mockReturnValueOnce(saved.promise);
  const session = createLocationSession('background-init/user', bridge, storage); const initialization = session.initialize();
  session.foreground(false); saved.resolve('auto'); await initialization;
  expect(session.getSnapshot().mode).toBe('auto'); expect(bridge.requestCurrentLocation).not.toHaveBeenCalled();
  session.foreground(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(session.getSnapshot().deviceVerified).toBe(true); expect(bridge.requestCurrentLocation).toHaveBeenCalledTimes(1); session.dispose();
});
test('first coarse grant is labeled approximate even if vendor reports a small radius', async () => {
  const { session, bridge } = sessionSetup('skip'); await session.initialize(); session.request('chat');
  bridge.status.mockResolvedValueOnce({ ...granted, permission: 'denied' as never, accuracy: 'none' as never });
  bridge.requestCurrentLocation.mockResolvedValueOnce({ ...fix(), accuracy_m: 10 }); await session.locate();
  expect(session.getSnapshot().approximate).toBe(true);
  expect(locationCaption(session.getSnapshot().location, session.getSnapshot().approximate)).toContain('大概位置'); session.dispose();
});
test('explicit first permission grant survives the OS sheet pause but ordinary sampling cancels on background', async () => {
  const { session, bridge } = sessionSetup('skip'); await session.initialize();
  bridge.status.mockResolvedValueOnce({ ...granted, permission: 'denied' as never, accuracy: 'none' as never });
  const delayed = deferred<ReturnType<typeof fix>>(); bridge.requestCurrentLocation.mockReturnValueOnce(delayed.promise);
  const choice = session.request('chat'); const locating = session.locate(); await Promise.resolve();
  session.foreground(false); expect(session.getSnapshot().dialog).toBe('chat'); session.foreground(true);
  delayed.resolve(fix()); await locating; expect((await choice).kind).toBe('selected');
  const next = session.request('chat'); const delayed2 = deferred<ReturnType<typeof fix>>(); bridge.requestCurrentLocation.mockReturnValueOnce(delayed2.promise);
  const again = session.locate(); await Promise.resolve(); session.foreground(false); expect(await next).toEqual({ kind: 'cancel' });
  delayed2.resolve(fix()); await again; expect(session.getSnapshot().dialog).toBeNull(); session.dispose();
});
test.each([
  ['permission_denied', '未获得定位权限', null], ['permission_blocked', '定位权限已关闭', 'permission'],
  ['services_disabled', '手机定位服务未开启', 'services'], ['timeout', '暂时没有获得位置', null],
])('failure %s has an accurate recoverable action', async (code, expected, settings) => {
  const { session, bridge } = sessionSetup('skip'); await session.initialize(); const choice = session.request('chat');
  bridge.requestCurrentLocation.mockRejectedValueOnce({ code }); await session.locate();
  expect(session.getSnapshot().error).toContain(expected); expect(session.getSnapshot().settings).toBe(settings);
  session.manual(); session.setInput('上海张江地铁站'); session.saveManual(); expect((await choice).kind).toBe('selected'); session.dispose();
});
test('real choice sheet uses automatic/manual controls, bounds address and allows continuing editing', async () => {
  const { session, bridge } = sessionSetup(); await session.initialize(); let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<LocationChoiceSheet session={session} />); }); trees.add(tree);
  const press = (label: string) => tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.onPress)[0].props.onPress();
  expect(bridge.requestCurrentLocation).not.toHaveBeenCalled(); await act(async () => press('手动填写'));
  expect(tree.root.findByType(TextInput).props.maxLength).toBe(200);
  await act(async () => tree.root.findByType(TextInput).props.onChangeText('上海张江地铁站'));
  await act(async () => press('使用这个位置')); expect(session.getSnapshot().location).toEqual(manual()); session.dispose();
});

async function chatSetup(initial = 'skip', scope = 'synthetic-user') {
  const key = `tada.location.consent.v1:${JSON.stringify(['https://synthetic.test', 'synthetic-instance', scope])}`;
  await AsyncStorage.setItem(key, initial);
  const state = createChatEntryState('conversation');
  const api = { messages: jest.fn().mockResolvedValue({ items: [] }), capabilities: jest.fn().mockResolvedValue({ items: [], runtime: { model_mode: 'local' } }),
    chat: jest.fn().mockResolvedValue({ conversation_id: 'conversation', message: { id: 'assistant', role: 'assistant', content: 'ok', created_at: '' } }),
    upload: jest.fn(), transcribe: jest.fn(), deleteUpload: jest.fn().mockResolvedValue({}) };
  Object.assign(api, { chatStream: jest.fn(async (intent: ChatIntent, onEvent: (event: SseEvent) => void, options: { signal: AbortSignal }) => {
    const response = await api.chat(intent);
    if (!options.signal.aborted) onEvent({ id: 1, event: 'done', data: { response } });
  }) });
  const context = { api, user: { id: scope, timezone: 'Asia/Shanghai' }, preferences: { serverUrl: 'https://synthetic.test', instance: { id: 'synthetic-instance' } }, invalidate: jest.fn(), formatDate: () => '' } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}><LocationProvider><ChatScreen entryState={state} /></LocationProvider></AppProvider>); }); trees.add(tree);
  const press = (label: string) => tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.onPress)[0].props.onPress();
  return { api, tree, state, press, context,
    type: async (text: string) => { await act(async () => tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '给助手的消息')!.props.onChangeText(text)); },
    manual: async (label = '上海张江地铁站') => {
      await act(async () => press('手动填写'));
      await act(async () => tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '位置地址')!.props.onChangeText(label));
      await act(async () => press('使用这个位置'));
    },
  };
}
test('actual chat pauses a location-dependent send, preserves draft and attachment, then sends a manual label without fake GPS', async () => {
  const app = await chatSetup(); await app.type('从我这个位置打车到陆家嘴，普通车');
  const attachment = { file: { uri: 'file:///synthetic.txt', name: 'synthetic.txt', mime_type: 'text/plain', size: 1 }, upload: { id: 'fixture-upload', name: 'synthetic.txt', mime_type: 'text/plain', size: 1, created_at: '', uri: '' } };
  await act(async () => app.state.update(old => ({ ...old, attachment })));
  let pending!: Promise<void>; await act(async () => { pending = app.press('发送消息'); });
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.state.getSnapshot().draft).toContain('陆家嘴'); expect(app.state.getSnapshot().attachment).toBe(attachment);
  await app.manual(); await pending;
  expect(app.api.chat).toHaveBeenCalledTimes(1);
  const intent = app.api.chat.mock.calls[0][0] as ChatIntent;
  expect(intent.upload_ids).toEqual(['fixture-upload']);
  expect(intent.client_context).toMatchObject({ location: manual() }); expect(intent.client_context?.location).not.toHaveProperty('latitude');
  expect(intent.client_context?.timezone).toBeTruthy(); expect(Object.isFrozen(intent.client_context)).toBe(true);
});
test('draft changes while choosing prevent accidental sending and preserve edited text', async () => {
  const app = await chatSetup(); await app.type('附近有什么餐厅'); let pending!: Promise<void>;
  await act(async () => { pending = app.press('发送消息'); }); await app.type('更改后的草稿'); await app.manual(); await pending;
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.state.getSnapshot().draft).toBe('更改后的草稿');
});
test('recognized hold-to-talk text waits for manual location and never sends the raw recording as attachment', async () => {
  const app = await chatSetup();
  await act(async () => app.state.update(old => ({ ...old, voice: { key: 'synthetic-voice',
    file: { uri: 'file:///synthetic.m4a', name: 'synthetic.m4a', mime_type: 'audio/mp4', size: 5 },
    upload: { id: 'voice-upload', name: 'synthetic.m4a', mime_type: 'audio/mp4', size: 5, created_at: '', uri: '' },
    text: '从我这里打车到陆家嘴', sendIntent: { draft: '', file: null, context: null, isVisible: () => true } } })));
  let pending!: Promise<void>;
  await act(async () => { pending = app.tree.root.findByType(ChatVoiceRecovery).props.onRetry(); });
  expect(app.state.getSnapshot().draft).toBe('从我这里打车到陆家嘴'); expect(app.api.chat).not.toHaveBeenCalled();
  await app.manual(); await pending;
  expect(app.api.chat.mock.calls[0][0]).toMatchObject({ message: '从我这里打车到陆家嘴', upload_ids: [], client_context: { location: { source: 'manual' } } });
  expect(app.api.transcribe).not.toHaveBeenCalled(); expect(app.api.upload).not.toHaveBeenCalled();
});
test('canceling the picker keeps quote/edit identity and the original draft intact', async () => {
  const app = await chatSetup(); const original = { id: 'original', conversation_id: 'conversation', role: 'user' as const, content: '原问题', created_at: '' };
  const editing = { message: original, previousDraft: '原草稿', previousAttachment: null };
  await act(async () => app.state.update(old => ({ ...old, messages: [original], editing, draft: '附近有什么餐厅' })));
  let pending!: Promise<void>; await act(async () => { pending = app.press('提交修改'); });
  expect(app.state.getSnapshot().editing).toBe(editing);
  await act(async () => app.press('继续编辑')); await pending;
  expect(app.api.chat).not.toHaveBeenCalled(); expect(app.state.getSnapshot().editing).toBe(editing);
  expect(app.state.getSnapshot().draft).toBe('附近有什么餐厅');
  await act(async () => app.state.update(old => ({ ...old, editing: null, quoting: original })));
  await act(async () => { pending = app.press('发送消息'); }); await act(async () => app.press('继续编辑')); await pending;
  expect(app.state.getSnapshot().quoting).toBe(original); expect(app.api.chat).not.toHaveBeenCalled();
});
test('skip explicitly sends timezone only, ordinary code questions never prompt or attach an existing location', async () => {
  const app = await chatSetup(); await app.type('附近有什么餐厅'); let pending!: Promise<void>;
  await act(async () => { pending = app.press('发送消息'); }); await act(async () => app.press('暂不提供并发送')); await pending;
  expect(app.api.chat.mock.calls[0][0].client_context).not.toHaveProperty('location');
  expect(app.tree.root.findAll(node => ['设置本次位置', '更改本次位置'].includes(node.props.accessibilityLabel))).toHaveLength(0);
  await app.type('附近有什么咖啡店');
  await act(async () => { pending = app.press('发送消息'); }); await app.manual(); await pending;
  expect(app.api.chat.mock.calls[1][0].client_context.location.source).toBe('manual');
  await app.type('解释Rust的所有权');
  await act(async () => app.press('发送消息'));
  expect(app.api.chat.mock.calls[2][0].client_context).not.toHaveProperty('location');
  await app.type('我这里的代码为什么报错'); await act(async () => app.press('发送消息'));
  expect(app.api.chat.mock.calls[3][0].client_context).not.toHaveProperty('location');
});
test('actual chat sends a fresh approximate device fix and an immutable retry retains the first context after the location changes', async () => {
  const app = await chatSetup('auto'); await app.type('从我这里打车到陆家嘴');
  app.api.chat.mockRejectedValueOnce({ code: 'synthetic_error', message: 'fixture failed' });
  await act(async () => app.press('发送消息'));
  const original = app.api.chat.mock.calls[0][0] as ChatIntent; const payload = JSON.stringify(original);
  expect(original.client_context?.location).toMatchObject({ source: 'device', accuracy_m: 800 });
  expect(app.tree.root.findAll(node => ['设置本次位置', '更改本次位置'].includes(node.props.accessibilityLabel))).toHaveLength(0);
  const locationSession = app.tree.root.findByType(LocationChoiceSheet).props.session;
  await act(async () => { void locationSession.request('edit'); }); await app.manual('上海人民广场');
  jest.setSystemTime(fixedNow + 60000);
  await act(async () => app.tree.root.findAllByType(Button).find(node => node.props.children === '重试')!.props.onPress());
  expect(JSON.stringify(app.api.chat.mock.calls[1][0])).toBe(payload);
});
test('controller clones a mutable context and reconnects/retries with identical original payload', async () => {
  const mutable = { timezone: 'Asia/Shanghai', location: manual() };
  const intents: ChatIntent[] = [];
  const chatStream = jest.fn(async (intent: ChatIntent, _event: (event: SseEvent) => void) => {
    intents.push(intent); throw { code: intents.length === 1 ? 'network' : 'fixture_failure', message: 'fixture' };
  });
  const operation = createChatStreamController({ api: { chatStream }, intent: { message: '附近的餐厅', conversation_id: null,
    client_request_id: 'fixture-context-immutable', upload_ids: [], remember: false, client_context: mutable },
    isCurrent: () => true, onChange: () => {}, onComplete: () => {} });
  mutable.location.label = 'mutation'; mutable.timezone = 'UTC';
  const started = operation.start(); await jest.advanceTimersByTimeAsync(600); await started;
  expect(intents).toHaveLength(2); expect(JSON.stringify(intents[0])).toBe(JSON.stringify(intents[1]));
  expect(intents[0].client_context).toMatchObject({ timezone: 'Asia/Shanghai', location: {
    source: 'manual', label: '上海张江地铁站', observed_at: new Date(fixedNow).toISOString() } });
  jest.setSystemTime(fixedNow + 60000); await operation.retry();
  expect(JSON.stringify(intents[2])).toBe(JSON.stringify(intents[0])); operation.dispose();
});

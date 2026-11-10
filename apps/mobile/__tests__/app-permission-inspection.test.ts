import { NativeModules, Platform } from 'react-native';
import { ChatTransportError } from '../src/api/chatSse';
import { detectPermissionInspection, inspectAppPermissions, supportsPermissionInspection } from '../src/features/app-permissions/inspection';
import type { ChatIntent } from '../src/domain/types';
import { createChatStreamController } from '../src/screens/chatStreamController';
import { createPermissionSession, performDeviceAction } from '../src/features/app-permissions/session';

const questions = [
  '帮我看看手机里有没有软件在监控我',
  '帮我看看手机里的app哪些权限不合理',
  '你看看我手机上有没有疑似监控我的软件',
];

const baseIntent: ChatIntent = {
  message: questions[0], conversation_id: null, client_request_id: 'permission-check',
  remember: false, upload_ids: [], app_permission_inspection_supported: true,
};
const makeCard = () => ({
  kind: 'app_permission_inspection', inspection: 'permissions',
  id: 'inspection', run_id: 'run', expires_at: Math.floor(Date.now() / 1000) + 90,
});
const response = { conversation_id: 'conversation', message: {
  id: 'assistant', conversation_id: 'conversation', role: 'assistant',
  content: '请查看本机报告。', created_at: '2026-11-09T00:00:00Z',
} };

const originalPlatform = Platform.OS;
beforeEach(() => { Platform.OS = 'android'; });
afterEach(() => {
  Platform.OS = originalPlatform;
  delete NativeModules.TadaAppPermissionInspection;
});

it('treats a bridge that fails to load as an unavailable device capability', async () => {
  Object.defineProperty(NativeModules, 'TadaAppPermissionInspection', {
    configurable: true,
    get() { throw new Error('TurboModule interop rejected the module'); },
  });

  expect(supportsPermissionInspection()).toBe(false);
  await expect(inspectAppPermissions()).resolves.toBeUndefined();
});

it.each(questions)('automatically scans once, renders findings locally and submits only counts for %s', async message => {
  const scan = jest.fn().mockResolvedValue({
    scanned: 15, flagged: 1, unavailable: [],
    findings: [{ name: '测试手电筒', packageName: 'test.only.device', grants: ['通讯录'], reasons: ['需核查'] }],
  });
  NativeModules.TadaAppPermissionInspection = { scan };
  const request = jest.fn();
  const api = { request, chatStream: jest.fn(async (_intent, receive) => {
    const card = makeCard();
    await new Promise<void>(resolve => {
      request.mockImplementationOnce(async () => {
        resolve();
        return { accepted: true };
      });
      receive({ id: 1, event: 'snapshot', data: { interaction: card } });
      receive({ id: 1, event: 'interaction', data: { card } });
    });
    receive({ id: 2, event: 'done', data: { response } });
  }) };
  const controller = createChatStreamController({ api, intent: { ...baseIntent, message }, isCurrent: () => true,
    onChange: jest.fn(), onComplete: jest.fn() });
  await controller.start();
  expect(scan).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('/chat/interactions/run/inspection', 'POST',
    { kind: 'app_permission_inspection', result: { status: 'completed', scanned: 15, flagged: 1 } }, expect.anything());
  expect(controller.getSnapshot().permissionReport?.findings[0]?.name).toBe('测试手电筒');
  controller.dispose();
});

it('reuses the device scan after reconnecting to a pending inspection', async () => {
  let resolveScan!: (value: unknown) => void;
  const scan = jest.fn(() => new Promise(resolve => { resolveScan = resolve; }));
  NativeModules.TadaAppPermissionInspection = { scan };
  const card = makeCard();
  const request = jest.fn();
  let connected = false;
  const api = { request, chatStream: jest.fn(async (_intent, receive) => {
    receive({ id: 1, event: 'snapshot', data: { interaction: card } });
    if (!connected) {
      connected = true;
      throw new ChatTransportError('stream_rotate', 'Reconnecting');
    }
    await new Promise<void>(resolve => {
      request.mockImplementationOnce(async () => { resolve(); return { accepted: true }; });
      resolveScan({ scanned: 15, flagged: 0, findings: [], unavailable: ['通知使用权'] });
    });
    receive({ id: 2, event: 'done', data: { response } });
  }) };
  const controller = createChatStreamController({ api, intent: baseIntent, isCurrent: () => true,
    onChange: jest.fn(), onComplete: jest.fn() });
  await controller.start();
  expect(api.chatStream).toHaveBeenCalledTimes(2);
  expect(scan).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('/chat/interactions/run/inspection', 'POST',
    { kind: 'app_permission_inspection', result: { status: 'partial', scanned: 15, flagged: 0 } }, expect.anything());
  controller.dispose();
});

it('does not let an interaction from the server arm a scan during an informational question', async () => {
  expect(detectPermissionInspection('怎么判断手机里的软件在监控我？')).toBeUndefined();
  expect(detectPermissionInspection('请翻译：帮我看看手机里的app哪些权限不合理')).toBeUndefined();
  const scan = jest.fn();
  NativeModules.TadaAppPermissionInspection = { scan };
  const api = { request: jest.fn(), chatStream: jest.fn(async (_intent, receive) => {
    receive({ id: 1, event: 'snapshot', data: { interaction: makeCard() } });
    receive({ id: 2, event: 'done', data: { response } });
  }) };
  const controller = createChatStreamController({ api, intent: { ...baseIntent, message: '无障碍权限是什么' },
    isCurrent: () => true, onChange: jest.fn(), onComplete: jest.fn() });
  await controller.start();
  expect(scan).not.toHaveBeenCalled();
  expect(api.request).not.toHaveBeenCalled();
  controller.dispose();
});

it.each([[true, false], [false, false], [true, true], [false, true]])('waits for an explicit device decision for a model request, approved=%s, previous report=%s', async (approved, previousReport) => {
  const scan = jest.fn().mockResolvedValue({ scanned: 0, flagged: 0, findings: [], unavailable: [] });
  NativeModules.TadaAppPermissionInspection = { scan };
  const message = '我担心这部设备上有跟踪程序，能替我查一下吗？';
  expect(detectPermissionInspection(message)).toBeUndefined();
  const card = previousReport ? { ...makeCard(), mode: 'reuse' } : makeCard();
  const session = createPermissionSession();
  if (previousReport) session.remember({ scanned: 15, flagged: 1, findings: [], unavailable: [],
    checkedAt: Date.now(), inspection: 'permissions' });
  let finish!: () => void;
  const api = { request: jest.fn().mockImplementation(async () => { finish(); return { accepted: true }; }),
    chatStream: jest.fn(async (_intent, receive) => {
      await new Promise<void>(resolve => {
        finish = resolve;
        receive({ id: 1, event: 'snapshot', data: { interaction: card } });
      });
      receive({ id: 2, event: 'done', data: { response } });
    }) };
  const controller = createChatStreamController({ api, intent: { ...baseIntent, message,
    app_permission_inspection_supported: undefined, app_permission_tool_supported: true, device_settings_supported: true },
    permissionSession: session, isCurrent: () => true, onChange: jest.fn(), onComplete: jest.fn() });
  const running = controller.start();
  expect(controller.getSnapshot().permissionApprovalNeeded).toBe(true);
  expect(scan).not.toHaveBeenCalled();
  controller.respondToPermissionInspection(card.id, approved);
  controller.respondToPermissionInspection(card.id, true);
  await running;
  expect(scan).toHaveBeenCalledTimes(approved ? 1 : 0);
  expect(api.request).toHaveBeenCalledTimes(1);
  expect(api.request).toHaveBeenCalledWith('/chat/interactions/run/inspection', 'POST',
    approved ? { kind: 'app_permission_inspection', result: { status: 'completed', scanned: 0, flagged: 0 } } : { kind: 'cancel' },
    expect.anything());
  controller.dispose();
});

it('uses recent checks only as context and performs a fresh scan even for a legacy reuse request', async () => {
  const scan = jest.fn().mockResolvedValue({ scanned: 4, flagged: 0, findings: [], unavailable: [] });
  const openDeviceSettings = jest.fn();
  NativeModules.TadaAppPermissionInspection = { scan, openDeviceSettings };
  const session = createPermissionSession();
  const report = { scanned: 3, flagged: 0, findings: [], unavailable: [], checkedAt: Date.now(), inspection: 'permissions' as const };
  session.remember(report);
  expect(session.hasRecentCheck()).toBe(true);
  const query = { kind: 'app_permission_inspection', inspection: 'permissions', mode: 'reuse' } as const;
  await expect(performDeviceAction(session, query)).resolves.toMatchObject({ report: { scanned: 4 } });
  expect(scan).toHaveBeenCalledTimes(1);
  await expect(performDeviceAction(session, { ...query, scope: 'selected_app' })).resolves.toEqual({ report: undefined });
  expect(scan).toHaveBeenCalledTimes(1);
  await expect(performDeviceAction(session, { kind: 'system_settings', destination: 'selected_app' })).resolves.toEqual({});
  expect(openDeviceSettings).not.toHaveBeenCalled();
  session.remember({ ...report, checkedAt: Date.now() - 600_000 });
  expect(session.hasRecentCheck()).toBe(false);
});

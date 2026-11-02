import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, Switch, type AppStateStatus } from 'react-native';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PrivateVaultScreen } from '../src/features/private-vault/PrivateVaultScreen';
import { privateVault } from '../src/platform/privateVault';
import type { VaultStatus } from '../src/domain/privateVault';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.mock('../src/platform/privateVault', () => ({ privateVault: {
  protect: jest.fn(), status: jest.fn(), summaries: jest.fn(), reveal: jest.fn(), recovery: jest.fn(), configure: jest.fn(),
  snapshot: jest.fn(), acknowledge: jest.fn(), stop: jest.fn(), copy: jest.fn(), share: jest.fn(),
} }));
const native = privateVault as jest.Mocked<typeof privateVault>;
const envelope = { schema: 1, algorithm: 'A256GCM', kid: '0123456789abcdef0123456789abcdef', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
let local: VaultStatus;
let foreground: ((state: AppStateStatus) => void) | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, listener) => { foreground = listener; return { remove: jest.fn() }; });
  local = { available: true, exists: true, backup_enabled: false, recovery_ready: false, remote_version: 0, consent_epoch: 0, revision: 'r1', synced_revision: '' };
  native.protect.mockResolvedValue();
  native.status.mockImplementation(async () => ({ ...local }));
  native.summaries.mockResolvedValue([{ id: 'card', type: 'bank', alias: '工资卡', summary: '示例银行 · 尾号 1234' }]);
  native.reveal.mockResolvedValue({ id: 'card', type: 'bank', alias: '工资卡', fields: { owner: '示例姓名', bank: '示例银行', number: '0000000000001234', branch: '示例支行' } });
  native.recovery.mockResolvedValue('TV1-EXAMPLE-RECOVERY-KEY');
  native.configure.mockImplementation(async (_scope, version) => { local = { ...local, backup_enabled: true, recovery_ready: true, remote_version: version, consent_epoch: 1 }; return null; });
  native.snapshot.mockResolvedValue({ envelope: envelope as any, revision: 'r1', remote_version: 0, consent_epoch: 1 });
  native.acknowledge.mockResolvedValue();
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
async function mount() {
  let cloud = { version: 0, envelope: null as unknown, updated_at: null as number | null };
  const api = { baseUrl: 'https://my-own.example/backend', request: jest.fn(async (_path, method = 'GET', body) => {
    if (method === 'PUT') cloud = { version: 1, envelope: body.envelope, updated_at: 1 };
    return cloud;
  }) };
  const value = { api, user: { id: 'owner' }, preferences: { serverUrl: api.baseUrl, instance: { id: 'server-one', name: '我的妥啦' } }, back: jest.fn() } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={value}><PrivateVaultScreen /></AppProvider>); });
  const press = async (name: string) => { await act(async () => { const button = tree.root.findAll(node => node.props.accessibilityLabel === name && typeof node.props.onPress === 'function')[0]; if (!button) throw new Error('missing '+name); button.props.onPress(); }); };
  const text = () => JSON.stringify(tree.toJSON());
  const close = async () => { await act(async () => tree.unmount()); };
  return { tree, value, api, press, text, close };
}

test('storage is off by default and inherits the authenticated app backend without another server picker', async () => {
  const app = await mount();
  await app.press('存储与备份');
  expect(app.tree.root.findByType(Switch).props.value).toBe(false);
  expect(app.text()).toContain('https://my-own.example/backend');
  expect(app.text()).toContain('当前 App 后端 · 自动跟随');
  expect(app.text()).not.toContain('选择备份服务器');
  expect(app.text()).not.toContain('自建服务器地址');
  await act(async () => { app.tree.root.findByType(Switch).props.onValueChange(true); });
  expect(app.text()).toContain('保管好你的恢复密钥');
  expect(app.text()).toContain('TV1-EXAMPLE-RECOVERY-KEY');
  expect(app.api.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
  await app.press('我已保存恢复密钥');
  await app.press('验证并开启加密备份');
  expect(app.tree.root.findByType(Switch).props.value).toBe(true);
  expect(JSON.stringify(app.api.request.mock.calls)).not.toContain('TV1-EXAMPLE-RECOVERY-KEY');
  expect(native.configure).toHaveBeenCalledWith(expect.stringContaining('server-one'), 0);
  await app.close();
});

test('masked previews reveal only after native authentication and leave no full number after backgrounding', async () => {
  const app = await mount();
  await app.press('验证并打开资料库');
  await app.press('查看私密资料：工资卡');
  expect(app.text()).not.toContain('0000000000001234');
  await app.press('验证并查看完整资料');
  expect(native.reveal).toHaveBeenCalled();
  expect(app.text()).toContain('0000000000001234');
  await act(async () => { foreground?.('background'); });
  expect(app.text()).not.toContain('0000000000001234');
  await app.close();
});

test('account changes synchronously hide full data and close the old native protection scope', async () => {
  const app = await mount();
  await app.press('验证并打开资料库'); await app.press('查看私密资料：工资卡'); await app.press('验证并查看完整资料');
  await act(async () => { app.tree.update(<AppProvider value={{ ...app.value, user: { ...app.value.user!, id: 'other-owner' } }}><PrivateVaultScreen /></AppProvider>); });
  expect(app.text()).not.toContain('0000000000001234');
  expect(app.text()).toContain('你的资料已锁定');
  expect(native.protect).toHaveBeenCalledWith(expect.stringContaining('owner'), false);
  await app.close();
});

test('a device without the native secure port fails closed', async () => {
  native.protect.mockRejectedValueOnce(new Error('设备安全资料库不可用'));
  const app = await mount();
  expect(app.text()).toContain('设备安全资料库不可用');
  await app.press('验证并打开资料库');
  expect(native.summaries).not.toHaveBeenCalled();
  expect(app.api.request).not.toHaveBeenCalled();
  await app.close();
});

test('full values are removed after the reveal timeout', async () => {
  jest.useFakeTimers();
  const app = await mount();
  await app.press('验证并打开资料库'); await app.press('查看私密资料：工资卡'); await app.press('验证并查看完整资料');
  expect(app.text()).toContain('0000000000001234');
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(app.text()).not.toContain('0000000000001234');
  expect(app.text()).toContain('完整资料已自动隐藏');
  await app.close();
});

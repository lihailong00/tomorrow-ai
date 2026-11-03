import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, AppState, Switch, TextInput, type AppStateStatus } from 'react-native';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { PrivateVaultScreen } from '../src/features/private-vault/PrivateVaultScreen';
import { privateVault } from '../src/platform/privateVault';
import type { VaultStatus } from '../src/domain/privateVault';

// Cold React Native rendering approaches five seconds on this shared build host.
jest.setTimeout(30000);

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
jest.mock('../src/platform/privateVault', () => ({ privateVault: {
  protect: jest.fn(), status: jest.fn(), summaries: jest.fn(), reveal: jest.fn(), recovery: jest.fn(), configure: jest.fn(),
  snapshot: jest.fn(), acknowledge: jest.fn(), stop: jest.fn(), copy: jest.fn(), share: jest.fn(), restore: jest.fn(),
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
async function mount(options?: { hasCloudBackup?: boolean }) {
  let cloud = options?.hasCloudBackup ? { version: 4, envelope: envelope as unknown, updated_at: 1 as number | null } : { version: 0, envelope: null as unknown, updated_at: null as number | null };
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
  expect(app.tree.root.findAll(node => node.props.accessibilityLabel === '验证并打开资料库')).toHaveLength(0);
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

test('a new phone offers restore or create immediately and creation never uploads or replaces a backup', async () => {
  local.exists = false;
  native.summaries.mockImplementationOnce(async () => { local.exists = true; return []; });
  const app = await mount({ hasCloudBackup: true });
  expect(app.text()).toContain('重要资料，接着用');
  expect(app.text()).toContain('恢复已有资料');
  expect(app.text()).toContain('创建新的资料库');
  expect(app.text()).toContain('https://my-own.example/backend');
  expect(app.api.request).not.toHaveBeenCalled();
  await app.press('创建新的资料库');
  expect(native.summaries).toHaveBeenCalledTimes(1);
  expect(app.api.request).not.toHaveBeenCalled();
  expect(app.text()).toContain('恢复已有资料');
  expect(local.backup_enabled).toBe(false);
  await app.close();
});

test('first-run restore uses current backend, clears the key and shows real restored summaries with backup off', async () => {
  local.exists = false;
  const summaries = [{ id: 'restored-card', type: 'bank' as const, alias: '工资卡', summary: '示例银行 · 尾号 1234' }];
  native.restore.mockImplementationOnce(async () => { local = { ...local, exists: true, recovery_ready: true, remote_version: 4 }; return summaries; });
  const app = await mount({ hasCloudBackup: true });
  await app.press('恢复已有资料');
  expect(app.text()).toContain('已找到加密备份');
  expect(app.text()).not.toContain('自建服务器地址');
  await act(async () => { app.tree.root.findByType(TextInput).props.onChangeText('TV1-PRIVATE-RECOVERY-KEY'); });
  expect(app.tree.root.findByType(TextInput).props.secureTextEntry).toBe(true);
  await app.press('显示密钥');
  expect(app.tree.root.findByType(TextInput).props.secureTextEntry).toBe(false);
  await app.press('验证并恢复到手机');
  expect(native.restore).toHaveBeenCalledWith(expect.stringContaining('server-one'), envelope, 'TV1-PRIVATE-RECOVERY-KEY', 4);
  expect(app.text()).toContain('都回来了。');
  expect(app.text()).toContain('工资卡');
  expect(app.tree.root.findByType(Switch).props.value).toBe(false);
  expect(app.text()).not.toContain('TV1-PRIVATE-RECOVERY-KEY');
  expect(JSON.stringify(app.api.request.mock.calls)).not.toContain('TV1-PRIVATE-RECOVERY-KEY');
  expect(app.api.request.mock.calls.every(([, method]) => method === 'GET')).toBe(true);
  await app.press('进入我的资料');
  expect(app.text()).toContain('工资卡');
  await app.close();
});

test('a missing backup leaves recovery disabled and explains the original account/backend requirement', async () => {
  local.exists = false;
  const app = await mount();
  await app.press('恢复已有资料');
  expect(app.text()).toContain('当前后端没有加密备份');
  expect(app.text()).toContain('备份时的账号和后端');
  await act(async () => { app.tree.root.findByType(TextInput).props.onChangeText('TV1-EXAMPLE'); });
  const button = app.tree.root.findAll(node => node.props.accessibilityLabel === '验证并恢复到手机' && typeof node.props.onPress === 'function')[0];
  expect(button.props.disabled).toBe(true);
  expect(native.restore).not.toHaveBeenCalled();
  await app.press('找不到恢复密钥？');
  await app.close();
});

test('the recovery field accepts the full copied-whitespace key supported by native crypto without truncation', async () => {
  local.exists = false;
  const app = await mount({ hasCloudBackup: true });
  await app.press('恢复已有资料');
  const compact = 'TV1-' + Array(8).fill('01234567').join('-');
  const copied = ' \t' + compact.toLowerCase().replace(/-/g, '-\r\n \t') + '\n';
  const input = app.tree.root.findByType(TextInput);
  expect(copied.length).toBeGreaterThan(100);
  expect(input.props.maxLength).toBeGreaterThanOrEqual(copied.length);
  await act(async () => { input.props.onChangeText(copied); });
  await app.press('验证并恢复到手机');
  expect(native.restore).toHaveBeenCalledWith(expect.stringContaining('server-one'), envelope, copied.trim(), 4);
  expect(JSON.stringify(app.api.request.mock.calls)).not.toContain('01234567');
  await app.close();
});

test('wrong recovery keys leave the first-run vault uninitialized and can be retried', async () => {
  local.exists = false;
  native.restore.mockRejectedValueOnce(new Error('密钥与备份不匹配'));
  const app = await mount({ hasCloudBackup: true });
  await app.press('恢复已有资料');
  await act(async () => { app.tree.root.findByType(TextInput).props.onChangeText('TV1-WRONG-KEY'); });
  await app.press('验证并恢复到手机');
  expect(app.text()).toContain('密钥与备份不匹配');
  expect(app.tree.root.findByType(TextInput).props.value).toBe('');
  expect(local.exists).toBe(false);
  expect(native.summaries).not.toHaveBeenCalled();
  expect(app.api.request.mock.calls.every(([, method]) => method === 'GET')).toBe(true);
  await app.press('返回上一页');
  expect(app.text()).toContain('创建新的资料库');
  await app.close();
});

test('system credential backgrounding keeps the real restore progress and never exposes the input key', async () => {
  local.exists = false;
  let resolve!: (items: Awaited<ReturnType<typeof privateVault.summaries>>) => void;
  native.restore.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const app = await mount({ hasCloudBackup: true });
  await app.press('恢复已有资料');
  await act(async () => { app.tree.root.findByType(TextInput).props.onChangeText('TV1-PRIVATE-EXAMPLE'); });
  await app.press('验证并恢复到手机');
  expect(app.text()).toContain('正在等待系统验证');
  await act(async () => { foreground?.('background'); });
  expect(app.text()).not.toContain('TV1-PRIVATE-EXAMPLE');
  expect(app.text()).toContain('找回你的私密资料');
  await act(async () => { resolve([]); });
  expect(app.text()).toContain('都回来了。');
  await app.close();
});

test('populated local vaults retain their records and do not restore over them', async () => {
  const alert = jest.spyOn(Alert, 'alert');
  const app = await mount({ hasCloudBackup: true });
  await app.press('验证并打开资料库');
  await app.press('存储与备份');
  const button = app.tree.root.findAll(node => node.props.accessibilityLabel === '使用恢复密钥恢复云端资料' && typeof node.props.onPress === 'function')[0];
  expect(button.props.disabled).toBe(true);
  await act(async () => { button.props.onPress(); });
  expect(alert).toHaveBeenCalledWith('先保留好本机资料', expect.stringContaining('不会直接覆盖'));
  expect(native.restore).not.toHaveBeenCalled();
  await app.close();
});

test('canceling the network read preserves the new phone and allows another attempt', async () => {
  local.exists = false;
  const app = await mount({ hasCloudBackup: true });
  await app.press('恢复已有资料');
  let resolve!: (value: { version: number; envelope: unknown; updated_at: number | null }) => void;
  app.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => { app.tree.root.findByType(TextInput).props.onChangeText('TV1-PRIVATE-EXAMPLE'); });
  await app.press('验证并恢复到手机');
  expect(app.text()).toContain('正在获取加密备份');
  await app.press('取消读取备份');
  await act(async () => { resolve({ version: 4, envelope, updated_at: 1 }); });
  expect(app.text()).toContain('已取消读取备份，未开始本机恢复');
  expect(app.tree.root.findByType(TextInput).props.value).toBe('');
  expect(native.restore).not.toHaveBeenCalled();
  expect(local.exists).toBe(false);
  await app.close();
});

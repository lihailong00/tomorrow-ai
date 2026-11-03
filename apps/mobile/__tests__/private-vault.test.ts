import type { ApiClient } from '../src/api/client';
import { findVaultRecords, validateVaultRecord, validVaultEnvelope, vaultOwner, type VaultCloudState, type VaultEnvelope, type VaultStatus } from '../src/domain/privateVault';
import type { VaultPlatform } from '../src/platform/privateVault';
import { VaultCloud } from '../src/features/private-vault/cloud';

jest.mock('../src/platform/privateVault', () => ({ privateVault: {} }));
const encrypted: VaultEnvelope = { schema: 1, algorithm: 'A256GCM', kid: '0123456789abcdef0123456789abcdef', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
function fixture(initial?: VaultCloudState, localInitial: Partial<VaultStatus> = {}) {
  let remote: VaultCloudState = initial ?? { version: 0, envelope: null, updated_at: null };
  let local: VaultStatus = { available: true, exists: true, backup_enabled: false, recovery_ready: true, remote_version: 0, consent_epoch: 0, revision: 'local-r1', synced_revision: '', ...localInitial };
  const native = {
    status: jest.fn(async () => ({ ...local })),
    snapshot: jest.fn(async () => { if (!local.backup_enabled) throw new Error('off'); return { envelope: encrypted, revision: local.revision, consent_epoch: local.consent_epoch, remote_version: local.remote_version }; }),
    configure: jest.fn(async (_scope: string, version: number) => { local = { ...local, backup_enabled: true, remote_version: version, consent_epoch: local.consent_epoch + 1 }; }),
    stop: jest.fn(async () => { local = { ...local, backup_enabled: false, consent_epoch: local.consent_epoch + 1 }; }),
    acknowledge: jest.fn(async (_scope: string, version: number, revision: string, epoch: number) => { if (epoch === local.consent_epoch) local = { ...local, remote_version: version, synced_revision: revision }; }),
    authorizeDeletion: jest.fn(async () => null),
    restore: jest.fn(async () => []),
  };
  const api = {
    baseUrl: 'https://my-server.example/prefix',
    request: jest.fn(async (path: string, method = 'GET', body?: { expected_version: number; envelope?: VaultEnvelope }) => {
      expect(path).toBe('/private-vault/backup');
      if (method === 'GET') return { ...remote };
      if (body?.expected_version !== remote.version) throw Object.assign(new Error('conflict'), { status: 409 });
      remote = { version: remote.version + 1, envelope: method === 'DELETE' ? null : body?.envelope ?? null, updated_at: 1 };
      return { ...remote };
    }),
  };
  const cloud = new VaultCloud(api as unknown as ApiClient, 'owner', native as unknown as VaultPlatform);
  return { cloud, native, api, local: () => local, remote: () => remote, setRemote: (value: VaultCloudState) => { remote = value; } };
}

test('owner scope separates accounts, server URLs and verified instance identities', () => {
  expect(vaultOwner('https://one.example', 'instance-a', 'u')).not.toBe(vaultOwner('https://one.example', 'instance-b', 'u'));
  expect(vaultOwner('https://one.example', 'instance-a', 'u')).not.toBe(vaultOwner('https://two.example', 'instance-a', 'u'));
  expect(vaultOwner('https://one.example', 'instance-a', 'u')).not.toBe(vaultOwner('https://one.example', 'instance-a', 'v'));
});
test('local lookup returns all candidate cards instead of guessing one, and input is validated', () => {
  const cards = [{ id: 'a', type: 'bank' as const, alias: '工资卡', summary: '尾号 1234' }, { id: 'b', type: 'bank' as const, alias: '备用卡', summary: '尾号 5678' }];
  expect(findVaultRecords('我的银行卡号', cards)).toEqual(cards);
  expect(findVaultRecords('工资卡是多少', cards)).toEqual([cards[0]]);
  expect(findVaultRecords('天气', cards)).toEqual([]);
  expect(validateVaultRecord({ type: 'bank', alias: '工资卡', fields: { bank: '示例银行', owner: '示例姓名', number: '0000000000001234' } })).toBeNull();
  expect(validateVaultRecord({ type: 'identity', alias: '证件', fields: { owner: '示例姓名', number: '1234' } })).toContain('18');
});
test('encrypted envelope rejects plaintext fields, missing fields and unexpected algorithms', () => {
  expect(validVaultEnvelope(encrypted)).toBe(true);
  expect(validVaultEnvelope({ ...encrypted, number: '0000000000001234' })).toBe(false);
  expect(validVaultEnvelope({ ...encrypted, algorithm: 'none' })).toBe(false);
  expect(validVaultEnvelope({ ...encrypted, ciphertext: 'plaintext' })).toBe(false);
});
test('backup stays local by default, enabling uses the existing authenticated client and ciphertext only', async () => {
  const f = fixture();
  expect(await f.cloud.sync()).toBeNull();
  expect(f.api.request).not.toHaveBeenCalled();
  await f.cloud.enable();
  expect(f.local().backup_enabled).toBe(true);
  expect(f.remote().envelope).toEqual(encrypted);
  const put = f.api.request.mock.calls.find(([, method]) => method === 'PUT');
  expect(put?.[2]).toEqual({ expected_version: 0, envelope: encrypted });
  expect(JSON.stringify(put)).not.toContain('recovery_key');
  expect(f.native.acknowledge).toHaveBeenCalledWith('owner', 1, 'local-r1', 1);
});
test('preexisting unknown cloud backup is never overwritten', async () => {
  const f = fixture({ version: 5, envelope: encrypted, updated_at: 1 });
  await expect(f.cloud.enable()).rejects.toThrow('恢复');
  expect(f.native.configure).not.toHaveBeenCalled();
  expect(f.api.request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true);
});
test('stop retains remote copy; verified deletion preserves local records and prevents stale writes', async () => {
  const f = fixture(); await f.cloud.enable();
  await f.cloud.stop(false);
  expect(f.local().backup_enabled).toBe(false);
  expect(f.remote().envelope).toEqual(encrypted);
  await f.cloud.stop(true);
  expect(f.native.authorizeDeletion).toHaveBeenCalledWith('owner');
  expect(f.remote().envelope).toBeNull();
  expect(f.local().remote_version).toBe(2);
  expect(f.local().exists).toBe(true);
  await f.cloud.enable();
  expect(f.remote().version).toBe(3);
});
test('canceling identity verification for deletion changes nothing', async () => {
  const f = fixture(); await f.cloud.enable();
  f.native.authorizeDeletion.mockRejectedValueOnce(new Error('cancelled'));
  await expect(f.cloud.stop(true)).rejects.toThrow('cancelled');
  expect(f.local().backup_enabled).toBe(true);
  expect(f.remote().envelope).not.toBeNull();
});

test('a fresh device deletes its cloud copy successfully without creating or acknowledging a missing local vault', async () => {
  const f = fixture({ version: 4, envelope: encrypted, updated_at: 1 }, { exists: false, recovery_ready: false, revision: '' });
  f.native.acknowledge.mockRejectedValueOnce(new Error('no local vault file'));
  await expect(f.cloud.stop(true)).resolves.toEqual({ version: 5, envelope: null, updated_at: 1 });
  expect(f.remote()).toEqual({ version: 5, envelope: null, updated_at: 1 });
  expect(f.native.authorizeDeletion).toHaveBeenCalledWith('owner');
  expect(f.native.stop).toHaveBeenCalledWith('owner');
  expect(f.native.acknowledge).not.toHaveBeenCalled();
  expect(f.native.snapshot).not.toHaveBeenCalled();
  expect(f.native.configure).not.toHaveBeenCalled();
  expect(f.native.restore).not.toHaveBeenCalled();
  expect(f.local().exists).toBe(false);
  expect(f.api.request.mock.calls).toEqual([
    ['/private-vault/backup', 'GET', undefined, expect.anything()],
    ['/private-vault/backup', 'DELETE', { expected_version: 4 }, expect.anything()],
  ]);
  expect(JSON.stringify(f.api.request.mock.calls)).not.toMatch(/recovery_key|fields|ciphertext/);
});
test('another device update conflicts rather than replacing data, and lost responses reconcile identical ciphertext', async () => {
  const f = fixture(); await f.cloud.enable();
  f.setRemote({ version: 9, envelope: { ...encrypted, iv: 'BBBBBBBBBBBBBBBB' }, updated_at: 2 });
  await expect(f.cloud.sync()).rejects.toThrow('其他设备');
  expect(f.remote().version).toBe(9);
  f.setRemote({ version: 10, envelope: encrypted, updated_at: 2 });
  await f.cloud.sync();
  expect(f.local().remote_version).toBe(10);
});
test('restore passes recovery key only to native decryption and disposal blocks further network access', async () => {
  const f = fixture({ version: 4, envelope: encrypted, updated_at: 1 });
  await f.cloud.restore('TV1-FAKE-EXAMPLE');
  expect(f.native.restore).toHaveBeenCalledWith('owner', encrypted, 'TV1-FAKE-EXAMPLE', 4);
  expect(JSON.stringify(f.api.request.mock.calls)).not.toContain('TV1-FAKE-EXAMPLE');
  f.cloud.dispose();
  await expect(f.cloud.read()).rejects.toThrow('连接已变化');
});

test('revoking consent during a delayed read prevents a new upload', async () => {
  const f = fixture(); await f.cloud.enable();
  f.native.snapshot.mockResolvedValueOnce({ envelope: { ...encrypted, iv: 'CCCCCCCCCCCCCCCC' }, revision: 'r2', consent_epoch: 1, remote_version: 1 });
  let resolve!: (value: VaultCloudState) => void;
  f.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const syncing = f.cloud.sync();
  while (!resolve) await Promise.resolve();
  const stopping = f.cloud.stop(false);
  await Promise.resolve();
  resolve(f.remote());
  await syncing; await stopping;
  expect(f.api.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
  expect(f.local().backup_enabled).toBe(false);
});

test('canceling restore during a delayed fetch prevents native decryption and reports actual stages', async () => {
  const f = fixture({ version: 4, envelope: encrypted, updated_at: 1 });
  const controller = new AbortController();
  const stages: string[] = [];
  let resolve!: (value: VaultCloudState) => void;
  f.api.request.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const restoring = f.cloud.restore('TV1-EXAMPLE', phase => stages.push(phase), controller.signal);
  while (!resolve) await Promise.resolve();
  controller.abort(); resolve(f.remote());
  await expect(restoring).rejects.toThrow('取消');
  expect(stages).toEqual(['fetching']);
  expect(f.native.restore).not.toHaveBeenCalled();
});

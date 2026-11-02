import type { ApiClient } from '../../api/client';
import { validVaultEnvelope, type VaultCloudState } from '../../domain/privateVault';
import { privateVault, type VaultPlatform } from '../../platform/privateVault';

const path = '/private-vault/backup';
function validateCloud(value: VaultCloudState): VaultCloudState {
  if (!value || !Number.isSafeInteger(value.version) || value.version < 0 ||
      (value.envelope !== null && !validVaultEnvelope(value.envelope))) throw new Error('云端返回的备份格式无效，已停止操作。');
  return value;
}
function sameEnvelope(a: VaultCloudState['envelope'], b: VaultCloudState['envelope']) {
  return a && b && a.kid === b.kid && a.iv === b.iv && a.ciphertext === b.ciphertext;
}
/** Exactly the authenticated app client; no separate address, token or fallback. */
export class VaultCloud {
  private queue: Promise<unknown> = Promise.resolve();
  private controller: AbortController | null = null;
  private disposed = false;
  private consentGeneration = 0;
  constructor(private api: ApiClient, private scope: string, private native: VaultPlatform = privateVault) {}
  dispose() { this.disposed = true; this.consentGeneration++; this.controller?.abort(); }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.disposed) throw new Error('资料所属连接已变化，请重新打开。');
      return run();
    });
    this.queue = next;
    return next;
  }
  private async request(method = 'GET', body?: unknown): Promise<VaultCloudState> {
    if (this.disposed) throw new Error('资料所属连接已变化，请重新打开。');
    const controller = new AbortController();
    this.controller = controller;
    try { return validateCloud(await this.api.request<VaultCloudState>(path, method, body, controller.signal)); }
    finally { if (this.controller === controller) this.controller = null; }
  }
  read() { return this.serial(() => this.request()); }
  private async syncCurrent(): Promise<VaultCloudState | null> {
    const status = await this.native.status(this.scope);
    if (!status.backup_enabled) return null;
    const snapshot = await this.native.snapshot(this.scope);
    const remote = await this.request();
    if (sameEnvelope(remote.envelope, snapshot.envelope)) {
      await this.native.acknowledge(this.scope, remote.version, snapshot.revision, snapshot.consent_epoch);
      return remote;
    }
    if (remote.version !== snapshot.remote_version) throw new Error('云端副本已在其他设备变化，已停止覆盖。请检查云端备份或先恢复资料。');
    // Consent can be revoked while waiting for the network read.
    const current = await this.native.status(this.scope);
    if (!current.backup_enabled || current.consent_epoch !== snapshot.consent_epoch) return null;
    const result = await this.request('PUT', { expected_version: remote.version, envelope: snapshot.envelope });
    await this.native.acknowledge(this.scope, result.version, snapshot.revision, snapshot.consent_epoch);
    return result;
  }
  sync() { return this.serial(() => this.syncCurrent()); }
  enable() {
    const consent = this.consentGeneration;
    return this.serial(async () => {
      const status = await this.native.status(this.scope);
      const remote = await this.request();
      if (this.disposed || consent !== this.consentGeneration) throw new Error('开启备份已取消。');
      if (remote.envelope && remote.version !== status.remote_version) throw new Error('当前账号已有云端备份，请先使用恢复密钥恢复；不会覆盖已有副本。');
      await this.native.configure(this.scope, remote.version);
      try {
        if (this.disposed || consent !== this.consentGeneration) throw new Error('开启备份已取消。');
        return await this.syncCurrent();
      }
      catch (error) { await this.native.stop(this.scope); throw error; }
    });
  }
  async stop(removeCloud: boolean): Promise<VaultCloudState | null> {
    if (removeCloud) await this.native.authorizeDeletion(this.scope);
    this.consentGeneration++;
    // Stop is persisted before waiting for an earlier upload or doing a delete.
    await this.native.stop(this.scope);
    this.controller?.abort();
    return this.serial(async () => {
      if (!removeCloud) return null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const remote = await this.request();
        try {
          const deleted = await this.request('DELETE', { expected_version: remote.version });
          const status = await this.native.status(this.scope);
          // A fresh device can delete its existing cloud copy without ever
          // creating a local vault. There is no local sync marker to update.
          if (status.exists) await this.native.acknowledge(this.scope, deleted.version, '', status.consent_epoch);
          return deleted;
        } catch (error) {
          if ((error as { status?: number }).status !== 409 || attempt === 2) throw error;
        }
      }
      throw new Error('云端副本正在变化，请稍后重试删除。');
    });
  }
  restore(recovery: string) {
    return this.serial(async () => {
      const remote = await this.request();
      if (!remote.envelope) throw new Error('当前后端没有可恢复的云端副本。');
      return this.native.restore(this.scope, remote.envelope, recovery, remote.version);
    });
  }
}

/** The only native boundary. iOS/HarmonyOS must implement this same contract;
 * unsupported devices fail closed, with no plaintext storage fallback. */
import { NativeModules } from 'react-native';
import type { VaultRecord, VaultSnapshot, VaultStatus, VaultSummary } from '../domain/privateVault';

export interface PrivateVaultPort {
  status(scope: string): Promise<VaultStatus>;
  setProtected(scope: string, enabled: boolean): Promise<void>;
  operate(scope: string, action: string, payload: string): Promise<string | null>;
  snapshot(scope: string): Promise<string>;
  stopBackup(scope: string): Promise<void>;
  acknowledge(scope: string, version: number, revision: string, epoch: number): Promise<void>;
}
function port(): PrivateVaultPort {
  const value = NativeModules.PrivateVault as PrivateVaultPort | undefined;
  if (!value) throw new Error('此版本尚未接入设备安全资料库，请使用支持本机加密与系统验证的 Android 版本。');
  return value;
}
export const privateVault = {
  available: () => !!NativeModules.PrivateVault,
  status: (scope: string) => port().status(scope),
  protect: (scope: string, enabled: boolean) => port().setProtected(scope, enabled),
  async summaries(scope: string): Promise<VaultSummary[]> { return JSON.parse((await port().operate(scope, 'list', '{}')) || '[]'); },
  async reveal(scope: string, id: string): Promise<VaultRecord> { return JSON.parse((await port().operate(scope, 'reveal', JSON.stringify({ id }))) || '{}'); },
  async save(scope: string, record: VaultRecord): Promise<VaultSummary[]> { return JSON.parse((await port().operate(scope, 'save', JSON.stringify(record))) || '[]'); },
  linkPhoneToAddress: (scope: string, phoneId: string, addressId: string) =>
    port().operate(scope, 'linkPhone', JSON.stringify({ phone_id: phoneId, address_id: addressId })),
  async remove(scope: string, id: string): Promise<VaultSummary[]> { return JSON.parse((await port().operate(scope, 'delete', JSON.stringify({ id }))) || '[]'); },
  copy: (scope: string, id: string) => port().operate(scope, 'copy', JSON.stringify({ id })),
  share: (scope: string, id: string, includeAddressContact = false) =>
    port().operate(scope, 'share', JSON.stringify({ id, include_address_contact: includeAddressContact })),
  recovery: (scope: string) => port().operate(scope, 'recovery', '{}'),
  copyRecovery: (scope: string) => port().operate(scope, 'copyRecovery', '{}'),
  async snapshot(scope: string): Promise<VaultSnapshot> { return JSON.parse(await port().snapshot(scope)); },
  configure: (scope: string, version: number) => port().operate(scope, 'configure', JSON.stringify({ acknowledged: true, remote_version: version })),
  stop: (scope: string) => port().stopBackup(scope),
  authorizeDeletion: (scope: string) => port().operate(scope, 'authorizeDelete', '{}'),
  acknowledge: (scope: string, version: number, revision: string, epoch: number) => port().acknowledge(scope, version, revision, epoch),
  async restore(scope: string, envelope: unknown, recovery_key: string, remote_version: number): Promise<VaultSummary[]> {
    return JSON.parse((await port().operate(scope, 'restore', JSON.stringify({ envelope, recovery_key, remote_version }))) || '[]');
  },
};
export type VaultPlatform = typeof privateVault;

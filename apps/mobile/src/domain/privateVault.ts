export type VaultKind = 'address' | 'bank' | 'identity';
export type VaultSummary = { id: string; type: VaultKind; alias: string; summary: string };
export type VaultRecord = { id?: string; type: VaultKind; alias: string; fields: Record<string, string> };
export type VaultEnvelope = { schema: 1; algorithm: 'A256GCM'; kid: string; iv: string; ciphertext: string };
export type VaultCloudState = { version: number; envelope: VaultEnvelope | null; updated_at: number | null };
export type VaultStatus = {
  available: boolean; exists: boolean; backup_enabled: boolean; recovery_ready: boolean;
  remote_version: number; consent_epoch: number; revision: string; synced_revision: string;
};
export type VaultSnapshot = { envelope: VaultEnvelope; revision: string; consent_epoch: number; remote_version: number };

export const vaultFields: Record<VaultKind, { key: string; label: string; required?: boolean }[]> = {
  address: [{ key: 'owner', label: '收件人', required: true }, { key: 'phone', label: '联系电话' }, { key: 'address', label: '完整地址', required: true }],
  bank: [{ key: 'bank', label: '所属银行', required: true }, { key: 'owner', label: '持卡人', required: true }, { key: 'number', label: '银行卡号', required: true }, { key: 'branch', label: '开户行' }],
  identity: [{ key: 'owner', label: '姓名', required: true }, { key: 'number', label: '身份证号码', required: true }, { key: 'validUntil', label: '有效期' }],
};
export const vaultKindLabels: Record<VaultKind, string> = { address: '地址', bank: '银行卡', identity: '身份证' };

export function vaultOwner(server: string, instance: string | undefined, user: string): string {
  if (!server || !user) throw new Error('请先登录当前服务器。');
  return JSON.stringify(['private-vault.v1', server.replace(/\/+$/, ''), instance ?? '', user]);
}
export function validateVaultRecord(record: VaultRecord): string | null {
  if (!record.alias.trim() || record.alias.trim().length > 36) return '请填写 1 至 36 字的资料名称。';
  for (const field of vaultFields[record.type]) {
    const value = record.fields[field.key]?.trim() ?? '';
    if (field.required && !value) return `请填写${field.label}。`;
    if (value.length > (field.key === 'address' ? 500 : 120)) return `${field.label}过长。`;
  }
  if (record.type === 'bank' && !/^\d{12,25}$/.test(record.fields.number.replace(/ /g, ''))) return '请核对银行卡号格式。';
  if (record.type === 'identity' && !/^\d{17}[\dX]$/i.test(record.fields.number)) return '请填写 18 位身份证号码。';
  return null;
}
export function findVaultRecords(query: string, items: VaultSummary[]): VaultSummary[] {
  const value = query.trim().toLocaleLowerCase();
  const exact = items.filter(item => value.includes(item.alias.toLocaleLowerCase()));
  if (exact.length) return exact;
  const kind = /身份证|证件/.test(value) ? 'identity' : /地址|收件|家/.test(value) ? 'address' : /卡|银行|收款/.test(value) ? 'bank' : null;
  return kind ? items.filter(item => item.type === kind) : [];
}
export function validVaultEnvelope(value: unknown): value is VaultEnvelope {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<VaultEnvelope>;
  return Object.keys(data).sort().join(',') === 'algorithm,ciphertext,iv,kid,schema' && data.schema === 1 && data.algorithm === 'A256GCM' &&
    typeof data.kid === 'string' && /^[a-f0-9]{32}$/.test(data.kid) &&
    typeof data.iv === 'string' && /^[A-Za-z0-9+/]{16}$/.test(data.iv) &&
    typeof data.ciphertext === 'string' && data.ciphertext.length >= 24 && data.ciphertext.length <= 262168 &&
    data.ciphertext.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(data.ciphertext);
}

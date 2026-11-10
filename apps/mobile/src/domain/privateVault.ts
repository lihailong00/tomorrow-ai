export const privateValueKinds = {
  phone: { label: '手机号', field: '手机号码', terms: /手机号(?:码)?|电话(?:号{1,2}码?)?|联系电话/ },
  social_security: { label: '社保卡', field: '社保卡号', terms: /(?:社保|社会保障)卡(?:号码|号)?/ },
  medical_insurance: { label: '医保卡', field: '医保卡号', terms: /(?:医保|医疗保险)卡(?:号码|号)?/ },
  passport: { label: '护照', field: '护照号码', terms: /护照(?:号码|号)?/ },
  driver_license: { label: '驾驶证', field: '驾驶证号码', terms: /(?:驾驶证|驾照)(?:号码|号)?/ },
  travel_permit: { label: '通行证', field: '通行证号码', terms: /(?:(?:往来港澳|往来台湾|港澳|台湾|大陆)?通行证|回乡证|台胞证)(?:号码|号)?/ },
  residence_permit: { label: '居住证', field: '居住证号码', terms: /居住证(?:号码|号)?/ },
  email: { label: '个人邮箱', field: '邮箱地址', terms: /(?:个人)?(?:电子邮箱|电子邮件地址|邮箱(?:地址)?|邮件地址|e-?mail)/i },
} as const;

type PrivateValueKind = keyof typeof privateValueKinds;
export const privateValueTypes = Object.keys(privateValueKinds) as PrivateValueKind[];
export type VaultKind = 'address' | 'bank' | 'identity' | PrivateValueKind;
export type VaultSummary = { id: string; type: VaultKind; alias: string; summary: string; has_contact_phone?: boolean };
export type VaultRecord = { id?: string; type: VaultKind; alias: string; fields: Record<string, string> };
export type VaultEnvelope = { schema: 1; algorithm: 'A256GCM'; kid: string; iv: string; ciphertext: string };
export type VaultCloudState = { version: number; envelope: VaultEnvelope | null; updated_at: number | null };
export type VaultStatus = {
  available: boolean; exists: boolean; backup_enabled: boolean; recovery_ready: boolean;
  remote_version: number; consent_epoch: number; revision: string; synced_revision: string;
};
export type VaultSnapshot = { envelope: VaultEnvelope; revision: string; consent_epoch: number; remote_version: number };

type VaultField = { key: string; label: string; required?: boolean };
export const vaultFields: Record<VaultKind, VaultField[]> = {
  address: [{ key: 'owner', label: '收件人', required: true }, { key: 'phone', label: '联系电话' }, { key: 'address', label: '完整地址', required: true }],
  bank: [{ key: 'bank', label: '所属银行', required: true }, { key: 'owner', label: '持卡人', required: true }, { key: 'number', label: '银行卡号', required: true }, { key: 'branch', label: '开户行' }],
  identity: [{ key: 'owner', label: '姓名', required: true }, { key: 'number', label: '身份证号码', required: true }, { key: 'validUntil', label: '有效期' }],
  ...Object.fromEntries(privateValueTypes.map(type => [type, [
    { key: 'owner', label: '姓名', required: true }, { key: 'number', label: privateValueKinds[type].field, required: true },
  ]])) as Record<PrivateValueKind, VaultField[]>,
};
export const vaultKindLabels: Record<VaultKind, string> = {
  address: '地址', bank: '银行卡', identity: '身份证',
  ...Object.fromEntries(privateValueTypes.map(type => [type, privateValueKinds[type].label])) as Record<PrivateValueKind, string>,
};

export function validPrivateValue(type: PrivateValueKind, value: string): boolean {
  if (value.length > 120) return false;
  if (type === 'phone') return /^(?:1[3-9]\d{9}|\+[1-9]\d{7,14})$/.test(value);
  if (type === 'email') return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(value);
  return /^[a-z\d-]{5,32}$/i.test(value) && /\d/.test(value);
}

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
  if (record.type !== 'address' && record.type !== 'identity' && record.type !== 'bank' && !validPrivateValue(record.type, record.fields.number.trim())) {
    return `请核对${privateValueKinds[record.type].field}格式。`;
  }
  return null;
}
export function findVaultRecords(query: string, items: VaultSummary[]): VaultSummary[] {
  const value = query.trim().toLocaleLowerCase();
  const exact = items.filter(item => value.includes(item.alias.toLocaleLowerCase()));
  if (exact.length) return exact;
  const specificKind = privateValueTypes.find(type => privateValueKinds[type].terms.test(value));
  const kind = specificKind ?? (/身份证|证件/.test(value) ? 'identity' : /地址|收件|家/.test(value) ? 'address' : /卡|银行|收款/.test(value) ? 'bank' : null);
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

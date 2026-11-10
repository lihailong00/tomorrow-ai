import type { VaultRecord } from '../../domain/privateVault';

const semantics = ['name', 'phone', 'email', 'address', 'city', 'address_detail', 'company', 'invoice_title'] as const;
type Semantic = typeof semantics[number];
export type PersonalDetailsField = { key: string; label: string; semantic: Semantic; value: string; source: string; required: boolean };
export type PersonalDetails = {
  kind: 'personal_details'; provider: string; tool: string; purpose: string; subject: string;
  fields: PersonalDetailsField[]; arguments: Record<string, unknown>;
};
export function readPersonalDetails(value: Record<string, unknown>): PersonalDetails | undefined {
  const text = (s: unknown, max: number): s is string => typeof s === 'string' && s.length <= max;
  if (value.kind !== 'personal_details' || !text(value.provider, 200) || !text(value.tool, 200) ||
      !text(value.purpose, 280) || !['home', 'work', 'self', 'other'].includes(String(value.subject)) ||
      !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments) ||
      !Array.isArray(value.fields) || !value.fields.length || value.fields.length > 12) return undefined;
  const keys = new Set<string>();
  for (const field of value.fields) {
    if (!field || typeof field !== 'object' || !text(field.key, 80) || !field.key || keys.has(field.key) ||
        !text(field.label, 120) || !text(field.value, 1000) || !text(field.source, 200) ||
        !semantics.includes(field.semantic) || typeof field.required !== 'boolean') return undefined;
    keys.add(field.key);
  }
  return { kind: 'personal_details', provider: value.provider, tool: value.tool, purpose: value.purpose,
    subject: String(value.subject), fields: value.fields, arguments: value.arguments as Record<string, unknown> };
}
export function initialPersonalValues(fields: PersonalDetailsField[]): Record<string, string> {
  return Object.fromEntries(fields.map(field => [field.key, field.value]));
}
export function applyVaultAddress(fields: PersonalDetailsField[], previous: Record<string, string>, record: VaultRecord): Record<string, string> {
  if (record.type !== 'address') return previous;
  const address = record.fields.address || '';
  const city = address.replace(/^.*?省/, '').match(/^([^市]+市)/)?.[1] || '';
  const detail = address.match(/\d.*[栋幢室号单].*$/)?.[0] || '';
  const data: Partial<Record<Semantic, string>> = { name: record.fields.owner, phone: record.fields.phone, address, city, address_detail: detail };
  const result = { ...previous };
  for (const field of fields) {
    // This is an explicit selection of a record, so replace the matching bundle
    // together instead of mixing a new recipient with the old phone/address.
    if (Object.prototype.hasOwnProperty.call(data, field.semantic)) result[field.key] = data[field.semantic] || '';
  }
  return result;
}

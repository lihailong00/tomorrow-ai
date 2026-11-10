/* eslint no-void: ["error", { "allowAsStatement": true }] */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, TextInput, View } from 'react-native';
import { useApp } from '../../app/context';
import { errorMessage } from '../../api/client';
import { privateVault } from '../../platform/privateVault';
import { vaultOwner, type VaultSummary } from '../../domain/privateVault';
import { Button, ErrorNotice } from '../../ui/components';
import { Text } from '../../ui/Text';
import type { PersonalDetails } from './personalDetails';
import { applyVaultAddress, initialPersonalValues } from './personalDetails';

// Device-credential authentication may pause the Activity. Do not discard a
// valid answer merely for that pause, and never reveal it while backgrounded.
async function foregroundAfterAuthentication(): Promise<boolean> {
  if (AppState.currentState === 'active') return true;
  return new Promise(resolve => {
    const timeout = setTimeout(() => { listener.remove(); resolve(false); }, 5000);
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') { clearTimeout(timeout); listener.remove(); resolve(true); }
    });
  });
}

export function PersonalDetailsCard({ card, busy, submit }: {
  card: PersonalDetails; busy: boolean; submit: (values: Record<string, string>) => void;
}) {
  const app = useApp();
  const scope = app.user ? vaultOwner(app.api.baseUrl, app.preferences.instance?.id, app.user.id) : '';
  const [values, setValues] = useState(() => initialPersonalValues(card.fields));
  const [records, setRecords] = useState<VaultSummary[]>([]);
  const [failure, setFailure] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const authenticating = useRef(false);
  const locked = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    ++epoch.current;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'background') {
        if (!authenticating.current) ++epoch.current;
        setRecords([]);
        setValues({});
        if (!authenticating.current) setUnlocking(false);
      }
    });
    return () => {
      alive.current = false;
      listener.remove();
      if (timer.current) clearTimeout(timer.current);
      if (locked.current) void privateVault.protect(scope, false).catch(() => {});
    };
  }, [scope]);
  const reveal = async (record: VaultSummary, ticket: number) => {
    const data = await privateVault.reveal(scope, record.id);
    if (!alive.current || epoch.current !== ticket || !await foregroundAfterAuthentication()) return;
    if (!alive.current || epoch.current !== ticket) return;
    if (data.type !== 'address') throw new Error('请选择地址资料。');
    setValues(previous => applyVaultAddress(card.fields, previous, data));
    setRecords([]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (alive.current) setValues({}); }, 30000);
  };
  const unlock = async (record?: VaultSummary) => {
    if (unlocking || !scope) return;
    const ticket = ++epoch.current;
    authenticating.current = true;
    setUnlocking(true);
    setFailure('');
    try {
      await privateVault.protect(scope, true);
      locked.current = true;
      if (!alive.current || epoch.current !== ticket) {
        await privateVault.protect(scope, false);
        return;
      }
      if (record) await reveal(record, ticket);
      else {
        const items = (await privateVault.summaries(scope)).filter(item => item.type === 'address');
        if (!alive.current || epoch.current !== ticket || !await foregroundAfterAuthentication()) return;
        if (!alive.current || epoch.current !== ticket) return;
        // A unique matching alias may be used; a sole unrelated address is not
        // automatically treated as home or as another person's address.
        const matches = items.filter(item => card.subject === 'home' ? /家|住址/.test(item.alias)
          : card.subject === 'work' ? /公司|工作/.test(item.alias) : false);
        if (matches.length === 1) await reveal(matches[0], ticket);
        else if (items.length) setRecords(items);
        else setFailure('资料库还没有地址，可直接补充下面缺少的内容。');
      }
    } catch (error) {
      if (alive.current && epoch.current === ticket) setFailure(errorMessage(error));
    } finally {
      if (alive.current && epoch.current === ticket) { authenticating.current = false; setUnlocking(false); }
    }
  };
  const disabled = busy || unlocking;
  const missing = card.fields.some(field => field.required && !(values[field.key] ?? '').trim());
  const extra = Object.entries(card.arguments).filter(([key]) => !card.fields.some(field => field.key === key));
  return <View style={styles.stack}>
    <Text style={styles.title}>{Object.values(values).some(value => value.trim()) ? '已为你填写可用资料' : '补充本次所需资料'}</Text>
    <Text>{card.purpose}</Text>
    <Text style={styles.note}>将提交给 {card.provider} · {card.tool}。核对后继续办理，已填写的内容可以修改。</Text>
    {card.subject === 'other' && <Text style={styles.note}>这次为别人办理，未使用你的默认资料。</Text>}
    {failure ? <ErrorNotice message={failure} /> : null}
    {card.fields.map(field => <View key={field.key} style={styles.field}>
      <Text>{field.label}{field.required ? '' : '（选填）'}</Text>
      <TextInput accessibilityLabel={field.label} value={values[field.key] ?? ''}
        onChangeText={value => setValues(previous => ({ ...previous, [field.key]: value }))}
        editable={!disabled} maxLength={500} autoCorrect={false}
        keyboardType={field.semantic === 'phone' ? 'phone-pad' : field.semantic === 'email' ? 'email-address' : 'default'}
        multiline={field.semantic === 'address'} style={styles.input}
        placeholder={`补充${field.label}`} />
      <Text style={styles.note}>{field.source}</Text>
    </View>)}
    {extra.map(([key, value]) => <Text key={key} style={styles.note}>{key}：{typeof value === 'string' ? value : JSON.stringify(value)}</Text>)}
    {privateVault.available() && scope && card.fields.some(f => ['name', 'phone', 'address', 'city', 'address_detail'].includes(f.semantic)) &&
      <Button variant="secondary" disabled={disabled} onPress={() => { void unlock(); }}>从本机私密资料填写</Button>}
    {records.map(record => <Button key={record.id} variant="secondary" disabled={disabled} onPress={() => { void unlock(record); }}>{record.alias}</Button>)}
    <Button disabled={disabled || missing} onPress={() => submit(Object.fromEntries(card.fields.map(f => [f.key, values[f.key] ?? ''])))}>使用这些资料并执行</Button>
  </View>;
}

const styles = StyleSheet.create({
  field: { gap: 4 },
  stack: { gap: 12 }, title: { fontSize: 20, fontWeight: '600' },
  note: { fontSize: 13, color: '#68758B', lineHeight: 20 },
  input: { backgroundColor: '#F1F5FD', color: '#30384B', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, minHeight: 46 },
});

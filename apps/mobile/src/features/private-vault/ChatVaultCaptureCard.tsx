/* eslint no-void: ["error", { "allowAsStatement": true }] */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { errorMessage } from '../../api/client';
import { validateVaultRecord, vaultFields, type VaultRecord } from '../../domain/privateVault';
import { privateVault } from '../../platform/privateVault';
import { Button, Card, ErrorNotice, Field } from '../../ui/components';
import { Text } from '../../ui/Text';
import { colors, styles } from '../../ui/theme';
import { Icon } from '../../ui/visuals';

export function ChatVaultCaptureCard({ scope, proposal, transcribed, isCurrent, onClose, onSaved }: {
  scope: string;
  proposal: VaultRecord;
  transcribed: boolean;
  isCurrent: () => boolean;
  onClose: () => void;
  onSaved: (alias: string) => void;
}) {
  const [record, setRecord] = useState(proposal);
  const [editing, setEditing] = useState(() => !!validateVaultRecord(proposal));
  const [protectedReady, setProtectedReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [savedPhone, setSavedPhone] = useState<{ id: string; addressId: string; linked: boolean } | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const alive = useRef(false);
  const operation = useRef(false);
  const callbacks = useRef({ isCurrent, onClose });
  callbacks.current = { isCurrent, onClose };

  useEffect(() => {
    alive.current = true;
    let closed = false;
    const protection = (async () => {
      try {
        if (!privateVault.available()) throw new Error('当前设备尚未接入本机加密资料库。');
        const status = await privateVault.status(scope);
        if (closed || !callbacks.current.isCurrent()) return false;
        if (!status.available) throw new Error('请先开启设备锁屏密码，再保存私密资料。');
        await privateVault.protect(scope, true);
        if (!closed && callbacks.current.isCurrent()) setProtectedReady(true);
        return true;
      } catch (error) {
        if (!closed) setFailure(errorMessage(error));
        return false;
      }
    })();
    const subscription = AppState.addEventListener('change', next => {
      setForeground(next === 'active');
      // The device credential sheet may temporarily background the Activity.
      if (next === 'background' && !operation.current) callbacks.current.onClose();
    });
    return () => {
      closed = true;
      alive.current = false;
      subscription.remove();
      void protection.then(enabled => { if (enabled) return privateVault.protect(scope, false); }).catch(() => {});
    };
  }, [scope]);

  const save = async () => {
    if (operation.current || !protectedReady || !foreground || !isCurrent()) return;
    const validation = validateVaultRecord(record);
    if (validation) { setFailure(validation); setEditing(true); return; }
    operation.current = true;
    setBusy(true);
    setFailure('');
    try {
      const items = await privateVault.save(scope, record);
      if (!alive.current || !isCurrent()) return;
      if (record.type === 'phone') {
        // The native save operation appends the record it just wrote.
        const saved = items[items.length - 1];
        const homes = items.filter(item => item.type === 'address' && /^(?:家庭住址|家庭地址|我家|家|家里)$/.test(item.alias));
        if (saved?.type === 'phone' && homes.length === 1 && homes[0].has_contact_phone === false) {
          setSavedPhone({ id: saved.id, addressId: homes[0].id, linked: false });
          setRecord({ ...record, fields: {} });
          return;
        }
      }
      onSaved(record.alias);
    } catch (error) {
      if (alive.current && isCurrent()) setFailure(errorMessage(error));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const link = async () => {
    if (!savedPhone || savedPhone.linked || operation.current || !protectedReady || !foreground || !isCurrent()) return;
    operation.current = true;
    setBusy(true);
    setFailure('');
    try {
      await privateVault.linkPhoneToAddress(scope, savedPhone.id, savedPhone.addressId);
      if (alive.current && isCurrent()) setSavedPhone({ ...savedPhone, linked: true });
    } catch (error) {
      if (alive.current && isCurrent()) setFailure(errorMessage(error));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const showDetails = protectedReady && foreground && !busy;
  if (savedPhone) return <Card testID="chat-vault-capture" style={{ gap: 8 }}>
    <Text style={styles.cardTitle}>本人手机号已加密保存</Text>
    <Text style={styles.small}>{savedPhone.linked ? '已填入家庭住址的联系电话。' : '要把这个手机号也填入家庭住址的联系电话吗？'}</Text>
    {failure && <ErrorNotice message={failure} />}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button variant={savedPhone.linked ? 'primary' : 'ghost'} disabled={!showDetails} onPress={() => onSaved(record.alias)}>
        {savedPhone.linked ? '完成' : '仅保存手机号'}
      </Button>
      {!savedPhone.linked && <Button disabled={!showDetails} onPress={() => { void link(); }}>{busy ? '等待系统验证…' : '填入联系电话'}</Button>}
    </View>
  </Card>;

  return <Card testID="chat-vault-capture" style={{ gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="shield" color={colors.accent} />
      <Text style={styles.cardTitle}>保存到私密资料？</Text>
    </View>
    <Text style={styles.small}>验证身份后写入本机加密资料库。跳过会丢弃这次待保存的输入。</Text>
    {transcribed && <Text style={styles.small}>语音已经过转写服务，这一步只保存到本机资料库。</Text>}
    {showDetails && (editing ? vaultFields[record.type].map(field => (
      <Field key={field.key} label={field.label} value={record.fields[field.key] ?? ''}
        onChangeText={value => setRecord(current => ({ ...current, fields: { ...current.fields, [field.key]: value } }))}
        maxLength={field.key === 'address' ? 500 : 120} autoCorrect={false} autoComplete="off" importantForAutofill="no"
        secureTextEntry={field.key === 'number'} />
    )) : <View>
      <Text style={styles.small}>{record.alias}</Text>
      <Text>{record.type === 'address' ? '完整地址已隐藏' : record.type === 'email' ? '邮箱地址已隐藏' : `尾号 ${record.fields.number.slice(-4)}`}</Text>
    </View>)}
    {failure && <ErrorNotice message={failure} />}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      <Button variant="ghost" disabled={busy} onPress={onClose}>跳过</Button>
      {showDetails && !editing && <Button variant="secondary" onPress={() => setEditing(true)}>修改</Button>}
      <Button disabled={!showDetails} onPress={() => { void save(); }}>{busy ? '等待系统验证…' : '验证并保存'}</Button>
    </View>
  </Card>;
}

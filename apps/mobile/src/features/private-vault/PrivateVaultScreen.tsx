/* eslint no-void: ["error", { "allowAsStatement": true }] */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useApp } from '../../app/context';
import { errorMessage } from '../../api/client';
import { findVaultRecords, validateVaultRecord, vaultFields, vaultKindLabels, vaultOwner, type VaultCloudState, type VaultKind, type VaultRecord, type VaultStatus, type VaultSummary } from '../../domain/privateVault';
import { privateVault } from '../../platform/privateVault';
import { Text } from '../../ui/Text';
import { Icon, type IconName } from '../../ui/visuals';
import { VaultCloud } from './cloud';

const p = { ink: '#30384B', muted: '#748096', blue: '#4D71C8', pale: '#EDF2FF', white: '#FFFFFF', line: '#E7ECF5', green: '#3B8274', red: '#B45164' };
const kindIcon: Record<VaultKind, IconName> = { address: 'import', bank: 'file', identity: 'shield' };
type Page = 'vault' | 'chat' | 'storage' | 'detail' | 'edit' | 'recovery' | 'restore' | 'history';
let nextOwner = 0;

export function PrivateVaultScreen() {
  const app = useApp();
  const userId = app.user?.id;
  const owner = useMemo(() => ({ id: ++nextOwner, scope: userId ? vaultOwner(app.api.baseUrl, app.preferences.instance?.id, userId) : '' }),
    [app.api, userId, app.preferences.instance?.id]);
  return app.user ? <VaultSession key={owner.id} scope={owner.scope} /> : null;
}

function VaultButton({ label, onPress, secondary = false, disabled = false, danger = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [v.button, secondary && v.secondaryButton, danger && v.dangerButton, disabled && v.disabled, pressed && v.pressed]}>
    <Text style={[v.buttonText, secondary && v.secondaryText]}>{label}</Text>
  </Pressable>;
}

function VaultSession({ scope }: { scope: string }) {
  const { api, preferences, back } = useApp();
  const cloud = useMemo(() => new VaultCloud(api, scope), [api, scope]);
  const [page, setPage] = useState<Page>('vault');
  const [records, setRecords] = useState<VaultSummary[] | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [remote, setRemote] = useState<VaultCloudState | null>(null);
  const [remoteError, setRemoteError] = useState('');
  const [selected, setSelected] = useState<VaultSummary | null>(null);
  const [revealed, setRevealed] = useState<VaultRecord | null>(null);
  const [draft, setDraft] = useState<VaultRecord | null>(null);
  const [recovery, setRecovery] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<{ query: string; matches: VaultSummary[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [protectedReady, setProtectedReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<{ action: string; alias: string; at: string }[]>([]);
  const alive = useRef(true);
  const operation = useRef(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPage = useRef(page); currentPage.current = page;
  const clearSecrets = () => {
    setRevealed(null); setDraft(null); setRecovery(''); setRecoveryInput(''); setAcknowledged(false);
    setQuery(''); setLookup(null);
  };
  const armLock = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      if (!alive.current) return;
      clearSecrets();
      if (['edit', 'recovery', 'restore'].includes(currentPage.current)) setPage('vault');
      setNotice('完整资料已自动隐藏，请重新验证后使用。');
    }, 30000);
  };
  const refresh = async () => {
    const next = await privateVault.status(scope);
    if (alive.current) setStatus(next);
    return next;
  };
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        await privateVault.protect(scope, true);
        if (!alive.current) return;
        setProtectedReady(true);
        await refresh();
      } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    })();
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        clearSecrets(); setRecords(null); setLookup(null);
        if (['edit', 'recovery', 'restore'].includes(currentPage.current)) setPage('vault');
      }
    });
    return () => {
      alive.current = false; listener.remove(); cloud.dispose();
      if (timeout.current) clearTimeout(timeout.current);
      void privateVault.protect(scope, false).catch(() => {});
    };
    // This component remounts synchronously for every account/client/instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, scope]);

  const run = async (work: () => Promise<void>) => {
    if (operation.current || !alive.current || !protectedReady) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally {
      operation.current = false;
      if (alive.current) { setBusy(false); void refresh().catch(() => {}); }
    }
  };
  const recordUse = (action: string, alias: string) => {
    if (!alive.current) return;
    setHistory(old => [{ action, alias, at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }, ...old].slice(0, 30));
  };
  const navigate = (next: Page) => {
    if (busy) return;
    clearSecrets(); setPage(next); setError(''); setNotice('');
    if (timeout.current) clearTimeout(timeout.current);
    if (next === 'storage') {
      setRemote(null); setRemoteError('');
      void cloud.read().then(value => { if (alive.current) setRemote(value); }).catch(failure => { if (alive.current) setRemoteError(errorMessage(failure)); });
    }
  };
  const goBack = () => {
    if (busy) return;
    if (page === 'vault') back();
    else navigate(['recovery', 'restore'].includes(page) ? 'storage' : 'vault');
  };
  const openRecord = (item: VaultSummary) => { setSelected(item); navigate('detail'); };
  const list = () => run(async () => {
    const items = await privateVault.summaries(scope);
    if (alive.current && AppState.currentState === 'active') setRecords(items);
  });
  const reveal = (edit: boolean) => selected && run(async () => {
    const value = await privateVault.reveal(scope, selected.id);
    if (!alive.current || AppState.currentState !== 'active') return;
    if (edit) { setDraft(value); setPage('edit'); } else setRevealed(value);
    recordUse(edit ? '编辑资料' : '查看完整资料', selected.alias); armLock();
  });
  const syncSaved = async () => {
    try { const result = await cloud.sync(); if (alive.current && result) setRemote(result); }
    catch (failure) { if (alive.current) setNotice('资料已保存在手机，云端备份尚未完成：' + errorMessage(failure)); }
  };
  const save = () => draft && run(async () => {
    const validation = validateVaultRecord(draft);
    if (validation) throw new Error(validation);
    const items = await privateVault.save(scope, draft);
    if (!alive.current) return;
    clearSecrets(); setRecords(items); setPage('vault'); setNotice('资料已加密保存在手机。');
    await syncSaved();
  });
  const copy = (item: VaultSummary) => run(async () => {
    await privateVault.copy(scope, item.id);
    if (!alive.current) return;
    recordUse('复制资料', item.alias); setNotice('已复制完整内容，将在约 30 秒后尝试清空剪贴板。');
  });
  const share = (item: VaultSummary) => Alert.alert('分享「' + item.alias + '」',
    '将提供' + vaultFields[item.type].map(field => field.label).join('、') + '。验证身份后，由你在系统分享面板选择接收人。',
    [{ text: '取消', style: 'cancel' }, { text: '验证并选择接收人', onPress: () => { void run(async () => { await privateVault.share(scope, item.id); recordUse('打开资料分享', item.alias); }); } }]);
  const remove = () => selected && Alert.alert('删除「' + selected.alias + '」？', '本机资料会被删除；如果备份已开启，更新后的加密副本也会同步。',
    [{ text: '保留', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => { void run(async () => {
      const items = await privateVault.remove(scope, selected.id);
      if (!alive.current) return;
      clearSecrets(); setRecords(items); setPage('vault'); await syncSaved();
    }); } }]);
  const newRecord = (type: VaultKind) => {
    if (busy || !status?.available) return;
    clearSecrets(); setDraft({ type, alias: '', fields: {} }); setPage('edit'); setError(''); armLock();
  };
  const chooseType = () => Alert.alert('添加哪种资料？', '完整内容只在本机加密资料库中保存。',
    (Object.keys(vaultKindLabels) as VaultKind[]).map(type => ({ text: vaultKindLabels[type], onPress: () => newRecord(type) })));
  const beginRecovery = () => run(async () => {
    const key = await privateVault.recovery(scope);
    if (!alive.current || AppState.currentState !== 'active') return;
    setRecovery(key || ''); setAcknowledged(false); setPage('recovery'); armLock();
  });
  const enable = () => run(async () => {
    const value = await cloud.enable();
    if (!alive.current) return;
    clearSecrets(); if (value) setRemote(value); setPage('storage'); setNotice('已备份到 App 当前连接的后端。');
  });
  const stop = (deleteCopy: boolean) => run(async () => {
    const value = await cloud.stop(deleteCopy);
    if (!alive.current) return;
    if (value) setRemote(value);
    else { try { setRemote(await cloud.read()); } catch { setRemote(null); setRemoteError('备份已停止，云端副本状态暂时无法确认。'); } }
    recordUse(deleteCopy ? '删除云端副本' : '停止云端备份', '私密资料库');
    setNotice(deleteCopy ? '已删除当前后端的加密副本，本机资料保留。' : '已停止后续备份，已有云端副本仍会保留。');
  });
  const toggleBackup = () => {
    if (status?.backup_enabled) Alert.alert('关闭备份后，副本怎么处理？', '手机里的资料都会保留。', [
      { text: '取消', style: 'cancel' }, { text: '停止备份，保留副本', onPress: () => { void stop(false); } },
      { text: '停止并删除云端副本', style: 'destructive', onPress: () => { void stop(true); } },
    ]);
    else if (!status?.recovery_ready) void beginRecovery();
    else Alert.alert('开启云端加密备份', '备份到当前后端：' + api.baseUrl + '。仅上传密文，恢复密钥由你保管。', [
      { text: '取消', style: 'cancel' }, { text: '验证并开启', onPress: () => { void enable(); } },
    ]);
  };
  const lookupLocal = async (text: string) => run(async () => {
    const items = records ?? await privateVault.summaries(scope);
    if (!alive.current || AppState.currentState !== 'active') return;
    setRecords(items); setLookup({ query: text, matches: findVaultRecords(text, items) }); setQuery('');
  });

  const renderRow = (item: VaultSummary) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={'查看私密资料：' + item.alias} onPress={() => openRecord(item)} disabled={busy} style={v.row}>
    <View style={v.typeIcon}><Icon name={kindIcon[item.type]} size={22} color={p.blue} /></View>
    <View style={v.flex}><Text style={v.rowTitle}>{item.alias}</Text><Text style={v.small}>{item.summary}</Text></View><Icon name="chevronRight" size={17} color={p.muted} />
  </Pressable>;
  const renderStorage = () => <>
    <Text style={v.title}>资料放在哪里，由你定</Text><Text style={v.subtitle}>手机始终保留一份，云端备份由你选择。</Text>
    <View style={v.card}><View style={v.inline}><View style={v.typeIcon}><Icon name="shield" color={p.blue} /></View><View style={v.flex}><Text style={v.rowTitle}>手机本地存储</Text><Text style={v.small}>加密保存 · 验证身份后取用</Text></View><Text style={v.green}>始终保留</Text></View></View>
    <View style={v.card}><View style={v.inline}><View style={v.typeIcon}><Icon name="server" color={p.blue} /></View><View style={v.flex}><Text style={v.rowTitle}>云端加密备份</Text><Text style={v.small}>{status?.backup_enabled ? '已开启 · 仅上传加密副本' : '已关闭 · 不上传新的资料'}</Text></View>
      <Switch accessibilityLabel="云端加密备份" value={!!status?.backup_enabled} onValueChange={toggleBackup} disabled={busy || !protectedReady || !status?.available} trackColor={{ false: '#D7DDEA', true: p.blue }} /></View>
      <View style={v.divider} /><Text style={v.small}>资料先在手机加密，再备份到 App 当前连接的后端。</Text>
      <View style={v.server}><Text style={v.small}>当前 App 后端 · 自动跟随</Text><Text style={v.rowTitle}>{preferences.instance?.name || '当前服务器'}</Text><Text style={v.url}>{api.baseUrl}</Text></View>
      <Text style={v.small}>{remote ? remote.envelope ? (status?.backup_enabled ? '当前后端保留了你的加密备份。' : '备份已停止，当前后端仍保留加密副本。') : '当前后端没有云端副本。' : '云端副本状态尚未确认。'}</Text>
      {!!remoteError && <Text accessibilityRole="alert" style={v.error}>{remoteError}</Text>}
      {status?.backup_enabled && <VaultButton label="立即备份" secondary disabled={busy} onPress={() => { void run(async () => { await syncSaved(); }); }} />}
    </View>
    <Text style={v.sectionTitle}>恢复与备份</Text>
    <VaultButton label="查看／保存恢复密钥" secondary disabled={busy} onPress={() => { void beginRecovery(); }} />
    <VaultButton label="使用恢复密钥恢复云端资料" secondary disabled={busy || !!records?.length} onPress={() => navigate('restore')} />
    {!!records?.length && <Text style={v.small}>恢复仅用于空资料库，已有本机资料不会被覆盖。</Text>}
    {remote?.envelope && <VaultButton label="删除当前后端的云端副本" secondary disabled={busy} onPress={() => Alert.alert('删除云端副本？', '将停止备份并删除当前后端的加密副本，手机资料完整保留。', [{ text: '取消', style: 'cancel' }, { text: '验证并删除', style: 'destructive', onPress: () => { void stop(true); } }])} />}
    <Text style={v.footnote}>恢复密钥由你保管；登录密码或短信验证码不能代替它恢复资料。</Text>
  </>;

  return <KeyboardAvoidingView style={v.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={v.header}><Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={goBack} disabled={busy} style={v.iconButton}><Icon name="back" color={p.ink} /></Pressable><Text style={v.headerTitle}>{page === 'storage' ? '存储与备份' : '私密资料'}</Text><Pressable accessibilityRole="button" accessibilityLabel="资料使用记录" onPress={() => navigate('history')} disabled={busy} style={v.iconButton}><Icon name="history" color={p.ink} /></Pressable></View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={v.content}>
      {page === 'vault' && <>
        <View style={v.inline}><Text style={[v.title, v.flex]}>重要的，都在这里</Text><Pressable accessibilityRole="button" accessibilityLabel="添加私密资料" onPress={chooseType} disabled={busy || !protectedReady} style={v.iconButton}><Icon name="plus" color={p.blue} /></Pressable></View>
        <Text style={v.subtitle}>记好每份资料，需要时一句话取用。</Text>
        <View style={v.tabs}><VaultButton label="我的资料" secondary disabled={busy} onPress={() => {}} /><VaultButton label="对话取用" secondary disabled={busy} onPress={() => navigate('chat')} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="存储与备份" disabled={busy} onPress={() => navigate('storage')} style={v.storageEntry}><Icon name="shield" size={16} color={p.green} /><Text style={[v.green, v.flex]}>{status?.backup_enabled ? '本机保存 · 云端加密备份' : '本机加密保存'}</Text><Text style={v.link}>存储与备份 ›</Text></Pressable>
        {records === null ? <View style={v.card}><Text style={v.rowTitle}>你的资料已锁定</Text><Text style={v.subtitle}>使用系统指纹或锁屏密码，打开你的资料列表。</Text><VaultButton label="验证并打开资料库" disabled={busy || !protectedReady} onPress={() => { void list(); }} /></View> : records.length ? records.map(renderRow) : <View style={v.card}><Text style={v.rowTitle}>把重要资料，安心放好</Text><Text style={v.subtitle}>先添加家庭地址、银行卡或身份证。</Text><VaultButton label="添加第一份资料" onPress={chooseType} disabled={busy} /></View>}
        <Text style={v.footnote}>完整内容不进入普通记忆、模型上下文或向量检索。</Text>
      </>}
      {page === 'storage' && renderStorage()}
      {page === 'detail' && selected && <>
        <Text style={v.title}>{selected.alias}</Text><Text style={v.subtitle}>{selected.summary}</Text>
        <View style={v.card}>{vaultFields[selected.type].map(field => <View key={field.key} style={v.field}><Text style={v.small}>{field.label}</Text><Text style={v.value}>{revealed?.fields[field.key] || (field.key === 'number' ? selected.summary.replace(/^.*尾号 /, '•••• •••• ') : '••••')}</Text></View>)}</View>
        <Text style={v.small}>{revealed ? '完整资料将在 30 秒后隐藏，离开页面立即隐藏。' : '完整内容仅在本机解锁显示。'}</Text>
        <VaultButton label={revealed ? '隐藏完整资料' : '验证并查看完整资料'} onPress={() => { if (revealed) setRevealed(null); else { void reveal(false); } }} disabled={busy} />
        <VaultButton label={selected.type === 'address' ? '复制完整地址' : '复制完整号码'} secondary onPress={() => { void copy(selected); }} disabled={busy} />
        <VaultButton label="分享资料，由我选择接收人" secondary onPress={() => share(selected)} disabled={busy} />
        <View style={v.tabs}><VaultButton label="编辑资料" secondary onPress={() => { void reveal(true); }} disabled={busy} /><VaultButton label="删除资料" danger onPress={remove} disabled={busy} /></View>
      </>}
      {page === 'edit' && draft && <>
        <Text style={v.title}>{draft.id ? '编辑' : '添加'}{vaultKindLabels[draft.type]}</Text><Text style={v.subtitle}>内容只在本机加密保存。保存时需要验证身份。</Text>
        <View style={v.card}><Text style={v.small}>资料名称</Text><TextInput accessibilityLabel="资料名称" value={draft.alias} editable={!busy} maxLength={36} autoCorrect={false} style={v.input} onChangeText={alias => { setDraft({ ...draft, alias }); armLock(); }} />
          {vaultFields[draft.type].map(field => <View key={field.key}><Text style={v.small}>{field.label}{field.required ? ' *' : ''}</Text><TextInput accessibilityLabel={field.label} value={draft.fields[field.key] || ''} editable={!busy} autoCorrect={false} autoComplete="off" importantForAutofill="no" maxLength={field.key === 'address' ? 500 : 120} multiline={field.key === 'address'} style={[v.input, field.key === 'address' && v.multiline]} onChangeText={value => { setDraft({ ...draft, fields: { ...draft.fields, [field.key]: value } }); armLock(); }} /></View>)}</View>
        <VaultButton label="验证并加密保存" onPress={() => { void save(); }} disabled={busy} />
      </>}
      {page === 'chat' && <>
        <Text style={v.title}>需要哪份资料？</Text><Text style={v.subtitle}>本机资料查找，完整内容不会发送给模型。</Text>
        {lookup && <><View style={v.userQuery}><Text style={v.value}>{lookup.query}</Text></View><Text style={v.subtitle}>{lookup.matches.length > 1 ? '找到了多份资料，请选择要使用的那份。' : lookup.matches.length ? '找到这份资料，解锁后即可使用。' : '没有找到匹配资料。你可以先添加，或换一个资料名称。'}</Text>{lookup.matches.map(renderRow)}</>}
        <View style={v.card}><TextInput accessibilityLabel="要查找的私密资料" placeholder="例如：我的工资卡号是多少？" value={query} onChangeText={value => { setQuery(value); armLock(); }} maxLength={100} editable={!busy} autoCorrect={false} style={v.input} onSubmitEditing={() => { if (query.trim()) void lookupLocal(query); }} /><VaultButton label="在本机查找" disabled={busy || !query.trim()} onPress={() => { void lookupLocal(query); }} /></View>
        {['我的银行卡号', '我的家庭地址', '我的身份证'].map(text => <VaultButton key={text} label={text} secondary disabled={busy} onPress={() => { void lookupLocal(text); }} />)}
      </>}
      {page === 'recovery' && <>
        <Text style={v.title}>保管好你的恢复密钥</Text><Text style={v.subtitle}>换手机时，用它解开云端加密备份。请存放到你自己控制的安全位置。</Text>
        <View style={v.keyCard}><Text style={v.recoveryKey}>{recovery || '密钥已隐藏，请返回后重新验证。'}</Text></View>
        <VaultButton label="验证并复制恢复密钥" secondary disabled={busy || !recovery} onPress={() => { void run(async () => { await privateVault.copyRecovery(scope); if (alive.current) setNotice('恢复密钥已复制，请妥善保管。'); }); }} />
        <Pressable accessibilityRole="checkbox" accessibilityLabel="我已保存恢复密钥" accessibilityState={{ checked: acknowledged }} onPress={() => { setAcknowledged(!acknowledged); armLock(); }} style={v.check} disabled={busy || !recovery}><Icon name={acknowledged ? 'check' : 'file'} size={20} color={p.blue} /><Text style={[v.value, v.flex]}>我已保存恢复密钥，理解丢失后可能无法恢复。</Text></Pressable>
        <Text style={v.small}>备份到当前 App 后端：{api.baseUrl}</Text><VaultButton label="验证并开启加密备份" disabled={busy || !acknowledged || !recovery} onPress={() => { void enable(); }} />
      </>}
      {page === 'restore' && <>
        <Text style={v.title}>恢复你的私密资料</Text><Text style={v.subtitle}>从当前 App 后端读取密文，在这台手机解密。不会把恢复密钥上传到服务器。</Text>
        <View style={v.card}><Text style={v.small}>恢复密钥</Text><TextInput accessibilityLabel="恢复密钥" value={recoveryInput} onChangeText={value => { setRecoveryInput(value); armLock(); }} secureTextEntry autoCorrect={false} autoComplete="off" importantForAutofill="no" editable={!busy} maxLength={100} style={v.input} /></View>
        <VaultButton label="验证并恢复到手机" disabled={busy || !recoveryInput.trim()} onPress={() => { void run(async () => { const items = await cloud.restore(recoveryInput); if (!alive.current) return; clearSecrets(); setRecords(items); setPage('vault'); setNotice('已恢复到手机，云端备份保持关闭，由你决定是否开启。'); }); }} />
      </>}
      {page === 'history' && <><Text style={v.title}>资料使用记录</Text><Text style={v.subtitle}>只记录操作与资料名称，不记录完整号码。本页记录仅保留到退出当前资料页面。</Text>{history.length ? history.map((item, index) => <View key={index} style={v.field}><Text style={v.value}>{item.action} · {item.alias}</Text><Text style={v.small}>{item.at}</Text></View>) : <Text style={v.footnote}>还没有使用记录。</Text>}</>}
      {!!error && <Text accessibilityRole="alert" style={v.error}>{error}</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={v.notice}>{notice}</Text>}
      {!status?.available && status && <Text style={v.error}>请先启用系统锁屏密码或指纹，资料库不会退回明文存储。</Text>}
      {busy && <View accessibilityLiveRegion="polite" style={v.inline}><ActivityIndicator color={p.blue} /><Text style={v.small}>请完成系统验证或等待操作结束…</Text></View>}
    </ScrollView>
  </KeyboardAvoidingView>;
}

const v = StyleSheet.create({
  fill: { flex: 1 }, flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 22, paddingTop: 10, paddingBottom: 9 },
  headerTitle: { fontSize: 17, color: p.ink, fontWeight: '500' },
  iconButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: '#FFFFFFBB' },
  content: { paddingHorizontal: 22, paddingTop: 17, paddingBottom: 36, gap: 13 },
  title: { fontSize: 27, lineHeight: 37, fontWeight: '600', color: p.ink },
  subtitle: { fontSize: 14, lineHeight: 23, color: p.muted },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  card: { backgroundColor: p.white, borderRadius: 23, padding: 18, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: p.white, borderRadius: 22, padding: 18, gap: 12, minHeight: 91 },
  typeIcon: { backgroundColor: p.pale, width: 44, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 16, lineHeight: 24, color: p.ink, fontWeight: '500' },
  small: { fontSize: 12, lineHeight: 20, color: p.muted },
  green: { color: p.green, fontSize: 12, lineHeight: 20 },
  tabs: { flexDirection: 'row', gap: 9 },
  storageEntry: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, flexWrap: 'wrap' },
  link: { color: p.blue, fontSize: 12 },
  button: { backgroundColor: p.blue, minHeight: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center', paddingVertical: 11, paddingHorizontal: 14, flexShrink: 1 },
  buttonText: { fontSize: 14, lineHeight: 22, color: p.white, fontWeight: '500', textAlign: 'center' },
  secondaryButton: { backgroundColor: p.pale }, secondaryText: { color: p.blue }, dangerButton: { backgroundColor: p.red },
  disabled: { opacity: 0.45 }, pressed: { opacity: 0.75 },
  divider: { height: 1, backgroundColor: p.line, marginVertical: 1 },
  server: { gap: 3, paddingVertical: 2 }, url: { fontSize: 12, lineHeight: 19, color: p.muted },
  sectionTitle: { fontSize: 15, lineHeight: 23, color: p.ink, fontWeight: '500', marginTop: 10 },
  footnote: { color: p.muted, fontSize: 12, lineHeight: 21, marginVertical: 7, textAlign: 'center' },
  error: { color: p.red, fontSize: 13, lineHeight: 22, backgroundColor: '#FCECF0', padding: 13, borderRadius: 14 },
  notice: { color: p.blue, fontSize: 13, lineHeight: 22, padding: 13, backgroundColor: p.pale, borderRadius: 14 },
  field: { borderBottomColor: p.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 6 },
  value: { color: p.ink, fontSize: 15, lineHeight: 25 },
  input: { color: p.ink, fontSize: 16, minHeight: 47, borderWidth: 1, borderColor: p.line, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: p.white, marginTop: 6, marginBottom: 12 },
  multiline: { minHeight: 90, textAlignVertical: 'top' },
  userQuery: { alignSelf: 'flex-end', maxWidth: '90%', backgroundColor: '#E3EAFA', borderRadius: 19, padding: 14 },
  keyCard: { backgroundColor: p.pale, borderRadius: 19, padding: 18 },
  recoveryKey: { color: p.blue, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 17, lineHeight: 29 },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44, paddingVertical: 9 },
});

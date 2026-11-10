/* eslint no-void: ["error", { "allowAsStatement": true }] */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useApp } from '../../app/context';
import { errorMessage } from '../../api/client';
import { findVaultRecords, validateVaultRecord, vaultFields, vaultKindLabels, vaultOwner, type VaultCloudState, type VaultKind, type VaultRecord, type VaultStatus, type VaultSummary } from '../../domain/privateVault';
import { privateVault } from '../../platform/privateVault';
import { Text } from '../../ui/Text';
import { Icon, type IconName } from '../../ui/visuals';
import { VaultCloud } from './cloud';

const p = { ink: '#30384B', muted: '#748096', blue: '#4D71C8', pale: '#EDF2FF', white: '#FFFFFF', line: '#E7ECF5', green: '#3B8274', red: '#B45164' };
const kindIcon: Partial<Record<VaultKind, IconName>> = { address: 'mapPin', bank: 'file', identity: 'shield' };
const revealDuration = 30;
type Page = 'opening' | 'welcome' | 'restored' | 'vault' | 'chat' | 'storage' | 'detail' | 'edit' | 'choose' | 'recovery' | 'restore' | 'history';
let nextOwner = 0;

export function PrivateVaultScreen() {
  const app = useApp();
  const userId = app.user?.id;
  const owner = useMemo(() => ({ id: ++nextOwner, scope: userId ? vaultOwner(app.api.baseUrl, app.preferences.instance?.id, userId) : '' }),
    [app.api, userId, app.preferences.instance?.id]);
  return app.user ? <VaultSession key={owner.id} scope={owner.scope} /> : null;
}

function VaultButton({ label, onPress, secondary = false, disabled = false }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [v.button, secondary && v.secondaryButton, disabled && v.disabled, pressed && v.pressed]}>
    <Text style={[v.buttonText, secondary && v.secondaryText]}>{label}</Text>
  </Pressable>;
}

function DetailAction({ label, icon, onPress, disabled, primary }: { label: string; icon: IconName; onPress: () => void; disabled: boolean; primary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
    style={({ pressed }) => [v.button, v.detailAction, !primary && v.secondaryButton, disabled && v.disabled, pressed && v.pressed]}>
    <Icon name={icon} size={17} color={primary ? p.white : p.blue} />
    <Text style={[v.buttonText, v.detailActionLabel, !primary && v.secondaryText]}>{label}</Text>
  </Pressable>;
}

function VaultSession({ scope }: { scope: string }) {
  const { api, preferences, back } = useApp();
  const cloud = useMemo(() => new VaultCloud(api, scope), [api, scope]);
  const [page, setPage] = useState<Page>('opening');
  const [records, setRecords] = useState<VaultSummary[] | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [remote, setRemote] = useState<VaultCloudState | null>(null);
  const [remoteError, setRemoteError] = useState('');
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [selected, setSelected] = useState<VaultSummary | null>(null);
  const [revealed, setRevealed] = useState<VaultRecord | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(revealDuration);
  const [detailSheet, setDetailSheet] = useState<'menu' | 'share' | null>(null);
  const [shareContact, setShareContact] = useState(false);
  const [draft, setDraft] = useState<VaultRecord | null>(null);
  const [recovery, setRecovery] = useState('');
  const [recoveryInput, setRecoveryInput] = useState('');
  const [showRecoveryInput, setShowRecoveryInput] = useState(false);
  const [restorePhase, setRestorePhase] = useState<'fetching' | 'decrypting' | null>(null);
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
  const lockAt = useRef(0);
  const currentPage = useRef(page); currentPage.current = page;
  const restoreReturnPage = useRef<Page>('storage');
  const historyReturnPage = useRef<Page>('vault');
  const localExists = useRef(false);
  const remoteRead = useRef(0);
  const backAction = useRef<() => void>(() => {});
  const restoreAbort = useRef<AbortController | null>(null);
  const currentRestorePhase = useRef<'fetching' | 'decrypting' | null>(null);
  const clearSecrets = () => {
    setRevealed(null); setDraft(null); setRecovery(''); setRecoveryInput(''); setAcknowledged(false);
    setQuery(''); setLookup(null);
    setShowRecoveryInput(false);
    setDetailSheet(null); setShareContact(false);
  };
  const armLock = () => {
    if (timeout.current) clearTimeout(timeout.current);
    lockAt.current = Date.now() + revealDuration * 1000;
    timeout.current = setTimeout(() => {
      timeout.current = null;
      if (!alive.current) return;
      clearSecrets();
      if (['edit', 'recovery', 'restore'].includes(currentPage.current)) setPage('vault');
      setNotice('完整资料已自动隐藏，请重新验证后使用。');
    }, revealDuration * 1000);
  };
  useEffect(() => {
    if (!revealed || page !== 'detail') return;
    const interval = setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((lockAt.current - Date.now()) / 1000))), 1000);
    return () => clearInterval(interval);
  }, [page, revealed]);
  const refresh = async () => {
    const next = await privateVault.status(scope);
    if (alive.current) { localExists.current = next.exists; setStatus(next); }
    return next;
  };
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        await privateVault.protect(scope, true);
        if (!alive.current) return;
        setProtectedReady(true);
        const initial = await refresh();
        if (alive.current) setPage(initial.exists ? 'vault' : 'welcome');
      } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    })();
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        clearSecrets(); setRecords(null); setLookup(null);
        if (['edit', 'recovery', 'restore'].includes(currentPage.current) &&
          !(currentPage.current === 'restore' && operation.current)) setPage(localExists.current ? 'vault' : 'welcome');
      }
    });
    const hardwareBack = BackHandler.addEventListener('hardwareBackPress', () => { backAction.current(); return true; });
    return () => {
      alive.current = false; listener.remove(); hardwareBack.remove(); cloud.dispose();
      restoreAbort.current?.abort();
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
  const inspectCloud = () => {
    const ticket = ++remoteRead.current;
    setRemote(null); setRemoteError(''); setRemoteLoading(true);
    void cloud.read().then(value => {
      if (alive.current && ticket === remoteRead.current) setRemote(value);
    }).catch(failure => {
      if (alive.current && ticket === remoteRead.current) setRemoteError(errorMessage(failure));
    }).finally(() => {
      if (alive.current && ticket === remoteRead.current) setRemoteLoading(false);
    });
  };
  const navigate = (next: Page) => {
    if (busy) return;
    clearSecrets(); setPage(next); setError(''); setNotice('');
    if (timeout.current) clearTimeout(timeout.current);
    if (next === 'storage' || next === 'restore') inspectCloud();
    else { remoteRead.current++; setRemoteLoading(false); }
  };
  const goBack = () => {
    if (busy) return;
    if (page === 'vault' || page === 'welcome' || page === 'opening') back();
    else if (page === 'restore') navigate(restoreReturnPage.current);
    else if (page === 'history' && historyReturnPage.current === 'detail' && selected) navigate('detail');
    else navigate(page === 'recovery' ? 'storage' : localExists.current ? 'vault' : 'welcome');
  };
  backAction.current = goBack;
  const openHistory = () => { historyReturnPage.current = page; navigate('history'); };
  const openRecord = (item: VaultSummary) => { setSelected(item); navigate('detail'); };
  const list = () => run(async () => {
    const items = await privateVault.summaries(scope);
    if (alive.current && AppState.currentState === 'active') setRecords(items);
  });
  const createVault = () => run(async () => {
    const items = await privateVault.summaries(scope);
    if (!alive.current) return;
    localExists.current = true;
    clearSecrets(); setRecords(items); setPage('vault');
    setNotice(items.length ? '已打开这台手机上的资料库。' : '新的资料库已在本机加密创建，云端备份默认关闭。');
  });
  const beginRestore = (returnTo: Page) => {
    if (busy) return;
    if (records?.length) {
      Alert.alert('先保留好本机资料', '恢复不会直接覆盖现有资料。请先迁移或处理本机已有资料。');
      return;
    }
    restoreReturnPage.current = returnTo;
    navigate('restore');
  };
  const restore = () => run(async () => {
    if (!recoveryInput.trim() || !remote?.envelope) return;
    const key = recoveryInput.trim();
    if (timeout.current) { clearTimeout(timeout.current); timeout.current = null; }
    const controller = new AbortController(); restoreAbort.current = controller;
    currentRestorePhase.current = 'fetching';
    setRecoveryInput(''); setShowRecoveryInput(false); setRestorePhase('fetching');
    try {
      const items = await cloud.restore(key, phase => {
        if (alive.current) { currentRestorePhase.current = phase; setRestorePhase(phase); }
      }, controller.signal);
      if (!alive.current) return;
      if (timeout.current) clearTimeout(timeout.current);
      localExists.current = true;
      setStatus(previous => previous ? { ...previous, exists: true, backup_enabled: false, recovery_ready: true } : previous);
      clearSecrets(); setRecords(items); setPage('restored');
      recordUse('恢复资料', '私密资料库');
    } catch (failure) {
      if (controller.signal.aborted) { if (alive.current) setNotice('已取消读取备份，未开始本机恢复。'); }
      else throw failure;
    } finally {
      if (restoreAbort.current === controller) restoreAbort.current = null;
      currentRestorePhase.current = null;
      if (alive.current) setRestorePhase(null);
    }
  });
  const cancelRestore = () => {
    if (currentRestorePhase.current === 'fetching') restoreAbort.current?.abort();
  };
  const recoveryHelp = () => Alert.alert('找不到恢复密钥？',
    '旧手机还在：打开旧手机的「私密资料 → 存储与备份 → 查看／保存恢复密钥」。\n\n旧手机无法使用：请查找自己保存的密钥。没有恢复密钥就无法解密；重置登录密码或短信验证码也不能代替它。');
  const reveal = (edit: boolean) => selected && run(async () => {
    const value = await privateVault.reveal(scope, selected.id);
    if (!alive.current || AppState.currentState !== 'active') return;
    if (edit) { clearSecrets(); setDraft(value); setPage('edit'); }
    else { setSecondsLeft(revealDuration); setRevealed(value); }
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
    const label = item.type === 'address' ? '地址' : item.type === 'email' ? '邮箱地址' : '号码';
    recordUse('复制资料', item.alias); setNotice(`已复制${label}，将在约 30 秒后尝试清空剪贴板。`);
  });
  const openShare = (item: VaultSummary, includeContact: boolean) => run(async () => {
    await privateVault.share(scope, item.id, includeContact);
    recordUse('打开资料分享', item.alias);
  });
  const hideDetails = () => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    clearSecrets(); setNotice('');
  };
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
  const chooseType = () => navigate('choose');
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
    <View style={v.typeIcon}><Icon name={kindIcon[item.type] ?? 'file'} size={22} color={p.blue} /></View>
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
    <VaultButton label="使用恢复密钥恢复云端资料" secondary disabled={busy || !!records?.length} onPress={() => beginRestore('storage')} />
    {!!records?.length && <Text style={v.small}>恢复仅用于空资料库，已有本机资料不会被覆盖。</Text>}
    {remote?.envelope && <VaultButton label="删除当前后端的云端副本" secondary disabled={busy} onPress={() => Alert.alert('删除云端副本？', '将停止备份并删除当前后端的加密副本，手机资料完整保留。', [{ text: '取消', style: 'cancel' }, { text: '验证并删除', style: 'destructive', onPress: () => { void stop(true); } }])} />}
    <Text style={v.footnote}>恢复密钥由你保管；登录密码或短信验证码不能代替它恢复资料。</Text>
  </>;

  return <KeyboardAvoidingView style={v.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={v.header}><Pressable accessibilityRole="button" accessibilityLabel="返回上一页" onPress={goBack} disabled={busy} style={v.iconButton}><Icon name="back" color={p.ink} /></Pressable><Text style={v.headerTitle}>{page === 'storage' ? '存储与备份' : '私密资料'}</Text>
      {page === 'detail' ? <Pressable accessibilityRole="button" accessibilityLabel="更多资料操作" onPress={() => setDetailSheet('menu')} disabled={busy} style={v.iconButton}><Icon name="more" color={p.ink} /></Pressable>
        : <Pressable accessibilityRole="button" accessibilityLabel="资料使用记录" onPress={openHistory} disabled={busy} style={v.iconButton}><Icon name="history" color={p.ink} /></Pressable>}
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={v.content}>
      {page === 'opening' && <View style={v.onboardingHero}>{error ? <Text style={v.rowTitle}>资料库暂时无法打开</Text> : <ActivityIndicator color={p.blue} />}<Text style={v.subtitle}>{error ? '请确认当前版本支持设备安全资料库。' : '正在检查这台手机上的资料库…'}</Text></View>}
      {page === 'welcome' && <>
        <Text style={v.small}>第一次在这台手机打开</Text>
        <View style={v.onboardingHeroIcon}><Icon name="shield" size={41} color={p.blue} /></View>
        <Text style={v.title}>重要资料，接着用</Text>
        <Text style={v.subtitle}>有过加密备份？用恢复密钥找回来。{ '\n' }也可以从这台手机，开始安心记录。</Text>
        <VaultButton label="恢复已有资料" disabled={busy || !protectedReady || !status?.available} onPress={() => beginRestore('welcome')} />
        <VaultButton label="创建新的资料库" secondary disabled={busy || !protectedReady || !status?.available} onPress={() => { void createVault(); }} />
        <View style={v.card}><Text style={v.small}>当前 App 后端 · 自动跟随</Text><Text style={v.rowTitle}>{preferences.instance?.name || '当前服务器'}</Text><Text style={v.url}>{api.baseUrl}</Text><Text style={v.small}>请使用备份时的账号和后端。</Text></View>
        <Text style={v.footnote}>创建新资料库不会自动覆盖已有云端备份。</Text>
      </>}
      {page === 'vault' && <>
        <View style={v.inline}><Text style={[v.title, v.flex]}>重要的，都在这里</Text><Pressable accessibilityRole="button" accessibilityLabel="添加私密资料" onPress={chooseType} disabled={busy || !protectedReady} style={v.iconButton}><Icon name="plus" color={p.blue} /></Pressable></View>
        <Text style={v.subtitle}>记好每份资料，需要时一句话取用。</Text>
        <View style={v.tabs}><VaultButton label="我的资料" secondary disabled={busy} onPress={() => {}} /><VaultButton label="对话取用" secondary disabled={busy} onPress={() => navigate('chat')} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="存储与备份" disabled={busy} onPress={() => navigate('storage')} style={v.storageEntry}><Icon name="shield" size={16} color={p.green} /><Text style={[v.green, v.flex]}>{status?.backup_enabled ? '本机保存 · 云端加密备份' : '本机加密保存'}</Text><Text style={v.link}>存储与备份 ›</Text></Pressable>
        {records === null ? <View style={v.card}><Text style={v.rowTitle}>你的资料已锁定</Text><Text style={v.subtitle}>使用系统指纹或锁屏密码，打开你的资料列表。</Text><VaultButton label="验证并打开资料库" disabled={busy || !protectedReady} onPress={() => { void list(); }} /></View> : records.length ? records.map(renderRow) : <View style={v.card}><Text style={v.rowTitle}>把重要资料，安心放好</Text><Text style={v.subtitle}>先添加家庭地址、银行卡或身份证。</Text><VaultButton label="添加第一份资料" onPress={chooseType} disabled={busy} /><VaultButton label="恢复已有资料" secondary disabled={busy} onPress={() => beginRestore('vault')} /></View>}
        <Text style={v.footnote}>完整内容不进入普通记忆、模型上下文或向量检索。</Text>
      </>}
      {page === 'storage' && renderStorage()}
      {page === 'choose' && <>
        <Text style={v.title}>添加哪种资料？</Text><Text style={v.subtitle}>完整内容只在本机加密资料库中保存。</Text>
        <View style={v.card}>{(Object.keys(vaultKindLabels) as VaultKind[]).map(type => (
          <Pressable key={type} accessibilityRole="button" accessibilityLabel={vaultKindLabels[type]} onPress={() => newRecord(type)} disabled={busy || !status?.available} style={v.row}>
            <View style={v.typeIcon}><Icon name={kindIcon[type] ?? 'file'} size={22} color={p.blue} /></View>
            <Text style={[v.rowTitle, v.flex]}>{vaultKindLabels[type]}</Text><Icon name="chevronRight" size={17} color={p.muted} />
          </Pressable>
        ))}</View>
      </>}
      {page === 'detail' && selected && <>
        <View style={v.detailHero}>
          <View style={v.detailIcon}><Icon name={kindIcon[selected.type] ?? 'file'} size={26} color={p.blue} /></View>
          <View style={v.flex}><Text style={v.detailTitle}>{selected.alias}</Text><Text style={v.subtitle}>{selected.type === 'address' ? '收件资料' : vaultKindLabels[selected.type]}</Text></View>
        </View>
        <View style={v.detailCard}>
          <View style={v.detailCardHeader}>
            <Text style={[v.small, v.flex]}>{selected.type === 'address' ? '收件地址' : vaultFields[selected.type].find(field => field.key === 'number')?.label}</Text>
            <View style={[v.detailStatus, revealed && v.detailStatusOpen]}>
              <Icon name={revealed ? 'clock' : 'lock'} size={13} color={revealed ? p.green : p.muted} />
              <Text style={[v.detailStatusText, revealed && v.detailStatusTextOpen]}>{revealed ? `显示中 00:${String(secondsLeft).padStart(2, '0')}` : '已隐藏'}</Text>
            </View>
            {!!revealed && <Pressable accessibilityRole="button" accessibilityLabel="立即隐藏资料" onPress={hideDetails} style={v.detailHide}><Icon name="eyeOff" size={19} color={p.muted} /></Pressable>}
          </View>
          <Text style={v.detailValue}>{selected.type === 'address'
            ? (revealed?.fields.address || '•••• ••••')
            : (revealed?.fields.number || selected.summary.replace(/^.*尾号 /, '•••• •••• '))}</Text>
          {!revealed && selected.type === 'address' && <Text style={v.small}>完整收件地址已隐藏</Text>}
          <View style={v.divider} />
          <View style={v.detailFields}>
            {vaultFields[selected.type].filter(field => field.key !== 'address' && field.key !== 'number').map(field => <View key={field.key} style={v.detailField}>
              <Text style={v.small}>{field.label}</Text><Text style={v.detailFieldValue}>{revealed ? (revealed.fields[field.key] || '未填写') : '••••'}</Text>
            </View>)}
          </View>
        </View>
        <View style={v.tabs}>
          {revealed ? <>
            <DetailAction label={selected.type === 'address' ? '复制地址' : selected.type === 'email' ? '复制邮箱地址' : '复制号码'} icon="copy" disabled={busy} onPress={() => { void copy(selected); }} />
            <DetailAction label="分享资料" icon="share" disabled={busy} onPress={() => { setShareContact(false); setDetailSheet('share'); }} />
          </> : <DetailAction label="查看完整资料" icon="eye" primary disabled={busy} onPress={() => { void reveal(false); }} />}
        </View>
        <View style={v.detailPrivacy}><Icon name="shield" size={14} color={p.muted} /><Text style={v.small}>{revealed ? '离开页面即隐藏' : '需验证身份 · 解锁后显示 30 秒'}</Text></View>
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
        {['我的手机号', '我的银行卡号', '我的家庭地址', '我的身份证'].map(text => <VaultButton key={text} label={text} secondary disabled={busy} onPress={() => { void lookupLocal(text); }} />)}
      </>}
      {page === 'recovery' && <>
        <Text style={v.title}>保管好你的恢复密钥</Text><Text style={v.subtitle}>换手机时，用它解开云端加密备份。请存放到你自己控制的安全位置。</Text>
        <View style={v.keyCard}><Text style={v.recoveryKey}>{recovery || '密钥已隐藏，请返回后重新验证。'}</Text></View>
        <VaultButton label="验证并复制恢复密钥" secondary disabled={busy || !recovery} onPress={() => { void run(async () => { await privateVault.copyRecovery(scope); if (alive.current) setNotice('恢复密钥已复制，请妥善保管。'); }); }} />
        <Pressable accessibilityRole="checkbox" accessibilityLabel="我已保存恢复密钥" accessibilityState={{ checked: acknowledged }} onPress={() => { setAcknowledged(!acknowledged); armLock(); }} style={v.check} disabled={busy || !recovery}><Icon name={acknowledged ? 'check' : 'file'} size={20} color={p.blue} /><Text style={[v.value, v.flex]}>我已保存恢复密钥，理解丢失后可能无法恢复。</Text></Pressable>
        <Text style={v.small}>备份到当前 App 后端：{api.baseUrl}</Text><VaultButton label="验证并开启加密备份" disabled={busy || !acknowledged || !recovery} onPress={() => { void enable(); }} />
      </>}
      {page === 'restore' && <>
        <Text style={v.title}>找回你的私密资料</Text><Text style={v.subtitle}>从当前登录的后端取回加密备份，用你保管的密钥在手机解密。</Text>
        <View style={v.card}><View style={v.inline}><Icon name="server" color={p.blue} /><View style={v.flex}><Text style={v.rowTitle}>{remoteLoading ? '正在查找加密备份…' : remote?.envelope ? '已找到加密备份' : remote ? '当前后端没有加密备份' : '暂时无法确认备份状态'}</Text>{remote?.updated_at ? <Text style={v.small}>上次更新：{new Date(remote.updated_at * 1000).toLocaleString('zh-CN')}</Text> : null}</View></View><Text style={v.small}>当前 App 后端 · {preferences.instance?.name || '当前服务器'}</Text><Text style={v.url}>{api.baseUrl}</Text>{remote && !remote.envelope && <Text style={v.small}>请确认使用的是备份时的账号和后端；只有密钥、没有加密副本，无法恢复资料。</Text>}{!!remoteError && <Text accessibilityRole="alert" style={v.error}>{remoteError}</Text>}{!remoteLoading && !remote?.envelope && <VaultButton label="重新查找备份" secondary disabled={busy} onPress={inspectCloud} />}</View>
        <View style={v.card}><Text style={v.small}>恢复密钥</Text><TextInput accessibilityLabel="恢复密钥" value={recoveryInput} onChangeText={value => { setRecoveryInput(value); armLock(); }} secureTextEntry={!showRecoveryInput} autoCorrect={false} autoComplete="off" importantForAutofill="no" editable={!busy} maxLength={256} placeholder="粘贴或输入恢复密钥" style={v.input} />
          <View style={v.inline}><VaultButton label={showRecoveryInput ? '隐藏密钥' : '显示密钥'} secondary disabled={busy || !recoveryInput} onPress={() => setShowRecoveryInput(!showRecoveryInput)} /><VaultButton label="找不到恢复密钥？" secondary disabled={busy} onPress={recoveryHelp} /></View></View>
        <Text style={v.small}>恢复密钥只在这台手机使用，不会上传给服务器或 AI 模型。</Text>
        <VaultButton label="验证并恢复到手机" disabled={busy || !recoveryInput.trim() || remoteLoading || !remote?.envelope} onPress={() => { void restore(); }} />
        {!!restorePhase && <Text accessibilityLiveRegion="polite" style={v.notice}>{restorePhase === 'fetching' ? '正在获取加密备份…' : '正在等待系统验证，并在这台手机上解密…'}</Text>}
        {restorePhase === 'fetching' && <VaultButton label="取消读取备份" secondary onPress={cancelRestore} />}
        {restorePhase === 'decrypting' && <Text style={v.small}>需要取消时，可使用系统身份验证弹窗里的取消按钮。</Text>}
      </>}
      {page === 'restored' && <>
        <View style={[v.onboardingHeroIcon, v.successIcon]}><Icon name="check" size={40} color={p.green} /></View><Text style={v.title}>都回来了。</Text><Text style={v.subtitle}>{records?.length ?? 0} 份资料已恢复并加密保存在本机。{ '\n' }完整内容仍需要你解锁后查看。</Text>
        {records?.map(renderRow)}
        <View style={v.card}><View style={v.inline}><View style={v.flex}><Text style={v.rowTitle}>云端加密备份</Text><Text style={v.small}>{status?.backup_enabled ? '已开启 · 使用当前 App 后端' : '恢复后默认关闭，由你决定是否开启'}</Text></View><Switch accessibilityLabel="云端加密备份" value={!!status?.backup_enabled} onValueChange={toggleBackup} disabled={busy} trackColor={{ false: '#D7DDEA', true: p.blue }} /></View></View>
        <VaultButton label="进入我的资料" disabled={busy} onPress={() => navigate('vault')} /><Text style={v.footnote}>恢复密钥已从输入框清除。</Text>
      </>}
      {page === 'history' && <><Text style={v.title}>资料使用记录</Text><Text style={v.subtitle}>只记录操作与资料名称，不记录完整号码。本页记录仅保留到退出当前资料页面。</Text>{history.length ? history.map((item, index) => <View key={index} style={v.field}><Text style={v.value}>{item.action} · {item.alias}</Text><Text style={v.small}>{item.at}</Text></View>) : <Text style={v.footnote}>还没有使用记录。</Text>}</>}
      {!!error && <Text accessibilityRole="alert" style={v.error}>{error}</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={v.notice}>{notice}</Text>}
      {!status?.available && status && <Text style={v.error}>请先启用系统锁屏密码或指纹，资料库不会退回明文存储。</Text>}
      {busy && <View accessibilityLiveRegion="polite" style={v.inline}><ActivityIndicator color={p.blue} /><Text style={v.small}>请完成系统验证或等待操作结束…</Text></View>}
    </ScrollView>
    {page === 'detail' && selected && detailSheet && <Modal transparent animationType="fade" onRequestClose={() => setDetailSheet(null)}>
      <View style={v.detailOverlay}>
        <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={() => setDetailSheet(null)} />
        <View accessibilityViewIsModal style={v.detailPanel}>
          <View style={v.inline}><Text style={[v.detailPanelTitle, v.flex]}>{detailSheet === 'menu' ? '资料操作' : '分享资料'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭资料操作" onPress={() => setDetailSheet(null)} style={v.detailHide}><Icon name="close" size={20} color={p.muted} /></Pressable>
          </View>
          {detailSheet === 'menu' ? <>
            <Pressable accessibilityRole="button" accessibilityLabel="编辑资料" style={v.detailMenuRow} onPress={() => { setDetailSheet(null); void reveal(true); }}><Icon name="edit" size={18} color={p.blue} /><Text style={v.value}>编辑资料</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="查看使用记录" style={v.detailMenuRow} onPress={openHistory}><Icon name="history" size={18} color={p.blue} /><Text style={v.value}>查看使用记录</Text></Pressable>
            <View style={v.divider} />
            <Pressable accessibilityRole="button" accessibilityLabel="删除资料" style={v.detailMenuRow} onPress={() => { setDetailSheet(null); remove(); }}><Icon name="delete" size={18} color={p.red} /><Text style={[v.value, v.detailDelete]}>删除资料</Text></Pressable>
          </> : <>
            <Text style={v.subtitle}>{selected.type === 'address' ? '默认只分享收件地址。' : '将分享' + vaultFields[selected.type].map(field => field.label).join('、') + '。'}</Text>
            {selected.type === 'address' && <Pressable accessibilityRole="checkbox" accessibilityLabel="同时分享收件人和电话" accessibilityState={{ checked: shareContact }}
              onPress={() => setShareContact(!shareContact)} style={v.detailMenuRow}>
              <View style={[v.detailCheckbox, shareContact && v.detailCheckboxChecked]}>{shareContact && <Icon name="check" size={15} color={p.white} />}</View>
              <Text style={[v.value, v.flex]}>同时分享收件人和电话</Text>
            </Pressable>}
            <VaultButton label="验证并选择接收人" onPress={() => {
              if (!revealed || Date.now() >= lockAt.current) return;
              setDetailSheet(null); void openShare(selected, shareContact);
            }} disabled={busy} />
          </>}
        </View>
      </View>
    </Modal>}
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
  secondaryButton: { backgroundColor: p.pale }, secondaryText: { color: p.blue },
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
  onboardingHero: { alignItems: 'center', justifyContent: 'center', gap: 13, paddingVertical: 38 },
  onboardingHeroIcon: { width: 82, height: 82, borderRadius: 27, backgroundColor: '#E5EDFE', alignItems: 'center', justifyContent: 'center', marginVertical: 10 },
  successIcon: { backgroundColor: '#E5F1EB' },
  detailHero: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingTop: 5, paddingBottom: 5 },
  detailIcon: { backgroundColor: '#E7EEFF', width: 52, height: 52, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  detailTitle: { fontSize: 25, lineHeight: 33, fontWeight: '600', color: p.ink },
  detailCard: { backgroundColor: p.white, borderRadius: 23, borderWidth: 1, borderColor: p.line, paddingHorizontal: 17, paddingVertical: 14, gap: 8 },
  detailCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 42 },
  detailStatus: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12, backgroundColor: '#F0F3F9' },
  detailStatusOpen: { backgroundColor: '#EAF5F0' },
  detailStatusText: { fontSize: 11, color: p.muted, fontVariant: ['tabular-nums'] },
  detailStatusTextOpen: { color: '#317466' },
  detailHide: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: '#F3F5FA' },
  detailValue: { color: p.ink, fontSize: 19, lineHeight: 29, fontWeight: '600', marginBottom: 2 },
  detailFields: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingTop: 2 },
  detailField: { flexGrow: 1, flexBasis: '42%', gap: 2 },
  detailFieldValue: { color: p.ink, fontSize: 14, lineHeight: 21, fontWeight: '500' },
  detailAction: { flex: 1, flexDirection: 'row', gap: 6, paddingHorizontal: 8 },
  detailActionLabel: { flexShrink: 1 },
  detailPrivacy: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5 },
  detailOverlay: { flex: 1, backgroundColor: '#18233B66', justifyContent: 'center', padding: 20 },
  detailPanel: { alignSelf: 'center', width: '100%', maxWidth: 360, backgroundColor: p.white, borderRadius: 23, padding: 16, gap: 7 },
  detailPanelTitle: { fontSize: 18, fontWeight: '600', color: p.ink },
  detailMenuRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 5, gap: 10 },
  detailDelete: { color: p.red },
  detailCheckbox: { height: 21, width: 21, borderRadius: 6, borderWidth: 1, borderColor: p.muted, alignItems: 'center', justifyContent: 'center' },
  detailCheckboxChecked: { backgroundColor: p.blue, borderColor: p.blue },
});

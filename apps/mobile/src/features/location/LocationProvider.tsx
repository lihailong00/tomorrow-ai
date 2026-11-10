import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Rect } from 'react-native-svg';
import { useApp } from '../../app/context';
import type { ApiClient } from '../../api/client';
import { deviceLocation } from '../../platform/deviceLocation';
import { platform } from '../../platform/ports';
import type { ChatClientContext } from '../../domain/types';
import { Text } from '../../ui/Text';
import { Icon } from '../../ui/visuals';
import { colors } from '../../ui/theme';
import { canReuseNearbyFix, captureClientContext, locationCaption, locationInputAction, needsCurrentLocation, validLocation } from './model';
import { createLocationSession, type LocationChoice, type LocationSession } from './session';
import { LocationMap } from './LocationMap';

const Context = createContext<LocationSession | null>(null);

export function LocationProvider({ children }: { children: React.ReactNode }) {
  const { user, preferences } = useApp();
  const enabled = Boolean(user && preferences.instance?.id && !preferences.connectionError && !preferences.pendingConnection);
  const scope = JSON.stringify([preferences.serverUrl, preferences.instance?.id, user?.id]);
  const session = useMemo(() => enabled ? createLocationSession(scope, deviceLocation, AsyncStorage) : null, [enabled, scope]);
  useEffect(() => {
    if (!session) return;
    session.foreground(AppState.currentState === 'active');
    void session.initialize();
    const subscription = AppState.addEventListener('change', value => session.foreground(value === 'active'));
    return () => { subscription.remove(); session.dispose(); };
  }, [session]);
  return <Context.Provider value={session}>{children}{session && <LocationChoiceSheet key={scope} session={session} />}</Context.Provider>;
}

function ReminderPermission() {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void Promise.resolve(platform.notificationPermissionStatus?.()).then(value => {
      if (alive.current && value === 'granted') setStatus('已开启');
    }).catch(() => {});
    return () => { alive.current = false; };
  }, []);
  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await platform.manageNotificationPermission();
      if (alive.current) setStatus(result === 'granted' ? '已开启'
        : result === 'settings' ? '返回后可继续设置；也可以稍后开启' : '暂未开启，不影响继续使用');
    } catch { if (alive.current) setStatus('暂时无法开启，可稍后在系统设置中允许通知'); }
    finally { if (alive.current) setBusy(false); }
  };
  return <View style={css.setupRow}>
    <View style={css.setupCopy}><Text style={css.rowTitle}>任务提醒</Text><Text style={css.rowCaption}>{status || '接收待办和跟进提醒'}</Text></View>
    <Pressable accessibilityRole="button" accessibilityLabel="开启任务提醒通知" disabled={busy || status === '已开启'}
      onPress={() => { void enable(); }} style={css.smallButton}><Text style={css.buttonText}>{busy ? '设置中…' : status === '已开启' ? '已开启' : '开启通知'}</Text></Pressable>
  </View>;
}

type LocationControlsProps = { session: LocationSession; onCancel?: () => void; api?: Pick<ApiClient, 'request'>; countdown?: boolean };
function LocationControls({ session, onCancel, api, countdown }: LocationControlsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const startup = state.dialog === 'startup';
  const chat = state.dialog === 'chat';
  const [startupAttempted, setStartupAttempted] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [bounds, setBounds] = useState({width: 0, height: 0});
  const countdownUsed = useRef(state.manual || state.busy);
  useEffect(() => {
    if (!countdown || !chat || state.manual || state.busy || countdownUsed.current) return;
    let active = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void session.canLocateSilently().then(granted => {
      if (!active || !granted) return;
      countdownUsed.current = true;
      const start = Date.now();
      setProgress(0);
      interval = setInterval(() => setProgress(Math.min(1, (Date.now() - start) / 5000)), 80);
      timer = setTimeout(() => {
        if (interval !== undefined) clearInterval(interval);
        setProgress(null);
        void session.locateSilently();
      }, 5000);
    }).catch(() => {});
    return () => {
      active = false;
      if (interval !== undefined) clearInterval(interval);
      if (timer !== undefined) clearTimeout(timer);
      setProgress(null);
    };
  }, [countdown, chat, state.manual, state.busy, session]);
  const perimeter = 2 * (bounds.width + bounds.height - 4) - (8 - 2 * Math.PI) * 17;
  if (chat && !state.manual) return <>
    <Text style={css.cardTitle}>{state.purpose === 'trip' ? '从哪里出发？' : '这次查询用哪个位置？'}</Text>
    <Text style={css.cardCaption}>{onCancel ? '选好位置后继续查询，不需要重新输入问题。' : '选好位置就会发送，也可以不带位置发送。'}</Text>
    {state.error && <Text accessibilityRole="alert" style={css.cardError}>{state.error}</Text>}
    <View style={css.choices}>
      <Pressable accessibilityRole="button" disabled={state.busy}
        accessibilityLabel={state.settings ? '去设置开启' : state.error ? '重新定位' : '使用当前位置'}
        accessibilityHint="使用手机系统定位；未授权时会请求定位权限"
        onPress={() => { void (state.settings ? session.openSettings() : session.locate()); }}
        onLayout={event => setBounds(event.nativeEvent.layout)}
        style={[css.choice, css.autoChoice, state.busy && css.disabled]}>
        {progress !== null && perimeter > 0 && bounds.width > 34 && bounds.height > 34 &&
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Svg width={bounds.width} height={bounds.height}>
              <Rect x={1} y={1} width={bounds.width - 2} height={bounds.height - 2} rx={17}
                fill="none" stroke="#4077E5" strokeWidth={2} strokeDasharray={[perimeter, perimeter]}
                strokeDashoffset={perimeter * (1 - progress)} />
            </Svg>
          </View>}
        <View style={css.choiceIcon}>{state.busy ? <ActivityIndicator size="small" color={colors.action} />
          : <Icon name={state.settings ? 'settings' : 'search'} size={20} color={colors.action} />}</View>
        <Text style={css.choiceTitle}>{state.busy ? '正在定位…' : state.settings ? '去设置开启' : state.error ? '重新定位' : '使用当前位置'}</Text>
        <Text style={css.choiceHint}>{state.busy ? '取到后自动继续' : state.settings === 'services' ? '打开手机定位服务'
          : state.settings === 'permission' ? '允许妥啦使用位置' : progress !== null ? `${Math.max(1, Math.ceil(5 * (1 - progress)))} 秒后使用当前位置` : '手机系统定位，按需使用'}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="手动填写" onPress={session.manual} style={css.choice}>
        <View style={[css.choiceIcon, css.manualIcon]}><Icon name="edit" size={20} color="#8075AD" /></View>
        <Text style={css.choiceTitle}>手动填写</Text><Text style={css.choiceHint}>城市、地标或详细地址</Text>
      </Pressable>
    </View>
    <View style={css.cardFooter}>
      <Pressable accessibilityRole="button" accessibilityLabel={onCancel ? '暂不提供位置' : '暂不提供并发送'}
        onPress={onCancel ?? session.skip} style={css.footerButton}><Text style={[css.footerText, !onCancel && { color: colors.action }]}>{onCancel ? '暂不提供' : '不带位置发送'}</Text></Pressable>
      {!onCancel && <Pressable accessibilityRole="button" accessibilityLabel="继续编辑" onPress={session.dismiss} style={css.footerButton}><Text style={css.footerText}>继续编辑</Text></Pressable>}
    </View>
  </>;
  const action = (label: string, onPress: () => void, primary = false, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
      style={[css.button, primary && css.primary, disabled && css.disabled]}><Text style={[css.buttonText, primary && css.primaryText]}>{label}</Text></Pressable>;
  if (startup && !state.manual) {
    const locationAction = state.busy ? '定位中…' : state.settings ? '去设置开启' : '允许定位';
    return <>
    <Text accessibilityRole="header" style={css.title}>开始前，按需设置</Text>
    <Text style={css.rowCaption}>这两项都可以稍后开启。</Text>
    <View style={css.setupGroup}>
      <View style={css.setupRow}>
        <View style={css.setupCopy}>
          <Text style={css.rowTitle}>使用你的位置</Text>
          <Text style={css.rowCaption}>{state.location ? locationCaption(state.location, state.approximate, state.cached)
            : '用于附近门店、天气和路线。'}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={locationAction} disabled={state.busy} style={[css.smallButton, state.busy && css.disabled]}
          onPress={() => { setStartupAttempted(true); void (state.settings ? session.openSettings() : session.locate()); }}>
          <Text style={css.buttonText}>{locationAction}</Text>
        </Pressable>
      </View>
      {startupAttempted && state.error && <Text accessibilityRole="alert" style={css.error}>{state.error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="手动填写" onPress={session.manual} style={css.manualLink}>
        <Text style={css.linkText}>手动填写</Text>
      </Pressable>
      <View style={css.setupDivider} />
      <ReminderPermission />
    </View>
    <Text style={css.rowCaption}>普通聊天不发送位置。相机和麦克风权限在首次使用时申请。</Text>
    {action('开始使用', session.completeSetup, true, state.busy)}
    <Pressable accessibilityRole="button" onPress={session.completeSetup} style={[css.footerButton, css.skipSetup]}>
      <Text style={css.footerText}>{state.location ? '其余稍后设置' : '暂不设置'}</Text>
    </Pressable>
    </>;
  }
  return <>
    <Text style={css.title}>{state.manual ? '手动填写位置' : state.purpose === 'trip' ? '从哪里出发？' : '这次查询用哪个位置？'}</Text>
    <Text style={css.caption}>{state.manual ? startup ? '填写常用城市、地标或地址。' : '填写城市、地标或地址，选好后继续原来的问题。'
      : state.busy ? '正在获取位置，取到后自动继续这次查询…' : '选择后自动继续，不需要重新发送消息。'}</Text>
    {state.manual ? chat && api ? <LocationMap api={api} session={session} initialQuery={state.input} rememberManual={state.rememberManual} /> : <>
      <TextInput accessibilityLabel="位置地址" placeholder="例如：上海张江地铁站" value={state.input}
        onChangeText={session.setInput} maxLength={200} autoFocus style={css.input} />
      <View style={css.setupRow}><Text style={[css.caption, css.setupCopy]}>保存为常用出发地（仅本机）</Text>
        <Switch accessibilityLabel="保存为常用出发地" value={state.rememberManual} onValueChange={session.rememberManual} /></View>
      {action('使用这个位置', () => session.saveManual(), true, !state.input.trim())}
      {action('改用自动定位', () => { void session.locate(); }, false, state.busy)}
    </> : <>
      {state.busy ? <View style={css.progress}><ActivityIndicator color={colors.action} /><Text style={css.caption}>正在获取位置，最多约 8 秒…</Text></View>
        : action(state.error ? '重新定位' : chat ? '使用当前位置' : '自动定位', () => { void session.locate(); }, true)}
      {action('手动填写', session.manual)}
    </>}
    {state.error && <Text accessibilityRole="alert" style={css.error}>{state.error}</Text>}
    {state.settings && (!startup || state.manual) && action('去设置开启', () => { void session.openSettings(); })}
    {startup && action('开始使用', session.completeSetup, false, state.busy)}
    {action(startup ? state.location ? '其余稍后设置' : '暂不设置' : chat ? onCancel ? '暂不提供位置' : '暂不提供并发送' : '清除位置', onCancel ?? (startup ? session.completeSetup : session.skip))}
    {!startup && !onCancel && action('继续编辑', session.dismiss)}
  </>;
}

/** Exported to allow deterministic rendering against an isolated synthetic session. */
export function LocationChoiceSheet({ session }: { session: LocationSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (!state.dialog || state.dialog === 'chat') return null;
  return <Modal transparent visible animationType="slide" onRequestClose={() => session.dismiss()}>
    <KeyboardAvoidingView style={css.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={css.sheet} testID="location-choice-sheet" accessibilityViewIsModal>
        <ScrollView keyboardShouldPersistTaps="handled" bounces={false} contentContainerStyle={css.content}>
          <View style={css.handle} />
          <LocationControls session={session} />
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

export function ChatLocationRequest({ session, ...props }: Omit<LocationControlsProps, 'session'> & { session: LocationSession | null }) {
  return session ? <ChatLocationCard session={session} {...props} /> : null;
}
function ChatLocationCard({ session, ...props }: LocationControlsProps) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (state.dialog !== 'chat') return null;
  if (props.countdown) return <View style={[css.inline, css.inlineContent, {maxHeight: undefined}]}
    testID="chat-location-request"><LocationControls session={session} {...props} /></View>;
  return <ScrollView style={css.inline} contentContainerStyle={css.inlineContent} keyboardShouldPersistTaps="handled"
    testID="chat-location-request"><LocationControls session={session} {...props} /></ScrollView>;
}

export function useChatLocation() {
  const session = useContext(Context);
  // Existing standalone screens can render without the application shell.
  const empty = useMemo(() => ({ ready: true, mode: null, location: null, deviceVerified: false, approximate: false, cached: false, dialog: null,
    manual: false, input: '', busy: false, error: null, settings: null,
    purpose: 'location' as const, rememberManual: false, savedManualLabel: null }), []);
  const state = useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.getSnapshot ?? (() => empty));
  const eligible = (snapshot: typeof state) => validLocation(snapshot.location) &&
    (snapshot.location.source !== 'device' || snapshot.deviceVerified) ? snapshot.location : null;
  const current = eligible(state);
  return {
    session,
    location: current,
    caption: locationCaption(current, state.approximate, state.cached),
    busy: state.busy,
    choosingForChat: state.dialog === 'chat',
    capture(message: string, explicitlyInclude = false, fallbackTimezone?: string,
      previous: readonly { role: string; content: string }[] = []): ChatClientContext | null {
      const relevant = needsCurrentLocation(message, previous) || explicitlyInclude;
      const snapshot = session?.getSnapshot() ?? state;
      const fresh = eligible(snapshot);
      if (relevant && snapshot.mode === 'auto' && fresh?.source === 'device' && canReuseNearbyFix(message, previous)) {
        return captureClientContext(fresh, fallbackTimezone);
      }
      if (session && relevant) return null;
      return captureClientContext(relevant ? fresh : null, fallbackTimezone);
    },
    request(reason: 'chat' | 'edit' = 'chat', message = '',
      previous: readonly { role: string; content: string }[] = []): Promise<LocationChoice> {
      const purpose = /打车|叫车|出发|路线|导航|怎么走|回家/u.test(message) ? 'trip' : 'location';
      return session?.request(reason, purpose, locationInputAction(message), canReuseNearbyFix(message, previous)) ??
        Promise.resolve({ kind: 'cancel' });
    },
  };
}

export function ChatLocationChip({ caption, selected, disabled, onPress }: {
  caption: string; selected: boolean; disabled?: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={selected ? '更改本次位置' : '设置本次位置'}
    disabled={disabled} onPress={onPress} style={[css.chip, disabled && css.disabled]}>
    <Text numberOfLines={1} style={css.chipText}>{caption}</Text><Text style={css.chipArrow}>⌄</Text>
  </Pressable>;
}

const css = StyleSheet.create({
  cardTitle: { color: colors.ink, fontSize: 19, fontWeight: '600', lineHeight: 27 },
  cardCaption: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginBottom: 3 },
  cardError: { color: colors.danger, fontSize: 12, lineHeight: 19, paddingVertical: 4 },
  choices: { flexDirection: 'row', gap: 10 },
  choice: { flex: 1, minWidth: 0, minHeight: 113, padding: 12, borderRadius: 17, backgroundColor: '#F4F1FC', gap: 5 },
  autoChoice: { backgroundColor: '#EDF3FF' },
  choiceIcon: { width: 31, height: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E1EAFF', borderRadius: 11, marginBottom: 2 },
  manualIcon: { backgroundColor: '#EAE4F7' },
  choiceTitle: { color: colors.ink, fontSize: 15, fontWeight: '600', lineHeight: 22 },
  choiceHint: { color: colors.secondary, fontSize: 11, lineHeight: 17 },
  cardFooter: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  footerButton: { minHeight: 36, paddingHorizontal: 4, justifyContent: 'center' },
  footerText: { color: colors.secondary, fontSize: 12 },
  inline: { maxHeight: 300, flexGrow: 0, backgroundColor: '#FAFBFF', borderRadius: 20, marginBottom: 8 },
  inlineContent: { padding: 16, gap: 8 },
  setupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  setupCopy: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  rowCaption: { color: colors.secondary, fontSize: 13, lineHeight: 20, marginTop: 2 },
  setupGroup: { backgroundColor: '#FFF', borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 13, gap: 2 },
  setupDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  manualLink: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center' },
  linkText: { color: colors.action, fontSize: 14, fontWeight: '500' },
  skipSetup: { alignItems: 'center', minHeight: 44 },
  smallButton: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: '#EDF2FC', borderRadius: 14 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(31,40,67,0.18)' },
  sheet: { maxHeight: '85%', backgroundColor: '#FAFBFF', borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  content: { padding: 24, paddingBottom: 32, gap: 10 },
  handle: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', backgroundColor: '#DDE2EE', marginBottom: 12 },
  title: { color: colors.ink, fontSize: 23, fontWeight: '600', lineHeight: 32 },
  caption: { color: colors.secondary, fontSize: 14, lineHeight: 22, marginBottom: 8 },
  button: { minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', padding: 12, backgroundColor: '#EDF2FC' },
  primary: { backgroundColor: colors.action },
  buttonText: { fontSize: 16, color: colors.action, fontWeight: '500' },
  primaryText: { color: '#FFF' },
  input: { backgroundColor: '#FFF', borderWidth: 1, borderColor: colors.line, borderRadius: 16, color: colors.ink, padding: 15, fontSize: 16, minHeight: 52 },
  progress: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  error: { color: colors.danger, fontSize: 14, lineHeight: 22 },
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', maxWidth: '95%', borderRadius: 15,
    paddingHorizontal: 11, minHeight: 32, backgroundColor: 'rgba(234,241,255,0.8)', gap: 6, marginBottom: 6 },
  chipText: { fontSize: 12, color: colors.secondary, flexShrink: 1 },
  chipArrow: { color: colors.action, fontSize: 16 },
  disabled: { opacity: 0.5 },
});

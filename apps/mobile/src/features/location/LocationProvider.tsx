import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../../app/context';
import { deviceLocation } from '../../platform/deviceLocation';
import type { ChatClientContext } from '../../domain/types';
import { Text } from '../../ui/Text';
import { colors } from '../../ui/theme';
import { captureClientContext, locationCaption, needsCurrentLocation, validLocation } from './model';
import { createLocationSession, type LocationChoice, type LocationSession } from './session';

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
  return <Context.Provider value={session}>{children}{session && <LocationChoiceSheet session={session} />}</Context.Provider>;
}

/** Exported to allow deterministic rendering against an isolated synthetic session. */
export function LocationChoiceSheet({ session }: { session: LocationSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (!state.dialog) return null;
  const startup = state.dialog === 'startup';
  const chat = state.dialog === 'chat';
  const action = (label: string, onPress: () => void, primary = false, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled}
      style={[css.button, primary && css.primary, disabled && css.disabled]}><Text style={[css.buttonText, primary && css.primaryText]}>{label}</Text></Pressable>;
  return <Modal transparent visible animationType="slide" onRequestClose={() => session.dismiss()}>
    <KeyboardAvoidingView style={css.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={css.sheet} testID="location-choice-sheet" accessibilityViewIsModal>
        <ScrollView keyboardShouldPersistTaps="handled" bounces={false} contentContainerStyle={css.content}>
          <View style={css.handle} />
          <Text style={css.title}>{state.manual ? '手动填写位置' : startup ? '让妥啦知道你在哪里' : '你想怎么设置位置？'}</Text>
          <Text style={css.caption}>{state.manual ? '输入城市、地标或地址。手动位置保留 24 小时，仅用于相关问题。'
            : '方便查附近、路线和出行价格。只在前台单次定位；普通聊天不发送位置。'}</Text>
          {state.manual ? <>
            <TextInput accessibilityLabel="位置地址" placeholder="例如：上海张江地铁站" value={state.input}
              onChangeText={session.setInput} maxLength={200} autoFocus style={css.input} />
            {action('使用这个位置', session.saveManual, true, !state.input.trim())}
            {action('改用自动定位', () => { void session.locate(); }, false, state.busy)}
          </> : <>
            {state.busy ? <View style={css.progress}><ActivityIndicator color={colors.action} /><Text style={css.caption}>正在获取位置，最多约 8 秒…</Text></View>
              : action(state.error ? '重新定位' : '自动定位', () => { void session.locate(); }, true)}
            {action('手动填写', session.manual)}
          </>}
          {state.error && <Text accessibilityRole="alert" style={css.error}>{state.error}</Text>}
          {state.settings && action('去设置开启', () => { void session.openSettings(); })}
          {action(startup ? '暂不设置' : chat ? '暂不提供并发送' : '清除位置', session.skip)}
          {!startup && action('继续编辑', session.dismiss)}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  </Modal>;
}

export function useChatLocation() {
  const session = useContext(Context);
  // Existing standalone screens can render without the application shell.
  const empty = useMemo(() => ({ ready: true, mode: null, location: null, deviceVerified: false, approximate: false, cached: false, dialog: null,
    manual: false, input: '', busy: false, error: null, settings: null }), []);
  const state = useSyncExternalStore(session?.subscribe ?? (() => () => {}), session?.getSnapshot ?? (() => empty));
  const eligible = (snapshot: typeof state) => validLocation(snapshot.location) &&
    (snapshot.location.source !== 'device' || snapshot.deviceVerified) ? snapshot.location : null;
  const current = eligible(state);
  return {
    session,
    location: current,
    caption: locationCaption(current, state.approximate, state.cached),
    busy: state.busy,
    capture(message: string, explicitlyInclude = false, fallbackTimezone?: string,
      previous: readonly { role: string; content: string }[] = []): ChatClientContext | null {
      const relevant = needsCurrentLocation(message, previous) || explicitlyInclude;
      const fresh = eligible(session?.getSnapshot() ?? state);
      // The production shell always supplies a session for a verified signed-in server.
      if (relevant && !fresh && session) return null;
      return captureClientContext(relevant ? fresh : null, fallbackTimezone);
    },
    request(reason: 'chat' | 'edit' = 'chat'): Promise<LocationChoice> {
      return session?.request(reason) ?? Promise.resolve({ kind: 'cancel' });
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

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from './src/ui/Text';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ApiClient, normalizeServerUrl } from './src/api/client';
import { createInstanceIdentityGuard, inspectInstance } from './src/api/instance';
import { connectionFromLink } from './src/domain/instance';
import { healthReceiptFromLink } from './src/domain/healthLink';
import { AppProvider, MainTab } from './src/app/context';
import { useRouteStack } from './src/app/navigation';
import { useForegroundNotifications } from './src/app/notifications';
import type { AuthSession } from './src/domain/types';
import { readableDate } from './src/domain/types';
import { platform, Preferences, defaultServerUrl } from './src/platform/ports';
import { AuthScreen, IntroScreen, SettingsScreen } from './src/screens/Account';
import {
  HomeScreen,
  MemoriesScreen,
  TasksScreen,
} from './src/screens/Main';
import { ChatScreen, ConversationsScreen, createChatEntryState } from './src/screens/Chat';
import { CurrentConversationPin } from './src/features/conversations/CurrentConversationPin';
import { UploadsScreen } from './src/screens/Uploads';
import { IntegrationsScreen, type ConnectionBrowseState } from './src/features/integrations/IntegrationsScreen';
import { CapabilitiesScreen } from './src/features/capabilities/CapabilitiesScreen';
import { capabilityAppearance } from './src/features/capabilities/model';
import { TodosScreen } from './src/features/todos/TodosScreen';
import { TodoDetail } from './src/features/todos/TodoDetail';
import { TodoSources } from './src/features/todos/TodoSources';
import { GrowthProvider, GrowthFeedbackBanner } from './src/features/growth/context';
import { GrowthScreen, GrowthWeekScreen } from './src/features/growth/GrowthScreen';
import { GrowthSettingsScreen } from './src/features/growth/GrowthSettings';
import { HealthScreen } from './src/features/health/HealthScreen';
import { AiHistoryScreen } from './src/features/ai-history/AiHistoryScreen';
import { UsageScreen } from './src/features/usage/UsageScreen';
import { PrivateVaultScreen } from './src/features/private-vault/PrivateVaultScreen';
import { appInputs } from './src/platform/appInputs';
import { phoneSources } from './src/platform/phoneSources';
import { HomeComposer, type HomeComposerDraft } from './src/features/today/HomeComposer';
import { photoIndex } from './src/platform/photoIndex';
import {
  ArtifactsScreen,
  MemoryEditor,
  NewTaskScreen,
  NotificationsScreen,
  ScheduleEditor,
  TaskDetailScreen,
} from './src/screens/Details';
import { IconButton, Loading } from './src/ui/components';
import { colors, styles as s } from './src/ui/theme';
import { chatAppearance } from './src/ui/ChatAppearance';
import { AmbientBackground, AssistantOrb, Icon } from './src/ui/visuals';
import { SidebarNavigation } from './src/features/navigation/SidebarNavigation';
import { HelpScreen } from './src/features/navigation/HelpScreen';
import { LocationProvider } from './src/features/location/LocationProvider';
import { DidiRideStatus } from './src/features/personal-mcp/DidiRideStatus';

function Application() {
  const [booting, setBooting] = useState(true);
  const [preferences, setPreferences] = useState<Preferences>({
    serverUrl: defaultServerUrl,
    onboarded: false,
  });
  const [session, setSession] = useState<AuthSession | null>(null);
  const activeToken = useRef<string | undefined>(undefined);
  const [expired, setExpired] = useState(false);
  const [authNotice, setAuthNotice] = useState('');
  const [tab, setTab] = useState<MainTab>('today');
  const [sidebarClient, setSidebarClient] = useState<ApiClient | null>(null);
  const [shellHeight, setShellHeight] = useState<number>();
  const [keyboardVisible, setKeyboardVisible] = useState(() =>
    Keyboard.isVisible(),
  );
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () =>
      setKeyboardVisible(true),
    );
    const hidden = Keyboard.addListener('keyboardDidHide', () =>
      setKeyboardVisible(false),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  const navigationOwner = useMemo(() => ({
    serverUrl: preferences.serverUrl,
    instanceId: preferences.instance?.id,
    token: session?.token,
    userId: session?.user.id,
    tab,
  }), [preferences.serverUrl, preferences.instance?.id, session?.token, session?.user.id, tab]);
  const { entry, depth, navigate, back, updateRoute, getEntryState, resetRoutes } = useRouteStack(navigationOwner);
  const [revision, setRevision] = useState(0);
  const [pendingInputs, setPendingInputs] = useState(0);
  const inputCleanup = useRef<Promise<void>>(Promise.resolve());
  const activeConnection = useRef(defaultServerUrl);
  const route = entry.route;
  const activeTab = route.name === 'main' ? route.tab ?? tab : tab;
  const selectTab = useCallback((next: MainTab) => {
    if (route.name !== 'main') {
      // Keep this conversation/editor entry behind the selected top-level page.
      navigate({ name: 'main', tab: next });
    } else if (route.tab !== undefined) {
      updateRoute(() => ({ name: 'main', tab: next }));
    } else {
      setTab(next);
    }
  }, [navigate, route, updateRoute]);
  // Measure the whole shell so moving the header cannot change this predicate.
  const compactChatHeader =
    route.name === 'chat' &&
    keyboardVisible &&
    shellHeight !== undefined &&
    shellHeight < 220;
  const clearInputs = useCallback(() => {
    const next = inputCleanup.current.catch(() => {}).then(() => appInputs.clear());
    inputCleanup.current = next;
    void next.catch(() => {});
    return next;
  }, []);
  useEffect(() => {
    let active = true;
    const update = () => {
      if (!session) { setPendingInputs(0); return; }
      void appInputs.getStatus().then(status => {
        if (active) { setPendingInputs(status.pending_count); }
      }).catch(() => {});
    };
    update();
    const unsubscribe = platform.onForeground(update);
    return () => { active = false; unsubscribe(); };
  }, [session, route.name, revision]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const prefs = await platform.loadPreferences();
      try {
        prefs.serverUrl = normalizeServerUrl(prefs.serverUrl);
      } catch {
        prefs.connectionError = prefs.connectionError ?? '保存的服务地址无效，请重新选择服务器。';
        prefs.serverUrl = '';
      }
      if (!alive) {
        return;
      }
      setPreferences(prefs);
      activeConnection.current = prefs.serverUrl;
      const stored = await platform.readSession().catch(async () => {
        await platform.removeSession().catch(() => {});
        return null;
      });
      if (!alive) {
        return;
      }
      let restored = false;
      if (stored) {
        try {
          const saved = JSON.parse(stored) as AuthSession & {
            serverUrl: string;
            instanceId?: string;
          };
          if (
            saved.serverUrl === prefs.serverUrl &&
            !prefs.connectionError &&
            saved.instanceId && saved.instanceId === prefs.instance?.id &&
            saved.token &&
            saved.user
          ) {
            // Restore locally first: an offline phone must still reach connection settings.
            activeToken.current = saved.token;
            setSession({ token: saved.token, user: saved.user });
            restored = true;
          }
        } catch {
          await platform.removeSession();
        }
      }
      // With no authenticated owner, an old native inbox must not be inherited
      // by the next account after a failed cleanup or a process restart.
      if (!restored) {
        await phoneSources.suspend();
        await photoIndex.suspend();
        await clearInputs();
        await platform.removeSession();
      }
    })()
      .catch(() => {
        activeConnection.current = '';
        setPreferences({ serverUrl: '', onboarded: true, serverUrlCustomized: true,
          connectionError: '暂时无法读取本机设置，请重新选择服务器。' });
      })
      .finally(() => {
        if (alive) {
          setBooting(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [clearInputs]);

  const unauthorized = useCallback(() => {
    void phoneSources.suspend().catch(() => {});
    void photoIndex.suspend().catch(() => {});
    void clearInputs();
    activeToken.current = undefined;
    setSession(null);
    setExpired(true);
    resetRoutes([{ name: 'main' }]);
    platform.removeSession().catch(() => {});
  }, [clearInputs, resetRoutes]);
  const identityGuard = useMemo(() => createInstanceIdentityGuard(preferences.serverUrl, {
    allowInsecureLan: preferences.allowInsecureLan,
    expectedId: preferences.instance?.id,
  }), [preferences.serverUrl, preferences.instance?.id, preferences.allowInsecureLan]);
  const api = useMemo(() => {
    const token = session?.token;
    return new ApiClient(preferences.connectionError ? '' : preferences.serverUrl, token, () => {
      // A delayed response from the previous account must not log out the new one.
      if (activeToken.current === token) {
        unauthorized();
      }
    }, fetch, identityGuard.verify);
  }, [preferences.serverUrl, preferences.connectionError, session?.token, unauthorized, identityGuard]);
  useEffect(() => {
    // Subscribe before foreground polling: a check begun before returning to
    // the app must not release queued credentials after the server changes.
    const unsubscribe = platform.onForeground(identityGuard.invalidate);
    return () => { unsubscribe(); identityGuard.dispose(); };
  }, [identityGuard]);
  useEffect(() => () => api.dispose(), [api]);
  const homeDraft = useMemo<HomeComposerDraft>(
    () => ({ text: '', file: null, voiceMode: false }),
    [preferences.serverUrl, preferences.instance?.id, session?.user.id],
  );
  useForegroundNotifications(api, session?.user.id);
  const linkContext = useRef({ api, session });
  linkContext.current = { api, session };
  const seenHealthLinks = useRef(new Set<string>());
  useEffect(() => {
    if (booting) return;
    let alive = true;
    const acceptLink = (link: string) => {
      try {
        if (!alive) return;
        const current = linkContext.current;
        const healthReceipt = healthReceiptFromLink(link, current.api.baseUrl);
        if (healthReceipt) {
          // No saved drafts, account switches or automatic network requests.
          if (!current.session || seenHealthLinks.current.has(link)) return;
          seenHealthLinks.current.add(link);
          if (seenHealthLinks.current.size > 20) seenHealthLinks.current.delete(seenHealthLinks.current.values().next().value!);
          resetRoutes([{ name: 'main' }, { name: 'health', receipt: healthReceipt }]);
          return;
        }
        const pendingConnection = connectionFromLink(link);
        if (!alive) return;
        // A scanned link opens a review form; it never switches or signs in.
        setPreferences(current => ({ ...current, pendingConnection }));
        resetRoutes([{ name: 'main' }, { name: 'settings' }]);
      } catch { /* Ignore unrelated or malformed external intents. */ }
    };
    void platform.initialConnectionLink().then(link => { if (link) acceptLink(link); }).catch(() => {});
    const unsubscribe = platform.onConnectionLink(acceptLink);
    return () => { alive = false; unsubscribe(); };
  }, [booting, resetRoutes]);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      // Connection details and search own their internal back stack, including
      // after a device/health route remounts the listeners in a different order.
      if (route.name === 'integrations') return false;
      if (depth > 1) {
        back();
        return true;
      }
      if (session && activeTab !== 'today') {
        selectTab('today');
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [depth, activeTab, selectTab, session, back, route.name]);
  const savePreferences = async (next: Preferences) => {
    const changed = next.serverUrl !== preferences.serverUrl || next.instance?.id !== preferences.instance?.id;
    if (changed) {
      // Cancel old uploads immediately, then revoke local background consent.
      api.dispose();
      activeConnection.current = '';
      await phoneSources.suspend();
      await photoIndex.suspend();
      await clearInputs();
      activeToken.current = undefined;
      await platform.removeSession();
      setSession(null);
      resetRoutes([{ name: 'main' }]);
    }
    const saved = { ...next };
    delete saved.pendingConnection;
    await platform.savePreferences(saved);
    activeConnection.current = next.serverUrl;
    setPreferences(next);
  };
  const signIn = async (next: AuthSession) => {
    const target = preferences.serverUrl;
    const checked = await inspectInstance(target, {
      allowInsecureLan: preferences.allowInsecureLan, expectedId: preferences.instance?.id,
    });
    if (activeConnection.current !== target) throw new Error('服务连接已变化，请重新登录。');
    // An expired account's local notification queue must be cleared before the
    // next account can use a new session, including a previously failed cleanup.
    await inputCleanup.current.catch(() => clearInputs());
    if (activeConnection.current !== target) throw new Error('服务连接已变化，请重新登录。');
    activeToken.current = next.token;
    try {
      await platform.writeSession(
        JSON.stringify({ ...next, serverUrl: target, instanceId: checked.instance.id }),
      );
    } catch (error) {
      activeToken.current = undefined;
      throw error;
    }
    if (activeConnection.current !== target) throw new Error('服务连接已变化，请重新登录。');
    const updatedPreferences = { ...preferences, instance: checked.instance };
    await platform.savePreferences(updatedPreferences);
    setPreferences(updatedPreferences);
    setSession(next);
    setExpired(false);
    setAuthNotice('');
    setTab('today');
    resetRoutes([{ name: 'main' }]);
  };
  const signOut = async () => {
    await phoneSources.suspend();
    await photoIndex.suspend();
    await clearInputs();
    try {
      await api.logout();
      setAuthNotice('已退出当前账号。');
    } catch {
      setAuthNotice(
        '已在本机退出。当前未能确认服务端注销；服务恢复后，原会话会按照服务端有效期失效。',
      );
    }
    await platform.removeSession();
    activeToken.current = undefined;
    setSession(null);
    setExpired(false);
    resetRoutes([{ name: 'main' }]);
    setTab('today');
  };
  if (booting) {
    return (
      <SafeAreaView style={s.screen}>
        <Loading label="为新的一天做准备…" />
      </SafeAreaView>
    );
  }

  let page: React.ReactNode;
  let currentChatEntry: ReturnType<typeof createChatEntryState> | undefined;
  if (route.name === 'settings') {
    page = <SettingsScreen initialSection={route.section} />;
  } else if (route.name === 'help') {
    page = <HelpScreen />;
  } else if (!preferences.onboarded) {
    page = (
      <IntroScreen
        onContinue={() => savePreferences({ ...preferences, onboarded: true })}
      />
    );
  } else if (!session) {
    page = <AuthScreen expired={expired} notice={authNotice} />;
  } else {
    switch (route.name) {
      case 'chat':
        currentChatEntry = getEntryState(scope => createChatEntryState(route.conversationId, route.prompt, scope, route.initialInput));
        page = (
          <ChatScreen
            conversationId={route.conversationId}
            prompt={route.prompt}
            entryState={currentChatEntry}
            navigationActions={
              compactChatHeader ? (
                <>
                  <IconButton label="返回" icon="back" onPress={back} />
                  <CurrentConversationPin entryState={currentChatEntry} />
                  <IconButton
                    label="历史对话"
                    icon="history"
                    onPress={() => navigate({ name: 'conversations' })}
                  />
                </>
              ) : undefined
            }
          />
        );
        break;
      case 'task':
        page = <TaskDetailScreen id={route.id} />;
        break;
      case 'todos':
        page = <TodosScreen />;
        break;
      case 'todo':
        page = <TodoDetail id={route.id} />;
        break;
      case 'todoSources':
        page = <TodoSources conversationId={route.conversationId} />;
        break;
      case 'growth':
        page = <GrowthScreen />;
        break;
      case 'growthSettings':
        page = <GrowthSettingsScreen />;
        break;
      case 'growthWeek':
        page = <GrowthWeekScreen />;
        break;
      case 'assistantTasks':
        page = <TasksScreen initialView={route.view} />;
        break;
      case 'newTask':
        page = <NewTaskScreen />;
        break;
      case 'memory':
        page = <MemoryEditor memory={route.memory} />;
        break;
      case 'privateVault':
        page = <PrivateVaultScreen key={session.user.id + preferences.serverUrl} />;
        break;
      case 'schedule':
        page = <ScheduleEditor schedule={route.schedule} />;
        break;
      case 'notifications':
        page = <NotificationsScreen />;
        break;
      case 'artifacts':
        page = <ArtifactsScreen />;
        break;
      case 'uploads':
        page = <UploadsScreen />;
        break;
      case 'integrations': {
        const connectionsEntry = getEntryState(scope => ({
          api,
          userId: session.user.id,
          isRetained: scope.isRetained,
          browse: { category: 'local', query: '', managing: false } as ConnectionBrowseState,
        }));
        if (connectionsEntry.api !== api || connectionsEntry.userId !== session.user.id) {
          connectionsEntry.api = api;
          connectionsEntry.userId = session.user.id;
          connectionsEntry.browse = { category: 'local', query: '', managing: false };
        }
        page = <IntegrationsScreen
          browseState={connectionsEntry.browse}
          onBrowseStateChange={next => {
            if (connectionsEntry.isRetained() && connectionsEntry.api === api && connectionsEntry.userId === session.user.id) {
              connectionsEntry.browse = next;
            }
          }}
        />;
        break;
      }
      case 'health':
        page = <HealthScreen key={session.user.id + preferences.serverUrl} initialReceipt={route.receipt} />;
        break;
      case 'aiHistory':
        page = <AiHistoryScreen key={session.user.id + preferences.serverUrl} />;
        break;
      case 'usage':
        page = <UsageScreen key={session.user.id + preferences.serverUrl} />;
        break;
      case 'conversations':
        page = <ConversationsScreen />;
        break;
      default:
        page =
          activeTab === 'today' ? (
            <HomeScreen onTasks={() => selectTab('tasks')} pendingInputs={pendingInputs} />
          ) : activeTab === 'tasks' ? (
            <TodosScreen />
          ) : activeTab === 'memories' ? (
            <MemoriesScreen />
          ) : (
            <CapabilitiesScreen />
          );
    }
  }
  const main = route.name === 'main';
  const today = main && activeTab === 'today' && Boolean(session) && preferences.onboarded;
  const chatPage = route.name === 'chat' && Boolean(session);
  const chatSurface = chatPage || (route.name === 'conversations' && Boolean(session));
  const capabilitiesSurface = main && activeTab === 'capabilities' && Boolean(session);
  const tabs: Array<{
    id: MainTab;
    label: string;
    icon: React.ComponentProps<typeof Icon>['name'];
  }> = [
    { id: 'today', label: '今日', icon: 'today' },
    { id: 'tasks', label: '事项', icon: 'tasks' },
    { id: 'memories', label: '记忆', icon: 'memory' },
    { id: 'capabilities', label: '能力', icon: 'sparkles' },
  ];
  return (
    <AppProvider
      key={`${preferences.serverUrl}:${preferences.instance?.id ?? 'unverified'}:${session?.user.id ?? 'signed-out'}`}
      value={{
        api,
        user: session?.user ?? null,
        preferences,
        navigate,
        back,
        signIn,
        signOut,
        savePreferences,
        updateUser: async user => {
          if (!session || activeToken.current !== session.token) {
            return;
          }
          const updated = { ...session, user };
          await platform.writeSession(
            JSON.stringify({ ...updated, serverUrl: preferences.serverUrl, instanceId: preferences.instance?.id }),
          );
          if (activeToken.current === session.token) {
            setSession(updated);
          }
        },
        revision,
        invalidate: () => setRevision(old => old + 1),
        formatDate: (value, timezone) =>
          readableDate(
            value,
            timezone ?? session?.user.timezone ?? 'Asia/Shanghai',
          ),
      }}
    >
      <LocationProvider>
      <GrowthProvider>
      <View style={[s.screen, chatSurface && shell.chatCanvas, capabilitiesSurface && {backgroundColor:capabilityAppearance.background}]}>
        {!capabilitiesSurface && <AmbientBackground />}
        <SafeAreaView
          style={shell.safeArea}
          edges={['top', 'bottom']}
          testID="application-shell"
          onLayout={event => setShellHeight(event.nativeEvent.layout.height)}
        >
          <StatusBar
            barStyle="dark-content"
            backgroundColor={capabilitiesSurface ? capabilityAppearance.background : colors.background}
          />
          {route.name !== 'health' && route.name !== 'integrations' && route.name !== 'usage' && route.name !== 'privateVault' && <View
            testID="application-header"
            style={[s.header, chatSurface && shell.chatHeader, compactChatHeader && shell.hiddenHeader]}
          >
            {chatPage ? <>
              <View style={shell.chatBrand}>
                <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={back} style={shell.chatHeaderButton}>
                  <Icon name="back" size={22} color={chatAppearance.ink} />
                </Pressable>
                <AssistantOrb size={32} />
                <Pressable accessibilityRole="button" accessibilityLabel="打开侧边栏" onPress={() => { Keyboard.dismiss(); setSidebarClient(api); }} style={shell.sidebarChatTitle}>
                  <Text numberOfLines={1} style={[s.wordmark, shell.brand, {flexShrink:1}]}>妥啦</Text>
                </Pressable>
              </View>
              <View style={shell.chatHeaderActions}>
                <CurrentConversationPin entryState={currentChatEntry} />
                <Pressable accessibilityRole="button" accessibilityLabel="开启新对话" onPress={() => navigate({ name: 'chat' })} style={shell.chatHeaderButton}>
                  <Icon name="compose" size={21} color={chatAppearance.ink} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="历史对话" onPress={() => navigate({ name: 'conversations' })} style={shell.chatHeaderButton}>
                  <Icon name="history" size={22} color={chatAppearance.ink} />
                </Pressable>
              </View>
            </> : main ? (
              <View style={s.row}>
                {session && <Pressable accessibilityRole="button" accessibilityLabel="打开侧边栏" onPress={() => { Keyboard.dismiss(); setSidebarClient(api); }} style={shell.sidebarMenuButton}>
                  <Icon name="menu" size={22} color={colors.ink} />
                </Pressable>}
                <AssistantOrb size={34} />
                <Text style={[s.wordmark, shell.brand]}>妥啦</Text>
              </View>
            ) : (
              <View style={[s.row, { gap: 8 }]}>
                <IconButton label="返回" icon="back" onPress={back} />
                {route.name === 'chat' && (
                  <Text style={shell.chatTitle}>妥啦</Text>
                )}
              </View>
            )}
            {chatPage ? null : route.name === 'chat' ? (
              <IconButton
                label="历史对话"
                icon="history"
                onPress={() => navigate({ name: 'conversations' })}
              />
            ) : route.name === 'settings' ? (
              <Text style={s.small}>你的空间</Text>
            ) : (
              <IconButton
                label={session ? '设置与账号' : '连接服务设置'}
                symbol={
                  session
                    ? (session.user.name || '我').slice(0, 1).toUpperCase()
                    : '⚙'
                }
                onPress={() => navigate({ name: 'settings', ...(session ? { section: 'account' as const } : {}) })}
              />
            )}
          </View>}
          {session && !today && pendingInputs > 0 && route.name !== 'integrations' && (
            <Pressable accessibilityRole="button" accessibilityLabel="查看待接收的手机资料"
              onPress={() => navigate({ name: 'integrations' })}
              style={{ marginHorizontal: 20, marginBottom: 8, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 18, backgroundColor: '#EAF1FF' }}>
              <Text style={{ color: colors.accent }}>有 {pendingInputs} 条手机资料待接收 · 查看并确认</Text>
            </Pressable>
          )}
          {session && <GrowthFeedbackBanner />}
          {session && <DidiRideStatus />}
          <KeyboardAvoidingView
            key={entry.key}
            style={s.fill}
            behavior={platform.keyboardBehavior}
          >
            {page}
            {today && <HomeComposer savedDraft={homeDraft} />}
          </KeyboardAvoidingView>
          {session && main && !(today && keyboardVisible) && (
            <View style={s.tabs} accessibilityRole="tablist">
              {tabs.map(item => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: item.id === activeTab }}
                  accessibilityLabel={item.label}
                  onPress={() => selectTab(item.id)}
                  style={({ pressed }) => [
                    s.tab,
                    activeTab === item.id && shell.selectedTab,
                    pressed && { opacity: 0.65 },
                  ]}
                >
                  <Icon
                    name={item.icon}
                    size={22}
                    color={activeTab === item.id ? colors.action : colors.secondary}
                  />
                  <Text style={[s.tabLabel, activeTab === item.id && s.tabActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </SafeAreaView>
        {session && <SidebarNavigation visible={sidebarClient === api} route={route} tab={activeTab}
          onClose={() => setSidebarClient(current => current === api ? null : current)}
          onSelect={destination => {
            if (destination.kind === 'tab') selectTab(destination.tab);
            else navigate(destination.route);
          }} />}
      </View>
      </GrowthProvider>
      </LocationProvider>
    </AppProvider>
  );
}
const shell = StyleSheet.create({
  hiddenHeader: { display: 'none' },
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  sidebarMenuButton: { width: 40, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  sidebarChatTitle: { minHeight: 44, flexShrink: 1, justifyContent: 'center' },
  brand: { marginLeft: 5 },
  chatTitle: { flex: 1, textAlign: 'center', color: chatAppearance.ink, fontSize: 17, fontWeight: '500' },
  chatCanvas: { backgroundColor: chatAppearance.background },
  chatHeader: { minHeight: 60, paddingHorizontal: 20, paddingVertical: 4, marginBottom: 0, backgroundColor: 'transparent' },
  chatBrand: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  chatHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chatHeaderButton: { width: 44, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  selectedTab: {
    backgroundColor: 'rgba(234,241,255,0.85)',
  },
});
export default function App() {
  return (
    <SafeAreaProvider>
      <Application />
    </SafeAreaProvider>
  );
}

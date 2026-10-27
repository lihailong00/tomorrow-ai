import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ApiClient, normalizeServerUrl } from './src/api/client';
import { AppProvider, MainTab, Route } from './src/app/context';
import { useForegroundNotifications } from './src/app/notifications';
import type { AuthSession } from './src/domain/types';
import { readableDate } from './src/domain/types';
import { platform, Preferences, defaultServerUrl } from './src/platform/ports';
import { AuthScreen, IntroScreen, SettingsScreen } from './src/screens/Account';
import {
  CapabilitiesScreen,
  HomeScreen,
  MemoriesScreen,
  TasksScreen,
} from './src/screens/Main';
import { ChatScreen, ConversationsScreen } from './src/screens/Chat';
import { UploadsScreen } from './src/screens/Uploads';
import { IntegrationsScreen } from './src/features/integrations/IntegrationsScreen';
import { appInputs } from './src/platform/appInputs';
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
import { AmbientBackground, AssistantOrb, Icon } from './src/ui/visuals';

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
  const [routes, setRoutes] = useState<Route[]>([{ name: 'main' }]);
  const [revision, setRevision] = useState(0);
  const [pendingInputs, setPendingInputs] = useState(0);
  const inputCleanup = useRef<Promise<void>>(Promise.resolve());
  const route = routes[routes.length - 1];
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
  }, [session?.user.id, route.name, revision]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const prefs = await platform.loadPreferences();
      try {
        prefs.serverUrl = normalizeServerUrl(prefs.serverUrl);
      } catch {
        prefs.serverUrl = defaultServerUrl;
      }
      if (!alive) {
        return;
      }
      setPreferences(prefs);
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
          };
          if (
            saved.serverUrl === prefs.serverUrl &&
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
      if (!restored) { await clearInputs(); }
    })()
      .catch(() => {})
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
    void clearInputs();
    activeToken.current = undefined;
    setSession(null);
    setExpired(true);
    setRoutes([{ name: 'main' }]);
    platform.removeSession().catch(() => {});
  }, [clearInputs]);
  const api = useMemo(() => {
    const token = session?.token;
    return new ApiClient(preferences.serverUrl, token, () => {
      // A delayed response from the previous account must not log out the new one.
      if (activeToken.current === token) {
        unauthorized();
      }
    });
  }, [preferences.serverUrl, session?.token, unauthorized]);
  useForegroundNotifications(api, session?.user.id);
  const navigate = useCallback(
    (next: Route) => setRoutes(old => [...old, next]),
    [],
  );
  const back = useCallback(
    () => setRoutes(old => (old.length > 1 ? old.slice(0, -1) : old)),
    [],
  );
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (routes.length > 1) {
        back();
        return true;
      }
      if (session && tab !== 'today') {
        setTab('today');
        return true;
      }
      return false;
    });
    return () => listener.remove();
  }, [routes.length, tab, session, back]);
  const savePreferences = async (next: Preferences) => {
    await platform.savePreferences(next);
    if (next.serverUrl !== preferences.serverUrl) {
      await clearInputs();
      activeToken.current = undefined;
      await platform.removeSession();
      setSession(null);
      setRoutes([{ name: 'main' }]);
    }
    setPreferences(next);
  };
  const signIn = async (next: AuthSession) => {
    // An expired account's local notification queue must be cleared before the
    // next account can use a new session, including a previously failed cleanup.
    await inputCleanup.current.catch(() => clearInputs());
    activeToken.current = next.token;
    try {
      await platform.writeSession(
        JSON.stringify({ ...next, serverUrl: preferences.serverUrl }),
      );
    } catch (error) {
      activeToken.current = undefined;
      throw error;
    }
    setSession(next);
    setExpired(false);
    setAuthNotice('');
    setTab('today');
    setRoutes([{ name: 'main' }]);
  };
  const signOut = async () => {
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
    setRoutes([{ name: 'main' }]);
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
  if (route.name === 'settings') {
    page = <SettingsScreen />;
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
        page = (
          <ChatScreen
            key={String(routes.length) + (route.conversationId ?? 'new')}
            conversationId={route.conversationId}
            prompt={route.prompt}
          />
        );
        break;
      case 'task':
        page = <TaskDetailScreen id={route.id} />;
        break;
      case 'newTask':
        page = <NewTaskScreen />;
        break;
      case 'memory':
        page = <MemoryEditor memory={route.memory} />;
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
      case 'integrations':
        page = <IntegrationsScreen />;
        break;
      case 'conversations':
        page = <ConversationsScreen />;
        break;
      default:
        page =
          tab === 'today' ? (
            <HomeScreen onTasks={() => setTab('tasks')} />
          ) : tab === 'tasks' ? (
            <TasksScreen />
          ) : tab === 'memories' ? (
            <MemoriesScreen />
          ) : (
            <CapabilitiesScreen />
          );
    }
  }
  const main = route.name === 'main';
  const tabs: Array<{
    id: MainTab;
    label: string;
    icon: React.ComponentProps<typeof Icon>['name'];
  }> = [
    { id: 'today', label: '今日', icon: 'today' },
    { id: 'tasks', label: '任务', icon: 'tasks' },
    { id: 'memories', label: '记忆', icon: 'memory' },
    { id: 'capabilities', label: '能力', icon: 'sparkles' },
  ];
  return (
    <AppProvider
      key={`${preferences.serverUrl}:${session?.user.id ?? 'signed-out'}`}
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
            JSON.stringify({ ...updated, serverUrl: preferences.serverUrl }),
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
      <View style={s.screen}>
        <AmbientBackground />
        <SafeAreaView style={shell.safeArea} edges={['top', 'bottom']}>
          <StatusBar
            barStyle="dark-content"
            backgroundColor={colors.background}
          />
          <View style={s.header}>
            {main ? (
              <View style={s.row}>
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
            {route.name === 'chat' ? (
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
                onPress={() => navigate({ name: 'settings' })}
              />
            )}
          </View>
          {session && pendingInputs > 0 && route.name !== 'integrations' && (
            <Pressable accessibilityRole="button" accessibilityLabel="查看待接收的手机资料"
              onPress={() => navigate({ name: 'integrations' })}
              style={{ marginHorizontal: 20, marginBottom: 8, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 18, backgroundColor: '#EAF1FF' }}>
              <Text style={{ color: colors.accent }}>有 {pendingInputs} 条手机资料待接收 · 查看并确认</Text>
            </Pressable>
          )}
          <KeyboardAvoidingView
            style={s.fill}
            behavior={platform.keyboardBehavior}
          >
            {page}
          </KeyboardAvoidingView>
          {session && main && (
            <View style={shell.dockArea}>
              <View style={shell.dock}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="我的附件"
                  onPress={() => navigate({ name: 'uploads' })}
                  style={shell.dockButton}
                >
                  <Icon name="plus" size={23} color={colors.secondary} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="和助手聊聊，打开文字与语音对话"
                  onPress={() => navigate({ name: 'chat' })}
                  style={shell.dockPrompt}
                >
                  <Text style={shell.dockText} numberOfLines={1}>
                    有什么想一起做的？
                  </Text>
                  <View style={shell.dockMic}>
                    <Icon name="mic" size={21} color={colors.accent} />
                  </View>
                </Pressable>
              </View>
            </View>
          )}
          {session && main && (
            <View style={s.tabs} accessibilityRole="tablist">
              {tabs.map(item => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: item.id === tab }}
                  accessibilityLabel={item.label}
                  onPress={() => setTab(item.id)}
                  style={({ pressed }) => [
                    s.tab,
                    tab === item.id && shell.selectedTab,
                    pressed && { opacity: 0.65 },
                  ]}
                >
                  <Icon
                    name={item.icon}
                    size={22}
                    color={tab === item.id ? colors.action : colors.secondary}
                  />
                  <Text style={[s.tabLabel, tab === item.id && s.tabActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </SafeAreaView>
      </View>
    </AppProvider>
  );
}
const shell = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: 'transparent' },
  brand: { marginLeft: 5 },
  chatTitle: { color: colors.ink, fontSize: 17, fontWeight: '500' },
  selectedTab: {
    backgroundColor: 'rgba(234,241,255,0.85)',
  },
  dockArea: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 8 },
  dock: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    padding: 5,
    borderRadius: 32,
    borderWidth: 1,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(255,255,255,0.92)',
    shadowColor: '#61739A',
    shadowOffset: { width: 0, height: 5 },
    shadowRadius: 15,
    shadowOpacity: 0.08,
    elevation: 2,
  },
  dockButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockPrompt: {
    flex: 1,
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dockText: { flex: 1, fontSize: 14, color: colors.secondary },
  dockMic: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EDF3FE',
    borderRadius: 24,
  },
});
export default function App() {
  return (
    <SafeAreaProvider>
      <Application />
    </SafeAreaProvider>
  );
}

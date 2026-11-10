import React from 'react';
import {
  Appearance,
  DeviceEventEmitter,
  Dimensions,
  StyleSheet,
  TextInput,
} from 'react-native';
import {
  act,
  create,
  ReactTestInstance,
  ReactTestRenderer,
} from 'react-test-renderer';
import App from '../App';
import { ChatScreen } from '../src/screens/Chat';
import { chatAppearance } from '../src/ui/ChatAppearance';
import { colors } from '../src/ui/theme';

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: require('react-native').View,
}));
jest.mock('../src/platform/ports', () => ({
  defaultServerUrl: 'https://test',
  platform: {
    updateRideNotification: jest.fn().mockResolvedValue(undefined),
    loadPreferences: jest.fn().mockResolvedValue({
      serverUrl: 'https://test',
      onboarded: true,
      instance: { id: 'test' },
    }),
    readSession: jest.fn().mockResolvedValue(
      JSON.stringify({
        serverUrl: 'https://test',
        instanceId: 'test',
        token: 'test-token',
        user: { id: 'user', name: 'Tester' },
      }),
    ),
    onForeground: () => () => {},
    initialConnectionLink: jest.fn().mockResolvedValue(null),
    onConnectionLink: () => () => {},
  },
}));
jest.mock('../src/api/client', () => ({
  normalizeServerUrl: (url: string) => url,
  newRequestId: () => 'request',
  errorMessage: (failure: unknown) => failure instanceof Error ? failure.message : '请求失败',
  ApiClient: jest.fn().mockImplementation(() => ({
    request: jest.fn().mockImplementation(async (path: string, method = 'GET') => {
      if (path === '/memory/preferences' && method === 'GET') {
        return { enabled: false, configured: false };
      }
      throw new Error(`Unexpected API fixture request: ${method} ${path}`);
    }),
    capabilities: jest
      .fn()
      .mockResolvedValue({ runtime: { model_mode: 'local' } }),
    dispose: jest.fn(),
  })),
}));
jest.mock('../src/api/instance', () => ({
  createInstanceIdentityGuard: () => ({
    verify: jest.fn(),
    invalidate: jest.fn(),
    dispose: jest.fn(),
  }),
}));
jest.mock('../src/platform/appInputs', () => ({
  appInputs: { getStatus: jest.fn().mockResolvedValue({ pending_count: 0 }) },
}));
jest.mock('../src/platform/photoIndex', () => ({ photoIndex: {} }));
jest.mock('../src/app/notifications', () => ({
  useForegroundNotifications: jest.fn(),
}));
jest.mock('../src/ui/visuals', () => ({
  AssistantOrb: () => null,
  AmbientBackground: () => require('react').createElement(require('react-native').View, { testID: 'approved-ambient-marker' }),
  Icon: () => null,
}));
jest.mock('../src/screens/Main', () => ({
  HomeScreen: () => {
    const { createElement } = require('react');
    const { navigate } = require('../src/app/context').useApp();
    const { Pressable } = require('react-native');
    return createElement(Pressable, {
      accessibilityLabel: '打开测试对话',
      onPress: () => navigate({ name: 'chat' }),
    });
  },
  ModeNotice: () => null,
  usePagedList: () => ({ items: [], loading: false, hasMore: false }),
}));
jest.mock('../src/screens/Account', () => ({}));
jest.mock('../src/screens/Details', () => ({}));
jest.mock('../src/screens/Uploads', () => ({}));
jest.mock('../src/features/integrations/IntegrationsScreen', () => ({}));
jest.mock('../src/features/ai-history/AiHistoryScreen', () => ({}));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});

const button = (root: ReactTestInstance, label: string) =>
  root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  )[0];

test('unified fixed-light palette keeps the home ambient surface in chat even when the system is dark', async () => {
  expect(chatAppearance).toMatchObject({ background: '#F5F6FA', surface: '#FFFFFF', ink: '#303849', secondary: '#657083', line: '#E6EAF2', accent: '#416CCB', onAccent: '#FFFFFF', keyboard: '#EEEFF6' });
  const systemTheme = jest.spyOn(Appearance, 'getColorScheme').mockReturnValue('dark');
  const setSystemTheme = jest.spyOn(Appearance, 'setColorScheme');
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(<App />); });
    const ambientCount = tree.root.findAll(n => n.props.testID === 'approved-ambient-marker').length;
    expect(ambientCount).toBeGreaterThan(0);
    await act(async () => button(tree.root, '打开测试对话').props.onPress());
    expect(tree.root.findAll(n => n.props.testID === 'approved-ambient-marker')).toHaveLength(ambientCount);
    const header = tree.root.findAll(n => n.props.testID === 'application-header')[0];
    expect(StyleSheet.flatten(header.props.style)).toMatchObject({ backgroundColor: 'transparent', minHeight: 60, paddingHorizontal: 20 });
    for (const label of ['返回', '开启新对话', '历史对话']) {
      const control = button(header, label);
      expect(control.props.accessibilityRole).toBe('button');
      expect(StyleSheet.flatten(control.props.style)).toMatchObject({ width: 44, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.7)' });
    }
    const chat = tree.root.findByType(ChatScreen);
    const root = chat.findAll(n => typeof n.props.onLayout === 'function')[0];
    expect(StyleSheet.flatten(root.props.style).backgroundColor).toBe('transparent');
    expect(setSystemTheme).not.toHaveBeenCalled();
    const field = tree.root.findByType(TextInput);
    await act(async () => field.props.onChangeText('Unsent approved draft'));
    const composer = tree.root.findAll(n => n.props.testID === 'unified-input-bar')[0];
    expect(StyleSheet.flatten(composer.props.style)).toMatchObject({ backgroundColor: 'rgba(255,255,255,0.92)', borderColor: '#FFFFFF', borderRadius: 30 });
    const send = button(tree.root, '发送消息');
    expect(StyleSheet.flatten(send.props.style).backgroundColor).toBe('#416CCB');
    const labels = tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children).join(' ');
    expect(labels).not.toContain('记忆由你主动添加'); expect(labels).not.toContain('交互演示');
    await act(async () => button(tree.root, '返回').props.onPress());
    expect(tree.root.findAll(n => n.props.testID === 'approved-ambient-marker').length).toBeGreaterThan(0);
    expect(colors.background).toBe('#F5F6FA'); expect(colors.action).toBe('#416CCB');
  } finally {
    if (tree) await act(async () => tree.unmount());
    systemTheme.mockRestore(); setSystemTheme.mockRestore();
  }
});

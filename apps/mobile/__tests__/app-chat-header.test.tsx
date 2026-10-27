import React from 'react';
import {
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

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: require('react-native').View,
}));
jest.mock('../src/platform/ports', () => ({
  defaultServerUrl: 'https://test',
  platform: {
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
  ApiClient: jest.fn().mockImplementation(() => ({
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
  AmbientBackground: () => null,
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

test('a short keyboard viewport moves navigation into the composer and restores its header without remounting the draft', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    DeviceEventEmitter.emit('keyboardDidHide');
    Dimensions.set({
      window: { width: 360, height: 640, scale: 2.75, fontScale: 2 },
    });
    tree = create(<App />);
  });
  const node = (id: string) =>
    tree.root.findAll(candidate => candidate.props.testID === id)[0];
  const layout = async (height: number) =>
    act(async () => {
      node('application-shell').props.onLayout({
        nativeEvent: { layout: { height } },
      });
    });
  const composer = () => node('chat-composer-scroll');
  const headerHidden = () =>
    StyleSheet.flatten(node('application-header').props.style).display ===
    'none';
  try {
    await layout(600);
    await act(async () => button(tree.root, '打开测试对话').props.onPress());
    await act(async () =>
      tree.root.findByType(TextInput).props.onChangeText('Keep my live draft.'),
    );
    const originalInput = tree.root.findByType(TextInput);
    expect(headerHidden()).toBe(false);

    // A short shell alone does not hide navigation without a visible keyboard.
    await layout(124);
    expect(headerHidden()).toBe(false);
    await act(async () =>
      DeviceEventEmitter.emit('keyboardDidShow', {
        endCoordinates: { screenX: 0, screenY: 124, width: 568, height: 196 },
      }),
    );
    expect(headerHidden()).toBe(true);
    expect(button(composer(), '返回')).toBeDefined();
    expect(button(composer(), '历史对话')).toBeDefined();
    expect(tree.root.findByType(TextInput)).toBe(originalInput);
    expect(originalInput.props.value).toBe('Keep my live draft.');

    // Header visibility cannot change its own whole-shell measurement.
    await layout(124);
    expect(headerHidden()).toBe(true);
    await layout(300);
    expect(headerHidden()).toBe(false);
    expect(tree.root.findByType(TextInput)).toBe(originalInput);
    await layout(124);
    expect(headerHidden()).toBe(true);
    await act(async () => DeviceEventEmitter.emit('keyboardDidHide'));
    expect(headerHidden()).toBe(false);
    expect(tree.root.findByType(TextInput)).toBe(originalInput);
    expect(originalInput.props.value).toBe('Keep my live draft.');

    await act(async () =>
      DeviceEventEmitter.emit('keyboardDidShow', { endCoordinates: {} }),
    );
    await act(async () => button(composer(), '历史对话').props.onPress());
    expect(tree.root.findAllByType(ChatScreen)).toHaveLength(0);
    expect(headerHidden()).toBe(false);
    await act(async () => button(tree.root, '返回').props.onPress());
    expect(tree.root.findAllByType(ChatScreen)).toHaveLength(1);
    await act(async () => button(composer(), '返回').props.onPress());
    expect(tree.root.findAllByType(ChatScreen)).toHaveLength(0);
    expect(button(tree.root, '打开测试对话')).toBeDefined();
  } finally {
    await act(async () => tree.unmount());
    DeviceEventEmitter.emit('keyboardDidHide');
  }
});

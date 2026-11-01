import React from 'react';
import {
  BackHandler,
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
  AmbientBackground: () => null,
  Icon: () => null,
}));
jest.mock('../src/screens/Main', () => ({
  HomeScreen: () => {
    const { createElement } = require('react');
    const { navigate } = require('../src/app/context').useApp();
    const { Pressable, View } = require('react-native');
    return createElement(View, null,
      createElement(Pressable, {
        accessibilityLabel: '打开测试对话',
        onPress: () => navigate({ name: 'chat' }),
      }),
      createElement(Pressable, {
        accessibilityLabel: '打开测试连接',
        onPress: () => navigate({ name: 'integrations' }),
      }),
    );
  },
  ModeNotice: () => null,
  usePagedList: () => ({ items: [], loading: false, hasMore: false }),
}));
jest.mock('../src/screens/Account', () => ({}));
jest.mock('../src/screens/Details', () => ({}));
jest.mock('../src/screens/Uploads', () => ({}));
jest.mock('../src/features/integrations/IntegrationsScreen', () => ({
  IntegrationsScreen: ({ browseState, onBrowseStateChange }: any) => {
    const { createElement, useEffect, useState } = require('react');
    const { BackHandler: NativeBackHandler, Pressable, View } = require('react-native');
    const { back, navigate } = require('../src/app/context').useApp();
    const [localQuery, setLocalQuery] = useState(browseState?.query || '');
    useEffect(() => {
      const subscription = NativeBackHandler.addEventListener('hardwareBackPress', () => {
        if (localQuery) {
          setLocalQuery('');
          onBrowseStateChange?.({ ...browseState, query: '' });
        } else back();
        return true;
      });
      return () => subscription.remove();
    }, [localQuery, back, browseState, onBrowseStateChange]);
    return createElement(View, null,
      createElement(View, { accessibilityLabel: '连接分类：' + (browseState?.category || 'unknown') + '，搜索：' + localQuery }),
      createElement(Pressable, {
        accessibilityLabel: '浏览设备并打开健康测试',
        onPress: () => {
          onBrowseStateChange?.({ category: 'devices', query: '华为', managing: false });
          navigate({ name: 'health' });
        },
      }),
      createElement(Pressable, {
        accessibilityLabel: '返回连接入口',
        onPress: back,
      }),
    );
  },
}));
jest.mock('../src/features/health/HealthScreen', () => ({
  HealthScreen: () => {
    const { createElement } = require('react');
    const { Pressable } = require('react-native');
    const { back } = require('../src/app/context').useApp();
    return createElement(Pressable, { accessibilityLabel: '返回设备连接测试', onPress: back });
  },
}));
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

test('the connection centre owns one navigation header and restores the application header on return', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<App />); });
  try {
    expect(tree.root.findAll(node => node.props.testID === 'application-header').length).toBeGreaterThan(0);
    await act(async () => button(tree.root, '打开测试连接').props.onPress());
    expect(tree.root.findAll(node => node.props.testID === 'application-header')).toHaveLength(0);
    expect(button(tree.root, '返回连接入口')).toBeDefined();
    await act(async () => button(tree.root, '返回连接入口').props.onPress());
    expect(tree.root.findAll(node => node.props.testID === 'application-header').length).toBeGreaterThan(0);
    expect(button(tree.root, '打开测试连接')).toBeDefined();
  } finally {
    await act(async () => tree.unmount());
  }
});

test('returning from health restores connection browsing without retaining it after the route is closed', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<App />); });
  const hasBrowse = (label: string) => tree.root.findAll(node => node.props.accessibilityLabel === label).length > 0;
  try {
    await act(async () => button(tree.root, '打开测试连接').props.onPress());
    expect(hasBrowse('连接分类：local，搜索：')).toBe(true);
    await act(async () => button(tree.root, '浏览设备并打开健康测试').props.onPress());
    await act(async () => button(tree.root, '返回设备连接测试').props.onPress());
    expect(hasBrowse('连接分类：devices，搜索：华为')).toBe(true);
    await act(async () => button(tree.root, '返回连接入口').props.onPress());
    await act(async () => button(tree.root, '打开测试连接').props.onPress());
    expect(hasBrowse('连接分类：local，搜索：')).toBe(true);
  } finally {
    await act(async () => tree.unmount());
  }
});

test('hardware back lets the remounted connection screen clear its query before leaving the route', async () => {
  const listeners: { active: boolean; handler: () => boolean | null | undefined }[] = [];
  const subscribe = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    const entry = { active: true, handler };
    listeners.push(entry);
    return { remove: () => { entry.active = false; } };
  });
  const pressBack = () => {
    for (const listener of [...listeners].reverse()) {
      if (listener.active && listener.handler()) return true;
    }
    return false;
  };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<App />); });
  try {
    await act(async () => button(tree.root, '打开测试连接').props.onPress());
    await act(async () => button(tree.root, '浏览设备并打开健康测试').props.onPress());
    await act(async () => button(tree.root, '返回设备连接测试').props.onPress());
    expect(tree.root.findAll(node => node.props.accessibilityLabel === '连接分类：devices，搜索：华为').length).toBeGreaterThan(0);
    await act(async () => { expect(pressBack()).toBe(true); });
    expect(button(tree.root, '返回连接入口')).toBeDefined();
    expect(tree.root.findAll(node => node.props.accessibilityLabel === '连接分类：devices，搜索：').length).toBeGreaterThan(0);
    await act(async () => { expect(pressBack()).toBe(true); });
    expect(button(tree.root, '打开测试连接')).toBeDefined();
  } finally {
    await act(async () => tree.unmount());
    subscribe.mockRestore();
  }
});

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

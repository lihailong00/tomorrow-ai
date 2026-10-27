import React from 'react';
import { Text } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, AppContextValue } from '../src/app/context';
import { SettingsScreen } from '../src/screens/Account';
import { platform } from '../src/platform/ports';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  defaultServerUrl: 'https://example.test',
  platform: { manageNotificationPermission: jest.fn(), openNotificationSettings: jest.fn() },
}));
jest.mock('../src/features/photo-index/PhotoIndexSettings', () => ({ PhotoIndexSettings: () => null }));
jest.mock('../src/features/instances/InstanceConnectionCard', () => ({ InstanceConnectionCard: () => null }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null, AssistantOrb: () => null }));

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => jest.clearAllMocks());

it('shows a direct system settings action after permanent denial without requesting on mount', async () => {
  (platform.manageNotificationPermission as jest.Mock).mockResolvedValue('blocked');
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AppProvider value={{ api: { baseUrl: 'https://example.test' },
      user: { id: 'user', name: 'QA', timezone: 'Asia/Shanghai' },
      preferences: { serverUrl: 'https://example.test' },
    } as unknown as AppContextValue}><SettingsScreen /></AppProvider>);
  });
  expect(platform.manageNotificationPermission).not.toHaveBeenCalled();
  const button = (label: string) => tree.root.findAllByType(Button).find(node => node.props.children === label)!;
  await act(async () => button('管理通知权限').props.onPress());
  expect(tree.root.findAllByType(Text).map(node => node.props.children).join('\n')).toContain('系统已停止弹出通知授权');
  await act(async () => button('打开系统通知设置').props.onPress());
  expect(platform.openNotificationSettings).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

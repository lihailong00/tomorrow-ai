import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { inspectInstance } from '../src/api/instance';
import { connectionFromLink, instanceServerUrl, InstanceManifest } from '../src/domain/instance';
import { AppProvider, AppContextValue } from '../src/app/context';
import { AuthScreen } from '../src/screens/Account';
import { InstanceConnectionCard } from '../src/features/instances/InstanceConnectionCard';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  defaultServerUrl: 'https://official.test',
  platform: { hasSecureStorage: true },
}));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const manifest: InstanceManifest = {
  id: 'own-instance', name: '家里的妥啦', deployment_mode: 'self_hosted', api_version: 1,
  auth_methods: ['email_password'], registration_policy: 'open', public_url: 'https://own.test',
  dataflow: { conversation: '家庭服务器本地模型', voice: '未配置', images: '家庭图片模型', files: '本机磁盘' },
};
const response = (data: unknown, extra = {}) => ({
  ok: true, status: 200, redirected: false, text: async () => JSON.stringify(data), ...extra,
} as Response);

describe('server identity and transport', () => {
  it('checks a manifest anonymously without following redirects', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(manifest));
    const result = await inspectInstance('https://OWN.test/v1/', { expectedId: 'own-instance', fetcher });
    expect(result.serverUrl).toBe('https://own.test');
    expect(fetcher).toHaveBeenCalledWith('https://own.test/v1/instance', expect.objectContaining({
      credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' },
    }));
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it('blocks a changed identity before sending any account token', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ ...manifest, id: 'replacement' }));
    const accountFetcher = jest.fn();
    const api = new ApiClient('https://own.test', 'private-session', undefined, accountFetcher,
      async () => { await inspectInstance('https://own.test', { expectedId: manifest.id, fetcher }); });
    await expect(api.me()).rejects.toThrow('身份已变化');
    expect(accountFetcher).not.toHaveBeenCalled();
  });
  it('blocks incompatible or redirected servers', async () => {
    await expect(inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response({ ...manifest, api_version: 2 })) })).rejects.toThrow('不兼容');
    await expect(inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response(manifest, { redirected: true })) })).rejects.toThrow('跳转');
  });
  it('never falls back to the official server when the custom server is offline', async () => {
    const fetcher = jest.fn().mockRejectedValue(new TypeError('offline'));
    await expect(inspectInstance('https://own.test', { fetcher })).rejects.toThrow('不会切换');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://own.test/v1/instance');
  });
  it('requires explicit LAN consent and rejects public plaintext or secret-bearing addresses', () => {
    expect(() => instanceServerUrl('http://192.168.1.8:8080')).toThrow('高级选项');
    expect(instanceServerUrl('http://192.168.1.8:8080', true)).toBe('http://192.168.1.8:8080');
    for (const url of ['http://example.com', 'https://user:secret@own.test', 'https://own.test?key=x', 'https://own.test/path']) {
      expect(() => instanceServerUrl(url, true)).toThrow();
    }
  });
  it('accepts only a nonsecret connection proposal, rejecting extra or duplicate parameters', () => {
    expect(connectionFromLink('tada://connect?url=https%3A%2F%2Fown.test&instance=own-instance')).toEqual({ url: 'https://own.test', instanceId: manifest.id });
    expect(() => connectionFromLink('tada://connect?url=https%3A%2F%2Fown.test&instance=own-instance&token=secret')).toThrow('不支持');
    expect(() => connectionFromLink('tada://connect?url=a&url=b&instance=own-instance')).toThrow('不支持');
  });
  it('cancels an in-flight upload and refuses later work on the old API instance', async () => {
    let signal!: AbortSignal;
    const fetcher = jest.fn((_url, init) => {
      signal = init.signal;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' }))));
    });
    const api = new ApiClient('https://own.test', 'old-token', undefined, fetcher);
    const request = api.request('/uploads', 'POST', { title: 'old data' });
    api.dispose();
    expect(signal.aborted).toBe(true);
    await expect(request).rejects.toBeInstanceOf(Error);
    await expect(api.me()).rejects.toMatchObject({ code: 'connection_required' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

async function screen(element: React.ReactNode, instance = manifest, extra = {}) {
  const api = { login: jest.fn().mockResolvedValue({ token: 'session', user: { id: 'u' } }),
    register: jest.fn().mockResolvedValue({ token: 'session', user: { id: 'u' } }),
    loginWithPhone: jest.fn(), requestPhoneCode: jest.fn() };
  const signIn = jest.fn().mockResolvedValue(undefined);
  const savePreferences = jest.fn().mockResolvedValue(undefined);
  const navigate = jest.fn();
  const context = { api, signIn, savePreferences, navigate, user: null,
    preferences: { serverUrl: 'https://own.test', serverUrlCustomized: true, onboarded: true, instance }, ...extra } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}>{element}</AppProvider>); });
  const button = (label: string) => tree.root.findAllByType(Button).find(n => n.props.children === label);
  return { api, signIn, savePreferences, navigate,
    field: (label: string) => tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === label),
    text: () => tree.root.findAllByType(Text).map(n => n.props.children).flat().join('\n'),
    button,
    press: async (label: string) => { await act(async () => { await button(label)!.props.onPress(); }); },
    input: async (label: string, value: string) => { await act(async () => {
      tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === label)!.props.onChangeText(value);
    }); },
    close: async () => { await act(async () => tree.unmount()); },
  };
}

describe('self-hosted phone UI', () => {
  it('logs in with email and password without any SMS', async () => {
    const view = await screen(<AuthScreen expired={false} />);
    expect(view.text()).toContain('邮箱密码登录');
    expect(view.field('验证码')).toBeUndefined();
    await view.input('邮箱', 'me@example.com'); await view.input('密码', 'a good password');
    await view.press('登录');
    expect(view.api.login).toHaveBeenCalledWith('me@example.com', 'a good password');
    expect(view.api.requestPhoneCode).not.toHaveBeenCalled(); expect(view.api.loginWithPhone).not.toHaveBeenCalled();
    await view.close();
  });
  it('requires an invitation for private registration and sends it only to registration', async () => {
    const view = await screen(<AuthScreen expired={false} />, { ...manifest, registration_policy: 'invite_only' });
    await view.press('创建账号'); await view.input('邮箱', 'me@example.com');
    await view.input('密码', 'valid password'); await view.input('确认密码', 'valid password');
    await view.press('创建账号'); expect(view.api.register).not.toHaveBeenCalled();
    await view.input('邀请码', 'invited-user-code'); await view.press('创建账号');
    expect(view.api.register).toHaveBeenCalledWith('me@example.com', 'valid password', '', 'Asia/Shanghai', 'invited-user-code');
    await view.close();
  });
  it('does not show signup when the server is closed', async () => {
    const view = await screen(<AuthScreen expired={false} />, { ...manifest, registration_policy: 'closed' });
    expect(view.button('创建账号')).toBeUndefined(); expect(view.text()).toContain('管理员创建账号');
    await view.close();
  });
  it('only saves a scanned server after checking identity and explicitly confirming', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = jest.fn().mockResolvedValue(response(manifest));
    try {
      const view = await screen(<InstanceConnectionCard />, manifest, {
        preferences: { serverUrl: 'https://official.test', onboarded: true,
          pendingConnection: { url: 'https://own.test', instanceId: manifest.id } },
      });
      expect(view.savePreferences).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
      await view.press('检查服务器');
      expect(view.text()).toContain('家庭服务器本地模型');
      expect(view.savePreferences).not.toHaveBeenCalled();
      await view.press('连接这台服务器');
      expect(view.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://own.test', instance: manifest }));
      await view.close();
    } finally { globalThis.fetch = originalFetch; }
  });
});

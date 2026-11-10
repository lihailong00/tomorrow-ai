import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient } from '../src/api/client';
import { inspectInstance } from '../src/api/instance';
import { connectionFromLink, instanceServerUrl, InstanceManifest } from '../src/domain/instance';
import { AppProvider, AppContextValue } from '../src/app/context';
import { AuthScreen, SettingsScreen } from '../src/screens/Account';
import { version as appVersion } from '../package.json';
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
  it.each([null, undefined])('accepts an optional absent public URL without changing the selected endpoint: %s', async publicUrl => {
    const fetcher = jest.fn().mockResolvedValue(response({ ...manifest, public_url: publicUrl }));
    const result = await inspectInstance('https://own.test', { expectedId: manifest.id, fetcher });
    expect(result.serverUrl).toBe('https://own.test');
    expect(result.instance.public_url).toBe('');
    expect(result.instance.id).toBe(manifest.id);
  });
  it.each([42, false, {}, []])('rejects a malformed optional public URL: %s', async publicUrl => {
    await expect(inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response({
      ...manifest, public_url: publicUrl,
    })) })).rejects.toThrow('不兼容');
  });
  it('accepts the deployed structured dataflow without weakening identity validation', async () => {
    const deployed = { ...manifest, dataflow: {
      conversation: { processor: 'configured_provider', destination: 'api.deepseek.com' },
      voice: { processor: 'configured_provider', destination: 'dashscope.aliyuncs.com' },
      images: { processor: 'disabled', destination: null },
      files: { processor: 'this_server', destination: null },
      official_server_fallback: false,
    } };
    const result = await inspectInstance('https://own.test', { expectedId: manifest.id,
      fetcher: jest.fn().mockResolvedValue(response(deployed)) });
    expect(result.instance.dataflow).toEqual({ conversation: 'api.deepseek.com', voice: 'dashscope.aliyuncs.com',
      images: '未启用', files: '当前服务器' });
    await expect(inspectInstance('https://own.test', { expectedId: 'another-instance',
      fetcher: jest.fn().mockResolvedValue(response(deployed)) })).rejects.toThrow('身份已变化');
  });
  it('rejects malformed structured dataflow instead of hiding unknown destinations', async () => {
    for (const entry of [{ processor: 'unknown', destination: null },
      { processor: 'configured_provider', destination: null },
      { processor: 'configured_provider', destination: 'https://user:secret@example.test' },
      { processor: 'disabled', destination: 'somewhere.test' }]) {
      await expect(inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response({
        ...manifest, dataflow: { ...manifest.dataflow, conversation: entry },
      })) })).rejects.toThrow('不兼容');
    }
  });
  it('normalizes optional text embedding destinations while preserving four-field legacy manifests', async () => {
    const legacy = await inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response(manifest)) });
    expect(legacy.instance.dataflow.embeddings).toBeUndefined();
    for (const [entry, description] of [
      [{ processor: 'configured_provider', destination: 'vectors.example.test' }, 'vectors.example.test'],
      [{ processor: 'disabled', destination: null }, '未启用'],
      ['本机向量服务', '本机向量服务'],
    ]) {
      const current = await inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response({
        ...manifest, dataflow: { ...manifest.dataflow, embeddings: entry },
      })) });
      expect(current.instance.dataflow.embeddings).toBe(description);
    }
    for (const entry of [null, {}, { processor: 'configured_provider', destination: 'https://user:secret@vectors.test' }]) {
      await expect(inspectInstance('https://own.test', { fetcher: jest.fn().mockResolvedValue(response({
        ...manifest, dataflow: { ...manifest.dataflow, embeddings: entry },
      })) })).rejects.toThrow('不兼容');
    }
  });
  it('checks a manifest anonymously without following redirects', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(manifest));
    const result = await inspectInstance('https://OWN.test/v1/', { expectedId: 'own-instance', fetcher });
    expect(result.serverUrl).toBe('https://own.test');
    expect(fetcher).toHaveBeenCalledWith('https://own.test/v1/instance', expect.objectContaining({
      credentials: 'omit', redirect: 'error', headers: expect.objectContaining({ Accept: 'application/json' }),
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
    loginWithPhone: jest.fn().mockResolvedValue({ token: 'phone-session', user: { id: 'phone-user' } }), requestPhoneCode: jest.fn() };
  const signIn = jest.fn().mockResolvedValue(undefined);
  const savePreferences = jest.fn().mockResolvedValue(undefined);
  const navigate = jest.fn();
  let context = { api, signIn, savePreferences, navigate, user: null,
    preferences: { serverUrl: 'https://own.test', serverUrlCustomized: true, onboarded: true, instance }, ...extra } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}>{element}</AppProvider>); });
  const button = (label: string) => tree.root.findAllByType(Button).find(n => n.props.children === label);
  return { api, signIn, savePreferences, navigate,
    field: (label: string) => tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === label),
    text: () => tree.root.findAllByType(Text).map(n => n.props.children).flat().join('\n'),
    button,
    press: async (label: string) => { await act(async () => { await button(label)!.props.onPress(); }); },
    revealDataflow: async () => { await act(async () => {
      tree.root.findAll(node => node.props.accessibilityLabel === '查看数据去向' && typeof node.props.onPress === 'function')[0].props.onPress();
    }); },
    input: async (label: string, value: string) => { await act(async () => {
      tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === label)!.props.onChangeText(value);
    }); },
    updateConnection: async (instance: InstanceManifest, serverUrl: string) => { await act(async () => {
      context = { ...context, preferences: { ...context.preferences, instance, serverUrl } };
      tree.update(<AppProvider value={context}>{element}</AppProvider>);
    }); },
    close: async () => { await act(async () => tree.unmount()); },
  };
}

describe('self-hosted phone UI', () => {
  const bothMethods: InstanceManifest = { ...manifest, auth_methods: ['email_password', 'phone_password'] };
  it('shows the current package version in settings', async () => {
    const view = await screen(<SettingsScreen />);
    expect(view.text()).toContain(`妥啦 · ${appVersion}`);
    await view.close();
  });
  it('shows the separate text embedding destination in connection settings', async () => {
    const view = await screen(<SettingsScreen />, { ...manifest,
      dataflow: { ...manifest.dataflow, embeddings: 'vectors.example.test' } });
    await view.revealDataflow();
    expect(view.text()).toContain('文字向量：\nvectors.example.test');
    await view.close();
  });
  it('allows a supported self-hosted phone account to log in without requesting SMS', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    expect(view.text()).toContain('邮箱密码登录');
    await view.input('邮箱', 'old@example.com'); await view.input('密码', 'email password');
    await view.press('使用手机号密码登录');
    expect(view.text()).toContain('手机号密码登录');
    expect(view.field('手机号 · +86')!.props.value).toBe('');
    expect(view.field('密码')!.props.value).toBe('');
    await view.input('手机号 · +86', '13800138000'); await view.input('密码', 'phone password');
    await view.press('登录');
    expect(view.api.loginWithPhone).toHaveBeenCalledWith('13800138000', 'phone password');
    expect(view.api.login).not.toHaveBeenCalled(); expect(view.api.requestPhoneCode).not.toHaveBeenCalled();
    expect(view.signIn).toHaveBeenCalledWith({ token: 'phone-session', user: { id: 'phone-user' } });
    await view.close();
  });
  it('discards credentials when choosing another supported login method', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    await view.press('使用手机号密码登录');
    await view.input('手机号 · +86', '13800138000'); await view.input('密码', 'phone password');
    await view.press('使用邮箱密码登录');
    expect(view.field('邮箱')!.props.value).toBe(''); expect(view.field('密码')!.props.value).toBe('');
    expect(view.api.login).not.toHaveBeenCalled(); expect(view.api.loginWithPhone).not.toHaveBeenCalled();
    await view.close();
  });
  it('blocks changing login method while an email sign-in is pending, including queued presses', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    let finish!: (session: unknown) => void;
    view.api.login.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await view.input('邮箱', 'me@example.com'); await view.input('密码', 'valid password');
    await act(async () => { void view.button('登录')!.props.onPress(); });
    expect(view.button('使用手机号密码登录')!.props.disabled).toBe(true);
    await view.press('使用手机号密码登录');
    expect(view.field('邮箱')).toBeDefined(); expect(view.field('手机号 · +86')).toBeUndefined();
    await act(async () => finish({ token: 'email-session', user: { id: 'email-user' } }));
    expect(view.signIn).toHaveBeenCalledTimes(1);
    await view.close();
  });
  it('blocks changing login method while a phone sign-in is pending', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    await view.press('使用手机号密码登录');
    let finish!: (session: unknown) => void;
    view.api.loginWithPhone.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await view.input('手机号 · +86', '13800138000'); await view.input('密码', 'valid password');
    await act(async () => { void view.button('登录')!.props.onPress(); });
    expect(view.button('使用邮箱密码登录')!.props.disabled).toBe(true);
    await view.press('使用邮箱密码登录');
    expect(view.field('手机号 · +86')).toBeDefined(); expect(view.field('邮箱')).toBeUndefined();
    await act(async () => finish({ token: 'phone-session', user: { id: 'phone-user' } }));
    expect(view.signIn).toHaveBeenCalledTimes(1);
    await view.close();
  });
  it('keeps the phone form mounted while an SMS challenge is being requested', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    await view.press('使用手机号密码登录'); await view.press('忘记密码');
    await view.input('手机号 · +86', '13800138000');
    let finish!: (challenge: unknown) => void;
    view.api.requestPhoneCode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { void view.button('获取验证码')!.props.onPress(); });
    expect(view.button('使用邮箱密码登录')!.props.disabled).toBe(true);
    await view.press('使用邮箱密码登录');
    expect(view.field('手机号 · +86')).toBeDefined(); expect(view.field('邮箱')).toBeUndefined();
    await act(async () => finish({ challenge_id: 'phone-code', expires_in: 300, retry_after: 60, test_mode: true }));
    expect(view.api.requestPhoneCode).toHaveBeenCalledTimes(1); expect(view.signIn).not.toHaveBeenCalled();
    await view.close();
  });
  it('keeps phone-only official and email-only instances free of unsupported switches', async () => {
    const phone = await screen(<AuthScreen expired={false} />, { ...manifest, deployment_mode: 'official', auth_methods: ['phone_password'] });
    expect(phone.text()).toContain('手机号密码登录');
    expect(phone.button('使用邮箱密码登录')).toBeUndefined(); await phone.close();
    const email = await screen(<AuthScreen expired={false} />);
    expect(email.text()).toContain('邮箱密码登录');
    expect(email.button('使用手机号密码登录')).toBeUndefined(); await email.close();
  });
  it('clears selected method and credentials when the confirmed server changes', async () => {
    const view = await screen(<AuthScreen expired={false} />, bothMethods);
    await view.press('使用手机号密码登录');
    await view.input('手机号 · +86', '13800138000'); await view.input('密码', 'old server password');
    await view.updateConnection({ ...bothMethods, id: 'second-instance' }, 'https://second.test');
    expect(view.text()).toContain('邮箱密码登录');
    expect(view.field('邮箱')!.props.value).toBe(''); expect(view.field('密码')!.props.value).toBe('');
    expect(view.api.login).not.toHaveBeenCalled(); expect(view.api.loginWithPhone).not.toHaveBeenCalled();
    await view.close();
  });
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
      await view.revealDataflow();
      expect(view.text()).toContain('家庭服务器本地模型');
      expect(view.savePreferences).not.toHaveBeenCalled();
      await view.press('连接这台服务器');
      expect(view.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://own.test', instance: manifest }));
      await view.close();
    } finally { globalThis.fetch = originalFetch; }
  });
});

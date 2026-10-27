import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AuthScreen } from '../src/screens/Account';
import { AppProvider, AppContextValue } from '../src/app/context';
import { ApiError } from '../src/api/client';
import { normalizePhoneNumber } from '../src/domain/phone';
import { validatePassword } from '../src/domain/password';
import { Button } from '../src/ui/components';

jest.mock('../src/platform/ports', () => ({
  platform: { hasSecureStorage: true },
}));
jest.mock('../src/ui/visuals', () => ({
  AssistantOrb: () => null,
  Icon: () => null,
}));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function setup() {
  const result = {
    token: 'account-a-token',
    user: {
      id: 'a',
      phone: '+8613800138000',
      email: '',
      name: '小林',
      timezone: 'Asia/Shanghai',
      created_at: '',
    },
  };
  const api = {
    requestPhoneCode: jest.fn().mockResolvedValue({
      challenge_id: 'challenge-a',
      expires_in: 300,
      retry_after: 60,
      test_mode: true,
    }),
    registerWithPhone: jest.fn().mockResolvedValue(result),
    loginWithPhone: jest.fn().mockResolvedValue(result),
    resetPhonePassword: jest.fn().mockResolvedValue({ ok: true }),
  };
  const signIn = jest.fn().mockResolvedValue(undefined);
  const context = {
    api,
    signIn,
    navigate: jest.fn(),
    preferences: { serverUrl: 'https://test.local', onboarded: true },
  } as unknown as AppContextValue;
  let tree: ReactTestRenderer;
  const field = (label: string) =>
    tree.root
      .findAllByType(TextInput)
      .find(n => n.props.accessibilityLabel === label);
  const button = (label: string) =>
    tree.root.findAllByType(Button).find(n => n.props.children === label);
  const tab = (label: string) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityRole === 'tab' &&
        n.props.accessibilityLabel === label,
    )[0];
  return {
    api,
    signIn,
    result,
    field,
    buttonProps: (label: string) => button(label)?.props,
    tabProps: (label: string) => tab(label).props,
    async mount() {
      await act(async () => {
        tree = create(
          <AppProvider value={context}>
            <AuthScreen expired={false} />
          </AppProvider>,
        );
      });
    },
    async input(label: string, value: string) {
      await act(async () => field(label)!.props.onChangeText(value));
    },
    async button(label: string) {
      await act(async () => {
        await button(label)!.props.onPress();
      });
    },
    async startButton(label: string) {
      await act(async () => {
        void button(label)!.props.onPress();
      });
    },
    async tab(label: string) {
      await act(async () => {
        tab(label).props.onPress();
      });
    },
    text() {
      return tree.root
        .findAllByType(Text)
        .map(n => n.props.children)
        .join('\n');
    },
    async unmount() {
      await act(async () => tree.unmount());
    },
  };
}

describe('phone password account flow', () => {
  it('logs in with a password without sending or requesting a code', async () => {
    const screen = setup();
    await screen.mount();
    expect(screen.field('验证码')).toBeUndefined();
    expect(screen.buttonProps('获取验证码')).toBeUndefined();
    expect(screen.field('密码')!.props.secureTextEntry).toBe(true);
    expect(screen.field('密码')!.props.autoComplete).toBe('current-password');
    await screen.input('手机号 · +86', '13800138000');
    await screen.input('密码', '  valid password  ');
    await screen.button('登录');
    expect(screen.api.requestPhoneCode).not.toHaveBeenCalled();
    expect(screen.api.loginWithPhone).toHaveBeenCalledWith(
      '13800138000',
      '  valid password  ',
    );
    expect(screen.signIn).toHaveBeenCalledWith(screen.result);
    expect(screen.text()).toContain('还未设置密码');
    await screen.unmount();
  });

  it('registers with an SMS challenge and the untrimmed confirmed password', async () => {
    const screen = setup();
    await screen.mount();
    await screen.tab('创建账号');
    await screen.input('手机号 · +86', '13800138000');
    await screen.input('怎么称呼你', '小林');
    await screen.input('密码', '  new password  ');
    await screen.input('确认密码', '  new password  ');
    await screen.button('获取验证码');
    expect(screen.api.requestPhoneCode).toHaveBeenCalledWith(
      '13800138000',
      'register',
    );
    expect(screen.text()).toContain('测试验证码：123456');
    await screen.input('验证码', '123456');
    await screen.button('创建账号');
    expect(screen.api.registerWithPhone).toHaveBeenCalledWith(
      '13800138000',
      '123456',
      'challenge-a',
      '  new password  ',
      '小林',
    );
    expect(screen.signIn).toHaveBeenCalledWith(screen.result);
    await screen.unmount();
  });

  it('resets via reset_password SMS and returns to login without signing in', async () => {
    const screen = setup();
    await screen.mount();
    await screen.input('手机号 · +86', '13800138000');
    await screen.button('忘记密码');
    expect(screen.field('手机号 · +86')!.props.value).toBe('13800138000');
    expect(screen.field('新密码')!.props.autoComplete).toBe('new-password');
    await screen.input('新密码', '恢复密码123456');
    await screen.input('确认密码', '恢复密码123456');
    await screen.button('获取验证码');
    expect(screen.api.requestPhoneCode).toHaveBeenCalledWith(
      '13800138000',
      'reset_password',
    );
    await screen.input('验证码', '123456');
    await screen.button('重置密码');
    expect(screen.api.resetPhonePassword).toHaveBeenCalledWith(
      '13800138000',
      '123456',
      'challenge-a',
      '恢复密码123456',
    );
    expect(screen.signIn).not.toHaveBeenCalled();
    expect(screen.api.loginWithPhone).not.toHaveBeenCalled();
    expect(screen.field('手机号 · +86')!.props.value).toBe('13800138000');
    expect(screen.field('密码')!.props.value).toBe('');
    expect(screen.field('验证码')).toBeUndefined();
    expect(screen.text()).toContain('密码已重置，请使用新密码登录');
    await screen.unmount();
  });

  it('clears the challenge after a phone or auth mode change', async () => {
    const screen = setup();
    await screen.mount();
    await screen.tab('创建账号');
    await screen.input('手机号 · +86', '13800138000');
    await screen.button('获取验证码');
    await screen.input('手机号 · +86', '13900139000');
    await screen.input('密码', 'valid-password');
    await screen.input('确认密码', 'valid-password');
    await screen.input('验证码', '123456');
    await screen.button('创建账号');
    expect(screen.api.registerWithPhone).not.toHaveBeenCalled();
    expect(screen.text()).toContain('请先获取验证码');
    await screen.button('获取验证码');
    await screen.button('忘记密码');
    await screen.input('新密码', 'valid-password');
    await screen.input('确认密码', 'valid-password');
    await screen.input('验证码', '123456');
    await screen.button('重置密码');
    expect(screen.api.resetPhonePassword).not.toHaveBeenCalled();
    expect(screen.text()).toContain('请先获取验证码');
    await screen.unmount();
  });

  it('rejects mismatched confirmation and preserves errors without signing in', async () => {
    const screen = setup();
    await screen.mount();
    await screen.tab('创建账号');
    await screen.input('手机号 · +86', '13800138000');
    await screen.input('密码', 'first-password');
    await screen.input('确认密码', 'second-password');
    await screen.button('创建账号');
    expect(screen.api.registerWithPhone).not.toHaveBeenCalled();
    expect(screen.text()).toContain('两次输入的密码不一致');
    await screen.tab('登录');
    screen.api.loginWithPhone.mockRejectedValueOnce(
      new Error('手机号或密码不正确。'),
    );
    await screen.input('密码', 'wrong-password');
    await screen.button('登录');
    expect(screen.signIn).not.toHaveBeenCalled();
    expect(screen.text()).toContain('手机号或密码不正确');
    await screen.unmount();
  });

  it('blocks phone and auth mode changes while login is in flight', async () => {
    const screen = setup();
    let finish!: (value: typeof screen.result) => void;
    screen.api.loginWithPhone.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    await screen.mount();
    await screen.input('手机号 · +86', '13800138000');
    await screen.input('密码', 'valid-password');
    await screen.startButton('登录');
    expect(screen.field('手机号 · +86')!.props.editable).toBe(false);
    expect(screen.tabProps('创建账号').disabled).toBe(true);
    expect(screen.buttonProps('忘记密码')!.disabled).toBe(true);
    // Simulate already queued native events despite disabled controls.
    await screen.input('手机号 · +86', '13900139000');
    await screen.tab('创建账号');
    await screen.button('忘记密码');
    expect(screen.field('手机号 · +86')!.props.value).toBe('13800138000');
    expect(screen.field('确认密码')).toBeUndefined();
    await act(async () => finish(screen.result));
    expect(screen.signIn).toHaveBeenCalledWith(screen.result);
    await screen.unmount();
  });

  it('honors the server Retry-After countdown without resending on a 429', async () => {
    const screen = setup();
    screen.api.requestPhoneCode.mockRejectedValueOnce(
      new ApiError('rate_limited', '验证码获取过于频繁，请稍后重试', 429, 90),
    );
    await screen.mount();
    await screen.button('忘记密码');
    await screen.input('手机号 · +86', '13800138000');
    await screen.button('获取验证码');
    expect(screen.buttonProps('90 秒后重试')!.disabled).toBe(true);
    expect(screen.text()).toContain('验证码获取过于频繁');
    await screen.button('90 秒后重试');
    expect(screen.api.requestPhoneCode).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.buttonProps('89 秒后重试')).toBeDefined();
    await screen.unmount();
  });

  it('keeps the original phone and mode while an SMS request is pending', async () => {
    const screen = setup();
    let finish!: () => void;
    screen.api.requestPhoneCode.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = () =>
            resolve({
              challenge_id: 'original-phone-challenge',
              expires_in: 300,
              retry_after: 60,
              test_mode: true,
            });
        }),
    );
    await screen.mount();
    await screen.tab('创建账号');
    await screen.input('手机号 · +86', '13800138000');
    await screen.startButton('获取验证码');
    await screen.input('手机号 · +86', '13900139000');
    await screen.tab('登录');
    expect(screen.field('手机号 · +86')!.props.value).toBe('13800138000');
    expect(screen.field('确认密码')).toBeDefined();
    await act(async () => finish());
    await screen.input('密码', 'valid-password');
    await screen.input('确认密码', 'valid-password');
    await screen.input('验证码', '123456');
    await screen.button('创建账号');
    expect(screen.api.registerWithPhone).toHaveBeenCalledWith(
      '13800138000',
      '123456',
      'original-phone-challenge',
      'valid-password',
      '',
    );
    await screen.unmount();
  });

  it('keeps a rejected password reset on the reset form without signing in', async () => {
    const screen = setup();
    screen.api.resetPhonePassword.mockRejectedValueOnce(
      new Error('验证码错误、已使用或已过期，请重新获取'),
    );
    await screen.mount();
    await screen.button('忘记密码');
    await screen.input('手机号 · +86', '13800138000');
    await screen.input('新密码', 'valid-password');
    await screen.input('确认密码', 'valid-password');
    await screen.button('获取验证码');
    await screen.input('验证码', '000000');
    await screen.button('重置密码');
    expect(screen.signIn).not.toHaveBeenCalled();
    expect(screen.field('新密码')).toBeDefined();
    expect(screen.text()).toContain('验证码错误');
    expect(screen.text()).not.toContain('密码已重置');
    await screen.unmount();
  });

  it('validates Unicode password characters and keeps spaces meaningful', () => {
    expect(normalizePhoneNumber('+86 138-0013-8000')).toBe('+8613800138000');
    expect(() => normalizePhoneNumber('123456')).toThrow();
    expect(() => validatePassword('🙂'.repeat(8))).not.toThrow();
    expect(() => validatePassword('🙂'.repeat(7))).toThrow();
    expect(() => validatePassword('密'.repeat(128))).not.toThrow();
    expect(() => validatePassword('密'.repeat(129))).toThrow();
    expect(() => validatePassword('  abcdef  ')).not.toThrow();
  });
});

import React from 'react';
import { TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import {
  MailComposer,
  MailConnectionForm,
  MailConnectionSheet,
  QQ_MAIL_HELP,
} from '../src/features/integrations/MailConnection';
import { platform } from '../src/platform/ports';
import type { Integration } from '../src/features/integrations/types';
jest.mock('../src/platform/ports', () => ({
  platform: { openUrl: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
});
const qq: Integration = {
  id: 'qq_mail',
  name: 'QQ 邮箱',
  category: '邮件',
  mode: 'mail',
  status: 'not_connected',
  detail: '查找邮件，梳理重点',
};
async function setup(
  element: React.ReactElement,
  request = jest.fn().mockResolvedValue({}),
) {
  const context = {
    api: { request },
    user: { id: 'mail-user' },
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<AppProvider value={context}>{element}</AppProvider>);
  });
  const field = (label: string) =>
    tree.root
      .findAllByType(TextInput)
      .find(node => node.props.accessibilityLabel === label)!;
  const button = (label: string) =>
    tree.root.findAll(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function' &&
        (node.props.accessibilityLabel === label ||
          node.findAll(
            node =>
              typeof node.props.children === 'string' &&
              node.props.children === label,
          ).length > 0),
    )[0];
  return {
    tree,
    request,
    context,
    field,
    button,
    fill: async (label: string, value: string) => {
      await act(async () => field(label).props.onChangeText(value));
    },
    press: async (label: string) => {
      const node = button(label);
      if (!node) throw new Error('Missing ' + label);
      expect(node.props.disabled).not.toBe(true);
      await act(async () => node.props.onPress());
    },
    unmount: async () => {
      await act(async () => tree.unmount());
    },
  };
}
it('opens the exact QQ help link without connecting or sending mail', async () => {
  const view = await setup(
    <MailConnectionForm item={qq} onConnected={jest.fn()} />,
  );
  await act(async () =>
    view.tree.root
      .findAll(
        node =>
          node.props.accessibilityRole === 'link' &&
          typeof node.props.onPress === 'function',
      )[0]
      .props.onPress(),
  );
  expect(platform.openUrl).toHaveBeenCalledWith(QQ_MAIL_HELP);
  expect(view.request).not.toHaveBeenCalled();
  await view.unmount();
});
it('requires a provider mailbox and authorization code and hides it by default', async () => {
  const connected = jest.fn();
  const view = await setup(
    <MailConnectionForm item={qq} onConnected={connected} />,
  );
  expect(view.button('验证并连接').props.disabled).toBe(true);
  await view.fill('邮箱地址', 'owner@qq.com.evil.test');
  await view.fill('邮箱客户端授权码', 'Abcd1234567890ef');
  expect(view.button('验证并连接').props.disabled).toBe(true);
  await view.fill('邮箱地址', 'owner@qq.com');
  expect(view.field('邮箱客户端授权码').props.secureTextEntry).toBe(true);
  await view.press('显示授权码');
  expect(view.field('邮箱客户端授权码').props.secureTextEntry).toBe(false);
  await view.press('验证并连接');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/qq_mail/connect',
    'POST',
    { email: 'owner@qq.com', authorization_code: 'Abcd1234567890ef' },
    expect.anything(),
  );
  expect(connected).toHaveBeenCalledTimes(1);
  expect(view.field('邮箱客户端授权码').props.value).toBe('');
  expect(view.field('邮箱客户端授权码').props.secureTextEntry).toBe(true);
  await view.unmount();
});
it('clears the secret after a failed verification and never claims success', async () => {
  const connected = jest.fn(),
    request = jest.fn().mockRejectedValue(new Error('授权码无效'));
  const view = await setup(
    <MailConnectionForm item={qq} onConnected={connected} />,
    request,
  );
  await view.fill('邮箱地址', 'owner@qq.com');
  await view.fill('邮箱客户端授权码', 'Abcd1234567890ef');
  await view.press('验证并连接');
  expect(connected).not.toHaveBeenCalled();
  expect(view.field('邮箱客户端授权码').props.value).toBe('');
  expect(JSON.stringify(view.tree.toJSON())).toContain('授权码无效');
  await view.unmount();
});
it('closes the sheet and discards credentials without submitting', async () => {
  const close = jest.fn(),
    done = jest.fn();
  const view = await setup(
    <MailConnectionSheet item={qq} onClose={close} onConnected={done} />,
  );
  await view.fill('邮箱客户端授权码', 'Abcd1234567890ef');
  await view.press('关闭邮箱连接弹层');
  expect(close).toHaveBeenCalledTimes(1);
  await act(async () =>
    view.tree.update(
      <AppProvider value={view.context}>
        <MailConnectionSheet item={null} onClose={close} onConnected={done} />
      </AppProvider>,
    ),
  );
  await act(async () =>
    view.tree.update(
      <AppProvider value={view.context}>
        <MailConnectionSheet item={qq} onClose={close} onConnected={done} />
      </AppProvider>,
    ),
  );
  expect(view.field('邮箱客户端授权码').props.value).toBe('');
  expect(view.request).not.toHaveBeenCalled();
  await view.unmount();
});
async function prepare(view: Awaited<ReturnType<typeof setup>>) {
  await view.press('写邮件');
  await view.fill('收件人', 'friend@example.com');
  await view.fill('邮件主题', '项目进展');
  await view.fill('邮件正文', '你好，\n明天确认方案。');
  await view.press('预览邮件');
}
it('requires preview and explicit confirmation and submits the exact plain text', async () => {
  const request = jest.fn().mockResolvedValue({
    status: 'sent',
    detail: '邮件已提交到邮箱发信服务器。',
  });
  const view = await setup(
    <MailComposer item={{ ...qq, status: 'connected' }} />,
    request,
  );
  await prepare(view);
  expect(request).not.toHaveBeenCalled();
  await view.press('继续编辑');
  expect(view.field('邮件正文').props.value).toBe('你好，\n明天确认方案。');
  await view.press('预览邮件');
  await view.press('确认发送');
  expect(request).toHaveBeenCalledWith(
    '/integrations/qq_mail/send',
    'POST',
    expect.objectContaining({
      to: 'friend@example.com',
      subject: '项目进展',
      body: '你好，\n明天确认方案。',
      confirmed: true,
    }),
    expect.anything(),
  );
  await view.press('完成');
  expect(view.button('写邮件')).toBeDefined();
  await view.unmount();
});
it('reuses the same request after network failure and preserves the draft when collapsed', async () => {
  const request = jest
    .fn()
    .mockRejectedValueOnce(new Error('网络超时'))
    .mockResolvedValueOnce({ status: 'sent', detail: '已提交' });
  const view = await setup(
    <MailComposer item={{ ...qq, status: 'connected' }} />,
    request,
  );
  await prepare(view);
  await view.press('确认发送');
  expect(request).toHaveBeenCalledTimes(1);
  await view.press('收起邮件');
  await view.press('写邮件');
  await view.press('检查发送状态');
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][2]).toEqual(request.mock.calls[1][2]);
  await view.unmount();
});
it('prevents malformed recipients and clears a draft when the signed-in user changes', async () => {
  const view = await setup(
    <MailComposer item={{ ...qq, status: 'connected' }} />,
  );
  await view.press('写邮件');
  await view.fill('收件人', 'a@example.com\nBcc:b@example.com');
  await view.fill('邮件主题', 'hello');
  await view.fill('邮件正文', 'hello');
  expect(view.button('预览邮件').props.disabled).toBe(true);
  await act(async () =>
    view.tree.update(
      <AppProvider
        value={
          { ...view.context, user: { id: 'other-user' } } as AppContextValue
        }
      >
        <MailComposer item={{ ...qq, status: 'connected' }} />
      </AppProvider>,
    ),
  );
  await view.press('写邮件');
  expect(view.field('邮件正文').props.value).toBe('');
  expect(view.request).not.toHaveBeenCalled();
  await view.unmount();
});
it('permits correction only after a definite rejection and requires another preview', async () => {
  const request = jest
    .fn()
    .mockResolvedValue({
      status: 'failed',
      detail: '邮箱服务拒绝了这次发信。',
    });
  const view = await setup(
    <MailComposer item={{ ...qq, status: 'connected' }} />,
    request,
  );
  await prepare(view);
  await view.press('确认发送');
  expect(view.button('确认发送')).toBeUndefined();
  await view.press('继续编辑');
  await view.fill('收件人', 'correct@example.com');
  expect(request).toHaveBeenCalledTimes(1);
  await view.press('预览邮件');
  await view.press('确认发送');
  expect(request.mock.calls[0][2].client_request_id).not.toBe(
    request.mock.calls[1][2].client_request_id,
  );
  await view.unmount();
});

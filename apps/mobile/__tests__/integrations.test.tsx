import React from 'react';
import { Switch, Text, TextInput } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppContextValue, AppProvider } from '../src/app/context';
import { IntegrationTools } from '../src/features/integrations/IntegrationsScreen';
import { importDraft, integrationsApi } from '../src/features/integrations/api';
import { appInputs } from '../src/platform/appInputs';
import { platform } from '../src/platform/ports';
import { Button, Section } from '../src/ui/components';
import type { ApiClient } from '../src/api/client';

jest.mock('../src/platform/appInputs', () => ({
  appInputSources: [
    { id: 'wechat', name: '微信' },
    { id: 'qq', name: 'QQ' },
  ],
  appInputs: {
    supported: true,
    hasImageTextRecognition: true,
    extractImageText: jest.fn(),
    getStatus: jest.fn(),
    listPending: jest.fn(),
    dismiss: jest.fn().mockResolvedValue(undefined),
    setApps: jest.fn().mockResolvedValue(undefined),
    openNotificationSettings: jest.fn().mockResolvedValue(undefined),
    openApp: jest.fn().mockResolvedValue(true),
  },
}));
jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn(() => jest.fn()),
    pickDocument: jest.fn(),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.clearAllMocks();
  appInputs.hasImageTextRecognition = true;
  (appInputs.extractImageText as jest.Mock).mockResolvedValue(
    '订单金额：58.60 元\n预计明天送达',
  );
  (appInputs.getStatus as jest.Mock).mockResolvedValue({
    supported: true,
    notification_access: true,
    selected_apps: ['qq'],
    installed_apps: ['wechat', 'qq'],
    pending_count: 1,
  });
  (appInputs.listPending as jest.Mock).mockResolvedValue([
    {
      id: 'notification-a',
      source_app: 'wechat',
      kind: 'notification',
      title: '项目讨论',
      text: '周五下午三点开会',
      created_at: '2026-10-27T08:00:00Z',
    },
  ]);
});

async function setup(cloudAvailable = true, catalog: object[] = []) {
  const request = jest.fn(async (_path: string, method = 'GET') => {
    if (!cloudAvailable) {
      throw new Error('暂时无法连接云端');
    }
    if (method === 'POST') {
      return { id: 'import-a' };
    }
    if (_path === '/integrations') return { items: catalog };
    return { items: [] };
  });
  const context = {
    api: { request, upload: jest.fn() },
    user: { id: 'user-a' },
    navigate: jest.fn(),
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <AppProvider value={context}>
        <IntegrationTools onBack={jest.fn()} />
      </AppProvider>,
    );
  });
  return {
    request,
    tree,
    context,
    async tab(label: string) {
      await act(async () => {
        tree.root
          .findAll(
            n =>
              n.props.accessibilityRole === 'tab' &&
              n.props.accessibilityLabel === label,
          )[0]
          .props.onPress();
      });
    },
    async button(label: string) {
      await act(async () => {
        const node = tree.root
          .findAllByType(Button)
          .find(n => n.props.children === label);
        if (!node) {
          throw new Error('Missing button: ' + label);
        }
        await node.props.onPress();
      });
    },
    async field(label: string, value: string) {
      await act(async () => {
        tree.root
          .findAllByType(TextInput)
          .find(n => n.props.accessibilityLabel === label)!
          .props.onChangeText(value);
      });
    },
    async unmount() {
      await act(async () => tree.unmount());
    },
  };
}

it('keeps incoming notification text on the phone until the user explicitly imports it', async () => {
  const view = await setup();
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(appInputs.dismiss).not.toHaveBeenCalled();
  await view.tab('待接收');
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(n => n.props.children === '周五下午三点开会'),
  ).toBe(true);
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  await view.button('导入文字');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/imports',
    'POST',
    {
      source_app: 'wechat',
      title: '项目讨论',
      text: '周五下午三点开会',
      external_id: 'notification-a',
    },
    expect.anything(),
  );
  expect(appInputs.dismiss).toHaveBeenCalledWith(['notification-a']);
  expect(
    view.request.mock.calls.some(call => call[0] === '/todos/extract'),
  ).toBe(false);
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '发现待办'),
  ).toBe(true);
  await view.unmount();
});

it('discovers candidates only from the confirmed notification import and shows server counts', async () => {
  const view = await setup();
  await view.tab('待接收');
  await view.button('导入文字');
  view.request.mockResolvedValueOnce({
    items: [
      { id: 'todo-a', status: 'suggested' },
      { id: 'todo-b', status: 'pending' },
    ],
    created_count: 1,
  } as any);
  await view.button('发现待办');
  expect(view.request).toHaveBeenLastCalledWith('/todos/extract', 'POST', {
    source_kind: 'integration_import',
    source_id: 'import-a',
    client_request_id: expect.any(String),
  });
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(
        n => n.props.children === '本次新增 1 件；这份来源还有 1 件待你确认。',
      ),
  ).toBe(true);
  await view.button('查看新发现');
  expect(view.context.navigate).toHaveBeenCalledWith({ name: 'todos' });
  await view.unmount();
});

it('preserves a saved import after discovery failure and retries the same extraction request', async () => {
  const view = await setup();
  await view.button('粘贴文字 / 链接');
  await view.field('文字内容', '明天去取包裹');
  await view.button('确认导入');
  view.request.mockRejectedValueOnce(new Error('服务暂时不可用'));
  await view.button('发现待办');
  const firstExtraction = view.request.mock.calls.find(
    call => call[0] === '/todos/extract',
  );
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(
        n => n.props.children === '资料已保存。发现待办暂未成功，可以重试。',
      ),
  ).toBe(true);
  view.request.mockResolvedValueOnce({ items: [], created_count: 0 } as any);
  await view.button('重试发现待办');
  const extractions = view.request.mock.calls.filter(
    call => call[0] === '/todos/extract',
  );
  expect(extractions).toHaveLength(2);
  expect(extractions[1]).toEqual(firstExtraction);
  expect(
    view.request.mock.calls.filter(
      call => call[0] === '/integrations/imports' && call[1] === 'POST',
    ),
  ).toHaveLength(1);
  expect(view.request.mock.calls.some(call => call[1] === 'DELETE')).toBe(
    false,
  );
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(
        n => n.props.children === '本次新增 0 件；这份来源还有 0 件待你确认。',
      ),
  ).toBe(true);
  await view.unmount();
});

it('hides the previous account discovery and ignores its late extraction response', async () => {
  const view = await setup();
  await view.tab('待接收');
  await view.button('导入文字');
  let complete!: (result: any) => void;
  view.request.mockReturnValueOnce(
    new Promise(resolve => {
      complete = resolve;
    }),
  );
  await view.button('发现待办');
  await act(async () => {
    view.tree.update(
      <AppProvider
        value={{ ...view.context, user: { id: 'user-b' } } as AppContextValue}
      >
        <IntegrationTools onBack={jest.fn()} />
      </AppProvider>,
    );
  });
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '发现待办'),
  ).toBe(false);
  await act(async () => {
    complete({
      items: [{ id: 'private-todo', status: 'suggested' }],
      created_count: 1,
    });
  });
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '查看新发现'),
  ).toBe(false);
  expect(view.context.navigate).not.toHaveBeenCalled();
  await view.unmount();
});

it('keeps mailbox results as an editable prefill until confirmed and only then offers discovery', async () => {
  const view = await setup(true, [
    {
      id: 'qq_mail',
      name: 'QQ 邮箱',
      mode: 'mail',
      status: 'connected',
      detail: '读取已连接邮箱',
    },
  ]);
  await act(async () => {
    view.tree.root
      .findAllByType(Section)
      .find(n => n.props.title === '更多连接方式')!
      .props.onAction();
  });
  await act(async () => {
    view.tree.root
      .findAll(n => n.props.accessibilityLabel === '设置QQ 邮箱')[0]
      .props.onPress();
  });
  view.request.mockResolvedValueOnce({
    items: [{ id: 'mail-a', title: '签字确认', text: '请周五前确认合同。' }],
  } as any);
  await view.button('读取资料');
  await view.button('导入这条资料');
  expect(
    view.tree.root
      .findAllByType(TextInput)
      .find(n => n.props.accessibilityLabel === '文字内容')?.props.value,
  ).toBe('请周五前确认合同。');
  expect(
    view.request.mock.calls.some(
      call => call[0] === '/integrations/imports' && call[1] === 'POST',
    ),
  ).toBe(false);
  expect(
    view.request.mock.calls.some(call => call[0] === '/todos/extract'),
  ).toBe(false);
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '发现待办'),
  ).toBe(false);
  await view.button('确认导入');
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '发现待办'),
  ).toBe(true);
  expect(
    view.request.mock.calls.some(call => call[0] === '/todos/extract'),
  ).toBe(false);
  await view.unmount();
});

it('can configure installed apps when the cloud connection is unavailable and preserves existing selections', async () => {
  const view = await setup(false);
  const wechat = view.tree.root
    .findAllByType(Switch)
    .find(n => n.props.accessibilityLabel === '微信接收通知')!;
  expect(wechat.props.disabled).toBe(false);
  await act(async () => {
    await wechat.props.onValueChange(true);
  });
  expect(appInputs.setApps).toHaveBeenCalledWith(['qq', 'wechat']);
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  await view.unmount();
});

it('opens a visible import form, validates links and saves only after confirmation', async () => {
  const view = await setup();
  await view.button('粘贴文字 / 链接');
  await view.field('文字内容', '  预约明天的会议室  ');
  await view.field('原文链接（可选）', 'javascript:alert(1)');
  await view.button('确认导入');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(
        n =>
          typeof n.props.children === 'string' &&
          n.props.children.includes('完整链接'),
      ),
  ).toBe(true);
  await view.field('原文链接（可选）', 'https://example.com/meeting');
  await view.button('确认导入');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/imports',
    'POST',
    {
      source_app: 'shared',
      title: '预约明天的会议室',
      text: '预约明天的会议室',
      url: 'https://example.com/meeting',
    },
    expect.anything(),
  );
  await view.unmount();
});

it('encodes query filters and resource IDs without exposing credentials in URLs', async () => {
  const request = jest.fn().mockResolvedValue({ items: [] });
  const client = integrationsApi({ request } as unknown as ApiClient);
  await client.imports('约见 & 工作', 'wechat');
  expect(request).toHaveBeenCalledWith(
    '/integrations/imports?q=' +
      encodeURIComponent('约见 & 工作') +
      '&source_app=wechat',
    undefined,
    undefined,
    undefined,
  );
  await client.connect('qq_mail', {
    email: 'test@qq.com',
    authorization_code: 'private-code',
  });
  expect(request).toHaveBeenLastCalledWith(
    '/integrations/qq_mail/connect',
    'POST',
    { email: 'test@qq.com', authorization_code: 'private-code' },
    undefined,
  );
  await client.removeImport('a/b');
  expect(request).toHaveBeenLastCalledWith(
    '/integrations/imports/a%2Fb',
    'DELETE',
    undefined,
    undefined,
  );
  expect(() => importDraft('shared', '', '', '')).toThrow('文字或链接');
  expect(() => importDraft('shared', '', 'a'.repeat(60001))).toThrow('太长');
});

it('does not upload a selected file if the account screen closed while the picker was open', async () => {
  let choose!: (value: unknown) => void;
  (platform.pickDocument as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      choose = resolve;
    }),
  );
  const view = await setup();
  await view.button('选取文件');
  await view.unmount();
  await act(async () => {
    choose({
      uri: 'content://private/document',
      name: '个人资料.docx',
      mime_type:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });
  expect(view.context.api.upload).not.toHaveBeenCalled();
  expect(view.context.navigate).not.toHaveBeenCalled();
});

it('aborts an upload and does not navigate or dismiss a share after account cleanup', async () => {
  let finish!: (value: unknown) => void;
  const file = {
    uri: 'content://private/document',
    name: '个人资料.docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  (appInputs.listPending as jest.Mock).mockResolvedValue([
    {
      id: 'file-share',
      source_app: 'wechat',
      kind: 'share',
      title: '个人资料',
      text: '',
      file,
      created_at: '',
    },
  ]);
  const view = await setup();
  (view.context.api.upload as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      finish = resolve;
    }),
  );
  await view.tab('待接收');
  await view.button('上传文件并整理');
  const signal = (view.context.api.upload as jest.Mock).mock
    .calls[0][1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  await view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish({ id: 'old-account-upload', name: file.name });
  });
  expect(appInputs.dismiss).not.toHaveBeenCalled();
  expect(view.context.navigate).not.toHaveBeenCalled();
});

it('hides local recognition when OCR is absent and never substitutes a cloud upload', async () => {
  appInputs.hasImageTextRecognition = false;
  (appInputs.listPending as jest.Mock).mockResolvedValue([{
    id: 'image-no-ocr', source_app: 'wechat', kind: 'share',
    title: '截图', text: '', created_at: '',
    file: {uri: 'file:///private/shared/image.png', name: 'image.png', mime_type: 'image/png'},
  }]);
  const view = await setup();
  await view.tab('待接收');
  expect(view.tree.root.findAllByType(Button).some(n => n.props.children === '识别图片文字')).toBe(false);
  expect(view.tree.root.findAllByType(Text).some(n =>
    String(n.props.children).includes('可在对话中发送图片'))).toBe(true);
  expect(appInputs.extractImageText).not.toHaveBeenCalled();
  expect(view.context.api.upload).not.toHaveBeenCalled();
  expect(view.request.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(0);
  expect(appInputs.dismiss).not.toHaveBeenCalled();
  await view.unmount();
});

it('recognizes a shared image only on tap and keeps the editable text local until confirmation', async () => {
  const file = {
    uri: 'file:///private/shared/order.png',
    name: 'order.png',
    mime_type: 'image/png',
  };
  (appInputs.listPending as jest.Mock).mockResolvedValue([
    {
      id: 'image-share',
      source_app: 'taobao',
      kind: 'share',
      title: '订单截图',
      text: '',
      file,
      created_at: '',
    },
  ]);
  const view = await setup();
  expect(appInputs.extractImageText).not.toHaveBeenCalled();
  await view.tab('待接收');
  expect(appInputs.extractImageText).not.toHaveBeenCalled();
  await view.button('识别图片文字');
  expect(appInputs.extractImageText).toHaveBeenCalledWith(file.uri);
  const textField = view.tree.root
    .findAllByType(TextInput)
    .find(n => n.props.accessibilityLabel === '文字内容');
  expect(textField?.props.value).toBe('订单金额：58.60 元\n预计明天送达');
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(view.context.api.upload).not.toHaveBeenCalled();
  expect(appInputs.dismiss).not.toHaveBeenCalled();
  await view.field('文字内容', '订单金额：58.60 元\n明天下午留意收货');
  await view.button('确认导入');
  expect(view.request).toHaveBeenCalledWith(
    '/integrations/imports',
    'POST',
    {
      source_app: 'taobao',
      title: '订单截图',
      text: '订单金额：58.60 元\n明天下午留意收货',
      external_id: 'image-share:ocr',
    },
    expect.anything(),
  );
  expect(appInputs.dismiss).toHaveBeenCalledWith(['image-share']);
  expect(view.context.api.upload).not.toHaveBeenCalled();
  await view.unmount();
});

it('retains the source image if local recognition fails and does not silently upload it', async () => {
  (appInputs.extractImageText as jest.Mock).mockRejectedValue(
    new Error('图片无法识别，请换一张清晰的图片。'),
  );
  const file = {
    uri: 'file:///private/shared/blurry.jpg',
    name: 'blurry.jpg',
    mime_type: 'image/jpeg',
  };
  (appInputs.listPending as jest.Mock).mockResolvedValue([
    {
      id: 'blurry-image',
      source_app: 'wechat',
      kind: 'share',
      title: '截图',
      text: '',
      file,
      created_at: '',
    },
  ]);
  const view = await setup();
  await view.tab('待接收');
  await view.button('识别图片文字');
  expect(
    view.tree.root
      .findAllByType(Text)
      .some(
        n =>
          typeof n.props.children === 'string' &&
          n.props.children.includes('图片无法识别'),
      ),
  ).toBe(true);
  expect(
    view.tree.root
      .findAllByType(Button)
      .some(n => n.props.children === '上传原文件'),
  ).toBe(true);
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(view.context.api.upload).not.toHaveBeenCalled();
  expect(appInputs.dismiss).not.toHaveBeenCalled();
  await view.unmount();
});

it('does not publish an OCR result after the account screen has closed', async () => {
  let complete!: (value: string) => void;
  (appInputs.extractImageText as jest.Mock).mockReturnValue(
    new Promise(resolve => {
      complete = resolve;
    }),
  );
  const file = {
    uri: 'file:///private/shared/order.png',
    name: 'order.png',
    mime_type: 'image/png',
  };
  (appInputs.listPending as jest.Mock).mockResolvedValue([
    {
      id: 'image-share',
      source_app: 'taobao',
      kind: 'share',
      title: '订单截图',
      text: '',
      file,
      created_at: '',
    },
  ]);
  const view = await setup();
  await view.tab('待接收');
  await view.button('识别图片文字');
  await view.unmount();
  await act(async () => {
    complete('旧账号的私密文字');
  });
  expect(
    view.request.mock.calls.filter(call => call[1] === 'POST'),
  ).toHaveLength(0);
  expect(view.context.navigate).not.toHaveBeenCalled();
  expect(view.context.api.upload).not.toHaveBeenCalled();
  expect(appInputs.dismiss).not.toHaveBeenCalled();
});

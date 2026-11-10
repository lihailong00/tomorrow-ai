import React from 'react';
import { AppState, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { ChatVaultCaptureCard } from '../src/features/private-vault/ChatVaultCaptureCard';
import { detectPrivateRecord } from '../src/features/private-vault/chatCapture';
import { privateVault } from '../src/platform/privateVault';
import { ChatScreen } from '../src/screens/Chat';
import { Button } from '../src/ui/components';

jest.mock('@shopify/flash-list', () => require('../test/flashListMock'));
jest.mock('../src/platform/ports', () => ({ platform: {
  getSystemFontScale: jest.fn().mockResolvedValue(null),
} }));
jest.mock('../src/ui/visuals', () => ({ AssistantOrb: () => null, Icon: () => null }));
jest.mock('../src/screens/Main', () => ({ ModeNotice: () => null }));
jest.mock('../src/platform/privateVault', () => ({ privateVault: {
  available: () => true,
  status: jest.fn().mockResolvedValue({ available: true }),
  protect: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue([]),
  linkPhoneToAddress: jest.fn().mockResolvedValue(null),
} }));

const address = '浦东新区虚构路 88 号，明月小区';
const phone = '+12025550100';
test.each([
  [`请记住我家住在${address}。`, '家庭住址'],
  ['我的工作地址是静安区虚构路 66 号，请你记下来吧。', '公司地址'],
  ['把测试市青山小区 5 栋保存为我的收货地址', '收货地址'],
  ['我的身份证号码是00000020000101000X', '我的身份证'],
  ['我的招商银行卡号是0000 0000 0000 0001', '我的银行卡'],
  [`我的手机号是${phone}`, '本人手机号'],
  ['哎，要不我给你说吧，我的电话号号码是＋１ ２０２ ５５５ ０１００，，请你记下来吧。', '本人手机号'],
  ['我的社保卡号是 001234567', '我的社保卡'],
  ['我的医保卡号码为 001234567', '我的医保卡'],
  ['我的护照号是 A0012345', '我的护照'],
  ['我的驾照号是 00000020000101000X', '我的驾驶证'],
  ['我的台胞证号是 A0012345', '我的通行证'],
  ['我的居住证号是 001234567', '我的居住证'],
  ['请帮我保存我的个人邮箱是 owner@example.test。', '我的个人邮箱'],
  ['把 owner@example.test 保存为我的个人邮箱', '我的个人邮箱'],
])('detects a direct declaration of the user’s own private information', (text, alias) => {
  expect(detectPrivateRecord(text, '测试用户')).toMatchObject({ alias });
});

test.each([
  '我家在上海市虚构路 88 号吗？', '假设我家在静安区虚构路 10 号',
  '我朋友家住在静安区虚构路 10 号', '我住在市中心的酒店',
  '我家在静安区虚构路 10 号，给我查打车费',
  '这次的收货地址是静安区虚构路 10 号', '我家在静安区虚构路 10 号，别记',
  '我的银行卡密码是000000', '我的验证码是000000',
  `我家住在${address}。`, `帮我寄到${address}`, '我的邮箱是 owner@example.test',
  `我的家庭住址是${address}帮我寄到这里，记住`,
  `我朋友的手机号是${phone}，请记住`, `“我的手机号是${phone}”`, `我的手机号是${phone}吗？`,
  `假设我的手机号是${phone}`, '我的手机号尾号是 0100', '我的银行卡 CVV 是 000',
])('leaves questions, contextual addresses, and login secrets outside the capture flow', text => {
  expect(detectPrivateRecord(text, '测试用户')).toBeNull();
});

test('an explicit request to save an unspecified address opens a blank address field', () => {
  expect(detectPrivateRecord('把这个地址保存为我的家庭住址', '测试用户')).toMatchObject({ type: 'address', fields: { address: '' } });
});

test('intercepts before chat submission and only reports a save after device authentication succeeds', async () => {
  const priorState = AppState.currentState;
  AppState.currentState = 'active';
  const api = { baseUrl: 'https://example.test', capabilities: jest.fn().mockResolvedValue({ runtime: {} }), chatStream: jest.fn() };
  const save = jest.mocked(privateVault.save);
  save.mockClear();
  let tree!: ReactTestRenderer;
  try {
    await act(async () => {
      tree = create(<AppProvider value={{
        api, user: { id: 'owner', name: '测试用户', timezone: 'Asia/Shanghai' },
        preferences: { instance: { id: 'instance' } }, navigate: jest.fn(),
        invalidate: jest.fn(), formatDate: () => '',
      } as unknown as AppContextValue}><ChatScreen /></AppProvider>);
    });
    const write = async (message = `请记住我的家庭住址是${address}。`) => {
      const input = tree.root.findAllByType(TextInput).find(n => n.props.accessibilityLabel === '给助手的消息')!;
      await act(async () => input.props.onChangeText(message));
      const send = tree.root.findAll(n => n.props.accessibilityLabel === '发送消息' && typeof n.props.onPress === 'function')[0];
      await act(async () => send.props.onPress());
    };
    const press = async (label: string) => {
      const button = tree.root.findAllByType(Button).find(n => n.props.children === label)!;
      await act(async () => button.props.onPress());
    };
    await write();
    expect(api.chatStream).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await press('跳过');
    expect(save).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).not.toContain(address);
    await write();
    save.mockRejectedValueOnce(new Error('已取消身份验证'));
    await press('验证并保存');
    expect(JSON.stringify(tree.toJSON())).toContain('已取消身份验证');
    expect(JSON.stringify(tree.toJSON())).not.toContain('已加密保存');
    await press('验证并保存');
    expect(save).toHaveBeenLastCalledWith(expect.stringContaining('instance'), {
      alias: '家庭住址', type: 'address', fields: { owner: '测试用户', address },
    });
    expect(api.chatStream).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('已加密保存');
    expect(JSON.stringify(tree.toJSON())).not.toContain(address);

    await write(`我的手机号是${phone}`);
    save.mockResolvedValueOnce([
      { id: 'home', type: 'address', alias: '家庭住址', summary: '已隐藏', has_contact_phone: true },
      { id: 'phone', type: 'phone', alias: '本人手机号', summary: '尾号 0100' },
    ]);
    await press('验证并保存');
    expect(save).toHaveBeenLastCalledWith(expect.stringContaining('instance'), {
      alias: '本人手机号', type: 'phone', fields: { owner: '测试用户', number: phone },
    });
    expect(JSON.stringify(tree.toJSON())).toContain('本人手机号');
    expect(JSON.stringify(tree.toJSON())).not.toContain('填入联系电话');
    expect(JSON.stringify(tree.toJSON())).not.toContain(phone);
    expect(api.chatStream).not.toHaveBeenCalled();
  } finally {
    if (tree) await act(async () => tree.unmount());
    AppState.currentState = priorState;
  }
});

test.each([false, true])('an address phone is written only with a second confirmation (confirm=%s)', async confirm => {
  const priorState = AppState.currentState;
  AppState.currentState = 'active';
  const save = jest.mocked(privateVault.save);
  const link = jest.mocked(privateVault.linkPhoneToAddress);
  link.mockClear();
  save.mockResolvedValueOnce([
    { id: 'home', type: 'address', alias: '家庭住址', summary: '已隐藏', has_contact_phone: false },
    { id: 'phone', type: 'phone', alias: '本人手机号', summary: '尾号 0100' },
  ]);
  const onSaved = jest.fn();
  const onClose = jest.fn();
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(<ChatVaultCaptureCard scope="owner" proposal={{ type: 'phone', alias: '本人手机号', fields: { owner: '测试用户', number: phone } }}
      transcribed={false} isCurrent={() => true} onClose={onClose} onSaved={onSaved} />); });
    const press = async (label: string) => {
      const button = tree.root.findAllByType(Button).find(n => n.props.children === label)!;
      await act(async () => button.props.onPress());
    };
    expect(JSON.stringify(tree.toJSON())).not.toContain(phone);
    await press('验证并保存');
    expect(JSON.stringify(tree.toJSON())).toContain('本人手机号已加密保存');
    expect(link).not.toHaveBeenCalled();
    if (confirm) {
      link.mockRejectedValueOnce(new Error('已取消身份验证'));
      await press('填入联系电话');
      expect(JSON.stringify(tree.toJSON())).toContain('已取消身份验证');
      expect(JSON.stringify(tree.toJSON())).not.toContain('已填入家庭住址的联系电话');
      await press('填入联系电话');
      expect(link).toHaveBeenLastCalledWith('owner', 'phone', 'home');
      expect(JSON.stringify(tree.toJSON())).toContain('已填入家庭住址的联系电话');
      await press('完成');
    } else {
      await press('仅保存手机号');
      expect(link).not.toHaveBeenCalled();
    }
    expect(onSaved).toHaveBeenCalledWith('本人手机号');
  } finally {
    if (tree) await act(async () => tree.unmount());
    AppState.currentState = priorState;
  }
});

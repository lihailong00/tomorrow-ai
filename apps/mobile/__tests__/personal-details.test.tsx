import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, TextInput } from 'react-native';
import { privateVault } from '../src/platform/privateVault';
import { PersonalDetailsCard } from '../src/features/location/PersonalDetailsCard';
import { readChatInteraction } from '../src/features/location/chatInteraction';
import { applyVaultAddress, initialPersonalValues, type PersonalDetails, type PersonalDetailsField } from '../src/features/location/personalDetails';

jest.mock('../src/app/context', () => ({ useApp: () => ({ api: { baseUrl: 'https://example.test' }, user: { id: 'test-user' }, preferences: {} }) }));
jest.mock('../src/platform/privateVault', () => ({ privateVault: {
  available: jest.fn(() => false), protect: jest.fn().mockResolvedValue(undefined),
  summaries: jest.fn(), reveal: jest.fn(),
} }));

const fields: PersonalDetailsField[] = [
  { key: 'contactName', label: '联系人', semantic: 'name', value: '测试收件人', source: '账号资料，请核对', required: true },
  { key: 'mobile', label: '联系电话', semantic: 'phone', value: '13800000000', source: '已保存资料', required: true },
  { key: 'street', label: '完整地址', semantic: 'address', value: '测试市测试路1号', source: '已保存资料', required: true },
];
const card: PersonalDetails = { kind: 'personal_details', provider: 'shipping-fixture', tool: 'create-recipient', purpose: '寄到家里', subject: 'home', arguments: {}, fields };

test('accepts the new card and rejects duplicate/unknown personal fields', () => {
  const wire = { id: 'card-1', run_id: 'run-1', expires_at: 1900000000, ...card };
  expect(readChatInteraction(wire)?.kind).toBe('personal_details');
  expect(readChatInteraction({ ...wire, fields: [fields[0], fields[0]] })).toBeUndefined();
  expect(readChatInteraction({ ...wire, fields: [{ ...fields[0], semantic: 'password' }] })).toBeUndefined();
  expect(readChatInteraction({ ...wire, subject: 'unknown' })).toBeUndefined();
});

test('selecting a vault record replaces the whole matching bundle and never uses bank data', () => {
  const before = initialPersonalValues(fields);
  const record = { id: 'address-1', type: 'address' as const, alias: '公司', fields: { owner: '另一个联系人', phone: '13900000000', address: '深圳市测试路2号' }, updatedAt: '2026-11-04' };
  const result = applyVaultAddress(fields, before, record);
  expect(result).toEqual({ contactName: '另一个联系人', mobile: '13900000000', street: '深圳市测试路2号' });
  expect(applyVaultAddress(fields, before, { ...record, type: 'bank' })).toBe(before);
});

test('prefilled fields are submitted without retyping, and one missing field is editable', async () => {
  const submit = jest.fn(); let root!: ReactTestRenderer;
  await act(async () => { root = create(<PersonalDetailsCard card={card} busy={false} submit={submit} />); });
  const inputs = root.root.findAllByType(TextInput);
  expect(inputs.map(input => input.props.value)).toEqual(fields.map(field => field.value));
  // The reusable Button ultimately exposes one Pressable host with its text.
  const press = root.root.findAll(node => typeof node.props.onPress === 'function' && node.props.children === '使用这些资料并执行')[0];
  expect(press.props.disabled).toBe(false);
  await act(async () => { press.props.onPress(); });
  expect(submit).toHaveBeenCalledWith(initialPersonalValues(fields));
  await act(async () => { inputs[1].props.onChangeText(''); });
  expect(root.root.findAll(node => typeof node.props.onPress === 'function' && node.props.children === '使用这些资料并执行')[0].props.disabled).toBe(true);
  await act(async () => { inputs[1].props.onChangeText('13900000000'); });
  expect(root.root.findAll(node => typeof node.props.onPress === 'function' && node.props.children === '使用这些资料并执行')[0].props.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test('the local vault is only opened on request and fills the requested address bundle after authentication', async () => {
  (privateVault.available as jest.Mock).mockReturnValue(true);
  (privateVault.summaries as jest.Mock).mockResolvedValue([{ id: 'home-1', type: 'address', alias: '家', summary: '已加密' }]);
  (privateVault.reveal as jest.Mock).mockResolvedValue({ id: 'home-1', type: 'address', alias: '家', fields: { owner: '本机联系人', phone: '13900000000', address: '测试市测试路9号' } });
  const prior = AppState.currentState;
  AppState.currentState = 'active';
  let tree!: ReactTestRenderer;
  try {
    await act(async () => { tree = create(<PersonalDetailsCard card={card} busy={false} submit={jest.fn()} />); });
    expect(privateVault.reveal).not.toHaveBeenCalled();
    const useVault = tree.root.findAll(node => typeof node.props.onPress === 'function' && node.props.children === '从本机私密资料填写')[0];
    await act(async () => { useVault.props.onPress(); });
    expect(privateVault.protect).toHaveBeenCalledWith(expect.stringContaining('test-user'), true);
    expect(privateVault.reveal).toHaveBeenCalledWith(expect.stringContaining('test-user'), 'home-1');
    expect(tree.root.findAllByType(TextInput).map(input => input.props.value)).toEqual(['本机联系人', '13900000000', '测试市测试路9号']);
  } finally {
    if (tree) await act(async () => { tree.unmount(); });
    AppState.currentState = prior;
    (privateVault.available as jest.Mock).mockReturnValue(false);
  }
});

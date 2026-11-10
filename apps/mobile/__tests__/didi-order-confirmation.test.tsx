import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ChatInteractionCard } from '../src/features/location/ChatInteractionCard';
import { readChatInteraction } from '../src/features/location/chatInteraction';
import { Button } from '../src/ui/components';

const wire = { id: 'card-1', run_id: 'run-1', expires_at: 1900000000, kind: 'didi_order',
  from: '测试上车点', to: '测试目的地', products: [{ name: '快车', price: '30' }], sandbox: false };

const cancelWire = { ...wire, kind: 'action_confirmation', title: '取消滴滴行程',
  details: '订单号 · ride-123', button: '确认取消' };
const paymentWire = { ...wire, kind: 'action_confirmation', title: '核对支付宝付款',
  details: '金额 · ¥30.00', button: '确认付款' };

test.each([
  [wire, '确认叫车', 'confirm_didi_order', '测试目的地'],
  [wire, '暂不叫车', 'cancel', '测试目的地'],
  [cancelWire, '确认取消', 'confirm_action', '订单号 · ride-123'],
  [cancelWire, '放弃操作', 'cancel', '订单号 · ride-123'],
  [paymentWire, '确认付款', 'confirm_action', '金额 · ¥30.00'],
] as const)('submits a chat card once without accepting operation parameters from the client (%#)', async (event, label, kind, details) => {
  const card = readChatInteraction(event);
  expect(card?.kind).toBe(event.kind);
  const request = jest.fn().mockResolvedValue({ accepted: true });
  let view!: ReactTestRenderer;
  await act(async () => { view = create(<ChatInteractionCard card={card!} api={{ request }} session={null} />); });
  try {
    expect(JSON.stringify(view.toJSON())).toContain(details);
    const button = view.root.findAllByType(Button).find(node => node.props.children === label)!;
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      const result = button.props.onPress();
      button.props.onPress();
      await result;
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/chat/interactions/run-1/card-1', 'POST', { kind }, expect.anything());
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test('requires a visible quote and carries the sandbox distinction', () => {
  expect(readChatInteraction({ ...wire, products: [] })).toBeUndefined();
  expect(readChatInteraction({ ...wire, sandbox: true })).toMatchObject({ kind: 'didi_order', sandbox: true });
});

test('validates the confirmation details and permits only official Alipay checkout links', () => {
  expect(readChatInteraction({ ...cancelWire, details: 'x'.repeat(12_201) })).toBeUndefined();
  const checkout = { ...wire, kind: 'alipay_checkout', payment_url: 'https://render.alipay.com/fixture' };
  expect(readChatInteraction(checkout)).toMatchObject({ kind: 'alipay_checkout', payment_url: checkout.payment_url });
  expect(readChatInteraction({ ...checkout, payment_url: 'https://alipay.com.invalid/fixture' })).toBeUndefined();
});

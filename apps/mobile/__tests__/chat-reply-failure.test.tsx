import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { ChatReplyFailure, replyFailureCopy } from '../src/ui/ChatReplyFailure';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });

test('a generic interruption never invents a provider outage or preserved assistant content', () => {
  const copy = replyFailureCopy('回复中断，已保留收到的内容；可重试此回复', false);
  expect(copy.title).toBe('这次回复没有完成');
  expect(copy.retained).toBe('你的消息已保留');
  expect(JSON.stringify(copy)).not.toMatch(/DeepSeek|繁忙|已生成的内容/);
});

test('busy, network and empty failures preserve the correct recovery advice', () => {
  expect(replyFailureCopy('HTTP 503 service_unavailable_error', false).title).toBe('模型暂时繁忙');
  expect(replyFailureCopy('网络连接中断', true)).toMatchObject({ title: '连接暂时中断', retained: '已生成的内容已保留' });
  expect(replyFailureCopy('', false).detail).toBe('请稍后重试。');
  const copy = replyFailureCopy('请重新登录\n请先重试这条消息，再继续发送新消息。', false);
  expect(copy.detail).toBe('请重新登录');
  expect(copy.gate).toBe('请先重试这条消息，再继续发送新消息。');
});

test('one accessible retry control calls the existing retry handler and keeps the notice compact', async () => {
  const retry = jest.fn(); let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatReplyFailure message="回复中断" hasContent onRetry={retry} />); });
  const buttons = tree.root.findAll(node => node.props.accessibilityLabel === '重试回复' && typeof node.props.onPress === 'function');
  expect(new Set(buttons.map(node => node.props.onPress)).size).toBe(1);
  expect(buttons[0].props).toMatchObject({ accessibilityLabel: '重试回复', accessibilityRole: 'button' });
  expect(tree.root.findAllByType(Text).map(node => node.props.children).join(' ')).toContain('已生成的内容已保留');
  await act(async () => buttons[0].props.onPress());
  expect(retry).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import {ApiError, type ApiClient, type User} from '@tada/client-core';
import {Chat} from './Chat';

vi.mock('@tanstack/react-virtual', () => ({useVirtualizer: (options: {count: number}) => ({
  getTotalSize: () => options.count * 100, scrollToIndex: vi.fn(), measureElement: vi.fn(),
  getVirtualItems: () => Array.from({length: options.count}, (_, index) => ({key: index, index, start: index * 100, size: 100})),
})}));
const user: User = {id: 'synthetic-user', name: '测试', email: '', timezone: 'Asia/Shanghai', created_at: ''};
describe('authoritative reply completion', () => {
  it.each(['done', 'snapshot'])('keeps a validated %s reply complete after a late transport error', async kind => {
    const onDone = vi.fn();
    const api = {chatStream: vi.fn(async (_intent, onEvent) => {
      const response = {conversation_id: 'conv-complete', message: {id: 'reply-complete', role: 'assistant', content: '已确认完成的回复', created_at: '', conversation_id: 'conv-complete'}};
      onEvent({id: 1, event: kind, data: kind === 'done' ? {response} : {status: 'done', content: response.message.content, response}});
      throw new ApiError('network', '回复连接已中断，收到的内容已保留。');
    })} as unknown as ApiClient;
    render(<Chat api={api} conversationId={null} user={user} onConversation={vi.fn()} onDone={onDone}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '测试问题'}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    await screen.findByText('已确认完成的回复');
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', {name: '继续接收'})).toBeNull();
    expect(screen.queryByText(/回复连接已中断/)).toBeNull();
    expect((screen.getByRole('textbox', {name: '发送消息'}) as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '下一条'}});
    expect((screen.getByRole('button', {name: '发送'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getAllByLabelText('你发送的消息')).toHaveLength(1);
  });

  it('keeps an incomplete reply interrupted and available for explicit resume', async () => {
    const onDone = vi.fn();
    const api = {chatStream: vi.fn(async (_intent, onEvent) => {
      onEvent({id: 1, event: 'text_delta', data: {delta: '尚未完成的部分'}});
      throw new ApiError('network', '真实断线');
    })} as unknown as ApiClient;
    render(<Chat api={api} conversationId={null} user={user} onConversation={vi.fn()} onDone={onDone}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '发送消息'}), {target: {value: '测试问题'}});
    fireEvent.click(screen.getByRole('button', {name: '发送'}));
    await screen.findByText('真实断线');
    expect(screen.getByText('尚未完成的部分')).toBeTruthy();
    expect(screen.getByRole('button', {name: '继续接收'})).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});

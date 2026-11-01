import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { ApiClient, ApiError } from '../src/api/client';
import { voiceFailure, voiceRetryTime } from '../src/screens/chatVoiceRecovery';
import { ChatVoiceRecovery } from '../src/ui/ChatVoiceRecovery';
import { Button } from '../src/ui/components';

jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => jest.useFakeTimers());
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

test('quota recovery distinguishes user/global limits and reports the Retry-After reset in local time', () => {
  const now = new Date('2026-11-01T14:20:00Z').getTime();
  const user = voiceFailure(new ApiError('asr_user_daily_limit', 'raw provider body', 429, 90), now);
  const global = voiceFailure(new ApiError('asr_global_daily_limit', 'raw provider body', 429, 120), now);
  expect(user).toMatchObject({ kind: 'quota', retryAt: now + 90000 });
  expect(global).toMatchObject({ kind: 'quota', retryAt: now + 120000 });
  expect(user.message).toContain('你的');
  expect(global.message).toContain('服务器');
  expect(voiceRetryTime(user.retryAt!)).toMatch(/^\d+月\d+日 \d{2}:\d{2}:\d{2}$/);
  for (const seconds of [-1, 0, 1.5, NaN, Infinity, 367 * 86400]) {
    expect(voiceFailure(new ApiError('asr_user_daily_limit', 'quota', 429, seconds), now).retryAt).toBeUndefined();
  }
});

test.each([
  ['asr_busy', 'busy'], ['asr_in_progress', 'processing'], ['asr_provider_auth', 'provider'], ['not_configured', 'provider'],
  ['asr_provider_quota', 'provider'], ['asr_provider_redirect', 'provider'],
  ['asr_provider_rate_limited', 'provider'], ['asr_provider_unavailable', 'provider'],
  ['asr_timeout', 'uncertain'], ['timeout', 'uncertain'], ['network', 'uncertain'], ['rate_limited', 'other'],
])('voice classifier %s does not display an upstream body', (code, kind) => {
  const failure = voiceFailure(new ApiError(code, 'sensitive provider upstream body', 503, 2));
  expect(failure.kind).toBe(kind);
  expect(failure.message).not.toContain('sensitive provider upstream body');
});

test('unknown API failures are bounded while a local actionable recorder error is retained', () => {
  expect(voiceFailure(new ApiError('future_provider_code', 'SECRET UPSTREAM')).message).not.toContain('SECRET UPSTREAM');
  expect(voiceFailure(new Error('请先缩短输入内容')).message).toContain('请先缩短输入内容');
  expect(voiceFailure(new ApiError('no_speech', 'upstream empty result')).message).toContain('重新录制');
  expect(voiceFailure(new ApiError('not_configured', 'upstream config details')).message).toContain('管理员');
});

test('a future quota reset is advisory: no timer posts and the only manual retry remains available', async () => {
  const now = new Date('2026-11-01T14:20:00Z').getTime(); jest.setSystemTime(now);
  const onRetry = jest.fn(), onCancel = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatVoiceRecovery phase="转写未完成" busy={false} blocked={false}
    failure={voiceFailure(new ApiError('asr_user_daily_limit', 'quota', 429, 3600), now)}
    retryLabel="重试识别并发送" onRetry={onRetry} onCancel={onCancel} />); });
  const buttons = tree.root.findAllByType(Button);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.disabled).toBe(false);
  expect(buttons[0].props.children).toBe('重新检查额度');
  await act(async () => { jest.advanceTimersByTime(60000); });
  expect(onRetry).not.toHaveBeenCalled();
  await act(async () => buttons[0].props.onPress());
  expect(onRetry).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(3600000); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('busy work exposes cancellation and never permits a second manual request', async () => {
  const onRetry = jest.fn(); let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ChatVoiceRecovery phase="正在转成文字…" busy={true} blocked={false}
    retryLabel="重试转写" onRetry={onRetry} onCancel={jest.fn()} />); });
  expect(tree.root.findAllByType(Button)).toHaveLength(0);
  await act(async () => tree.update(<ChatVoiceRecovery phase="失败" busy={false} blocked={true}
    retryLabel="重试转写" onRetry={onRetry} onCancel={jest.fn()} />));
  const button = tree.root.findByType(Button);
  expect(button.props.disabled).toBe(true);
  await act(async () => button.props.onPress());
  expect(onRetry).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('transcribe allows server queue and provider deadlines before 170 seconds, without retrying POST', async () => {
  let signal!: AbortSignal;
  const fetcher = jest.fn((_url, init) => new Promise<Response>((resolve, reject) => {
    signal = init.signal;
    const timer = setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify({ text: '保留的录音' }) } as Response), 155000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  const result = api.transcribe('voice/id');
  await jest.advanceTimersByTimeAsync(120001);
  expect(signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(34999);
  await expect(result).resolves.toMatchObject({ text: '保留的录音' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://self.example/v1/uploads/voice%2Fid/transcribe');
  expect(fetcher.mock.calls[0][1].method).toBe('POST');
});

test.each([['asr', 170000], ['image', 120000]] as const)('%s deadline stays bounded and never creates an automatic retry', async (kind, duration) => {
  let signal!: AbortSignal;
  const fetcher = jest.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const api = new ApiClient('https://self.example', 'synthetic', undefined, fetcher);
  const result = (kind === 'asr' ? api.transcribe('same-recording') : api.analyzeImage('photo')).catch(error => error);
  await jest.advanceTimersByTimeAsync(duration - 1);
  expect(signal.aborted).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ code: 'timeout' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

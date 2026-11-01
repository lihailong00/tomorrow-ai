import { ApiError, errorMessage } from '../api/client';

export type VoiceFailure = {
  kind: 'quota' | 'busy' | 'processing' | 'provider' | 'uncertain' | 'other';
  message: string;
  retryAt?: number;
};

export function voiceFailure(error: unknown, now = Date.now()): VoiceFailure {
  const code = error instanceof ApiError ? error.code : '';
  const seconds = error instanceof ApiError ? error.retryAfterSeconds : undefined;
  const retryAt = typeof seconds === 'number' && Number.isSafeInteger(seconds) &&
    seconds > 0 && seconds <= 366 * 86400 ? now + seconds * 1000 : undefined;
  if (code === 'asr_user_daily_limit' || code === 'asr_global_daily_limit') return {
    kind: 'quota', retryAt,
    message: code === 'asr_user_daily_limit' ? '你的语音识别额度暂时用完了。' : '服务器的语音识别额度暂时用完了。',
  };
  if (code === 'asr_busy') return { kind: 'busy', retryAt, message: '语音服务暂时繁忙，这次尚未开始转写。' };
  if (code === 'asr_in_progress') return { kind: 'processing', retryAt, message: '这段录音仍在转写，请稍后重试，无需重新录制。' };
  if (code === 'asr_retry_required') return { kind: 'other', message: '上一轮转写未完成，请手动重试这段录音。' };
  if (code === 'asr_provider_auth' || code === 'asr_disabled' || code === 'asr_not_configured' || code === 'not_configured') return {
    kind: 'provider', message: '语音服务配置或权限异常，请联系这台服务器的管理员。',
  };
  if (code === 'asr_provider_quota') return {
    kind: 'provider', message: '语音服务商的余额或额度不足，请联系这台服务器的管理员。',
  };
  if (code === 'asr_provider_redirect') return {
    kind: 'provider', message: '语音服务地址配置异常，请联系这台服务器的管理员。',
  };
  if (code === 'no_speech') return {
    kind: 'other', message: '未识别到语音，请关闭这段录音后重新录制，或继续输入文字。',
  };
  if (code === 'asr_provider_rate_limited') return { kind: 'provider', retryAt, message: '语音服务商暂时限流，请稍后手动重试。' };
  if (code === 'asr_provider_unavailable' || code === 'asr_unavailable') return {
    kind: 'provider', retryAt, message: '语音服务暂不可用，请稍后手动重试。',
  };
  if (code === 'asr_timeout' || code === 'timeout' || code === 'network') return {
    kind: 'uncertain', message: '上一次转写结果暂未确认；可手动重试同一录音，服务商仍可能计费。',
  };
  if (code === 'rate_limited') return { kind: 'other', retryAt, message: '请求暂时受到限制，请稍后手动重试。' };
  // API messages are server-controlled. Known provider failures never expose a
  // provider response body here; local recorder/input errors remain actionable.
  return { kind: 'other', message: error instanceof ApiError
    ? '转写未完成，请稍后手动重试；也可以继续输入文字。' : `转写未完成：${errorMessage(error)}` };
}

export function voiceRetryTime(retryAt: number): string {
  const date = new Date(retryAt);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

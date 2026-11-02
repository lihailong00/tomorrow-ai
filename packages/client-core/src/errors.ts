export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0, public readonly retryAfterSeconds?: number) {
    super(message); this.name = 'ApiError';
  }
}
export function cancelled(): ApiError { return new ApiError('cancelled', '操作已取消，已收到的内容会保留。'); }
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请稍后重试。';
}

export function validatePassword(value: string): void {
  const length = Array.from(value).length;
  if (length < 8 || length > 128) {
    throw new Error('密码需要 8–128 个字符。');
  }
}

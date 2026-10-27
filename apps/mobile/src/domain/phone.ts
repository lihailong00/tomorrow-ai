export function normalizePhoneNumber(value: string): string {
  const number = value.replace(/[\s-]/g, '').replace(/^(\+86|0086)/, '');
  if (!/^1[3-9][0-9]{9}$/.test(number)) {
    throw new Error('请输入有效的中国大陆手机号。');
  }
  return `+86${number}`;
}

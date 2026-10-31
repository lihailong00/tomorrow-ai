import { walletDocumentationUrl } from '../src/features/personal-mcp/walletLinks';

it('allows the two verified public wallet documentation pages', () => {
  for (const url of [
    'https://aipay.alipay.com/wallet-guide',
    'https://aipay.alipay.com/products/mobile-agent-pay',
  ]) {
    expect(walletDocumentationUrl(url)).toBe(url);
  }
});

it.each([
  'javascript:alert(1)',
  'http://aipay.alipay.com/wallet-guide',
  'https://evil.example/wallet-guide',
  'https://aipay.alipay.com.evil.example/wallet-guide',
  'https://aipay.alipay.com@evil.example/wallet-guide',
  'https://user@aipay.alipay.com/wallet-guide',
  'https://aipay.alipay.com:8080/wallet-guide',
  'https://aipay.alipay.com/wallet-guide#token',
  'https://aipay.alipay.com/wallet-guide\n',
  ' https://aipay.alipay.com/wallet-guide',
  'alipays://platformapi/startapp?appId=123',
  'https://qr.alipay.com/pay/abc',
  'https://aipay.alipay.com./wallet-guide',
  'https://aipay.alipay.com/wallet-guide?redirect=https://evil.example',
  'https://u.alipay.com/authorization',
])('rejects a non-documentation URL: %s', input => {
  expect(walletDocumentationUrl(input)).toBeNull();
});

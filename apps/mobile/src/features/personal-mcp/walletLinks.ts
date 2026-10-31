/** Only the verified public documentation pages; never a payment or auth link. */
export function walletDocumentationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return [
    'https://aipay.alipay.com/wallet-guide',
    'https://aipay.alipay.com/products/mobile-agent-pay',
  ].includes(value)
    ? value
    : null;
}

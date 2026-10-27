/** Public server identity. This record never contains account or service secrets. */
export interface InstanceManifest {
  id: string;
  name: string;
  deployment_mode: 'official' | 'self_hosted';
  api_version: 1;
  auth_methods: Array<'phone_password' | 'email_password'>;
  registration_policy: 'open' | 'invite_only' | 'closed';
  public_url: string;
  dataflow: { conversation: string; voice: string; images: string; files: string };
  configuration_revision?: number;
}

export function readInstanceManifest(value: unknown): InstanceManifest {
  const item = value as InstanceManifest | null;
  if (!item || typeof item !== 'object' || item.api_version !== 1 ||
      typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120 ||
      !['official', 'self_hosted'].includes(item.deployment_mode) ||
      !['open', 'invite_only', 'closed'].includes(item.registration_policy) ||
      !Array.isArray(item.auth_methods) || !item.auth_methods.length ||
      item.auth_methods.some(method => !['phone_password', 'email_password'].includes(method)) ||
      typeof item.public_url !== 'string' || !item.dataflow ||
      ['conversation', 'voice', 'images', 'files'].some(key => {
        const value = item.dataflow[key as keyof InstanceManifest['dataflow']];
        return typeof value !== 'string' || value.length > 1000;
      })) {
    throw new Error('此服务器版本不兼容，或尚未完成初始化。请联系服务器管理员。');
  }
  return item;
}

/** A phone may deliberately use HTTP on a private LAN; public connections require TLS. */
export function instanceServerUrl(input: string, allowInsecureLan = false): string {
  const value = input.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  const match = /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i.exec(value);
  if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) {
    throw new Error('请输入不含账号、路径或参数的服务器地址，例如 https://tada.example.com');
  }
  const protocol = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const octets = host.split('.').map(Number);
  const privateV4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (octets[0] === 10 || octets[0] === 127 ||
     (octets[0] === 192 && octets[1] === 168) ||
     (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const local = privateV4 || host === 'localhost' || host.endsWith('.local') ||
    host === '[::1]' || /^\[f[cd][0-9a-f:]+\]$/.test(host);
  if (protocol === 'http' && (!local || !allowInsecureLan)) {
    throw new Error('公网连接需要 HTTPS。局域网 HTTP 需要先开启下方的高级选项。');
  }
  return `${protocol}://${host}${match[3] ? `:${Number(match[3])}` : ''}`;
}

export function connectionFromLink(input: string): { url: string; instanceId: string } {
  // Treat a QR/deep link as a proposal only. The UI must fetch the manifest and
  // obtain explicit confirmation before replacing the current connection.
  const match = /^tada:\/\/connect\?([^#]{1,3000})$/.exec(input);
  if (!match) throw new Error('这不是妥啦服务器连接链接。');
  const values: Record<string, string> = {};
  for (const pair of match[1].split('&')) {
    const index = pair.indexOf('=');
    if (index < 0) throw new Error('连接链接不完整。');
    let key: string; let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, index));
      value = decodeURIComponent(pair.slice(index + 1));
    } catch { throw new Error('连接链接无法识别。'); }
    if (!['url', 'instance'].includes(key) || key in values) throw new Error('连接链接含有不支持的参数。');
    values[key] = value;
  }
  if (!values.url || !/^[a-zA-Z0-9_-]{1,128}$/.test(values.instance ?? '')) {
    throw new Error('连接链接不完整。');
  }
  return { url: values.url, instanceId: values.instance };
}

import {
  connectionRows,
  type ConnectionSnapshot,
} from '../src/features/integrations/connectionsCatalog';
import type { PersonalMcpConnection } from '../src/features/personal-mcp/types';

const requested = [
  'dida365',
  'fliggy',
  'jianguoyun',
  'amap',
  'baidu_maps',
  'qq_mail',
  'netease163',
  'netease126',
  'tencent_docs',
  'tencent_meeting',
  'didi',
  'mcdonalds',
  'notion',
  'memos',
  'weread',
  'weiyun',
  'luckin',
  'qq_music',
  'ima',
];
const added = [
  'dida365',
  'fliggy',
  'jianguoyun',
  'baidu_maps',
  'weread',
  'weiyun',
  'luckin',
  'qq_music',
  'ima',
];
const empty: ConnectionSnapshot = {
  native: null,
  integrations: null,
  mcp: null,
  health: null,
  systemHealth: null,
  photoEnabled: null,
};
const connection = (
  id: string,
  extra: Partial<PersonalMcpConnection> = {},
): PersonalMcpConnection => ({
  id,
  name: id,
  description: '本人授权服务',
  help_url: 'https://example.invalid',
  credential_label: '个人凭证',
  transport: 'streamable_http',
  status: 'not_connected',
  tool_count: 0,
  environment: 'production',
  ...extra,
});

test('all nineteen choices remain discoverable before catalog loading and without saved credentials', () => {
  const rows = connectionRows(empty, []);
  for (const id of requested)
    expect(rows.some(row => 'id' in row.target && row.target.id === id)).toBe(
      true,
    );
  expect(rows.some(row => row.added || row.usable)).toBe(false);
});

test.each(added)(
  'an older server keeps %s visible and truthfully unavailable',
  id => {
    const rows = connectionRows({ ...empty, mcp: [connection('didi')] }, []);
    const row = rows.find(item => item.key === 'mcp:' + id)!;
    expect(row).toBeDefined();
    expect(row.status).toBe('当前服务器尚未提供');
    expect(row.unavailable).toBe(true);
    expect(row.added).toBe(false);
    expect(row.usable).toBe(false);
  },
);

test('advertised Fliggy with blank credentials is selectable, not already connected', () => {
  const rows = connectionRows(
    { ...empty, mcp: [connection('fliggy', { name: '飞猪' })] },
    [],
  );
  const row = rows.find(item => item.key === 'mcp:fliggy')!;
  expect(row.name).toBe('飞猪');
  expect(row.status).toBe('未连接');
  expect(row.unavailable).toBe(false);
  expect(row.usable).toBe(false);
});

test('removed catalog entries cannot be resurrected as connected by an earlier update', () => {
  const rows = connectionRows(
    {
      ...empty,
      mcp: [],
      mcpUpdates: [
        connection('fliggy', { status: 'connected', has_credentials: true }),
      ],
    },
    [],
  );
  const row = rows.find(item => item.key === 'mcp:fliggy')!;
  expect(row.unavailable).toBe(true);
  expect(row.added).toBe(false);
  expect(row.usable).toBe(false);
});

test('new server-provided providers are retained alongside the built-in choices', () => {
  const rows = connectionRows(
    { ...empty, mcp: [connection('extra-provider')] },
    [],
  );
  expect(rows.some(row => row.key === 'mcp:extra-provider')).toBe(true);
  expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
});

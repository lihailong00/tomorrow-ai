import React from 'react';
import { BackHandler, Switch, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppProvider, type AppContextValue } from '../src/app/context';
import { IntegrationsScreen } from '../src/features/integrations/IntegrationsScreen';
import { Button } from '../src/ui/components';
import {
  connectionRows,
  filterConnectionRows,
  type ConnectionSnapshot,
} from '../src/features/integrations/connectionsCatalog';
import { appInputSources, appInputs, type AppInputStatus } from '../src/platform/appInputs';

const mockForegroundCallbacks = new Set<() => void>();
jest.mock('../src/platform/appInputs', () => ({
  ...jest.requireActual('../src/platform/appInputs'),
  appInputs: {
    supported: true, hasImageTextRecognition: false,
    getStatus: jest.fn(), listPending: jest.fn().mockResolvedValue([]),
    setApps: jest.fn().mockResolvedValue(undefined),
    dismiss: jest.fn().mockResolvedValue(undefined),
    openNotificationSettings: jest.fn().mockResolvedValue(undefined),
    openApp: jest.fn().mockResolvedValue(false),
  },
}));
jest.mock('../src/platform/ports', () => ({
  platform: {
    onForeground: jest.fn((callback: () => void) => {
      mockForegroundCallbacks.add(callback);
      return () => mockForegroundCallbacks.delete(callback);
    }),
    pickDocument: jest.fn().mockResolvedValue(undefined),
    openUrl: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/platform/photoIndex', () => ({ photoIndexAvailable: false, photoIndex: {} }));
jest.mock('../src/features/health/native', () => ({ nativeHealth: {
  availability: jest.fn().mockResolvedValue({ provider: 'health_connect', status: 'unavailable', detail: '测试未提供系统健康通道' }),
} }));
jest.mock('../src/ui/visuals', () => ({ Icon: () => null }));

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => { jest.clearAllMocks(); mockForegroundCallbacks.clear(); });

const empty: ConnectionSnapshot = {
  native: null,
  integrations: null,
  mcp: null,
  health: null,
  systemHealth: null,
  photoEnabled: null,
};

function rows(patch: Partial<ConnectionSnapshot> = {}) {
  return connectionRows({ ...empty, ...patch }, appInputSources);
}

describe('independent connections catalog acceptance', () => {
  it('keeps all 17 native app sources independently addressable without claiming they are installed', () => {
    const expected = [
      'wechat', 'qq', 'xiaohongshu', 'bilibili', 'douyin', 'zhihu', 'taobao',
      'jd', 'meituan', 'alipay', 'didi', 'feishu', 'dingtalk', 'wecom', 'wps',
      'tencent_docs', 'amap',
    ];
    const apps = rows().filter(row => row.target.kind === 'app');
    expect(apps.map(row => row.key)).toEqual(expected.map(id => 'app:' + id));
    expect(new Set(apps.map(row => row.key)).size).toBe(17);
    expect(apps.every(row => !row.added && !row.usable)).toBe(true);
    expect(apps.every(row => row.status !== '手机已安装')).toBe(true);
  });

  it('does not count a selected app as usable while its notification permission is off', () => {
    const selected = rows({ native: {
      supported: true, notification_access: false, selected_apps: ['wechat'],
      installed_apps: ['wechat'], pending_count: 0,
    } }).find(row => row.key === 'app:wechat')!;
    expect(selected.added).toBe(true);
    expect(selected.usable).toBe(false);
    expect(selected.attention).toBe(true);
    expect(selected.status).toContain('待开启通知权限');
  });

  it('keeps uninstalled apps usable through manual import rather than inventing a notification connection', () => {
    const selected = rows({ native: {
      supported: true, notification_access: true, selected_apps: ['wechat'],
      installed_apps: [], pending_count: 0,
    } }).find(row => row.key === 'app:wechat')!;
    expect(selected.usable).toBe(false);
    expect(selected.attention).toBe(true);
    expect(selected.status).toContain('未安装');
    expect(rows().find(row => row.key === 'local:share')!.method).toContain('复制粘贴');
  });

  it('does not fabricate connected states when server or native catalogs are missing', () => {
    const result = rows();
    expect(result.some(row => row.added || row.usable)).toBe(false);
    expect(result.find(row => row.key === 'mcp:alipay')!.unavailable).toBe(true);
    expect(result.find(row => row.key === 'health:huawei')!.status).toBe('服务状态待确认');
    expect(result.find(row => row.key === 'health:apple')!.status).toContain('不支持直接连接');
  });

  it('retains expired personal credentials in management without presenting them as usable', () => {
    const result = rows({ mcp: [{
      id: 'yinxiang', name: '印象笔记', description: '查找笔记', help_url: 'https://example.test/help',
      credential_label: '个人凭据', transport: 'streamable_http', status: 'needs_reconnect',
      tool_count: 0, has_credentials: true, environment: 'production',
    }] });
    const expired = result.find(row => row.key === 'mcp:yinxiang')!;
    expect(expired.added).toBe(true);
    expect(expired.usable).toBe(false);
    expect(expired.attention).toBe(true);
    expect(filterConnectionRows(result, 'local', '', true).map(row => row.key)).toEqual(['mcp:yinxiang']);
  });

  it('distinguishes an available system health service from granted access and a configured vendor account', () => {
    const result = rows({
      systemHealth: { provider: 'health_connect', status: 'available', detail: '系统支持' },
      health: [{ id: 'huawei', name: '华为运动健康', status: 'not_configured',
        detail: '服务未配置', metrics: ['steps'], has_credentials: false }],
    });
    expect(result.find(row => row.key === 'health:system')!.added).toBe(false);
    expect(result.find(row => row.key === 'health:system')!.usable).toBe(false);
    expect(result.find(row => row.key === 'health:system')!.status).toContain('查看授权范围');
    expect(result.find(row => row.key === 'health:huawei')!.unavailable).toBe(true);
    expect(result.find(row => row.key === 'health:huawei')!.usable).toBe(false);
  });

  it('retains email connectors and separates public service readiness from a connected personal account', () => {
    const result = rows({ integrations: [
      { id: 'qq_mail', name: 'QQ 邮箱', category: '邮件', mode: 'mail', status: 'not_connected', detail: '只读邮件' },
      { id: 'amap', name: '高德地图', category: '出行', mode: 'map', status: 'available', detail: '公共地点查询' },
      { id: 'wechat', name: '微信', category: '聊天', mode: 'import', status: 'available', detail: '主动导入' },
    ] });
    expect(result.find(row => row.key === 'integration:qq_mail')!.method).toContain('本人邮箱');
    expect(result.find(row => row.key === 'integration:amap')!.added).toBe(false);
    expect(result.find(row => row.key === 'integration:amap')!.method).toContain('后台配置');
    expect(result.find(row => row.key === 'integration:wechat')).toBeUndefined();
  });

  it('distinguishes indexing enabled from indexing usable instead of hiding failures in a connected count', () => {
    const failed = rows({ photoEnabled: true, photoState: 'failed' }).find(row => row.key === 'local:photos')!;
    expect(failed.added).toBe(true);
    expect(failed.usable).toBe(false);
    expect(failed.attention).toBe(true);
    const idle = rows({ photoEnabled: true, photoState: 'idle' }).find(row => row.key === 'local:photos')!;
    expect(idle.usable).toBe(true);
  });

  it('searches across categories by a stated use while managing only accounts actually added', () => {
    const result = rows({ native: {
      supported: true, notification_access: false, selected_apps: ['wechat'],
      installed_apps: ['wechat'], pending_count: 0,
    } });
    expect(filterConnectionRows(result, 'devices', '  微信  ', false).map(row => row.key)).toEqual(['app:wechat', 'app:wecom']);
    expect(filterConnectionRows(result, 'cloud', '', true).map(row => row.key)).toEqual(['app:wechat']);
    expect(filterConnectionRows(result, 'local', '不存在的应用', false)).toEqual([]);
  });
});

async function renderConnections(request: jest.Mock) {
  const context = {
    api: { request, upload: jest.fn(), baseUrl: 'http://127.0.0.1:18093' },
    user: { id: 'independent-user' },
    preferences: { serverUrl: 'http://127.0.0.1:18093' },
    navigate: jest.fn(), back: jest.fn(), revision: 0,
  } as unknown as AppContextValue;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<AppProvider value={context}><IntegrationsScreen /></AppProvider>); });
  return {
    context, tree,
    async press(label: string) {
      await act(async () => {
        const button = tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
        if (!button) throw new Error('Missing control: ' + label);
        await button.props.onPress();
      });
    },
    async row(id: string) {
      await act(async () => {
        const row = tree.root.findAll(node => node.props.testID === 'connection-row-' + id && typeof node.props.onPress === 'function')[0];
        if (!row) throw new Error('Missing row: ' + id);
        await row.props.onPress();
      });
    },
    async search(query: string) {
      await act(async () => {
        tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '搜索应用或用途')!.props.onChangeText(query);
      });
    },
    async button(label: string) {
      const read = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(read).join('') : React.isValidElement(value) ? read((value.props as any).children) : '';
      await act(async () => {
        const node = tree.root.findAllByType(Button).find(candidate => read(candidate.props.children) === label);
        if (!node) throw new Error('Missing button: ' + label);
        await node.props.onPress();
      });
    },
    rowLabels() {
      return [...new Set(tree.root.findAll(node => node.props.testID?.startsWith('connection-row-')).map(node => node.props.accessibilityLabel as string))];
    },
    text() {
      const read = (node: any): string => typeof node === 'string' ? node : Array.isArray(node) ? node.map(read).join('') : read(node?.children || []);
      return read(tree.toJSON());
    },
    async unmount() { await act(async () => tree.unmount()); },
  };
}

const nativeStatus = (notification_access = false): AppInputStatus => ({
  supported: true, notification_access, selected_apps: ['wechat'], installed_apps: ['wechat'], pending_count: 0,
});
const emptyRequest = () => jest.fn(async () => ({ items: [] }));

describe('independent real React Native interaction acceptance', () => {
  it('consumes hardware back through detail, search, management and root navigation', async () => {
    (appInputs.getStatus as jest.Mock).mockResolvedValue({ ...nativeStatus(), selected_apps: [] });
    const handlers = new Set<() => boolean | null | undefined>();
    const subscription = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
      handlers.add(handler);
      return { remove: () => { handlers.delete(handler); } };
    });
    const dispatch = () => {
      for (const handler of [...handlers].reverse()) if (handler()) return true;
      return false;
    };
    const view = await renderConnections(emptyRequest());
    try {
      await view.search('QQ');
      await view.row('app:qq');
      await act(async () => { expect(dispatch()).toBe(true); });
      expect(view.tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '搜索应用或用途')!.props.value).toBe('QQ');
      expect(view.context.back).not.toHaveBeenCalled();
      await act(async () => { expect(dispatch()).toBe(true); });
      expect(view.tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '搜索应用或用途')!.props.value).toBe('');
      await view.press('管理已添加的连接');
      await act(async () => { expect(dispatch()).toBe(true); });
      expect(view.context.back).not.toHaveBeenCalled();
      await act(async () => { expect(dispatch()).toBe(true); });
      expect(view.context.back).toHaveBeenCalledTimes(1);
    } finally { await view.unmount(); subscription.mockRestore(); }
  });

  it('does not let an app toggle read overwrite a newer foreground permission revocation', async () => {
    const initial = { ...nativeStatus(true), selected_apps: [] };
    let releaseToggleRead!: (value: AppInputStatus) => void;
    const toggleRead = new Promise<AppInputStatus>(resolve => { releaseToggleRead = resolve; });
    let reads = 0;
    (appInputs.getStatus as jest.Mock).mockImplementation(async () => {
      reads += 1;
      if (reads <= 2) return initial;
      if (reads === 3) return toggleRead;
      return nativeStatus(false);
    });
    const view = await renderConnections(emptyRequest());
    try {
      await view.row('app:wechat');
      await act(async () => {
        view.tree.root.findAllByType(Switch).find(node => node.props.accessibilityLabel === '微信接收通知')!.props.onValueChange(true);
      });
      expect(reads).toBe(3);
      await act(async () => { for (const callback of mockForegroundCallbacks) callback(); });
      expect(view.text()).toContain('待开启通知权限');
      await act(async () => { releaseToggleRead(nativeStatus(true)); });
      expect(view.text()).toContain('待开启通知权限');
      expect(view.text()).not.toContain('通知已开启');
    } finally { releaseToggleRead(nativeStatus(true)); await view.unmount(); }
  });

  it('refreshes revoked native permission on foreground while a cloud catalog is still pending', async () => {
    let release!: (value: { items: never[] }) => void;
    const pending = new Promise<{ items: never[] }>(resolve => { release = resolve; });
    let current = nativeStatus(true);
    (appInputs.getStatus as jest.Mock).mockImplementation(async () => current);
    const request = jest.fn((path: string) => path === '/personal-mcp' ? pending : Promise.resolve({ items: [] }));
    const view = await renderConnections(request);
    try {
      expect(view.rowLabels().find(label => label.startsWith('微信，'))).toContain('通知已开启');
      current = nativeStatus(false);
      await act(async () => { for (const callback of mockForegroundCallbacks) callback(); });
      expect(appInputs.getStatus).toHaveBeenCalledTimes(2);
      expect(view.rowLabels().find(label => label.startsWith('微信，'))).toContain('待开启通知权限');
    } finally {
      release({ items: [] });
      await view.unmount();
    }
  });

  it('keeps all local app rows and explicit paste actions reachable when every cloud request fails', async () => {
    (appInputs.getStatus as jest.Mock).mockResolvedValue({ ...nativeStatus(false), installed_apps: [] });
    const view = await renderConnections(jest.fn().mockRejectedValue(new Error('测试云端暂不可用')));
    try {
      expect(view.rowLabels().filter(label => appInputSources.some(app => label.startsWith(app.name + '，')))).toHaveLength(17);
      await view.row('app:wechat');
      expect(view.tree.root.findAll(node => node.props.accessibilityLabel === '返回连接列表').length).toBeGreaterThan(0);
      // The feature's Button label is a child; checking its rendered tree avoids invoking a cloud call.
      expect(view.text()).toContain('粘贴微信内容');
      expect(view.text()).not.toContain('打开微信');
    } finally { await view.unmount(); }
  });

  it('ignores an older native permission response that arrives after a foreground refresh', async () => {
    let releaseNative!: (value: AppInputStatus) => void;
    let releaseCloud!: (value: { items: never[] }) => void;
    const pendingNative = new Promise<AppInputStatus>(resolve => { releaseNative = resolve; });
    const pendingCloud = new Promise<{ items: never[] }>(resolve => { releaseCloud = resolve; });
    (appInputs.getStatus as jest.Mock).mockImplementationOnce(() => pendingNative).mockResolvedValue(nativeStatus(false));
    const request = jest.fn((path: string) => path === '/personal-mcp' ? pendingCloud : Promise.resolve({ items: [] }));
    const view = await renderConnections(request);
    try {
      await act(async () => { for (const callback of mockForegroundCallbacks) callback(); });
      expect(view.rowLabels().find(label => label.startsWith('微信，'))).toContain('待开启通知权限');
      await act(async () => { releaseNative(nativeStatus(true)); });
      expect(view.rowLabels().find(label => label.startsWith('微信，'))).toContain('待开启通知权限');
    } finally { releaseNative(nativeStatus(true)); releaseCloud({ items: [] }); await view.unmount(); }
  });

  it('searches across category boundaries without exposing a fake connected state', async () => {
    (appInputs.getStatus as jest.Mock).mockResolvedValue({ ...nativeStatus(), selected_apps: [] });
    const view = await renderConnections(emptyRequest());
    try {
      await view.press('外部设备');
      await view.search('微信');
      expect(view.rowLabels().map(label => label.split('，')[0])).toEqual(['微信', '企业微信']);
      expect(view.rowLabels().some(label => label.includes('已连接'))).toBe(false);
    } finally { await view.unmount(); }
  });

  it('isolates one MCP provider and immediately reflects a failed credential test in the hub', async () => {
    (appInputs.getStatus as jest.Mock).mockResolvedValue({ ...nativeStatus(), selected_apps: [] });
    let current = {
      id: 'yinxiang', name: '印象笔记', description: '查找笔记', help_url: 'https://example.test/help',
      credential_label: '个人凭据', transport: 'streamable_http', status: 'connected',
      tool_count: 2, has_credentials: true, environment: 'production',
    };
    const other = { ...current, id: 'yuque', name: '其他平台秘密' };
    const original = { ...current };
    let mcpReads = 0;
    let releaseStale!: (value: unknown) => void;
    const staleCatalog = new Promise(resolve => { releaseStale = resolve; });
    const request = jest.fn(async (path: string) => {
      if (path === '/personal-mcp') { mcpReads += 1; return mcpReads === 2 ? staleCatalog : { items: [current, other] }; }
      if (path === '/personal-mcp/actions') return { items: [{ id: 'other-action', provider: 'yuque',
        provider_name: '其他平台秘密', tool: '其他平台操作', arguments: { secret: '其他平台私密参数' },
        status: 'pending', expires_at: '2099-01-01T00:00:00Z' }] };
      if (path === '/personal-mcp/yinxiang/test') {
        current = { ...current, status: 'needs_reconnect' };
        throw new Error('测试凭据已失效');
      }
      return { items: [] };
    });
    const view = await renderConnections(request);
    try {
      await view.press('云端账号');
      await act(async () => { for (const callback of mockForegroundCallbacks) callback(); });
      await view.row('mcp:yinxiang');
      expect(view.text()).not.toContain('其他平台秘密');
      expect(view.text()).not.toContain('其他平台私密参数');
      await view.button('测试连接');
      expect(view.text()).toContain('测试凭据已失效');
      expect(view.text()).toContain('需要重新连接');
      await act(async () => { releaseStale({ items: [original, other] }); });
      await view.press('返回连接列表');
      expect(view.rowLabels().find(label => label.startsWith('印象笔记，'))).toContain('需要重新连接');
      expect(view.text()).toContain('1 项当前可用');
    } finally { releaseStale({ items: [] }); await view.unmount(); }
  });

  it('clears browse input on account/server changes and ignores a late old-account response', async () => {
    (appInputs.getStatus as jest.Mock).mockResolvedValue({ ...nativeStatus(), selected_apps: [] });
    let release!: (value: unknown) => void;
    const pending = new Promise(resolve => { release = resolve; });
    const request = jest.fn((path: string) => path === '/personal-mcp' ? pending : Promise.resolve({ items: [] }));
    const view = await renderConnections(request);
    try {
      await view.search('旧账号私密检索');
      const context = { ...view.context,
        api: { ...view.context.api, baseUrl: 'http://127.0.0.1:18094', request: emptyRequest() },
        user: { id: 'different-user' },
      } as unknown as AppContextValue;
      await act(async () => { view.tree.update(<AppProvider value={context}><IntegrationsScreen /></AppProvider>); });
      expect(view.tree.root.findAllByType(TextInput).find(node => node.props.accessibilityLabel === '搜索应用或用途')!.props.value).toBe('');
      await act(async () => { release({ items: [{ id: 'yinxiang', name: '旧账号私密连接', description: '私密', status: 'connected', has_credentials: true }] }); });
      expect(view.text()).not.toContain('旧账号私密连接');
      expect(view.text()).not.toContain('旧账号私密检索');
    } finally { release({ items: [] }); await view.unmount(); }
  });
});

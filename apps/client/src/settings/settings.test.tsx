import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiClient, ApiError, type InstanceManifest, type User} from '@tada/client-core';
import {App} from '../App';
import {createPlatform} from '../platform';
import {SettingsPage} from './SettingsPage';
import {profileInput, readNotifications, readUploads} from './shared';
import {readReport, type UsageMetrics, type UsageReport} from './usageApi';

vi.mock('../platform', async original => ({...await original<typeof import('../platform')>(), createPlatform: vi.fn()}));
const user: User = {id: 'settings-user', email: 'person@example.test', phone: '+8613800000001', name: '测试用户', timezone: 'Asia/Shanghai', created_at: '2026-11-01T00:00:00Z'};
const manifest: InstanceManifest = {id: 'settings-instance', name: '合成服务', deployment_mode: 'self_hosted', api_version: 1, auth_methods: ['phone_password'], registration_policy: 'closed', public_url: 'http://127.0.0.1:20223', dataflow: {chat: {processor: '测试模型', destination: '合成服务商'}}};
function props(request = vi.fn()) {
  const api = {baseUrl: manifest.public_url, request, inspectInstance: vi.fn(async () => manifest), health: vi.fn(async () => ({ok: true}))} as unknown as ApiClient;
  return {api, user: {...user}, manifest, choice: {url: manifest.public_url, instanceId: manifest.id}, desktop: true, onUser: vi.fn(), onServer: vi.fn(), onMemories: vi.fn(), onTodos: vi.fn(), onLogout: vi.fn(async () => {})};
}
const metrics: UsageMetrics = {call_count: 2, input_tokens: 1200, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, audio_ms: null, image_count: null, usage_status: 'complete', estimated_cost_cny_micros: 200000, known_cost_cny_micros: 200000, unknown_cost_call_count: 0, cost_status: 'complete'};
function report(): UsageReport {
  return {period: 'month', timezone: 'Asia/Shanghai', start_date: '2026-11-01', end_date: '2026-11-03', today: '2026-11-03', generated_at: '2026-11-03T01:00:00Z', recording_start: '2026-11-01T00:00:00Z', history_status: 'partial', totals: {...metrics}, cells: [{...metrics, model_key: 'deepseek-chat', model: 'deepseek-chat', model_name: 'DeepSeek 测试模型', provider: '合成服务商', capability: 'llm', purpose: 'chat'}], monthly_reminder: {enabled: false, threshold_cny_micros: 5000000, month: '2026-11', known_cost_cny_micros: 200000, cost_status: 'complete', reached: false, notice_key: null}};
}
beforeEach(() => {localStorage.clear(); Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: vi.fn(async () => {})}});});
afterEach(() => vi.restoreAllMocks());

describe('桌面设置', () => {
  it('侧边栏有明确设置入口，保存资料会更新账号显示', async () => {
    vi.mocked(createPlatform).mockResolvedValue({desktop: true, transport: {request: vi.fn()}, readSession: vi.fn(async () => 'synthetic-session'), writeSession: vi.fn(async () => {})});
    vi.spyOn(ApiClient.prototype, 'inspectInstance').mockResolvedValue(manifest);
    const request = vi.spyOn(ApiClient.prototype, 'request').mockImplementation(async (path, method, body) => {
      if (path.startsWith('/conversations')) return {items: []};
      if (path === '/me' && method !== 'PATCH') return user;
      if (path === '/me' && method === 'PATCH') return {...user, ...(body as object)};
      throw new Error('Unexpected mock request: ' + path);
    });
    localStorage.setItem('tada.client.server.v1', JSON.stringify({url: manifest.public_url, instanceId: manifest.id, autoRestore: true}));
    render(<App/>);
    await screen.findByRole('button', {name: /测试用户/});
    fireEvent.click(screen.getByRole('button', {name: '打开设置'}));
    expect(await screen.findByRole('navigation', {name: '设置分类'})).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', {name: '称呼'}), {target: {value: '新的称呼'}});
    fireEvent.click(screen.getByRole('button', {name: '保存资料'}));
    await screen.findByText('个人资料已保存。');
    expect(screen.getByRole('button', {name: /新的称呼/})).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/me', 'PATCH', {name: '新的称呼', timezone: 'Asia/Shanghai'}, expect.any(AbortSignal));
  });

  it('称呼和时区经过校验；保存失败保留草稿', async () => {
    const request = vi.fn().mockRejectedValue(new Error('网络未连接'));
    render(<SettingsPage {...props(request)}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '时区'}), {target: {value: 'Not/AZone'}});
    fireEvent.click(screen.getByRole('button', {name: '保存资料'}));
    await screen.findByText('请选择有效的时区，例如 Asia/Shanghai。'); expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '纽约'}));
    fireEvent.change(screen.getByRole('textbox', {name: '称呼'}), {target: {value: '  草稿姓名  '}});
    fireEvent.click(screen.getByRole('button', {name: '保存资料'}));
    await screen.findByText('网络未连接');
    expect((screen.getByRole('textbox', {name: '称呼'}) as HTMLInputElement).value).toBe('  草稿姓名  ');
    expect(request).toHaveBeenCalledWith('/me', 'PATCH', {name: '草稿姓名', timezone: 'America/New_York'}, expect.any(AbortSignal));
    expect(() => profileInput(' ', 'UTC')).toThrow();
  });

  it('更换服务器后迟到的资料保存不会更新新账号', async () => {
    let finish!: (value: User) => void;
    const request = vi.fn((_path: string, _method?: string, _body?: unknown, _signal?: AbortSignal) => new Promise<User>(resolve => {finish = resolve;}));
    const p = props(request); const view = render(<SettingsPage {...p}/>);
    fireEvent.change(screen.getByRole('textbox', {name: '称呼'}), {target: {value: '旧服务器名称'}});
    fireEvent.click(screen.getByRole('button', {name: '保存资料'}));
    const signal = request.mock.calls[0][3] as AbortSignal;
    view.rerender(<SettingsPage {...props(vi.fn())} api={{...p.api, baseUrl: 'http://127.0.0.1:20224'} as ApiClient}/>);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({...user, name: '旧服务器名称'}));
    expect(p.onUser).not.toHaveBeenCalled();
  });

  it('费用读取真实数据并保存提醒；查询周期会传给后端', async () => {
    const value = report();
    const request = vi.fn(async (path: string, method?: string, body?: unknown) => {
      if (path.startsWith('/usage?')) return value;
      if (path === '/usage/reminder' && method === 'PATCH') return {...value.monthly_reminder, ...(body as object)};
      throw new Error('Unexpected mock request');
    });
    render(<SettingsPage {...props(request)}/>);
    fireEvent.click(screen.getByRole('button', {name: '用量与费用'}));
    await screen.findByRole('table', {name: '各模型用量'});
    expect(screen.getAllByText('¥0.20').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('checkbox', {name: '开启每月费用提醒'}));
    fireEvent.click(within(screen.getByRole('group', {name: '费用提醒金额'})).getByRole('button', {name: '¥10.00'}));
    fireEvent.click(screen.getByRole('button', {name: '保存费用提醒'}));
    await screen.findByText('费用提醒已保存。');
    expect(request).toHaveBeenCalledWith('/usage/reminder', 'PATCH', {enabled: true, threshold_cny_micros: 10000000}, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole('button', {name: '近7天'}));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/usage?period=week', 'GET', undefined, expect.any(AbortSignal)));
  });

  it('缺少模型价格不会显示成零费用，非法自定义日期不发请求', async () => {
    const value = report(); value.totals = {...metrics, estimated_cost_cny_micros: null, known_cost_cny_micros: 0, cost_status: 'unknown', unknown_cost_call_count: 2, missing_price_call_count: 2, missing_measurement_call_count: 0}; value.cells = [];
    const request = vi.fn(async () => value); render(<SettingsPage {...props(request)}/>);
    fireEvent.click(screen.getByRole('button', {name: '用量与费用'}));
    await screen.findByText('待配置价格');
    expect(screen.getByText('缺少模型单价')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '自定义'}));
    fireEvent.change(screen.getByLabelText('开始日期'), {target: {value: '2026-11-03'}});
    fireEvent.change(screen.getByLabelText('结束日期'), {target: {value: '2026-11-02'}});
    fireEvent.submit(screen.getByLabelText('开始日期').closest('form')!);
    await screen.findByText('开始日期不能晚于结束日期。');
    expect(request).toHaveBeenCalledTimes(1);
    expect(() => readReport({...value, totals: {...value.totals, estimated_cost_cny_micros: 0}})).toThrow();
  });

  it('消息标为已读会真正调用接口，未确认前不伪装已读', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn((path: string) => path.startsWith('/notifications?') ? Promise.resolve({items: [{id: 'note/1', title: '任务已完成', body: '合成消息正文', read: false, created_at: user.created_at}]}) : new Promise(resolve => {finish = resolve;}));
    render(<SettingsPage {...props(request)}/>);
    fireEvent.click(screen.getByRole('button', {name: '消息通知'}));
    await screen.findByText('任务已完成');
    fireEvent.click(screen.getByRole('button', {name: '标为已读'}));
    expect(screen.queryByText('已读')).toBeNull();
    await act(async () => finish({ok: true}));
    await screen.findByText('已读');
    expect(request).toHaveBeenCalledWith('/notifications/note%2F1/read', 'POST', {}, expect.any(AbortSignal));
  });

  it('文件删除有二次确认；失败保留文件并显示错误', async () => {
    const request = vi.fn(async (path: string, method?: string) => {
      if (method === 'DELETE') throw new Error('删除失败');
      if (path.startsWith('/uploads?')) return {items: [{id: 'upload-1', name: '我的录音.m4a', mime_type: 'audio/mp4', size: 1024, created_at: user.created_at}]};
      throw new Error('Unexpected mock request');
    });
    render(<SettingsPage {...props(request)}/>);
    fireEvent.click(screen.getByRole('button', {name: '隐私与资料'}));
    await screen.findByText('我的录音.m4a');
    fireEvent.click(screen.getByRole('button', {name: '删除文件：我的录音.m4a'}));
    expect(request.mock.calls.filter(row => row[1] === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', {name: '确认删除文件'}));
    await screen.findByText('删除失败');
    expect(screen.getByText('我的录音.m4a')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/uploads/upload-1', 'DELETE', undefined, expect.any(AbortSignal));
  });

  it('服务版本缺少新接口时可恢复，其他设置仍可访问', async () => {
    render(<SettingsPage {...props(vi.fn(async () => {throw new ApiError('not_found', 'Not found', 404);}))}/>);
    fireEvent.click(screen.getByRole('button', {name: '用量与费用'}));
    await screen.findByText('这台服务器暂不支持此功能，请更新服务器后重试。');
    expect(screen.getByRole('button', {name: '重试'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: '个人资料'}));
    expect(screen.getByRole('textbox', {name: '称呼'})).toBeTruthy();
  });

  it('连接检查不调用模型，帮助模板不带账号隐私，版本来自构建信息', async () => {
    const p = props(); render(<SettingsPage {...p}/>);
    fireEvent.click(screen.getByRole('button', {name: '服务连接'}));
    fireEvent.click(screen.getByRole('button', {name: '检查连接'}));
    await screen.findByText('服务器身份与健康检查通过。');
    expect(p.api.inspectInstance).toHaveBeenCalledTimes(1); expect(p.api.health).toHaveBeenCalledTimes(1); expect(p.api.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '帮助与反馈'}));
    fireEvent.click(screen.getByRole('button', {name: '复制反馈模板'}));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(copied).toContain('操作步骤：'); expect(copied).not.toContain(user.phone); expect(copied).not.toContain(user.email); expect(copied).not.toContain(user.id);
    fireEvent.click(screen.getByRole('button', {name: '关于妥啦'}));
    expect(screen.getByText(/桌面版 · \d+\.\d+\.\d+/)).toBeTruthy();
  });

  it('退出登录要先确认，取消不会退出', async () => {
    const p = props(); render(<SettingsPage {...p}/>);
    fireEvent.click(screen.getByRole('button', {name: '退出登录'}));
    expect(p.onLogout).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', {name: '留在这里'}));
    expect(p.onLogout).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', {name: '退出登录'})); fireEvent.click(screen.getByRole('button', {name: '确认退出登录'}));
    await waitFor(() => expect(p.onLogout).toHaveBeenCalledTimes(1));
  });

  it('列表数据损坏不显示错误金额或文件大小', () => {
    expect(() => readUploads({items: [{id: 'x', name: 'file', mime_type: 'text/plain', size: -1, created_at: user.created_at}]})).toThrow();
    expect(() => readNotifications({items: [{id: 'x', title: '标题', body: '正文', read: 'false', created_at: user.created_at}]})).toThrow();
  });
});

import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiClient, type InstanceManifest} from '@tada/client-core';
import {ServerDialog} from './Auth';
import {OFFICIAL_SERVER, readServerChoice, type Platform} from './platform';

const manifest: InstanceManifest = {id: 'server-choice-test', name: '合成测试服务', deployment_mode: 'self_hosted', api_version: 1, auth_methods: ['phone_password'], registration_policy: 'closed', public_url: 'https://private.example.test', dataflow: {}};
const platform: Platform = {desktop: true, transport: {request: vi.fn()}, readSession: vi.fn(async () => null), writeSession: vi.fn(async () => {})};
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('官方与自建服务选择', () => {
  it('首次启动默认官方服务，官方模式没有地址编辑和内网 HTTP 选项', () => {
    expect(readServerChoice().url).toBe(OFFICIAL_SERVER);
    render(<ServerDialog platform={platform} current={readServerChoice()} onClose={vi.fn()} onChoose={vi.fn()}/>);
    expect(screen.getByRole('button', {name: /妥啦官方服务/}).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('textbox', {name: '服务地址'})).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('自建地址只能在自建模式编辑；切回官方后请求固定官方地址且不启用内网 HTTP', async () => {
    const requests: string[] = [];
    vi.spyOn(ApiClient.prototype, 'inspectInstance').mockImplementation(async function(this: ApiClient) {requests.push(this.baseUrl); return manifest;});
    const choose = vi.fn(async () => {});
    render(<ServerDialog platform={platform} current={{url: OFFICIAL_SERVER}} onClose={vi.fn()} onChoose={choose}/>);
    fireEvent.click(screen.getByRole('button', {name: /自建服务器/}));
    fireEvent.change(screen.getByRole('textbox', {name: '服务地址'}), {target: {value: 'http://192.168.1.12:8080'}});
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', {name: '检查连接'}));
    await waitFor(() => expect((screen.getByRole('button', {name: '确认使用这台服务器'}) as HTMLButtonElement).disabled).toBe(false));
    expect(requests).toEqual(['http://192.168.1.12:8080']);
    fireEvent.click(screen.getByRole('button', {name: /妥啦官方服务/}));
    expect(screen.queryByRole('textbox', {name: '服务地址'})).toBeNull();
    expect((screen.getByRole('button', {name: '确认使用这台服务器'}) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', {name: '检查连接'}));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toBe(OFFICIAL_SERVER);
    await waitFor(() => expect((screen.getByRole('button', {name: '确认使用这台服务器'}) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('官方服务 · 连接正常')).toBeTruthy();
    expect(screen.queryByText(new RegExp(manifest.id))).toBeNull();
    expect(screen.queryByText(/API v/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', {name: '确认使用这台服务器'})));
    expect(choose).toHaveBeenCalledWith({url: OFFICIAL_SERVER, allowInsecureLan: false, instanceId: manifest.id, autoRestore: false}, manifest);
  });

  it('保存过的自建服务器继续使用自建模式，切换选项不会丢失输入草稿', () => {
    const privateUrl = 'https://private.example.test';
    localStorage.setItem('tada.client.server.v1', JSON.stringify({url: privateUrl, instanceId: manifest.id}));
    expect(readServerChoice().url).toBe(privateUrl);
    render(<ServerDialog platform={platform} current={readServerChoice()} onClose={vi.fn()} onChoose={vi.fn()}/>);
    const field = screen.getByRole('textbox', {name: '服务地址'}) as HTMLInputElement;
    expect(field.value).toBe(privateUrl);
    fireEvent.change(field, {target: {value: 'https://new-private.example.test'}});
    fireEvent.click(screen.getByRole('button', {name: /妥啦官方服务/}));
    fireEvent.click(screen.getByRole('button', {name: /自建服务器/}));
    expect((screen.getByRole('textbox', {name: '服务地址'}) as HTMLInputElement).value).toBe('https://new-private.example.test');
  });
});

import {useEffect, useState} from 'react';
import {ArrowRight, Bell, Check, CircleHelp, Coins, Globe2, Info, LoaderCircle, LogOut, RefreshCw, Server, ShieldCheck, UserRound} from 'lucide-react';
import type {ApiClient, InstanceManifest, User} from '@tada/client-core';
import {Notice} from '../Auth';
import {CopyButton} from '../Markdown';
import {openExternal, serviceLabel, type ServerChoice} from '../platform';
import {NotificationsPane, UploadsPanel} from './SettingsLists';
import {profileInput, readProfile, useSettingsAction} from './shared';
import {UsagePane} from './UsagePane';
import './settings.css';

declare const __TADA_CLIENT_VERSION__: string;
const clientVersion = __TADA_CLIENT_VERSION__;
const sections = [
  {id: 'profile', title: '个人资料', icon: UserRound}, {id: 'usage', title: '用量与费用', icon: Coins},
  {id: 'notifications', title: '消息通知', icon: Bell}, {id: 'privacy', title: '隐私与资料', icon: ShieldCheck},
  {id: 'server', title: '服务连接', icon: Server}, {id: 'help', title: '帮助与反馈', icon: CircleHelp},
  {id: 'about', title: '关于妥啦', icon: Info},
] as const;
type Section = typeof sections[number]['id'];
type Props = {api: ApiClient; user: User; manifest: InstanceManifest | null; choice: ServerChoice; desktop: boolean; onUser(user: User): void; onServer(): void; onMemories(): void; onTodos(): void; onLogout(): Promise<void>};

export function SettingsPage(props: Props) {
  const [section, setSection] = useState<Section>('profile');
  const [confirmLogout, setConfirmLogout] = useState(false); const logoutAction = useSettingsAction();
  const [version, setVersion] = useState(clientVersion);
  useEffect(() => {
    let active = true;
    if (props.desktop && '__TAURI_INTERNALS__' in window) void import('@tauri-apps/api/app').then(module => module.getVersion()).then(value => {if (active) setVersion(value);}).catch(() => {});
    return () => {active = false;};
  }, [props.desktop]);
  return <div className="content-page settings-hub">
    <div className="page-title"><div><div className="eyebrow">属于你的工作区</div><h2>设置</h2><p>管理你的账号、资料与连接方式。</p></div></div>
    <div className="settings-layout"><nav className="settings-navigation" aria-label="设置分类">{sections.map(({id, title, icon: Icon}) => <button key={id} aria-current={id === section ? 'page' : undefined} onClick={() => setSection(id)}><Icon size={17}/><span>{title}</span><ArrowRight size={13}/></button>)}</nav>
      <div className="settings-pane" key={`${props.api.baseUrl}:${props.user.id}:${section}`}>
        {section === 'profile' && <ProfilePane api={props.api} user={props.user} onUser={props.onUser}/>}
        {section === 'usage' && <UsagePane api={props.api}/>}
        {section === 'notifications' && <NotificationsPane api={props.api} timezone={props.user.timezone}/>}
        {section === 'privacy' && <PrivacyPane {...props}/>}
        {section === 'server' && <ServerPane {...props}/>}
        {section === 'help' && <HelpPane version={version} desktop={props.desktop} onServer={props.onServer} onTodos={props.onTodos} onMemories={props.onMemories}/>}
        {section === 'about' && <><h3>关于妥啦</h3><div className="settings-about"><span className="orb"/><strong>妥啦</strong><span>{props.desktop ? '桌面版' : 'Web 版'} · {version}</span><p>把想法交给妥啦，把时间留给生活。</p></div><p className="settings-note">对话、事项和记忆使用你选择的服务器。手机短信、相册等权限不会自动授予电脑。</p><button className="secondary" onClick={() => setSection('help')}><CircleHelp size={15}/>帮助与反馈</button></>}
      </div>
    </div>
    <div className="settings-account-footer"><div><strong>{props.user.name}</strong><small>{props.user.phone || props.user.email}</small></div>{confirmLogout ? <div className="settings-logout-confirm"><span>退出后，云端计划仍会继续执行。</span><button className="secondary" disabled={logoutAction.busy} onClick={() => setConfirmLogout(false)}>留在这里</button><button className="danger" disabled={logoutAction.busy} onClick={() => void logoutAction.run(() => props.onLogout(), () => setConfirmLogout(false))}>确认退出登录</button></div> : <button className="icon-text" onClick={() => setConfirmLogout(true)}><LogOut size={15}/>退出登录</button>}</div>{logoutAction.error && <Notice>{logoutAction.error}</Notice>}
  </div>;
}

function ProfilePane({api, user, onUser}: Pick<Props, 'api' | 'user' | 'onUser'>) {
  const [name, setName] = useState(user.name); const [timezone, setTimezone] = useState(user.timezone);
  const action = useSettingsAction();
  useEffect(() => {setName(user.name); setTimezone(user.timezone);}, [user.name, user.timezone]);
  const timezoneOptions = [{id: 'Asia/Shanghai', label: '北京'}, {id: 'Asia/Hong_Kong', label: '香港'}, {id: 'Asia/Tokyo', label: '东京'}, {id: 'Europe/London', label: '伦敦'}, {id: 'America/New_York', label: '纽约'}, {id: 'UTC', label: 'UTC'}];
  return <><h3>个人资料</h3><p className="settings-description">与当前服务器上的手机版同步，让妥啦更熟悉你。</p><form className="settings-profile-form" onSubmit={event => {event.preventDefault(); void action.run(async signal => {
    const input = profileInput(name, timezone);
    return readProfile(await api.request('/me', 'PATCH', input, signal), user.id);
  }, onUser, '个人资料已保存。');}}>
    <div className="settings-identity"><span className="avatar">{user.name.slice(0, 1) || '妥'}</span><div><strong>{user.name}</strong><small>{user.phone || user.email}</small></div></div>
    <label>称呼<input aria-label="称呼" value={name} maxLength={160} autoComplete="nickname" disabled={action.busy} onChange={e => setName(e.target.value)}/></label>
    <div><label>时区<input aria-label="时区" value={timezone} maxLength={100} spellCheck={false} disabled={action.busy} onChange={e => setTimezone(e.target.value)}/></label><div className="settings-periods" role="group" aria-label="常用时区">{timezoneOptions.map(value => <button type="button" disabled={action.busy} key={value.id} aria-pressed={value.id === timezone} onClick={() => setTimezone(value.id)}>{value.label}</button>)}</div><button className="icon-text" type="button" disabled={action.busy} onClick={() => setTimezone(new Intl.DateTimeFormat().resolvedOptions().timeZone)}><Globe2 size={14}/>使用本机时区</button></div>
    <p className="settings-note">修改账号时区不会更改已有计划，各计划按创建时保存的时区执行。</p>
    {action.error && <Notice>{action.error}</Notice>}{action.notice && <Notice tone="success">{action.notice}</Notice>}
    <button className="primary" disabled={action.busy || name === user.name && timezone === user.timezone} type="submit">{action.busy ? <LoaderCircle className="spin" size={15}/> : <Check size={15}/>} {action.busy ? '正在保存…' : '保存资料'}</button>
  </form></>;
}

function ServerPane({api, manifest, choice, onServer}: Pick<Props, 'api' | 'manifest' | 'choice' | 'onServer'>) {
  const action = useSettingsAction();
  return <><h3>服务连接</h3><p className="settings-description">默认使用官方服务，也可以直接连接自己的服务器。</p><div className="settings-server-card"><span className="status-dot"/><div><strong>{serviceLabel(choice.url, manifest)}</strong><p>{manifest?.name || '已选择的服务'}</p><code>{choice.url}</code></div><CopyButton text={choice.url} label="复制地址"/></div>
    <p className="settings-note">{serviceLabel(choice.url, manifest) === '官方服务' ? '账号和数据保存在妥啦官方服务。' : '账号和数据保存在你选择的服务器，请求直接发往该服务器。'} 切换服务器不会自动搬迁账号或历史资料。</p>
    <div className="settings-button-row"><button className="secondary" onClick={onServer}><Server size={15}/>更换服务器</button><button className="secondary" disabled={action.busy} onClick={() => void action.run(async signal => {await api.inspectInstance(signal); await api.health(signal);}, () => {}, '服务器身份与健康检查通过。')}><RefreshCw size={15}/>{action.busy ? '正在检查…' : '检查连接'}</button></div>
    <p className="settings-note">连接检查不会调用付费模型或发送短信。</p>{action.error && <Notice>{action.error}</Notice>}{action.notice && <Notice tone="success">{action.notice}</Notice>}
    {manifest?.deployment_mode === 'self_hosted' && <section className="settings-subsection"><h4>自建服务管理</h4><p>模型、语音等 API Key 在服务管理后台配置，需要管理员身份。</p><button className="secondary" disabled={action.busy} onClick={() => void action.run(() => openExternal(`${api.baseUrl}/admin/`), () => {})}>打开服务管理后台 <ArrowRight size={15}/></button></section>}
  </>;
}

function PrivacyPane({api, user, manifest, desktop, choice, onMemories}: Props) {
  const dataLabels: Record<string, string> = {chat: '对话', speech: '语音', asr: '语音转文字', vision: '图片理解', embedding: '向量检索', storage: '附件存储', gallery: '相册'};
  return <><h3>隐私与资料</h3><p className="settings-description">清楚知道数据在哪里，并管理已经保存的资料。</p><div className="settings-privacy-note"><ShieldCheck size={20}/><div><strong>当前数据保存在{serviceLabel(choice.url, manifest)}</strong><p>{desktop ? '登录凭据保存在系统凭据库中。' : '网页登录状态只保存在当前页面内存中。'} 模型 API Key 由后端管理，不填写在客户端。</p></div></div>
    {!!Object.keys(manifest?.dataflow || {}).length && <dl className="settings-dataflow">{Object.entries(manifest?.dataflow || {}).map(([key, value]) => <div key={key}><dt>{dataLabels[key] || key}</dt><dd>{typeof value === 'string' ? value : [value.processor, value.destination].filter(Boolean).join(' · ') || '由当前服务配置决定'}</dd></div>)}</dl>}
    <section className="settings-subsection"><h4>长期记忆</h4><p>可逐条查看、编辑或删除。删除记忆不会删除原始对话。</p><button className="secondary" onClick={onMemories}>管理我的记忆 <ArrowRight size={15}/></button></section>
    <UploadsPanel api={api} timezone={user.timezone}/>
    <p className="settings-note">当前服务尚未提供账号注销和完整数据导出入口。客户端不会通过清理本地设置来冒充删除服务器数据。</p>
  </>;
}

function HelpPane({version, desktop, onServer, onTodos, onMemories}: {version: string; desktop: boolean; onServer(): void; onTodos(): void; onMemories(): void}) {
  const template = `妥啦问题反馈\n版本：${version}\n客户端：${desktop ? '桌面版' : 'Web 版'}\n操作系统与版本：\n操作步骤：\n期望结果：\n实际结果：\n`;
  return <><h3>帮助与反馈</h3><p className="settings-description">先试试这些方法，也可以复制反馈模板，把问题说清楚。</p><div className="settings-faq">
    <details open><summary>连接不上服务器怎么办？</summary><p>在“服务连接”中检查地址和服务器身份，确认网络正常。使用自建服务时，请检查后端进程和 HTTPS 配置。</p><button className="icon-text" onClick={onServer}>查看服务连接 <ArrowRight size={14}/></button></details>
    <details><summary>电脑和手机的数据会同步吗？</summary><p>连接同一台服务器、登录同一个账号时，对话、事项、记忆、个人资料和用量使用同一份服务端数据。连接不同服务器时，账号和资料分别保存。</p></details>
    <details><summary>任务和记忆在哪里管理？</summary><p>在“事项”中添加或调整待办，在“记忆”中查看和编辑长期资料。</p><div className="settings-button-row"><button className="icon-text" onClick={onTodos}>打开事项 <ArrowRight size={14}/></button><button className="icon-text" onClick={onMemories}>打开记忆 <ArrowRight size={14}/></button></div></details>
    <details><summary>为什么费用显示“暂无法估算”？</summary><p>部分模型没有配置单价，或者服务商没有返回完整用量。已知费用会单独显示；未知部分不会当成零元。</p></details>
    <details><summary>为什么退出后任务仍在执行？</summary><p>任务和定时安排由你选择的服务器运行。退出客户端只结束登录；需要停止任务时，请在相应任务或安排中处理。</p></details>
  </div><section className="settings-subsection"><h4>问题反馈</h4><p>模板只包含版本和待填写的操作步骤，不包含聊天内容、手机号或密钥。复制后补充说明，再发给维护者。</p><CopyButton text={template} label="复制反馈模板"/><pre className="settings-feedback-preview">{template}</pre></section></>;
}

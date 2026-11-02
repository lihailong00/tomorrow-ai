import {useEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowRight, CheckCircle2, Eye, EyeOff, LoaderCircle, LockKeyhole, Server, ShieldCheck, X} from 'lucide-react';
import {ApiClient, normalizeServerUrl, type AuthSession, type InstanceManifest} from '@tada/client-core';
import {errorText, OFFICIAL_SERVER, serviceLabel, type Platform, type ServerChoice} from './platform';

export function Orb({small = false}: {small?: boolean}) { return <span className={`orb ${small ? 'small' : ''}`} aria-hidden="true"/>; }
export function Notice({children, tone = 'error'}: {children: React.ReactNode; tone?: 'error' | 'info' | 'success'}) {return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;}

export function Auth({api, manifest, connectionError, onLogin, onServer}: {api: ApiClient; manifest: InstanceManifest | null; connectionError: string; onLogin(session: AuthSession): Promise<void>; onServer(): void}) {
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [method, setMethod] = useState<'phone_password' | 'email_password'>('phone_password');
  const methods = manifest?.auth_methods ?? [];
  useEffect(() => { if (methods.length && !methods.includes(method)) setMethod(methods[0]); }, [manifest, method]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !manifest) return;
    setBusy(true); setError('');
    try {
      const session = method === 'phone_password' ? await api.loginWithPhone(phone.trim(), password) : await api.loginWithEmail(email.trim(), password);
      setPassword(''); await onLogin(session);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  return <div className="auth-layout"><div className="auth-intro"><Orb/><h1>把想法交给妥啦，<br/>把时间留给生活。</h1><p>接着上次的对话继续，<br/>让每个想法都更进一步。</p><div className="intro-tags"><span>聊一聊</span><span>理清事项</span><span>记住重要的事</span></div></div>
    <section className="auth-card"><div className="eyebrow">欢迎回来</div><h2>{method === 'email_password' ? '邮箱密码登录' : '手机号密码登录'}</h2><p className="subtle">使用你的妥啦账号，连接自己的每一天。</p>
      {methods.length > 1 && <div className="segments" aria-label="登录方式">{methods.map(value => <button key={value} className={method === value ? 'active' : ''} onClick={() => {setMethod(value); setError('');}}>{value === 'phone_password' ? '手机号' : '邮箱'}</button>)}</div>}
      <form onSubmit={submit}><label>{method === 'phone_password' ? '手机号 · +86' : '邮箱地址'}<input aria-label={method === 'phone_password' ? '手机号' : '邮箱地址'} autoComplete="username" type={method === 'phone_password' ? 'tel' : 'email'} value={method === 'phone_password' ? phone : email} maxLength={method === 'phone_password' ? 18 : 254} onChange={e => method === 'phone_password' ? setPhone(e.target.value) : setEmail(e.target.value)} placeholder={method === 'phone_password' ? '请输入手机号' : 'you@example.com'} required/></label>
      <label>登录密码<div className="password-input"><input aria-label="登录密码" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" maxLength={128} required/><button type="button" className="icon-button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
      {(error || connectionError) && <Notice>{error || connectionError}</Notice>}
      <button className="primary auth-submit" disabled={busy || !manifest || !methods.length} type="submit">{busy ? <LoaderCircle className="spin" size={18}/> : <ArrowRight size={18}/>} {busy ? '正在登录…' : manifest ? '登录' : connectionError ? '请先检查服务器' : '正在验证服务器…'}</button></form>
      <div className="login-foot"><LockKeyhole size={14}/> 登录使用密码，不发送收费短信。</div><div className="server-mini"><span><span className={`status-dot ${manifest ? '' : 'offline'}`}/>{serviceLabel(api.baseUrl, manifest)}</span><button onClick={onServer}>更换服务 <ArrowRight size={13}/></button></div><p className="server-address">{api.baseUrl}</p>
      <p className="account-help">首次注册、忘记密码？请先在妥啦手机版完成账号设置。</p>
    </section></div>;
}

export function ServerDialog({platform, current, onClose, onChoose}: {platform: Platform; current: ServerChoice; onClose(): void; onChoose(value: ServerChoice, manifest: InstanceManifest): Promise<void>}) {
  const [url, setUrl] = useState(current.url);
  const [allowLan, setAllowLan] = useState(current.allowInsecureLan ?? false);
  const [checked, setChecked] = useState<{choice: ServerChoice; manifest: InstanceManifest} | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const sequence = useRef(0);
  const probe = useRef<ApiClient | null>(null);
  useEffect(() => {++sequence.current; setChecked(null); setError('');}, [url, allowLan]);
  useEffect(() => () => {++sequence.current; probe.current?.dispose();}, []);
  async function check(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    const scope = ++sequence.current;
    setBusy(true); setError(''); setChecked(null);
    let api: ApiClient | undefined;
    try {
      const choice = {url: normalizeServerUrl(url, allowLan), allowInsecureLan: allowLan};
      api = new ApiClient(choice.url, {transport: platform.transport, allowInsecureLan: allowLan});
      probe.current = api;
      const manifest = await api.inspectInstance(); if (scope === sequence.current) setChecked({choice: {...choice, instanceId: manifest.id, autoRestore: false}, manifest});
    } catch (err) {if (scope === sequence.current) setError(errorText(err));} finally {api?.dispose(); if (scope === sequence.current) setBusy(false);}
  }
  return <div className="modal-overlay" role="presentation" onClick={onClose}><section className="modal server-modal" role="dialog" aria-modal="true" aria-labelledby="server-heading" onClick={e => e.stopPropagation()} onKeyDown={e => {if (e.key === 'Escape' && !saving) onClose();}}><div className="modal-heading"><div><div className="eyebrow">你的数据，你的选择</div><h2 id="server-heading">连接服务器</h2></div><button aria-label="关闭服务器设置" className="icon-button" onClick={onClose}><X size={20}/></button></div>
      <div className="server-presets"><button disabled={busy || saving} className={url === OFFICIAL_SERVER ? 'active' : ''} onClick={() => {setUrl(OFFICIAL_SERVER); setAllowLan(false);}}><Orb small/><span>妥啦官方服务<small>直接使用，简单开始</small></span></button><button disabled={busy || saving} className={url !== OFFICIAL_SERVER ? 'active' : ''} onClick={() => {setUrl(''); setChecked(null);}}><Server size={24}/><span>自建服务器<small>连接你自己的后端</small></span></button></div>
      <form onSubmit={check}><label>服务地址<input aria-label="服务地址" disabled={busy || saving} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://tada.example.com" autoFocus type="url" required/></label><label className="checkbox-label"><input type="checkbox" disabled={busy || saving} checked={allowLan} onChange={e => setAllowLan(e.target.checked)}/>允许局域网 HTTP（仅适用于你信任的内网）</label><button className="secondary" disabled={busy || saving}>{busy ? <LoaderCircle className="spin" size={16}/> : <ShieldCheck size={16}/>} {busy ? '正在检查…' : '检查连接'}</button></form>
      {error && <Notice>{error}</Notice>}{checked && <div className="checked-server"><CheckCircle2 size={20}/><div><strong>{checked.manifest.name}</strong><p>{serviceLabel(checked.choice.url, checked.manifest)} · API v{checked.manifest.api_version}</p><p>支持{checked.manifest.auth_methods.map(x => x === 'phone_password' ? '手机号密码' : '邮箱密码').join('、')}登录</p><code>实例 {checked.manifest.id}</code></div></div>}
      <p className="privacy-note">确认后将退出当前账号。新服务使用独立账号与数据；连接失败时不会自动切换到其他服务器。</p><button className="primary full-width" disabled={!checked || saving} onClick={async () => {if (!checked || saving) return; setSaving(true); try {await onChoose(checked.choice, checked.manifest);} catch (e) {setError(errorText(e)); setSaving(false);}}}>{saving ? '正在切换…' : '确认使用这台服务器'}</button>
    </section></div>;
}

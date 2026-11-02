import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, CalendarDays, CheckCheck, ChevronDown, CircleHelp, Heart, ListTodo, LogOut, MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings2, ShieldCheck, Sparkles, X} from 'lucide-react';
import {ApiClient, type AuthSession, type Conversation, type InstanceManifest} from '@tada/client-core';
import {Auth, Notice, Orb, ServerDialog} from './Auth';
import {Chat} from './Chat';
import {TodayView, TodosView, MemoriesView} from './Views';
import {createPlatform, errorText, readServerChoice, saveServerChoice, serviceLabel, type Platform, type ServerChoice} from './platform';

type Route = 'chat' | 'today' | 'todos' | 'memories' | 'settings';
const routes: Array<{id: Route; title: string; icon: typeof MessageCircle}> = [
  {id: 'chat', title: '对话', icon: MessageCircle}, {id: 'today', title: '今日', icon: CalendarDays},
  {id: 'todos', title: '事项', icon: ListTodo}, {id: 'memories', title: '记忆', icon: Heart},
];

export function App() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [choice, setChoice] = useState(readServerChoice);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [manifest, setManifest] = useState<InstanceManifest | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [booting, setBooting] = useState(true);
  const [route, setRoute] = useState<Route>('chat');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationOffset, setConversationOffset] = useState<number | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [chatEpoch, setChatEpoch] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [serverDialog, setServerDialog] = useState(false);
  const [accountMessage, setAccountMessage] = useState('');
  const generation = useRef(0);
  const choiceRef = useRef(choice); choiceRef.current = choice;
  const activeClients = useRef(new Set<ApiClient>());
  const clientLeases = useRef(new Map<ApiClient, number>());

  useEffect(() => {let active = true; createPlatform().then(p => {if (active) setPlatform(p);}).catch(e => {if (active) {setConnectionError(errorText(e)); setBooting(false);}}); return () => {active = false;};}, []);
  useEffect(() => {
    if (!platform) return;
    const current = ++generation.current;
    setBooting(true); setManifest(null); setConnectionError('');
    let probe: ApiClient | undefined;
    const currentGeneration = () => generation.current === current;
    (async () => {
      try {
        probe = new ApiClient(choice.url, {transport: platform.transport, allowInsecureLan: choice.allowInsecureLan});
        const info = await probe.inspectInstance();
        if (!currentGeneration()) return;
        if (choice.instanceId && choice.instanceId !== info.id) throw new Error('服务器实例身份已变化。为保护账号，已停止自动登录；请检查并重新确认服务器。');
        setManifest(info);
        saveServerChoice({...choice, instanceId: info.id});
        const token = choice.instanceId && choice.autoRestore === true ? await platform.readSession(choice.url, info.id) : null;
        if (!token || !currentGeneration()) return;
        const authenticated = new ApiClient(choice.url, {transport: platform.transport, token, expectedInstanceId: info.id, allowInsecureLan: choice.allowInsecureLan});
        try { const user = await authenticated.me(); if (currentGeneration()) setSession({user, token}); }
        catch (error) {if (currentGeneration()) {await platform.writeSession(choice.url, info.id, null).catch(() => {}); setAccountMessage('登录已过期，请重新登录。');}}
        finally {authenticated.dispose();}
      } catch (error) {if (currentGeneration()) setConnectionError(errorText(error));}
      finally {probe?.dispose(); if (currentGeneration()) setBooting(false);}
    })();
    return () => {++generation.current; probe?.dispose();};
  }, [platform, choice]);

  const clearAccount = useCallback(() => {
    saveServerChoice({...choiceRef.current, autoRestore: false});
    activeClients.current.forEach(client => client.dispose());
    ++generation.current; setSession(null); setConversations([]); setConversationOffset(null); setSelected(null); setChatEpoch(e => e + 1); setRoute('chat'); setHistoryError(''); setSearching(false); setQuery('');
  }, []);
  const api = useMemo(() => {
    if (!platform) return null;
    try {
      const client = new ApiClient(choice.url, {transport: platform.transport, token: session?.token, expectedInstanceId: manifest?.id, allowInsecureLan: choice.allowInsecureLan, onUnauthorized: () => {clearAccount(); setAccountMessage('登录已过期，请重新登录。'); if (manifest) void platform.writeSession(choice.url, manifest.id, null).catch(() => {});}});
      activeClients.current.add(client); return client;
    } catch {return null;}
  }, [platform, choice, session?.token, manifest?.id, clearAccount]);
  useEffect(() => {
    if (!api) return;
    clientLeases.current.set(api, (clientLeases.current.get(api) ?? 0) + 1);
    return () => {
      clientLeases.current.set(api, (clientLeases.current.get(api) ?? 1) - 1);
      queueMicrotask(() => {if (!clientLeases.current.get(api)) {api.dispose(); activeClients.current.delete(api); clientLeases.current.delete(api);}});
    };
  }, [api]);
  // Each content route receives its own request scope; leaving it cancels requests.
  const pageApi = useMemo(() => {
    if (!platform || !session) return null;
    try {const client = new ApiClient(choice.url, {transport: platform.transport, token: session.token, expectedInstanceId: manifest?.id, allowInsecureLan: choice.allowInsecureLan, onUnauthorized: () => {clearAccount(); setAccountMessage('登录已过期，请重新登录。');}}); activeClients.current.add(client); return client;} catch {return null;}
  }, [platform, choice, session?.token, manifest?.id, route, clearAccount]);
  useEffect(() => {
    if (!pageApi) return;
    clientLeases.current.set(pageApi, (clientLeases.current.get(pageApi) ?? 0) + 1);
    return () => {
      clientLeases.current.set(pageApi, (clientLeases.current.get(pageApi) ?? 1) - 1);
      queueMicrotask(() => {if (!clientLeases.current.get(pageApi)) {pageApi.dispose(); activeClients.current.delete(pageApi); clientLeases.current.delete(pageApi);}});
    };
  }, [pageApi]);

  const refreshHistory = useCallback(async (append = false) => {
    if (!api || !session) return;
    const scope = generation.current;
    setHistoryBusy(true); setHistoryError('');
    try {
      const page = await api.conversations({limit: 40, offset: append ? conversationOffset ?? 0 : 0});
      if (scope !== generation.current) return;
      setConversations(previous => append ? [...previous, ...page.items.filter(i => !previous.some(p => p.id === i.id))] : page.items);
      setConversationOffset(page.next_offset ?? null);
    } catch (error) {if (scope === generation.current) setHistoryError(errorText(error));}
    finally {if (scope === generation.current) setHistoryBusy(false);}
  }, [api, session?.token, conversationOffset]);
  useEffect(() => {if (session) void refreshHistory();}, [api, session?.token]);
  const newChat = useCallback(() => {setRoute('chat'); setSelected(null); setChatEpoch(i => i + 1); setSearching(false);}, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {event.preventDefault(); if (session) setSearching(s => !s);}
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {event.preventDefault(); if (session) newChat();}
      if (event.key === 'Escape') {setSearching(false); setServerDialog(false);}
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [newChat, session]);

  async function login(value: AuthSession) {
    if (!platform || !manifest) return;
    const current = generation.current;
    saveServerChoice({...choice, instanceId: manifest.id, autoRestore: false});
    setSession(value); setAccountMessage('');
    const updatedChoice = {...choice, instanceId: manifest.id, autoRestore: false}; saveServerChoice(updatedChoice);
    try {await platform.writeSession(choice.url, manifest.id, value.token); if (generation.current === current) saveServerChoice({...updatedChoice, autoRestore: true});} catch {if (generation.current === current) setAccountMessage('已登录，但系统凭据库暂不可用；关闭客户端后需要重新登录。');}
  }
  async function logout() {
    const oldApi = api; const oldChoice = choice;
    clearAccount(); oldApi?.dispose();
    let clearFailed = false;
    if (manifest) await platform?.writeSession(oldChoice.url, manifest.id, null).catch(() => {clearFailed = true; setAccountMessage('已关闭自动登录，但系统凭据库清理失败，请稍后重试。');});
    const logoutApi = platform && session ? new ApiClient(oldChoice.url, {token: session.token, transport: platform.transport, expectedInstanceId: manifest?.id, allowInsecureLan: oldChoice.allowInsecureLan}) : null;
    try {await logoutApi?.logout();} catch {setAccountMessage(clearFailed ? '已关闭自动登录。系统凭据清理和远端会话撤销尚未确认，请恢复连接后重试。' : '本机已退出。服务器暂时无法连接，远端会话可能尚未撤销。');} finally {logoutApi?.dispose();}
  }
  async function chooseServer(value: ServerChoice, info: InstanceManifest) {
    clearAccount(); api?.dispose(); pageApi?.dispose();
    if (manifest) await platform?.writeSession(choice.url, manifest.id, null).catch(() => {});
    saveServerChoice(value); setChoice(value); setManifest(info); setServerDialog(false); setConnectionError(''); setAccountMessage('');
  }
  const currentTitle = route === 'chat' ? conversations.find(c => c.id === selected)?.title ?? '新对话' : route === 'settings' ? '设置' : routes.find(r => r.id === route)!.title;
  const filtered = conversations.filter(c => c.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className={`app-shell ${sidebar ? '' : 'sidebar-collapsed'}`}>
    <aside className="sidebar" aria-label="主导航"><div className="sidebar-top"><button className="brand" onClick={newChat} aria-label="妥啦首页"><Orb small/><strong>妥啦</strong><span>桌面版</span></button><button className="icon-button collapse-button" onClick={() => setSidebar(false)} aria-label="收起侧栏"><PanelLeftClose size={18}/></button></div>
      <button className="new-chat" onClick={newChat} disabled={!session}><Plus size={18}/><span>新对话</span><kbd>Ctrl ⇧ O</kbd></button>
      <nav>{routes.map(({id, title, icon: Icon}) => <button key={id} className={route === id ? 'active' : ''} onClick={() => setRoute(id)} disabled={!session}><Icon size={19}/><span>{title}</span>{id === 'chat' && <span className="nav-current-dot"/>}</button>)}</nav>
      <div className="history-heading"><span>最近对话</span><button className="icon-button" onClick={() => setSearching(true)} aria-label="搜索对话" disabled={!session}><Search size={15}/></button></div><div className="history-list">{session ? <>{conversations.map(c => <button key={c.id} className={route === 'chat' && selected === c.id ? 'selected' : ''} title={c.title} onClick={() => {setSelected(c.id); setRoute('chat');}}>{c.title || '未命名对话'}</button>)}{!conversations.length && !historyBusy && !historyError && <p className="sidebar-empty">每一个想法，<br/>都可以从这里开始。</p>}{historyError && <button className="history-retry" onClick={() => void refreshHistory()}>加载失败，点击重试</button>}{conversationOffset !== null && <button className="load-history" disabled={historyBusy} onClick={() => void refreshHistory(true)}>{historyBusy ? '正在加载…' : '加载更多对话'}</button>}</> : <p className="sidebar-empty">登录后，<br/>接着上次的想法继续。</p>}</div>
      <div className="sidebar-bottom"><button className={route === 'settings' ? 'account active' : 'account'} onClick={() => session ? setRoute('settings') : setServerDialog(true)}><span className="avatar">{session?.user.name?.slice(0, 1) || '妥'}</span><span><strong>{session?.user.name || '欢迎使用妥啦'}</strong><small>{session ? serviceLabel(choice.url, manifest) : '选择你的服务器'}</small></span><Settings2 size={17}/></button></div>
    </aside>
    <main className="main"><header className="workspace-header"><div>{!sidebar && <button className="icon-button" onClick={() => setSidebar(true)} aria-label="展开侧栏"><PanelLeftOpen size={19}/></button>}<h1>{session ? currentTitle : '妥啦'}</h1>{session && route === 'chat' && <span className="header-badge">个人 AI 助手</span>}</div><button className="connection-chip" onClick={() => setServerDialog(true)} title={choice.url}><span className={`status-dot ${manifest ? '' : 'offline'}`}/><span>{serviceLabel(choice.url, manifest)}</span><ChevronDown size={13}/></button></header>
    {accountMessage && <div className="global-notice"><Notice tone="info">{accountMessage}<button className="icon-button" aria-label="关闭提示" onClick={() => setAccountMessage('')}><X size={14}/></button></Notice></div>}
    {!platform || !api ? <div className="center-loading"><Orb/><p>{connectionError || '正在准备你的工作区…'}</p>{platform && <><small>{choice.url}</small><button className="secondary" onClick={() => setServerDialog(true)}>检查服务地址</button></>}</div> : !session ? booting ? <div className="center-loading"><Orb/><p>正在安全连接服务器…</p></div> : <Auth api={api} manifest={manifest} connectionError={connectionError} onLogin={login} onServer={() => setServerDialog(true)}/> : pageApi ? <div className="page-body" key={`${choice.url}:${session.user.id}:${route}`}>
      {route === 'chat' && <Chat key={chatEpoch} api={pageApi} conversationId={selected} user={session.user} onConversation={(id, title) => {setSelected(id); setConversations(prev => [{id, title: prev.find(x => x.id === id)?.title ?? title, updated_at: new Date().toISOString()}, ...prev.filter(x => x.id !== id)]);}} onDone={() => void refreshHistory()}/>}
      {route === 'today' && <TodayView api={pageApi} user={session.user} onAsk={newChat} onTodos={() => setRoute('todos')}/>}
      {route === 'todos' && <TodosView api={pageApi}/>}{route === 'memories' && <MemoriesView api={pageApi}/>}
      {route === 'settings' && <div className="content-page settings-page"><div className="page-title"><div><div className="eyebrow">属于你的工作区</div><h2>设置</h2><p>连接方式清楚，数据去向透明。</p></div></div><section className="settings-section"><h3><ServerIcon/> 当前服务器</h3><div className="settings-row"><div><strong>{serviceLabel(choice.url, manifest)}</strong><p>{manifest?.name} · {choice.url}</p><small>{serviceLabel(choice.url, manifest) === '官方服务' ? '当前连接妥啦官方服务。' : '请求直接发送给你选择的服务器，不经过官方业务服务器。'}</small></div><button className="secondary" onClick={() => setServerDialog(true)}>更换服务器 <ArrowRight size={15}/></button></div></section><section className="settings-section"><h3><ShieldCheck size={18}/> 账号与隐私</h3><div className="settings-row"><div><strong>{session.user.name}</strong><p>{session.user.phone || session.user.email}</p><small>{platform.desktop ? '登录凭据保存在系统凭据库中。' : '网页版登录状态只保留在当前页面内存中。'}</small></div><button className="secondary" onClick={() => void logout()}><LogOut size={15}/> 退出登录</button></div></section><section className="settings-section"><h3><Sparkles size={18}/> 关于妥啦</h3><div className="settings-row"><div><strong>妥啦 {platform.desktop ? '桌面版' : 'Web 版'} · 0.1.0</strong><p>对话、事项、记忆，陪你理清每一天。</p><small>本版支持连接现有后端。手机短信、相册等设备权限不会自动迁移到电脑。</small></div></div></section></div>}
    </div> : null}</main>
    {platform && serverDialog && <ServerDialog platform={platform} current={choice} onClose={() => setServerDialog(false)} onChoose={chooseServer}/>}
    {searching && session && <div className="modal-overlay" onClick={() => setSearching(false)}><section className="modal search-modal" role="dialog" aria-modal="true" aria-label="搜索对话" onClick={e => e.stopPropagation()}><div className="search-input"><Search size={19}/><input aria-label="搜索对话标题" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索已加载的对话…" autoFocus/><button className="icon-button" aria-label="关闭搜索" onClick={() => setSearching(false)}><X size={18}/></button></div><div className="search-results">{filtered.map(c => <button key={c.id} onClick={() => {setSelected(c.id); setRoute('chat'); setSearching(false);}}><MessageCircle size={17}/><span>{c.title}</span><ArrowLeft size={14}/></button>)}{!filtered.length && <p>没有找到匹配的对话</p>}{conversationOffset !== null && <button disabled={historyBusy} onClick={() => void refreshHistory(true)}>加载更多历史后搜索</button>}</div><div className="search-footer">搜索当前已加载的 {conversations.length} 条对话 <kbd>Esc 关闭</kbd></div></section></div>}
  </div>;
}
function ServerIcon() {return <CheckCheck size={18}/>;}

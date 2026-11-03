import {memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent} from 'react';
import {ArrowDown, ArrowUp, Check, CornerDownRight, Lightbulb, LoaderCircle, MessageCircle, RotateCcw, Square, WandSparkles, X} from 'lucide-react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {initialChatStreamState, newRequestId, reduceChatStream, type ApiClient, type ChatIntent, type ChatStreamState, type Message, type ReasoningEffort, type User} from '@tada/client-core';
import {Notice, Orb} from './Auth';
import {CopyButton, Markdown} from './Markdown';
import {ReasoningMenu} from './ReasoningMenu';
import {composeFollowUpMessage, TextSelectionActions} from './TextSelectionActions';
import {errorText} from './platform';

type Row = Message & {delivery?: 'sending' | 'sent' | 'interrupted'; toolStatus?: string};
type Pending = {intent: ChatIntent; stream: ChatStreamState; userKey: string; assistantKey: string};
export function shouldSendOnEnter(event: {key: string; shiftKey: boolean; isComposing?: boolean; nativeEvent?: {isComposing?: boolean; keyCode?: number}}) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229;
}

export function Chat({api, conversationId, user, onConversation, onDone}: {api: ApiClient; conversationId: string | null; user: User; onConversation(id: string, title: string): void; onDone(): void}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState('');
  const [quotedText, setQuotedText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!conversationId);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningEffort>('off');
  const [atBottom, setAtBottom] = useState(true);
  const [hasPending, setHasPending] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const currentConversation = useRef<string | null>(null);
  const pending = useRef<Pending | null>(null);
  const operation = useRef<AbortController | null>(null);
  const lifetime = useRef(0);
  const loadingScope = useRef(0);
  const scrollWanted = useRef(true);
  const atBottomRef = useRef(atBottom); atBottomRef.current = atBottom;
  const updateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const virtualizer = useVirtualizer({count: rows.length, getScrollElement: () => viewport.current, estimateSize: i => rows[i]?.role === 'user' ? 110 : 220, overscan: 5, getItemKey: i => rows[i]?.id ?? i});
  useEffect(() => {const scope = ++lifetime.current; return () => {if (lifetime.current === scope) ++lifetime.current; operation.current?.abort(); if (updateTimer.current) clearTimeout(updateTimer.current);};}, [api]);
  useEffect(() => {
    if (conversationId === currentConversation.current) return;
    const scope = ++loadingScope.current;
    operation.current?.abort(); pending.current = null; setHasPending(false); setRows([]); setBusy(false); setError(''); setStopped(false); setBefore(null); setQuotedText(null); currentConversation.current = conversationId;
    if (!conversationId) {setLoading(false); return;}
    setLoading(true);
    api.messages(conversationId, {limit: 60}).then(page => {
      if (scope !== loadingScope.current) return;
      setRows(page.items); setBefore(page.next_before ?? null); scrollWanted.current = true;
    }).catch(e => {if (scope === loadingScope.current) setError(errorText(e));}).finally(() => {if (scope === loadingScope.current) setLoading(false);});
    return () => {++loadingScope.current; if (currentConversation.current === conversationId) currentConversation.current = null;};
  }, [api, conversationId]);
  useLayoutEffect(() => {
    if (scrollWanted.current && rows.length) {
      virtualizer.scrollToIndex(rows.length - 1, {align: 'end'});
      scrollWanted.current = false;
    }
  }, [rows, virtualizer]);
  useLayoutEffect(() => {if (!input.current) return; input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;}, [draft]);

  function applyProgress(item: Pending) {
    const value = item.stream;
    setRows(previous => previous.map(row => row.id === item.userKey ? {...(value.userMessage ?? row), id: item.userKey, delivery: value.userMessage ? 'sent' : 'sending'} : row.id === item.assistantKey ? {...row, content: value.content, delivery: value.status === 'complete' ? 'sent' : value.status === 'interrupted' ? 'interrupted' : 'sending', toolStatus: toolLabel(value.toolStatus)} : row));
    if (atBottomRef.current) scrollWanted.current = true;
  }
  async function run(item: Pending, retry = false) {
    if (busy) return;
    const controller = new AbortController(); operation.current = controller;
    const scope = lifetime.current;
    setBusy(true); setError(''); setStopped(false); setHasPending(true);
    try {
      await api.chatStream(item.intent, event => {
        if (scope !== lifetime.current || controller.signal.aborted || pending.current !== item) return;
        item.stream = reduceChatStream(item.stream, event);
        if (item.stream.conversationId && item.stream.conversationId !== currentConversation.current) {
          currentConversation.current = item.stream.conversationId; onConversation(item.stream.conversationId, item.intent.message.slice(0, 32));
        }
        if (item.stream.status === 'complete' || item.stream.status === 'interrupted') {
          if (updateTimer.current) clearTimeout(updateTimer.current); updateTimer.current = null; applyProgress(item);
        } else if (!updateTimer.current) {
          updateTimer.current = setTimeout(() => {updateTimer.current = null; if (scope === lifetime.current && pending.current === item) applyProgress(item);}, 45);
        }
      }, {signal: controller.signal, lastEventId: retry && item.stream.lastEventId >= 0 ? item.stream.lastEventId : undefined, retry});
      if (scope !== lifetime.current || pending.current !== item) return;
      applyProgress(item);
      if (item.stream.status === 'complete') {pending.current = null; setHasPending(false); onDone();}
      else {setError(item.stream.error || '连接已中断，已收到的内容已保留。你可以继续接收同一条回复。');}
    } catch (e) {
      if (scope !== lifetime.current || pending.current !== item) return;
      applyProgress(item);
      // A validated server completion is authoritative even if transport
      // shutdown subsequently fails; never lock a finished reply for retry.
      if (item.stream.status === 'complete' && item.stream.response) {
        pending.current = null; setHasPending(false); onDone(); return;
      }
      if (controller.signal.aborted) {setStopped(true);} else {setError(errorText(e));}
      setRows(previous => previous.map(row => row.id === item.assistantKey ? {...row, delivery: 'interrupted'} : row));
    } finally {
      if (scope === lifetime.current && pending.current === item || scope === lifetime.current && !pending.current) setBusy(false);
      if (operation.current === controller) operation.current = null;
    }
  }
  function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || busy || loading || pending.current) return;
    const text = composeFollowUpMessage(draft.trim(), quotedText);
    if (text.length > 20_000) {setError('引用和问题合计不能超过 20,000 字，请缩短后再发送。'); return;}
    const id = newRequestId();
    const item: Pending = {intent: {message: text, conversation_id: currentConversation.current, client_request_id: id, remember: false, upload_ids: [], reasoning_effort: reasoning}, stream: initialChatStreamState(), userKey: `${id}-user`, assistantKey: `${id}-assistant`};
    pending.current = item; setDraft(''); setQuotedText(null); setError(''); scrollWanted.current = true;
    setRows(prev => [...prev, {id: item.userKey, conversation_id: currentConversation.current ?? '', role: 'user', content: text, created_at: new Date().toISOString(), delivery: 'sending'}, {id: item.assistantKey, conversation_id: currentConversation.current ?? '', role: 'assistant', content: '', created_at: new Date().toISOString(), delivery: 'sending'}]);
    void run(item);
  }
  async function earlier() {
    if (!before || !currentConversation.current || loadingEarlier) return;
    const scope = loadingScope.current;
    const oldHeight = viewport.current?.scrollHeight ?? 0;
    const oldTop = viewport.current?.scrollTop ?? 0;
    setLoadingEarlier(true);
    try {
      const page = await api.messages(currentConversation.current, {before, limit: 60});
      if (scope !== loadingScope.current) return;
      scrollWanted.current = false;
      setRows(prev => [...page.items.filter(row => !prev.some(p => p.id === row.id)), ...prev]); setBefore(page.next_before ?? null);
      requestAnimationFrame(() => {if (viewport.current && scope === loadingScope.current) viewport.current.scrollTop = oldTop + viewport.current.scrollHeight - oldHeight;});
    } catch (e) {if (scope === loadingScope.current) setError(errorText(e));} finally {if (scope === loadingScope.current) setLoadingEarlier(false);}
  }
  function insertPrompt(value: string) {setDraft(value); input.current?.focus();}
  const empty = rows.length === 0 && !loading;
  return <div className={`chat-workspace ${empty ? 'empty' : ''}`}>
    <TextSelectionActions containerRef={viewport} resetKey={conversationId ?? 'new'} followUpDisabled={loading || hasPending && !busy} onFollowUp={text => {setQuotedText(text); input.current?.focus({preventScroll: true});}}/>
    <div className="chat-viewport" ref={viewport} onScroll={() => {const el = viewport.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);}}>
      {loading && <div className="center-loading"><LoaderCircle className="spin" size={22}/><p>正在打开对话…</p></div>}
      {empty && <div className="chat-welcome"><Orb/><div className="eyebrow">你的个人 AI 助手</div><h2>{user.name ? `${user.name}，` : ''}有什么想聊的？</h2><p>一个问题、一个想法，都可以从这里开始。</p><div className="prompt-grid"><button onClick={() => insertPrompt('结合我已有的事项和记忆，帮我理清今天最值得做的三件事。')}><span className="prompt-icon blue"><ListPromptIcon/></span><strong>理清今天的重点</strong><small>把繁杂的安排，变成清晰的下一步</small><ArrowUp size={15}/></button><button onClick={() => insertPrompt('我想学习一个新知识，请先问我感兴趣的方向，再带我一步步理解。')}><span className="prompt-icon purple"><Lightbulb size={19}/></span><strong>一起学点新知识</strong><small>从好奇开始，让理解更进一步</small><ArrowUp size={15}/></button><button onClick={() => insertPrompt('帮我把一个想法整理成可执行的计划。请先问我具体想做什么。')}><span className="prompt-icon peach"><WandSparkles size={19}/></span><strong>把想法变成行动</strong><small>一起拆解，找到现在就能做的事</small><ArrowUp size={15}/></button></div></div>}
      {!empty && !loading && <div className="message-column">{before && <button className="load-earlier" disabled={loadingEarlier || busy} onClick={() => void earlier()}>{loadingEarlier ? '正在加载…' : '加载更早的消息'}</button>}<div className="virtual-messages" style={{height: virtualizer.getTotalSize(), position: 'relative'}}>{virtualizer.getVirtualItems().map(item => <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)`}}><MessageRow row={rows[item.index]}/></div>)}</div></div>}
    </div>
    {!atBottom && rows.length > 0 && <button className="jump-latest" aria-label="回到最新消息" onClick={() => {virtualizer.scrollToIndex(rows.length - 1, {align: 'end'}); setAtBottom(true);}}><ArrowDown size={18}/></button>}
    <div className={`composer-dock ${empty ? 'welcome-dock' : ''}`}><div className="composer-column">
      {error && <Notice>{error}{hasPending && !busy && <button className="inline-action" onClick={() => pending.current && void run(pending.current, true)}><RotateCcw size={14}/>继续接收</button>}</Notice>}
      {stopped && !error && <Notice tone="info">已停止接收，收到的内容已保留。服务器可能仍在处理。<button className="inline-action" disabled={busy} onClick={() => pending.current && void run(pending.current, true)}>继续接收</button></Notice>}
      <form className={`composer ${busy ? 'receiving' : ''}`} onSubmit={send}>{quotedText && <div className="composer-quote"><CornerDownRight size={15}/><div><strong>追问这段内容</strong><p>{quotedText}</p></div><button type="button" aria-label="取消引用" onClick={() => {setQuotedText(null); input.current?.focus();}}><X size={15}/></button></div>}<textarea ref={input} aria-label="发送消息" placeholder={hasPending && !busy ? '先继续接收上一条回复，或新建对话' : '发消息，或说说你的想法…'} rows={2} value={draft} disabled={loading || hasPending && !busy} maxLength={20_000} onChange={e => setDraft(e.target.value)} onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}} onKeyDown={e => {if (!composing.current && shouldSendOnEnter(e)) {e.preventDefault(); send();}}}/><div className="composer-toolbar"><div className="composer-left"><ReasoningMenu value={reasoning} onChange={setReasoning} disabled={busy || hasPending}/></div><div className="composer-right"><span>{busy ? '正在回复' : 'Enter 发送 · Shift Enter 换行'}</span>{busy ? <button className="send-button stop-button" type="button" aria-label="停止接收回复" title="停止接收回复，服务器可能仍在处理" onClick={() => operation.current?.abort()}><Square size={15} fill="currentColor"/></button> : <button className="send-button" disabled={!draft.trim() || loading || hasPending} type="submit" aria-label="发送"><ArrowUp size={20}/></button>}</div></div></form><p className="composer-footnote">AI 也会有疏漏，重要的信息请核实。</p>
    </div></div>
  </div>;
}
function ListPromptIcon() {return <Check size={20}/>;}
function toolLabel(value?: Record<string, unknown> | null): string | undefined {
  if (!value) return;
  const title = typeof value.title === 'string' ? value.title : typeof value.label === 'string' ? value.label : typeof value.name === 'string' ? value.name : typeof value.tool === 'string' ? value.tool : '';
  if (/search|web|搜索|查询/i.test(title)) return '正在搜索资料';
  if (/read|fetch|读取|文件/i.test(title)) return '正在读取资料';
  return title ? `正在使用 ${title}` : '正在使用工具';
}
const MessageRow = memo(function MessageRow({row}: {row: Row}) {
  const user = row.role === 'user';
  return <article className={`message-row ${user ? 'user-row' : 'assistant-row'}`} aria-label={user ? '你发送的消息' : '妥啦的回复'}>
    {!user && <div className="assistant-name"><Orb small/><span>妥啦</span></div>}
    {user ? <div className="user-bubble" data-selection-content data-message-id={row.id}>{row.content}</div> : row.content ? <div data-selection-content data-message-id={row.id}><Markdown text={row.content}/></div> : <div className="reply-waiting"><span className="waiting-orb"/><span>{row.delivery === 'interrupted' ? '回复已中断' : row.toolStatus || '正在想…'}</span></div>}
    {!user && row.content && row.toolStatus && <div className="tool-status"><LoaderCircle className="spin" size={13}/>{row.toolStatus}</div>}
    <div className="message-actions">{row.content && <CopyButton text={row.content} label="复制消息"/>}{user && row.delivery === 'sending' && <span>发送中</span>}{row.delivery === 'interrupted' && <span>已保留内容</span>}</div>
  </article>;
});

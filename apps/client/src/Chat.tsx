import {memo, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent} from 'react';
import {ArrowDown, ArrowUp, Check, CornerDownRight, Image as ImageIcon, Lightbulb, LoaderCircle, MapPin, RotateCcw, Square, WandSparkles, X} from 'lucide-react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {initialChatStreamState, newRequestId, reduceChatStream, type ApiClient, type ChatIntent, type ChatStreamState, type Message, type ReasoningEffort, type Upload, type User} from '@tada/client-core';
import {Notice, Orb} from './Auth';
import {CopyButton, Markdown} from './Markdown';
import {ReasoningMenu} from './ReasoningMenu';
import {composeFollowUpMessage, TextSelectionActions} from './TextSelectionActions';
import {errorText} from './platform';
import type {LocationBridge} from './location/bridge';
import {LocationPicker} from './location/LocationPicker';
import {locationCaption} from './location/model';
import {useChatLocation} from './location/useChatLocation';
import {DidiOrderCard} from './location/DidiOrderCard';
import {ServerInputCard} from './location/ServerInputCard';
import {pastedImage, pastedImageError, prepareChatImage} from './chatImage';
import './chatImage.css';

type Row = Message & {delivery?: 'waiting_location' | 'sending' | 'sent' | 'interrupted'; toolStatus?: string};
type Pending = {intent: ChatIntent; stream: ChatStreamState; userKey: string; assistantKey: string};
type DraftImage = {file: File; upload?: Upload; analyzed?: boolean};
export function shouldSendOnEnter(event: {key: string; shiftKey: boolean; isComposing?: boolean; nativeEvent?: {isComposing?: boolean; keyCode?: number}}) {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing && !event.nativeEvent?.isComposing && event.nativeEvent?.keyCode !== 229;
}

export function Chat({api, conversationId, user, onConversation, onDone, locationBridge}: {api: ApiClient; conversationId: string | null; user: User; onConversation(id: string, title: string): void; onDone(): void; locationBridge?: LocationBridge}) {
  const location = useChatLocation(locationBridge, api);
  const [rows, setRows] = useState<Row[]>([]);
  const [locationPreview, setLocationPreview] = useState<Row | null>(null);
  const [draft, setDraft] = useState('');
  const [image, setImage] = useState<DraftImage | null>(null);
  const draftImage = useRef<DraftImage | null>(null);
  const [imagePhase, setImagePhase] = useState('');
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
  const [didiOrder, setDidiOrder] = useState<ChatStreamState['didiOrder']>();
  const [inputRequest, setInputRequest] = useState<ChatStreamState['inputRequest']>();
  const actedOrders = useRef(new Set<string>());
  const [preparingLocation, setPreparingLocation] = useState(false);
  const preparing = useRef(false);
  const preparationEpoch = useRef(0);
  const imageOperation = useRef<AbortController | null>(null);
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
  const visibleRows = locationPreview ? [...rows, locationPreview] : rows;
  const virtualizer = useVirtualizer({count: visibleRows.length, getScrollElement: () => viewport.current, estimateSize: i => visibleRows[i]?.role === 'user' ? 110 : 220, overscan: 5, getItemKey: i => visibleRows[i]?.id ?? i});
  useEffect(() => {
    const scope = ++lifetime.current;
    setImage(null); setImagePhase(''); preparing.current = false; setPreparingLocation(false);
    setLocationPreview(null); setDidiOrder(undefined); setInputRequest(undefined); actedOrders.current.clear();
    return () => {
      if (lifetime.current === scope) ++lifetime.current;
      preparationEpoch.current++; imageOperation.current?.abort(); releaseDraftImage();
      operation.current?.abort(); if (updateTimer.current) clearTimeout(updateTimer.current);
    };
  }, [api]);
  useEffect(() => {
    if (conversationId === currentConversation.current) return;
    preparationEpoch.current++; preparing.current = false; setPreparingLocation(false); location.reset();
    setLocationPreview(null); setDidiOrder(undefined); setInputRequest(undefined); actedOrders.current.clear();
    imageOperation.current?.abort(); releaseDraftImage(); setImage(null); setImagePhase('');
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
    if (scrollWanted.current && visibleRows.length) {
      virtualizer.scrollToIndex(visibleRows.length - 1, {align: 'end'});
      scrollWanted.current = false;
    }
  }, [rows, locationPreview, virtualizer]);
  useLayoutEffect(() => {if (!input.current) return; input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 180)}px`;}, [draft]);

  function applyProgress(item: Pending) {
    const value = item.stream;
    setDidiOrder(value.didiOrder);
    setInputRequest(value.inputRequest);
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
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const selectedImage = draftImage.current;
    if ((!draft.trim() && !selectedImage) || busy || loading || pending.current || preparing.current || location.state.open) return;
    const text = composeFollowUpMessage(draft.trim() || '请帮我看看这张图片。', quotedText);
    if (text.length > 20_000) {setError('引用和问题合计不能超过 20,000 字，请缩短后再发送。'); return;}
    preparing.current = true; setPreparingLocation(true);
    const epoch = ++preparationEpoch.current;
    const id = newRequestId();
    const outgoing: Row = {id: `${id}-user`, conversation_id: currentConversation.current ?? '', role: 'user',
      content: text, created_at: new Date().toISOString(), delivery: 'waiting_location'};
    let context;
    let pickedLocation = false;
    const controller = new AbortController();
    imageOperation.current = controller;
    setError('');
    try {
      const preparation = location.capture(text, rows, user.timezone);
      pickedLocation = preparation instanceof Promise;
      if (pickedLocation) {scrollWanted.current = true; setLocationPreview(outgoing);}
      context = preparation instanceof Promise ? await preparation : preparation;
      if (epoch !== preparationEpoch.current || !context) return;
      if (selectedImage && !selectedImage.analyzed) {
        if (!selectedImage.upload) {
          setImagePhase('正在上传图片…');
          const file = await prepareChatImage(selectedImage.file);
          if (controller.signal.aborted) return;
          const upload = await api.uploadImage(file, controller.signal);
          if (controller.signal.aborted) {void api.deleteUpload(upload.id).catch(() => {}); return;}
          selectedImage.upload = upload;
        }
        setImagePhase('正在理解图片…');
        const result = await api.analyzeImage(selectedImage.upload.id, controller.signal);
        if (controller.signal.aborted) return;
        if (!result.text.trim()) throw new Error('图片理解没有返回内容，请重试或更换图片。');
        selectedImage.analyzed = true;
      }
    } catch (error) {
      if (epoch === preparationEpoch.current) setError(errorText(error));
      return;
    } finally {
      if (imageOperation.current === controller) imageOperation.current = null;
      if (epoch === preparationEpoch.current) {
        preparing.current = false; setPreparingLocation(false); setImagePhase(''); setLocationPreview(null);
        input.current?.focus();
      }
    }
    const upload = selectedImage?.upload;
    const item: Pending = {intent: Object.freeze({message: text, conversation_id: currentConversation.current, client_request_id: id, remember: false, upload_ids: upload ? [upload.id] : [], reasoning_effort: reasoning, client_context: context,
      interaction_mode: pickedLocation ? 'location_decided' : 'enabled', didi_order_confirmation_supported: true}), stream: initialChatStreamState(), userKey: outgoing.id, assistantKey: `${id}-assistant`};
    pending.current = item; setDraft(''); setQuotedText(null); setError(''); scrollWanted.current = true;
    draftImage.current = null; setImage(null);
    setRows(prev => [...prev, {...outgoing, delivery: 'sending', attachments: upload ? [{upload_id: upload.id, name: upload.name, mime_type: upload.mime_type, size: upload.size}] : undefined}, {id: item.assistantKey, conversation_id: currentConversation.current ?? '', role: 'assistant', content: '', created_at: new Date().toISOString(), delivery: 'sending'}]);
    void run(item);
  }
  function releaseDraftImage() {
    const upload = draftImage.current?.upload;
    draftImage.current = null;
    if (upload) void api.deleteUpload(upload.id).catch(() => {});
  }
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file = pastedImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    if (preparing.current || location.state.open) return;
    const error = pastedImageError(file);
    if (error) {setError(error); return;}
    releaseDraftImage();
    const next = {file};
    draftImage.current = next; setImage(next); setError('');
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
  const empty = visibleRows.length === 0 && !loading;
  return <div className={`chat-workspace ${empty ? 'empty' : ''}`}>
    <TextSelectionActions containerRef={viewport} resetKey={conversationId ?? 'new'} followUpDisabled={loading || hasPending && !busy} onFollowUp={text => {setQuotedText(text); input.current?.focus({preventScroll: true});}}/>
    <div className="chat-viewport" ref={viewport} onScroll={() => {const el = viewport.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);}}>
      {loading && <div className="center-loading"><LoaderCircle className="spin" size={22}/><p>正在打开对话…</p></div>}
      {empty && <div className="chat-welcome"><Orb/><div className="eyebrow">你的个人 AI 助手</div><h2>{user.name ? `${user.name}，` : ''}有什么想聊的？</h2><p>一个问题、一个想法，都可以从这里开始。</p><div className="prompt-grid"><button onClick={() => insertPrompt('结合我已有的事项和记忆，帮我理清今天最值得做的三件事。')}><span className="prompt-icon blue"><ListPromptIcon/></span><strong>理清今天的重点</strong><small>把繁杂的安排，变成清晰的下一步</small><ArrowUp size={15}/></button><button onClick={() => insertPrompt('我想学习一个新知识，请先问我感兴趣的方向，再带我一步步理解。')}><span className="prompt-icon purple"><Lightbulb size={19}/></span><strong>一起学点新知识</strong><small>从好奇开始，让理解更进一步</small><ArrowUp size={15}/></button><button onClick={() => insertPrompt('帮我把一个想法整理成可执行的计划。请先问我具体想做什么。')}><span className="prompt-icon peach"><WandSparkles size={19}/></span><strong>把想法变成行动</strong><small>一起拆解，找到现在就能做的事</small><ArrowUp size={15}/></button></div></div>}
      {!empty && !loading && <div className="message-column">{before && <button className="load-earlier" disabled={loadingEarlier || busy} onClick={() => void earlier()}>{loadingEarlier ? '正在加载…' : '加载更早的消息'}</button>}<div className="virtual-messages" style={{height: virtualizer.getTotalSize(), position: 'relative'}}>{virtualizer.getVirtualItems().map(item => {
        const row = visibleRows[item.index];
        return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={{position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)`}}><MessageRow row={row}/>
          {row === locationPreview && <LocationPicker location={location} api={api}/>}
          {didiOrder && row.id === pending.current?.assistantKey && <DidiOrderCard key={didiOrder.id} card={didiOrder} api={api} acted={actedOrders.current}/>}
          {inputRequest && row.id === pending.current?.assistantKey && <ServerInputCard key={inputRequest.id} card={inputRequest} api={api} bridge={locationBridge}/>}
        </div>;
      })}</div></div>}
    </div>
    {!atBottom && rows.length > 0 && <button className="jump-latest" aria-label="回到最新消息" onClick={() => {virtualizer.scrollToIndex(rows.length - 1, {align: 'end'}); setAtBottom(true);}}><ArrowDown size={18}/></button>}
    <div className={`composer-dock ${empty ? 'welcome-dock' : ''}`}><div className="composer-column">
      {!locationPreview && <LocationPicker location={location} api={api}/>}
      {!location.state.open && <div className="location-chip-row"><button type="button" className="location-chip" disabled={busy || hasPending || preparingLocation} onClick={location.edit}><MapPin size={13}/><span>{locationCaption(location.state.location)}</span></button>{location.state.location && <button type="button" className="location-clear" disabled={busy || hasPending || preparingLocation} onClick={location.clear}>清除</button>}</div>}
      {error && <Notice>{error}{hasPending && !busy && <button className="inline-action" onClick={() => pending.current && void run(pending.current, true)}><RotateCcw size={14}/>继续接收</button>}</Notice>}
      {stopped && !error && <Notice tone="info">已停止接收，收到的内容已保留。服务器可能仍在处理。<button className="inline-action" disabled={busy} onClick={() => pending.current && void run(pending.current, true)}>继续接收</button></Notice>}
      <form className={`composer ${busy ? 'receiving' : ''}`} onSubmit={send}>
        {quotedText && <div className="composer-quote"><CornerDownRight size={15}/><div><strong>追问这段内容</strong><p>{quotedText}</p></div><button type="button" aria-label="取消引用" onClick={() => {setQuotedText(null); input.current?.focus();}}><X size={15}/></button></div>}
        {image && <ImagePreview file={image.file} status={imagePhase} disabled={preparingLocation} onRemove={() => {releaseDraftImage(); setImage(null); setError(''); input.current?.focus();}}/>}
        <textarea ref={input} aria-label="发送消息" placeholder={hasPending && !busy ? '先继续接收上一条回复，或新建对话' : image ? '想问这张图片的什么？' : '发消息，或说说你的想法…'} rows={2} value={locationPreview ? '' : draft}
          disabled={loading || hasPending && !busy} readOnly={preparingLocation || location.state.open} maxLength={20_000}
          onChange={e => setDraft(e.target.value)} onPaste={handlePaste}
          onCompositionStart={() => {composing.current = true;}} onCompositionEnd={() => {composing.current = false;}}
          onKeyDown={e => {if (!composing.current && shouldSendOnEnter(e)) {e.preventDefault(); void send();}}}/>
        <div className="composer-toolbar">
          <div className="composer-left"><ReasoningMenu value={reasoning} onChange={setReasoning} disabled={busy || hasPending || preparingLocation || location.state.open}/></div>
          <div className="composer-right"><span>{busy ? '正在回复' : 'Enter 发送 · Shift Enter 换行'}</span>
            {busy ? <button className="send-button stop-button" type="button" aria-label="停止接收回复" title="停止接收回复，服务器可能仍在处理" onClick={() => operation.current?.abort()}><Square size={15} fill="currentColor"/></button> :
              <button className="send-button" disabled={(!draft.trim() && !image) || loading || hasPending || preparingLocation || location.state.open} type="submit" aria-label="发送"><ArrowUp size={20}/></button>}
          </div>
        </div>
      </form>
      <p className="composer-footnote">AI 也会有疏漏，重要的信息请核实。</p>
    </div></div>
  </div>;
}
function ImagePreview({file, status, disabled, onRemove}: {file: File; status: string; disabled: boolean; onRemove(): void}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return <div className="composer-image">
    {url && <img src={url} alt="待发送图片预览"/>}
    <div><strong>粘贴的图片</strong><span role="status">{status || '发送时上传'}</span></div>
    <button type="button" aria-label="移除图片" disabled={disabled} onClick={onRemove}><X size={16}/></button>
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
    {user ? <div className="user-bubble">
      {row.attachments?.map(file => <div key={file.upload_id} className="message-attachment"><ImageIcon size={15}/><span>{file.name}{file.unavailable ? '（不可用）' : ''}</span></div>)}
      <div data-selection-content data-message-id={row.id}>{row.content}</div>
    </div> : row.content ? <div data-selection-content data-message-id={row.id}><Markdown text={row.content}/></div> : <div className="reply-waiting"><span className="waiting-orb"/><span>{row.delivery === 'interrupted' ? '回复已中断' : row.toolStatus || '正在想…'}</span></div>}
    {!user && row.content && row.toolStatus && <div className="tool-status"><LoaderCircle className="spin" size={13}/>{row.toolStatus}</div>}
    <div className="message-actions">{row.content && row.delivery !== 'waiting_location' && <CopyButton text={row.content} label="复制消息"/>}{user && row.delivery === 'sending' && <span>发送中</span>}{row.delivery === 'waiting_location' && <span>等待出发地</span>}{row.delivery === 'interrupted' && <span>已保留内容</span>}</div>
  </article>;
});

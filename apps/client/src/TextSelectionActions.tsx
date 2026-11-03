import {useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {Check, Copy, CornerDownRight, Square, Volume2} from 'lucide-react';
import './text-selection-actions.css';

type Popup = {kind: 'selection' | 'context'; text: string; x: number; top: number; bottom: number};
type Props = {
  containerRef: RefObject<HTMLElement | null>;
  onFollowUp(text: string): void;
  followUpDisabled?: boolean;
  resetKey: string;
};

function contentAt(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : node?.parentElement;
  if (element?.closest('button,input,textarea,select,[contenteditable="true"]')) return null;
  return element?.closest<HTMLElement>('[data-selection-content]') ?? null;
}

function selectedText(container: HTMLElement | null) {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const start = contentAt(range.startContainer);
  if (!start || !container.contains(start) || start !== contentAt(range.endContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {text, content: start, rect};
}

/** One listener set for the viewport, independent of the number of messages. */
export function TextSelectionActions({containerRef, onFollowUp, followUpDisabled = false, resetKey}: Props) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [position, setPosition] = useState({left: 0, top: 0, ready: false});
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const popupRef = useRef(popup); popupRef.current = popup;
  const callbacks = useRef({onFollowUp, followUpDisabled}); callbacks.current = {onFollowUp, followUpDisabled};
  const speechRun = useRef(0);
  const ownsSpeech = useRef(false);

  function stopReading() {
    ++speechRun.current;
    if (ownsSpeech.current) window.speechSynthesis?.cancel();
    ownsSpeech.current = false; setReading(false);
  }

  useEffect(() => {
    setPopup(null); setNotice(''); stopReading();
    return () => {
      ++speechRun.current;
      if (ownsSpeech.current) window.speechSynthesis?.cancel();
      ownsSpeech.current = false;
    };
  }, [resetKey]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    let dragging = false;
    const insidePanel = (target: EventTarget | null) => target instanceof Node && panel.current?.contains(target);
    const down = (event: PointerEvent) => {
      if (insidePanel(event.target)) return;
      const content = contentAt(event.target instanceof Node ? event.target : null);
      dragging = event.button === 0 && !!content && !!containerRef.current?.contains(content);
      setPopup(null);
    };
    const showSelection = () => {
      const selected = selectedText(containerRef.current);
      if (!selected) {setPopup(null); return;}
      setPosition(previous => ({...previous, ready: false}));
      setPopup({kind: 'selection', text: selected.text, x: selected.rect.left + selected.rect.width / 2, top: selected.rect.top, bottom: selected.rect.bottom});
    };
    const up = (event: PointerEvent) => {
      const fromMessage = dragging;
      dragging = false;
      const content = contentAt(event.target instanceof Node ? event.target : null);
      if (event.button === 0 && !insidePanel(event.target) && (fromMessage || content && containerRef.current?.contains(content))) showSelection();
    };
    const selectionChanged = () => {
      if (dragging || !popupRef.current || panel.current?.contains(document.activeElement)) return;
      if (!selectedText(containerRef.current)) setPopup(null);
    };
    const context = (event: MouseEvent) => {
      const content = contentAt(event.target instanceof Node ? event.target : null);
      if (!content || !containerRef.current?.contains(content)) return;
      event.preventDefault();
      const selected = selectedText(containerRef.current);
      const text = selected?.content === content ? selected.text : content.innerText || content.textContent || '';
      if (!text.trim()) {setPopup(null); return;}
      setPosition(previous => ({...previous, ready: false}));
      setPopup({kind: 'context', text, x: event.clientX, top: event.clientY, bottom: event.clientY});
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopup(null);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      const extending = event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
      if (!insidePanel(event.target) && (extending || (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) showSelection();
    };
    const hide = () => setPopup(null);
    const scroll = (event: Event) => {if (!insidePanel(event.target)) hide();};
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up);
    document.addEventListener('selectionchange', selectionChanged);
    containerRef.current?.addEventListener('contextmenu', context);
    document.addEventListener('keydown', key);
    document.addEventListener('keyup', keyUp);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    const container = containerRef.current;
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('selectionchange', selectionChanged);
      container?.removeEventListener('contextmenu', context);
      document.removeEventListener('keydown', key);
      document.removeEventListener('keyup', keyUp);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [containerRef]);

  useLayoutEffect(() => {
    if (!popup || !panel.current) return;
    const rect = panel.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const desiredLeft = popup.kind === 'context' ? popup.x : popup.x - rect.width / 2;
    const above = popup.kind === 'selection' && popup.top - rect.height - 9 >= 8;
    const desiredTop = above ? popup.top - rect.height - 9 : popup.bottom + (popup.kind === 'selection' ? 9 : 2);
    setPosition({left: Math.max(8, Math.min(desiredLeft, viewportWidth - rect.width - 8)), top: Math.max(8, Math.min(desiredTop, viewportHeight - rect.height - 8)), ready: true});
    if (popup.kind === 'context') panel.current.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
  }, [popup, reading]);

  async function copy() {
    if (!popup) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(popup.text);
      setNotice('已复制'); setPopup(null);
    } catch {setNotice('复制失败，请重试或使用 Ctrl+C');}
  }

  function read() {
    if (reading) {stopReading(); return;}
    if (!popup) return;
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {setNotice('当前系统不支持朗读，请安装系统语音后重试'); return;}
    stopReading();
    const run = ++speechRun.current;
    const text = popup.text;
    const language = /[\u3400-\u9fff]/.test(text) ? 'zh-CN' : document.documentElement.lang || 'en-US';
    const voices = synthesis.getVoices();
    const voice = voices.find(item => item.localService && item.lang.toLowerCase().startsWith(language.split('-')[0].toLowerCase()))
      ?? voices.find(item => item.lang.toLowerCase() === language.toLowerCase());
    // Queue one short segment at a time, avoiding long-utterance browser stalls.
    const characters = Array.from(text);
    const chunks: string[] = [];
    for (let index = 0; index < characters.length; index += 180) chunks.push(characters.slice(index, index + 180).join(''));
    ownsSpeech.current = true; setReading(true);
    const speak = (index: number) => {
      if (run !== speechRun.current) return;
      if (index >= chunks.length) {ownsSpeech.current = false; setReading(false); return;}
      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      utterance.lang = language;
      if (voice) utterance.voice = voice;
      utterance.onend = () => speak(index + 1);
      utterance.onerror = () => {
        if (run !== speechRun.current) return;
        ownsSpeech.current = false; setReading(false); setNotice('朗读未能开始，请检查系统语音设置后重试');
      };
      try {synthesis.speak(utterance);} catch {utterance.onerror?.(new Event('error') as SpeechSynthesisErrorEvent);}
    };
    speak(0);
  }

  return createPortal(<>
    {popup && <div ref={panel} className={`text-selection-actions ${popup.kind === 'context' ? 'copy-only' : ''}`} role={popup.kind === 'context' ? 'menu' : 'toolbar'} aria-label={popup.kind === 'context' ? '消息右键菜单' : '选中文字操作'} style={{left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden'}} onPointerDown={event => event.preventDefault()} onKeyDown={event => {
      if (event.key === 'Escape') {event.preventDefault(); setPopup(null);}
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      if (event.key === 'Tab' && popup.kind === 'context') setPopup(null);
    }}>
      <button type="button" role={popup.kind === 'context' ? 'menuitem' : undefined} onClick={() => void copy()}><Copy size={15}/><span>复制</span></button>
      {popup.kind === 'selection' && <><span className="text-selection-divider"/><button type="button" onClick={read}><Volume2 size={16}/><span>{reading ? '停止朗读' : '朗读'}</span></button><span className="text-selection-divider"/><button type="button" className="text-selection-follow-up" disabled={followUpDisabled} onClick={() => {
        if (callbacks.current.followUpDisabled) return;
        if (popup.text.length > 12_000) {setNotice('选中文字较长，请缩小选区后追问'); return;}
        callbacks.current.onFollowUp(popup.text); window.getSelection()?.removeAllRanges(); setPopup(null);
      }}><CornerDownRight size={16}/><span>追问</span></button></>}
    </div>}
    {reading && <div className="selection-reading-status"><Volume2 size={14}/><span>正在朗读</span><button type="button" onClick={stopReading} aria-label="停止朗读"><Square size={11} fill="currentColor"/>停止</button></div>}
    {notice && <div className="selection-action-notice" role="status">{notice === '已复制' && <Check size={14}/>}<span>{notice}</span></div>}
  </>, document.body);
}

export function composeFollowUpMessage(message: string, quotedText: string | null) {
  if (!quotedText) return message;
  return `针对以下引用内容：\n${quotedText.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n${message}`;
}

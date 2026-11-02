import {memo, useEffect, useState} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {Check, Copy, WrapText, ChevronDown, ChevronUp} from 'lucide-react';
import {openExternal} from './platform';

type Tokens = Array<Array<{content: string; color?: string}>>;
let worker: Worker | undefined;
let nextId = 0;
const awaiting = new Map<number, (tokens: Tokens | null) => void>();
function highlight(code: string, language: string, receive: (tokens: Tokens | null) => void) {
  if (typeof Worker === 'undefined' || code.length > 30_000) return () => {};
  try {if (!worker) {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = ({data}: MessageEvent<{id: number; tokens: Tokens | null}>) => {
      awaiting.get(data.id)?.(data.tokens); awaiting.delete(data.id);
    };
    worker.onerror = () => { awaiting.forEach(receive => receive(null)); awaiting.clear(); };
  }
  const id = ++nextId;
  awaiting.set(id, receive); worker.postMessage({id, code, language});
  return () => { awaiting.delete(id); };
  } catch { receive(null); return () => {}; }
}

export function CopyButton({text, label = '复制'}: {text: string; label?: string}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (!copied && !failed) return; const t = setTimeout(() => {setCopied(false); setFailed(false);}, 2000); return () => clearTimeout(t); }, [copied, failed]);
  return <button className="icon-text" aria-label={copied ? '已复制' : label} onClick={() => {
    if (!navigator.clipboard?.writeText) {setFailed(true); return;}
    navigator.clipboard.writeText(text).then(() => setCopied(true)).catch(() => setFailed(true));
  }}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span>{copied ? '已复制' : failed ? '复制失败，请选中文字' : label}</span></button>;
}

const CodeBlock = memo(function CodeBlock({code, language}: {code: string; language: string}) {
  const [tokens, setTokens] = useState<Tokens | null>(null);
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setTokens(null);
    let release = () => {};
    const timeout = setTimeout(() => { release = highlight(code, language, setTokens); }, 180);
    return () => { clearTimeout(timeout); release(); };
  }, [code, language]);
  const lines = code.split('\n');
  const folded = !expanded && lines.length > 16;
  const count = folded ? 14 : lines.length;
  return <section className="code-card" aria-label={`${language || '文本'}代码块`}>
    <div className="code-toolbar"><span>{language || '纯文本'}<small>{lines.length} 行</small></span><div><button className={`icon-text ${wrap ? 'selected' : ''}`} onClick={() => setWrap(!wrap)} aria-label="切换代码自动换行" aria-pressed={wrap}><WrapText size={15}/><span>换行</span></button><CopyButton text={code} label="复制代码"/></div></div>
    <pre className={wrap ? 'wrap' : ''}><code>{tokens ? tokens.slice(0, count).map((line, i) => <span className="code-line" key={i}>{line.map((token, j) => <span key={j} style={{color: token.color}}>{token.content}</span>)}{'\n'}</span>) : lines.slice(0, count).join('\n')}</code></pre>
    {lines.length > 16 && <button className="code-fold" onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>} {expanded ? '收起代码' : `展开全部 ${lines.length} 行`}</button>}
  </section>;
});

export const Markdown = memo(function Markdown({text}: {text: string}) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: ({children}) => <>{children}</>,
    code: ({children, className, node}) => {
      const code = String(children).replace(/\n$/, '');
      const language = /language-([\w+-]+)/.exec(className ?? '')?.[1] ?? '';
      const block = !!language || String(children).endsWith('\n') || (node?.position?.start.line !== node?.position?.end.line);
      return block ? <CodeBlock code={code} language={language}/> : <code className="inline-code">{children}</code>;
    },
    table: ({children}) => <div className="table-scroll" tabIndex={0} aria-label="可横向滚动的表格"><table>{children}</table></div>,
    a: ({href, children}) => <a href={href} onClick={event => {event.preventDefault(); if (href) void openExternal(href);}}>{children}</a>,
    img: ({alt}) => <span className="remote-image-note">[图片{alt ? `：${alt}` : ''}，请在来源中查看]</span>,
  }}>{text}</ReactMarkdown></div>;
});

export type WebSource = { url: string; domain: string; title: string; pdf: boolean };
export type LinkToken = { kind: 'text' | 'code'; text: string } | { kind: 'link'; text: string; source: WebSource };

/** Only absolute web URLs. Reject credentials, control/bidi characters and pseudo schemes. */
export function webSource(target: string, title?: string): WebSource | null {
  if (target.length > 8192 || /[\s\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069\\]/u.test(target)) return null;
  const match = /^(https?):\/\/([^/?#]+)([^\s]*)$/i.exec(target);
  if (!match || /[@%]/.test(match[2])) return null;
  const host = /^(\[[a-f\d:]+\]|[a-z\d\u0080-\uffff](?:[a-z\d.\-\u0080-\uffff]*[a-z\d\u0080-\uffff])?)(?::(\d{1,5}))?$/i.exec(match[2]);
  if (!host || (host[2] && (+host[2] < 1 || +host[2] > 65535))) return null;
  const authority = match[2].toLowerCase();
  return { url: `${match[1].toLowerCase()}://${authority}${match[3]}`, domain: authority,
    title: title?.trim() || authority, pdf: /\.pdf(?:[?#]|$)/i.test(match[3]) };
}

/** A bounded scanner handles balanced URL parentheses and leaves code inert. */
export function markdownLinks(value: string): LinkToken[] {
  const tokens: LinkToken[] = [];
  let text = '', i = 0;
  const flush = () => { if (text) { tokens.push({ kind: 'text', text }); text = ''; } };
  const add = (target: string, label?: string) => {
    const source = webSource(target, label);
    if (source) { flush(); tokens.push({ kind: 'link', text: label || source.domain, source }); }
    else text += label || target;
  };
  while (i < value.length) {
    if (value[i] === '\\' && /[\[\]()`]/.test(value[i + 1] || '')) { text += value[i + 1]; i += 2; continue; }
    if (value[i] === '`') {
      let end = i; while (value[end] === '`') end++;
      const marker = value.slice(i, end), close = value.indexOf(marker, end);
      if (close >= 0) { flush(); tokens.push({ kind: 'code', text: value.slice(i, close + marker.length) }); i = close + marker.length; continue; }
    }
    if (value[i] === '!' && value[i + 1] === '[') {
      const end = value.indexOf(')', i + 2);
      if (end >= 0) { text += value.slice(i, end + 1); i = end + 1; continue; }
    }
    if (value[i] === '<') {
      const end = value.indexOf('>', i + 1);
      if (end > i && webSource(value.slice(i + 1, end))) { add(value.slice(i + 1, end)); i = end + 1; continue; }
    }
    if (value[i] === '[' && value[i - 1] !== '!') {
      const offset = value.slice(i + 1, i + 641).indexOf('](');
      if (offset >= 0) {
        const label = value.slice(i + 1, i + offset + 1), start = i + offset + 3;
        let cursor = start, depth = 1;
        while (cursor < value.length && cursor - start <= 8192) {
          if (value[cursor] === '\\' && /[()]/.test(value[cursor + 1] || '')) { cursor += 2; continue; }
          if (value[cursor] === '(') depth++;
          if (value[cursor] === ')' && --depth === 0) break;
          cursor++;
        }
        if (!depth) {
          const raw = value.slice(start, cursor).trim();
          const destination = /^(<[^>]+>|\S+?)(?:\s+["'][\s\S]*["'])?$/.exec(raw)?.[1] || raw;
          add(destination.replace(/^<|>$/g, '').replace(/\\([()])/g, '$1'), label);
          i = cursor + 1; continue;
        }
        // A streamed target is not clickable until its closing delimiter arrives.
        if (cursor === value.length && /^(?:https?:|javascript:|data:)/i.test(value.slice(start))) { text += label; i = value.length; continue; }
      }
    }
    if (/^(?:https?:\/\/)/i.test(value.slice(i, i + 8)) && (i === 0 || !/[a-z\d_]/i.test(value[i - 1]))) {
      const rest = value.slice(i);
      const raw = /^[^\s<>"'\u3000，。；！、]+/.exec(rest)?.[0] || '';
      let target = raw.replace(/[.,;!]+$/, '');
      while (target.endsWith(')') && (target.match(/\)/g)?.length || 0) > (target.match(/\(/g)?.length || 0)) target = target.slice(0, -1);
      while (target.endsWith(']') || target.endsWith('}')) target = target.slice(0, -1);
      if (target) { add(target); i += target.length; continue; }
    }
    text += value[i++];
  }
  flush(); return tokens;
}

export function linkDisplayText(value: string): string { return markdownLinks(value).map(t => t.text).join(''); }

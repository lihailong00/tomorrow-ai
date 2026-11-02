/** Small, bounded display-only tokenizer. Source text is never executed or modified. */
export type CodeToken = { text: string; kind?: 'keyword' | 'type' | 'comment' | 'string' | 'number' | 'attribute' | 'lifetime' };
export type CodeGrammar = 'rust' | 'python' | 'javascript' | 'typescript' | 'json' | 'shell' | 'plain';
export type CodeLanguage = { grammar: CodeGrammar; label: string };
const aliases: Record<string, CodeLanguage> = {
  rust: { grammar: 'rust', label: 'Rust' }, rs: { grammar: 'rust', label: 'Rust' },
  python: { grammar: 'python', label: 'Python' }, py: { grammar: 'python', label: 'Python' },
  javascript: { grammar: 'javascript', label: 'JavaScript' }, js: { grammar: 'javascript', label: 'JavaScript' }, jsx: { grammar: 'javascript', label: 'JSX' },
  typescript: { grammar: 'typescript', label: 'TypeScript' }, ts: { grammar: 'typescript', label: 'TypeScript' }, tsx: { grammar: 'typescript', label: 'TSX' },
  json: { grammar: 'json', label: 'JSON' }, jsonc: { grammar: 'javascript', label: 'JSONC' },
  bash: { grammar: 'shell', label: 'Shell' }, sh: { grammar: 'shell', label: 'Shell' }, shell: { grammar: 'shell', label: 'Shell' }, zsh: { grammar: 'shell', label: 'Shell' },
  text: { grammar: 'plain', label: '文本' }, plaintext: { grammar: 'plain', label: '文本' }, txt: { grammar: 'plain', label: '文本' },
};
export function codeLanguage(info: string): CodeLanguage {
  const value = info.trim().split(/\s/)[0].replace(/^language-/i, '').slice(0, 32);
  const key = value.toLowerCase();
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : { grammar: 'plain', label: value || '代码' };
}
const sharedKeywords = 'true false null undefined';
const keywords: Record<CodeGrammar, Set<string>> = {
  rust: new Set(('pub struct mut use fn let enum impl trait for in if else match return const static mod self Self super crate as async await move ref where type dyn unsafe extern loop while break continue true false').split(' ')),
  python: new Set(('from import as class def return if else elif for in not and or is None True False lambda with try except finally raise pass yield async await global nonlocal del assert while break continue').split(' ')),
  javascript: new Set(('const let var function return if else for of in class new this async await try catch finally throw import export default from extends static get set instanceof typeof void delete switch case break continue yield ' + sharedKeywords).split(' ')),
  typescript: new Set(('const let var function return if else for of in class new this async await try catch finally throw import export default from extends static get set instanceof typeof void delete switch case break continue yield interface type readonly public private protected declare namespace implements as keyof infer satisfies ' + sharedKeywords).split(' ')),
  json: new Set('true false null'.split(' ')),
  shell: new Set('if then else elif fi for in do done case esac function while until select return export local readonly source'.split(' ')),
  plain: new Set(),
};
const builtins = new Set('u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool str int float list dict set tuple string number boolean unknown never any void'.split(' '));
export const CODE_HIGHLIGHT_CHAR_LIMIT = 24000;
export const CODE_HIGHLIGHT_TOKEN_LIMIT = 1200;

export function highlightCode(source: string, grammar: CodeGrammar): CodeToken[] {
  if (!source || grammar === 'plain') return [{ text: source }];
  const tokens: CodeToken[] = [];
  const end = Math.min(source.length, CODE_HIGHLIGHT_CHAR_LIMIT);
  let i = 0, plainStart = 0;
  function emit(to: number, kind: CodeToken['kind']) {
    if (i > plainStart) tokens.push({ text: source.slice(plainStart, i) });
    tokens.push({ text: source.slice(i, to), kind });
    i = to; plainStart = to;
  }
  while (i < end && tokens.length < CODE_HIGHLIGHT_TOKEN_LIMIT) {
    const char = source[i], next = source[i + 1];
    if ((char === '/' && next === '/' && ['rust', 'javascript', 'typescript'].includes(grammar)) ||
        (char === '#' && ['python', 'shell'].includes(grammar))) {
      const newline = source.indexOf('\n', i);
      emit(newline < 0 ? end : Math.min(end, newline), 'comment'); continue;
    }
    if (char === '/' && next === '*' && ['rust', 'javascript', 'typescript'].includes(grammar)) {
      const close = source.indexOf('*/', i + 2);
      emit(close < 0 ? end : Math.min(end, close + 2), 'comment'); continue;
    }
    if (char === "'" && grammar === 'rust') {
      const lifetime = /^'[A-Za-z_]\w*/.exec(source.slice(i, Math.min(end, i + 100)));
      if (lifetime && source[i + lifetime[0].length] !== "'") { emit(i + lifetime[0].length, 'lifetime'); continue; }
    }
    if (char === '"' || (char === "'" && grammar !== 'json') || (char === '`' && ['javascript', 'typescript', 'shell'].includes(grammar))) {
      const triple = grammar === 'python' && source.slice(i, i + 3) === char.repeat(3);
      const delimiter = triple ? char.repeat(3) : char;
      let close = i + delimiter.length;
      for (; close < end; close++) {
        if (source[close] === '\\') { close++; continue; }
        if (source.slice(close, close + delimiter.length) === delimiter) { close += delimiter.length; break; }
      }
      emit(Math.min(end, close), 'string'); continue;
    }
    if (char === '#' && next === '[' && grammar === 'rust') {
      const attr = /^#\[\w+/.exec(source.slice(i, Math.min(end, i + 100)));
      if (attr) { emit(i + attr[0].length, 'attribute'); continue; }
    }
    if (/[A-Za-z_$]/.test(char)) {
      let to = i + 1;
      while (to < end && /[A-Za-z0-9_$]/.test(source[to])) to++;
      const word = source.slice(i, to);
      const kind = keywords[grammar].has(word) ? 'keyword' : /^[A-Z]/.test(word) || builtins.has(word) ? 'type' : undefined;
      if (kind) emit(to, kind); else i = to;
      continue;
    }
    if (/\d/.test(char) && (i === 0 || !/[\w$]/.test(source[i - 1]))) {
      let to = i + 1;
      while (to < end && /[\da-fA-FxXob_\.]/.test(source[to])) to++;
      emit(to, 'number'); continue;
    }
    i++;
  }
  if (plainStart < source.length) tokens.push({ text: source.slice(plainStart) });
  return tokens;
}

/** Ignore only the fence's final line terminator; keep intentional blank code lines. */
export function codeLines(source: string): string[] {
  if (!source) return [];
  const lines = source.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

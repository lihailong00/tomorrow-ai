import { CODE_HIGHLIGHT_CHAR_LIMIT, CODE_HIGHLIGHT_TOKEN_LIMIT, codeLanguage, codeLines, highlightCode } from '../src/ui/codeHighlight';
import { markdownBlocks } from '../src/ui/markdownBlocks';

test('a whole fenced block preserves raw indentation, CRLF, blank lines and trailing newline', () => {
  const source = '\tlet value = 1;\r\n\r\n    // 原样\r\n';
  expect(markdownBlocks(`说明\r\n\`\`\`rust\r\n${source}\`\`\`\r\n末尾`)).toEqual([
    { kind: 'line', line: 0, text: '说明', code: false },
    { kind: 'code', line: 1, language: 'rust', text: source, closed: true },
    { kind: 'line', line: 6, text: '末尾', code: false },
  ]);
});
test('open streaming fence exists immediately and retains opening-line identity through completion', () => {
  const content = '说明\n```ts';
  for (const [suffix, expected, closed] of [['', '', false], ['\nconst x', 'const x', false], ['\nconst x = 1;\n```', 'const x = 1;\n', true]] as const) {
    expect(markdownBlocks(content + suffix)[1]).toEqual({ kind: 'code', line: 1, language: 'ts', text: expected, closed });
  }
});
test('code ignores tables, links, headings, short/mismatched closing fences and supports adjacent blocks', () => {
  const blocks = markdownBlocks('~~~~rust\n```\n|a|b|\n|---|---|\n[x](https://example.com)\n~~~\n~~~~\n```json\n{}\n```');
  expect(blocks.map(block => block.kind)).toEqual(['code', 'code']);
  expect(blocks[0]).toMatchObject({ line: 0, text: '```\n|a|b|\n|---|---|\n[x](https://example.com)\n~~~\n', closed: true });
});
test.each(['constructor', '__proto__', 'toString', '<script>', 'odd-language', ''])('unknown %s labels cannot access prototypes or execute markup', label => {
  const language = codeLanguage(label);
  expect(language.grammar).toBe('plain');
  expect(highlightCode('<script>run()</script>', language.grammar)).toEqual([{ text: '<script>run()</script>' }]);
});
test.each([
  ['Rust', 'rust'], ['rs', 'rust'], ['language-ts', 'typescript'], ['py', 'python'], ['jsx', 'javascript'], ['JSON', 'json'], ['bash', 'shell'],
] as const)('resolves %s syntax grammar', (info, grammar) => expect(codeLanguage(info).grammar).toBe(grammar));
test.each([
  ['rust', '#[derive(Accounts)]\npub struct A<\'info> {\n /* hi\n still comment */ let a = "quote //";\n}'],
  ['python', 'def name():\n    """a\nlong string"""\n    return 3 # hello'],
  ['javascript', 'const url = "https://example.com"; // comment\nfunction hi() { return true; }'],
  ['typescript', 'interface User { name: string; }\nconst user: User = {name: "x"};'],
  ['json', '{"enabled":true,"amount":123,"text":"<div>raw</div>"}'],
  ['shell', '#!/bin/sh\nexport NAME="value"\necho "$NAME"'],
] as const)('%s highlighting changes only presentation; exact code is reconstructable', (grammar, source) => {
  const tokens = highlightCode(source, grammar);
  expect(tokens.map(token => token.text).join('')).toBe(source);
  expect(tokens.some(token => token.kind)).toBe(true);
});
test('strings protect comment-looking content and Rust lifetimes stay intact', () => {
  const tokens = highlightCode('let a = "// text"; // real\nlet x: &\'info str;', 'rust');
  expect(tokens.filter(token => token.kind === 'comment').map(token => token.text)).toEqual(['// real']);
  expect(tokens.filter(token => token.kind === 'lifetime').map(token => token.text)).toEqual(["'info"]);
});
test('token and character budgets keep all remaining content as plain source, without truncating', () => {
  const source = 'let value = "123";\n'.repeat(10000);
  const tokens = highlightCode(source, 'rust');
  expect(tokens.length).toBeLessThanOrEqual(CODE_HIGHLIGHT_TOKEN_LIMIT + 3);
  expect(tokens.map(token => token.text).join('')).toBe(source);
  const long = 'x'.repeat(CODE_HIGHLIGHT_CHAR_LIMIT + 100) + '\n"tail"';
  expect(highlightCode(long, 'rust').map(token => token.text).join('')).toBe(long);
});
test('line count omits only final fence terminator and retains deliberate empty lines', () => {
  expect(codeLines('')).toEqual([]);
  expect(codeLines('a\n\n')).toEqual(['a', '']);
  expect(codeLines('\n')).toEqual(['']);
  expect(codeLines('a\r\nb\r\n')).toEqual(['a', 'b']);
});

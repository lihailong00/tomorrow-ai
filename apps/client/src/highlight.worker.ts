import {createHighlighterCore} from 'shiki/core';
import {createJavaScriptRegexEngine} from 'shiki/engine/javascript';
const languages = ['rust', 'typescript', 'javascript', 'python', 'json', 'bash', 'sql', 'html', 'css', 'markdown'] as const;
const highlighter = createHighlighterCore({
  themes: [import('shiki/themes/github-light.mjs')],
  langs: [import('shiki/langs/rust.mjs'), import('shiki/langs/typescript.mjs'), import('shiki/langs/javascript.mjs'), import('shiki/langs/python.mjs'), import('shiki/langs/json.mjs'), import('shiki/langs/bash.mjs'), import('shiki/langs/sql.mjs'), import('shiki/langs/html.mjs'), import('shiki/langs/css.mjs'), import('shiki/langs/markdown.mjs')],
  engine: createJavaScriptRegexEngine(),
});
self.onmessage = async ({data}: MessageEvent<{id: number; code: string; language: string}>) => {
  try {
    const engine = await highlighter;
    const aliases: Record<string, string> = {ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', rs: 'rust', md: 'markdown'};
    const language = aliases[data.language] ?? data.language;
    const tokens = engine.codeToTokens(data.code, {lang: languages.includes(language as typeof languages[number]) ? language as typeof languages[number] : 'text', theme: 'github-light'}).tokens;
    self.postMessage({id: data.id, tokens});
  } catch { self.postMessage({id: data.id, tokens: null}); }
};

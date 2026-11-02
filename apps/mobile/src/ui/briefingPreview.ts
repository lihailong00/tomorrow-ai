import { markdownBlocks, markdownInlineText } from './markdownBlocks';
import { codeLines } from './codeHighlight';

/** A compact text excerpt, never a slice of raw Markdown or of an open fence. */
export function briefingPreview(content: string): string {
  const lines: string[] = [];
  for (const block of markdownBlocks(content)) {
    if (block.kind === 'code') {
      lines.push(`代码片段 · ${codeLines(block.text).length} 行`);
    } else if (block.kind === 'table') {
      lines.push(block.headers.map(markdownInlineText).join(' · '));
      for (const row of block.rows.slice(0, 2)) lines.push(row.map(markdownInlineText).join(' · '));
    } else {
      let text = block.text.trim();
      if (!text || /^(?:[-*_]\s*){3,}$/.test(text)) continue;
      text = text.replace(/^(?:>\s*)+/, '').replace(/^#{1,6}(?:\s+|$)/, '')
        .replace(/^[-*+]\s+/, '• ');
      lines.push(markdownInlineText(text));
    }
    if (lines.join('\n').length >= 800) break;
  }
  const text = lines.join('\n');
  if (text.length <= 800) return text || '展开查看简报内容';
  const end = /[\uD800-\uDBFF]/.test(text[799]) ? 799 : 800;
  return text.slice(0, end) + '…';
}

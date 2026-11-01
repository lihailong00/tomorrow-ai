import { linkDisplayText } from './markdownLinks';
export type ColumnAlignment = 'left' | 'center' | 'right';
export type MarkdownBlock =
  | { kind: 'line'; line: number; text: string; code: boolean }
  | { kind: 'table'; line: number; headers: string[]; alignments: ColumnAlignment[]; rows: string[][] };

type PipeRow = { cells: string[]; hasPipe: boolean };

/** A matching run is needed before a backtick can protect pipes as inline code. */
function closingTicks(value: string, from: number, size: number): number {
  for (let i = from; i < value.length;) {
    if (value[i] !== '`') { i++; continue; }
    let end = i + 1;
    while (value[end] === '`') end++;
    if (end - i === size) return i;
    i = end;
  }
  return -1;
}

/** Split delimiters, never escaped pipes or pipes inside balanced code spans. */
function pipeRow(source: string): PipeRow {
  const value = source.trim();
  const cells = [''];
  const delimiters: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && ['|', '\\', '`'].includes(value[i + 1])) {
      cells[cells.length - 1] += value[i + 1] === '`' ? '\\`' : value[i + 1];
      i++;
    } else if (char === '`') {
      let end = i + 1;
      while (value[end] === '`') end++;
      const size = end - i;
      const close = closingTicks(value, end, size);
      if (close >= 0) {
        cells[cells.length - 1] += value.slice(i, close + size).replace(/\\\|/g, '|');
        i = close + size - 1;
      } else {
        cells[cells.length - 1] += value.slice(i, end);
        i = end - 1;
      }
    } else if (char === '|') {
      delimiters.push(i);
      cells.push('');
    } else cells[cells.length - 1] += char;
  }
  if (delimiters[0] === 0) cells.shift();
  if (delimiters[delimiters.length - 1] === value.length - 1) cells.pop();
  return { cells: cells.map(cell => cell.trim()), hasPipe: delimiters.length > 0 };
}

/** Keep the small existing text renderer's formatting, including literal code. */
export function markdownInlineText(value: string): string {
  value = linkDisplayText(value);
  let result = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === '`') {
      result += '`'; i++;
    } else if (value[i] === '`') {
      let end = i + 1;
      while (value[end] === '`') end++;
      const size = end - i;
      const close = closingTicks(value, end, size);
      if (close >= 0) {
        result += value.slice(end, close);
        i = close + size - 1;
      } else {
        result += value.slice(i, end);
        i = end - 1;
      }
    } else result += value[i];
  }
  return result.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
}

/** Parse only proven tables; a partial streamed separator remains ordinary text. */
export function markdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let fence: { char: string; size: number } | null = null;
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && !marker[2].trim()) {
        fence = null;
      } else blocks.push({ kind: 'line', line, text, code: true });
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], size: marker[1].length };
      continue;
    }
    const header = pipeRow(text);
    const separator = line + 1 < lines.length ? pipeRow(lines[line + 1]) : null;
    if (header.hasPipe && header.cells.length > 0 && separator &&
        header.cells.length === separator.cells.length &&
        separator.cells.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const table: Extract<MarkdownBlock, { kind: 'table' }> = {
        kind: 'table', line, headers: header.cells,
        alignments: separator.cells.map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left'),
        rows: [],
      };
      line++;
      while (line + 1 < lines.length) {
        const next = lines[line + 1];
        if (!next.trim() || /^ {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3,}|~{3,})/.test(next)) break;
        const row = pipeRow(next);
        if (!row.hasPipe) break;
        const cells = row.cells.slice(0, header.cells.length);
        // Do not silently discard malformed or streamed extra cells.
        if (row.cells.length > cells.length) cells[cells.length - 1] += ' | ' + row.cells.slice(cells.length).join(' | ');
        while (cells.length < header.cells.length) cells.push('');
        table.rows.push(cells);
        line++;
      }
      blocks.push(table);
    } else blocks.push({ kind: 'line', line, text, code: false });
  }
  return blocks;
}

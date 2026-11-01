import { linkDisplayText, markdownLinks, webSource } from '../src/ui/markdownLinks';
const links = (value: string) => markdownLinks(value).filter(t => t.kind === 'link');

test('Markdown titles replace raw syntax, balanced URL parentheses and escaped parentheses survive', () => {
  const value = '[证券时报](https://stcn.com/a_(b).html)，[公告](https://example.com/a\\(b\\).pdf)';
  expect(linkDisplayText(value)).toBe('证券时报，公告');
  expect(links(value).map(t => t.kind === 'link' && t.source.url)).toEqual(['https://stcn.com/a_(b).html', 'https://example.com/a(b).pdf']);
});
test('plain URLs, angle links and Markdown titles expose actual domains and document types', () => {
  expect(linkDisplayText('见 https://example.com/very/long/path?q=x。')).toBe('见 example.com。');
  expect(linkDisplayText('<https://example.com/file.pdf?download=1>')).toBe('example.com');
  expect(links('[公告](https://cdn.example.com/file.PDF?x=1 "文档")')[0]).toMatchObject({ source: { domain: 'cdn.example.com', pdf: true } });
});
test.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'intent://x', '//example.com', 'https://user:secret@example.com/a', 'https://example.com\\@bad.test', 'https://ex\u202eample.com', 'https://example.com:99999'])('rejects unsafe or ambiguous target %s', target => {
  expect(webSource(target)).toBeNull();
  expect(links(`[安全标题](${target})`)).toHaveLength(0);
});
test('inline code and image markup stay inert; a streamed link becomes active only when complete', () => {
  expect(links('`https://example.com` 和 ``[代码](https://example.com)``')).toHaveLength(0);
  expect(links('![图片](https://example.com/image.png)')).toHaveLength(0);
  expect(linkDisplayText('[来源](https://example.com/incomplete')).toBe('来源');
  expect(links('[来源](https://example.com/complete)')).toHaveLength(1);
});
test('display text does not expose credentials from rejected Markdown targets', () => {
  expect(linkDisplayText('[来源](https://user:secret@example.com)')).toBe('来源');
});

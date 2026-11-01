import React from 'react';
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { ResultText } from '../src/ui/ResultText';

beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
const trees = new Set<ReactTestRenderer>();
beforeEach(() => Dimensions.set({ window: { width: 360, height: 640, scale: 2.75, fontScale: 1 } }));
afterEach(async () => {
  await act(async () => trees.forEach(tree => tree.unmount()));
  trees.clear();
});
async function render(content: string, textStyle?: React.ComponentProps<typeof ResultText>['textStyle']) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<ResultText content={content} textStyle={textStyle} />); });
  trees.add(tree);
  return tree;
}
const texts = (tree: ReactTestRenderer) => tree.root.findAllByType(Text).map(node => String(node.props.children ?? ''));
const tables = (tree: ReactTestRenderer) => tree.root.findAllByType(View).filter(node => node.props.testID === 'markdown-table');
const bodyRows = (tree: ReactTestRenderer) => tree.root.findAllByType(View).filter(node => node.props.testID === 'markdown-table-row');

test('AI table renders native header/cells rather than Markdown delimiter source, preserving surrounding prose', async () => {
  const tree = await render('以下为比较：\n\n| 基金 | 每日额度 |\n| --- | ---: |\n| 华夏 | 100 元 |\n| 南方 | 200 元 |\n\n以公告为准。');
  expect(tables(tree)).toHaveLength(1);
  expect(bodyRows(tree)).toHaveLength(2);
  expect(texts(tree)).toEqual(expect.arrayContaining(['以下为比较：', '基金', '每日额度', '华夏', '100 元', '南方', '200 元', '以公告为准。']));
  expect(texts(tree).some(value => value.includes('---') || value.startsWith('|'))).toBe(false);
  expect(tree.root.findAllByType(Text).filter(node => node.props.accessibilityRole === 'header')).toHaveLength(2);
  const limit = tree.root.findAllByType(Text).find(node => node.props.children === '100 元')!;
  expect(limit.props.selectable).toBe(true);
  expect(limit.props.accessibilityLabel).toBe('每日额度：100 元');
  expect(StyleSheet.flatten(limit.props.style).textAlign).toBe('right');
});

test('optional outer pipes, CRLF, left/center/right alignment and basic inline formatting work', async () => {
  const tree = await render('**事项** | 状态 | 数值\r\n:--- | :---: | ---:\r\n__学习__ | 完成 | `10`');
  expect(tables(tree)).toHaveLength(1);
  const cells = tree.root.findAllByType(Text).filter(node => node.props.accessibilityRole === 'text');
  expect(cells.map(node => node.props.children)).toEqual(['学习', '完成', '10']);
  expect(cells.map(node => StyleSheet.flatten(node.props.style).textAlign)).toEqual(['left', 'center', 'right']);
  expect(texts(tree)).toContain('事项');
});

test('escaped delimiters and balanced single/double backtick spans do not create phantom columns', async () => {
  const tree = await render('| 表达式 | 说明 |\n| --- | --- |\n| a\\|b | `x\\|y` |\n| ``a`b|c`` | 尾部\\| |');
  expect(bodyRows(tree)).toHaveLength(2);
  expect(texts(tree)).toEqual(expect.arrayContaining(['a|b', 'x|y', 'a`b|c', '尾部|']));
  const body = tree.root.findAllByType(Text).filter(node => node.props.accessibilityRole === 'text');
  expect(body).toHaveLength(4);
});

test('fenced table examples remain selectable literal code and never become native tables', async () => {
  const tree = await render('```markdown\n| **原样** | B |\n| --- | --- |\n| x | y |\n# 原样标题\n```\n# 真正标题\n- 正文项目');
  expect(tables(tree)).toHaveLength(0);
  expect(texts(tree)).toEqual(expect.arrayContaining(['| **原样** | B |', '# 原样标题', '真正标题', '• 正文项目']));
  const code = tree.root.findAllByType(Text).find(node => node.props.children === '# 原样标题')!;
  expect(StyleSheet.flatten(code.props.style).fontFamily).toBe('monospace');
  expect(code.props.selectable).toBe(true);
});

test('fence closing uses the matching character and sufficient run length', async () => {
  const tree = await render('~~~~\n```\n| A | B |\n| --- | --- |\n~~~\n~~~~\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  expect(tables(tree)).toHaveLength(1);
  expect(texts(tree)).toContain('```');
  expect(texts(tree)).toContain('~~~');
  expect(bodyRows(tree)).toHaveLength(1);
});

test('ordinary pipes, mismatched separators and incomplete Markdown remain readable text', async () => {
  const tree = await render('状态 A | 状态 B\n这是普通说明\n\n| A | B |\n| --- |\n\n| C | D |\n| -- | --- |');
  expect(tables(tree)).toHaveLength(0);
  expect(texts(tree)).toContain('状态 A | 状态 B');
  expect(texts(tree)).toContain('| A | B |');
  expect(texts(tree)).toContain('| -- | --- |');
});

test('streamed header, partial separator and body render incrementally without losing the next paragraph', async () => {
  const tree = await render('| 名称 | 限额 |');
  expect(tables(tree)).toHaveLength(0);
  await act(async () => tree.update(<ResultText content={'| 名称 | 限额 |\n| --- | --'} />));
  expect(tables(tree)).toHaveLength(0);
  await act(async () => tree.update(<ResultText content={'| 名称 | 限额 |\n| --- | --- |\n| 产品甲 |'} />));
  expect(tables(tree)).toHaveLength(1);
  expect(bodyRows(tree)).toHaveLength(1);
  expect(texts(tree)).toContain('产品甲');
  await act(async () => tree.update(<ResultText content={'| 名称 | 限额 |\n| --- | --- |\n| 产品甲 | 10 元 |\n| 产品乙 | 20 元 |\n后续说明仍是普通段落。'} />));
  expect(tables(tree)).toHaveLength(1);
  expect(bodyRows(tree)).toHaveLength(2);
  expect(texts(tree)).toEqual(expect.arrayContaining(['10 元', '产品乙', '20 元', '后续说明仍是普通段落。']));
});

test('ragged or overlong streamed rows retain all supplied content and do not throw', async () => {
  const tree = await render('| 名称 | 数值 |\n| --- | --- |\n| 只有名称 |\n| 产品 | 10 | 补充内容 |');
  expect(bodyRows(tree)).toHaveLength(2);
  expect(texts(tree)).toContain('只有名称');
  expect(texts(tree)).toContain('10 | 补充内容');
  const empty = tree.root.findAllByType(Text).find(node => node.props.accessibilityLabel === '数值：空白');
  expect(empty).toBeDefined();
});

test('stream chunks completing escaped pipes and inline code keep the table and all final cell data', async () => {
  const prefix = '| 名称 | 表达式 |\n| --- | --- |\n';
  const tree = await render(prefix + '| A \\');
  expect(tables(tree)).toHaveLength(1);
  expect(bodyRows(tree)).toHaveLength(1);
  await act(async () => tree.update(<ResultText content={prefix + '| A \\| B | `x|'} />));
  expect(tables(tree)).toHaveLength(1);
  expect(bodyRows(tree)).toHaveLength(1);
  await act(async () => tree.update(<ResultText content={prefix + '| A \\| B | `x|y` |\n| C | ``p`q|r`` |\n\n这是最终说明。'} />));
  const cells = tree.root.findAllByType(Text).filter(node => node.props.accessibilityRole === 'text');
  expect(cells.map(node => node.props.children)).toEqual(['A | B', 'x|y', 'C', 'p`q|r']);
  expect(cells).toHaveLength(4);
  expect(texts(tree)).toContain('这是最终说明。');
});

test('narrow display and large fonts keep complete cells in a horizontal native scroller', async () => {
  Dimensions.set({ window: { width: 280, height: 640, scale: 2.75, fontScale: 2 } });
  const tree = await render('| 基金名称 | 最新申购限额 | 公告适用日期 |\n| --- | --- | --- |\n| 一个较长的产品名称 | 每人每日不超过一百元 | 2026年11月1日 |', { color: '#303849', fontSize: 15, lineHeight: 28 });
  const pane = tree.root.findByType(ScrollView);
  expect(pane.props.horizontal).toBe(true);
  expect(pane.props.nestedScrollEnabled).toBe(true);
  expect(pane.props.showsHorizontalScrollIndicator).toBe(true);
  expect(texts(tree)).toContain('左右滑动查看表格');
  const value = tree.root.findAllByType(Text).find(node => node.props.children === '每人每日不超过一百元')!;
  expect(value.props.numberOfLines).toBeUndefined();
  expect(StyleSheet.flatten(value.props.style)).toMatchObject({ color: '#303849', fontSize: 15, lineHeight: 28 });
  const widths = tree.root.findAllByType(View).map(node => StyleSheet.flatten(node.props.style)?.width).filter(value => typeof value === 'number') as number[];
  expect(widths.every(value => value >= 184 && value <= 480)).toBe(true);
  expect(widths.slice(0, 3).reduce((sum, value) => sum + value, 0)).toBeGreaterThan(280);
});

test('safe rendering never executes model HTML and tables can appear between separate sections', async () => {
  const tree = await render('<script>alert(1)</script>\n\n| A |\n| --- |\n| first |\n\n## 第二组\n| B |\n| --- |\n| second |');
  expect(tables(tree)).toHaveLength(2);
  expect(texts(tree)).toContain('<script>alert(1)</script>');
  expect(texts(tree)).toEqual(expect.arrayContaining(['first', '第二组', 'second']));
});

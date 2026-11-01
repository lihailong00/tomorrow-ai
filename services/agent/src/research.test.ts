import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekWeb } from './web.js';
import { createResearch, needsResearch, researchAudit, researchReviewEnabled } from './research.js';

test('mandatory research review requires explicit deployment opt-in', () => {
  for (const value of [undefined, '', 'false', ' false ']) assert.equal(researchReviewEnabled(value), false);
  assert.equal(researchReviewEnabled('true'), true);
  assert.equal(researchReviewEnabled(' true '), true);
  for (const value of ['1', 'TRUE', 'enabled']) assert.throws(() => researchReviewEnabled(value), /AGENT_RESEARCH_REVIEW_ENABLED/);
});

const active = async () => {};
const oldQuote = '2026年9月28日，A类和C类份额合并计算，每日限额10元。';
const newQuote = '2026年10月21日起，A类和C类份额不合并计算，代销限额5元。';
function fixture() {
  const web = createDeepSeekWeb({ apiKey: 'synthetic', searches: 4, fetches: 4 }, async (url, init) => {
    const body = JSON.parse(init?.body as string);
    return Response.json(String(url).endsWith('/search') ? { results: [{ url: 'https://issuer.cn/new', title: '新公告', summary: newQuote }] } :
      { title: '公告', content: body.url.endsWith('/old') ? oldQuote : newQuote });
  }).session(active);
  return { web, research: createResearch(web, true, active) };
}
const plan = { questions: ['当前限额与份额合并规则是什么？'] };
const review = (status = 'supported', evidence: { source_id: string; quote: string }[] = []) => ({ checks: [
  { question: plan.questions[0], status, conclusion: status === 'supported' ? '根据新公告，限额5元且不合并。' : '未取得足够正文，限额未核实。', evidence },
], conflicts: [] });

test('search snippets cannot substantiate a supported finding or skip the body read', async () => {
  const { web, research } = fixture();
  await research.tools[0]!.execute('plan', plan);
  await web.tools[0]!.execute('search', { query: '当前申购限额' });
  await assert.rejects(research.tools[1]!.execute('review', review('supported', [{ source_id: 's1', quote: newQuote }])), /尚未尝试读取正文/);
  assert.equal(research.approved(), false);
  await web.tools[1]!.execute('read', { url: 'https://issuer.cn/new' });
  await assert.rejects(research.tools[1]!.execute('fabricated', review('supported', [{ source_id: 's1', quote: '这句伪造的正文根本不在实际获取的网页里面。' }])), /引文未出现在/);
  await research.tools[1]!.execute('reviewed', review('supported', [{ source_id: 's1', quote: newQuote }]));
  assert.equal(research.approved(), true);
  research.invalidate();
  assert.equal(research.approved(), false);
});

test('all planned questions must be covered and missing evidence remains uncertain', async () => {
  const { web, research } = fixture();
  await assert.rejects(research.tools[1]!.execute('no-plan', review('uncertain')), /research_plan/);
  await research.tools[0]!.execute('plan', plan);
  await assert.rejects(research.tools[1]!.execute('no-investigation', review('uncertain')), /尚未搜索或读取/);
  await web.tools[1]!.execute('read', { url: 'https://issuer.cn/new' });
  await assert.rejects(research.tools[1]!.execute('no-evidence', review()), /需要实际读取/);
  await research.tools[0]!.execute('two-questions', { questions: [...plan.questions, '销售平台有无独立限制？'] });
  await assert.rejects(research.tools[1]!.execute('missing-question', review('uncertain')), /逐项覆盖/);
  const result = await research.tools[1]!.execute('partial', { checks: [...review('supported', [{ source_id: 's1', quote: newQuote }]).checks,
    { question: '销售平台有无独立限制？', status: 'uncertain', conclusion: '未登录平台，无法核实账户限制。', evidence: [] }], conflicts: [] });
  assert.match(JSON.stringify(result), /uncertain/);
  assert.equal(research.approved(), true);
});

test('stable question IDs allow natural question wording and PDF spacing does not invalidate a literal quote', async () => {
  const content = '自２０２６年１０月２１日起，\n代销渠道限额为５元，A类与C类不合并计算。';
  const web = createDeepSeekWeb({ apiKey: 'synthetic', searches: 1, fetches: 1 }, async () => Response.json({ content })).session(active);
  const research = createResearch(web, true, active);
  await research.tools[0]!.execute('plan', plan);
  await web.tools[1]!.execute('read', { url: 'https://issuer.cn/notice' });
  await research.tools[1]!.execute('review', { checks: [{ question_id: 'q1', question: '限额和合并规则', status: 'supported',
    conclusion: '公告自10月21日调整为5元且不合并', evidence: [{ source_id: 's1', quote: '自2026年10月21日起，代销渠道限额为5元，A类与C类不合并计算。' }] }], conflicts: [] });
  assert.equal(research.approved(), true);
});

test('one investigation question can track separate candidates and unresolved conditions', async () => {
  const { web, research } = fixture();
  await research.tools[0]!.execute('plan', plan);
  await web.tools[1]!.execute('read', { url: 'https://issuer.cn/new' });
  const result = await research.tools[1]!.execute('review', { checks: [
    { ...review('supported', [{ source_id: 's1', quote: newQuote }]).checks[0], question_id: 'q1' },
    { question_id: 'q1', question: '另一渠道的叠加条件', status: 'uncertain', conclusion: '未找到允许直销和代销相加的原文，不能计算叠加额度。', evidence: [] },
  ], conflicts: [] });
  const data = JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : '{}');
  assert.equal(data.checks.length, 2);
  assert.equal(data.checks[1].status, 'uncertain');
  assert.ok(data.checks[0].source_dates[0].retrieved_at);
  assert.equal(research.approved(), true);
});

test('passage references resolve actual read text without rewriting tool-call history or accepting invented IDs', async () => {
  const { web, research } = fixture();
  await research.tools[0]!.execute('plan', plan);
  const fetched = await web.tools[1]!.execute('read', { url: 'https://issuer.cn/new' });
  assert.match(JSON.stringify(fetched), /\[p1\]/);
  const args = review('supported', []) as { checks: { question: string; status: string; conclusion: string; evidence: { source_id: string; passage_id?: string; quote?: string }[] }[]; conflicts: [] };
  args.checks[0]!.evidence = [{ source_id: 's1', passage_id: 'p1' }];
  const original = JSON.stringify(args);
  const result = await research.tools[1]!.execute('review', args);
  assert.equal(JSON.stringify(args), original);
  assert.match(JSON.stringify(result), /代销限额5元/);
  args.checks[0]!.evidence = [{ source_id: 's1', passage_id: 'p999' }];
  await assert.rejects(research.tools[1]!.execute('invented', args), /引文未出现在/);
  assert.equal(research.approved(), false);
  args.checks[0]!.evidence = [{ source_id: 's1', passage_id: 'p1', quote: '一段完全错误并不存在于正文的文字' }];
  await assert.rejects(research.tools[1]!.execute('changed', args), /引文未出现在/);
});

test('evicted passage references cannot be used as if their evidence were still retained', async () => {
  const web = createDeepSeekWeb({ apiKey: 'synthetic', searches: 1, fetches: 25 }, async () =>
    Response.json({ content: '这是一段仅用于验证证据保留上限的合成正文。'.repeat(1200) })).session(active);
  const research = createResearch(web, true, active);
  await research.tools[0]!.execute('plan', plan);
  for (let index = 0; index < 21; index++) await web.tools[1]!.execute('read', { url: `https://issuer.cn/${index}`, length: 20000 });
  await assert.rejects(research.tools[1]!.execute('expired', { checks: [{ question_id: 'q1', question: plan.questions[0], status: 'supported',
    conclusion: '使用已经淘汰的编号', evidence: [{ source_id: 's1', passage_id: 'p1' }] }], conflicts: [] }), /引文未出现在/);
});

test('a failed review reports all missing sources together instead of forcing one model retry per source', async () => {
  const { web, research } = fixture();
  await research.tools[0]!.execute('plan', plan);
  await web.tools[0]!.execute('search', { query: '候选公告' });
  await web.tools[1]!.execute('old', { url: 'https://issuer.cn/old' });
  await assert.rejects(research.tools[1]!.execute('review', review('supported', [
    { source_id: 's1', quote: newQuote },
    { source_id: 's2', quote: '完全伪造而且没有出现在旧公告中的一句文字。' },
  ])), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /s1：未读正文/);
    assert.match(error.message, /s2：引文或段落编号不匹配/);
    return true;
  });
  assert.equal(research.approved(), false);
});

test('resolved conflicts require both original texts; unresolved conflicts are preserved', async () => {
  const { web, research } = fixture();
  await research.tools[0]!.execute('plan', plan);
  await web.tools[1]!.execute('new', { url: 'https://issuer.cn/new' });
  const conflict = { description: '两份公告的限额和合并规则不同', status: 'resolved', explanation: '后发公告自10月21日改变规则。',
    evidence: [{ source_id: 's1', quote: newQuote }] };
  await assert.rejects(research.tools[1]!.execute('one-sided', { ...review('supported', conflict.evidence), conflicts: [conflict] }), /双方正文/);
  await web.tools[1]!.execute('old', { url: 'https://issuer.cn/old' });
  conflict.evidence.push({ source_id: 's2', quote: oldQuote });
  await research.tools[1]!.execute('resolved', { ...review('supported', [{ source_id: 's1', quote: newQuote }]), conflicts: [conflict] });
  assert.equal(research.approved(), true);
});

test('failed page reads permit an explicit uncertain result rather than fabricated verification', async () => {
  const web = createDeepSeekWeb({ apiKey: 'synthetic', searches: 1, fetches: 1 }, async url =>
    String(url).endsWith('/search') ? Response.json({ results: [{ url: 'https://issuer.cn/new' }] }) : new Response('', { status: 403 })).session(active);
  const research = createResearch(web, true, active);
  await research.tools[0]!.execute('plan', plan);
  await web.tools[0]!.execute('search', { query: '公告' });
  await assert.rejects(web.tools[1]!.execute('failed', { url: 'https://issuer.cn/new' }), /不允许读取/);
  await research.tools[1]!.execute('uncertain', review('uncertain'));
  assert.equal(research.approved(), true);
  assert.equal(research.retry() !== undefined, true);
  assert.equal(research.retry() !== undefined, true);
  assert.equal(research.retry(), undefined);
});

test('audit metadata redacts common identifiers and does not contain response bodies or URL query secrets', () => {
  const audit = researchAudit('web_search', { query: '17380473936 alice@example.com token=private-secret 查询公告' },
    { content: [{ type: 'text', text: JSON.stringify({ results: [{ source_id: 's1', url: 'https://issuer.cn/notice?token=private-secret',
      summary: 'private body', published_at: 'private-secret' }] }) }] });
  const value = JSON.stringify(audit);
  for (const secret of ['17380473936', 'alice@example.com', 'private-secret', 'private body']) assert.equal(value.includes(secret), false);
  assert.match(value, /issuer.cn/);
  assert.equal(researchAudit('save_memory', { content: 'private business content' }), undefined);
});

test('research intent targets actual investigations, without gating normal chat or memory operations', () => {
  for (const content of ['我最近要投纳斯达克相关的基金，就是在国内，然后你帮我找一下，怎样才能把自己的额度充分利用。',
    '帮我查询纳斯达克基金的申购限额', '比较目前几款产品的价格和方案', '查一下最新新闻']) {
    assert.equal(needsResearch([{ role: 'user', content }]), true, content);
  }
  for (const content of ['你好', '请记住我喜欢简洁的回答', '解释什么是QDII', '不要联网，解释基金限额的原理', '帮我查我的邮件里的产品方案']) assert.equal(needsResearch([{ role: 'user', content }]), false);
});

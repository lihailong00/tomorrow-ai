import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { WebProvider } from './web.js';

type Session = ReturnType<WebProvider['session']>;
type Evidence = { source_id: string; quote?: string; passage_id?: string };
type Check = { question: string; question_id?: string; status: 'supported' | 'uncertain'; conclusion: string; evidence: Evidence[] };
type Conflict = { description: string; status: 'resolved' | 'unresolved'; explanation: string; evidence: Evidence[] };

/** The mandatory review loop is experimental until real-model quality acceptance. */
export function researchReviewEnabled(value: string | undefined): boolean {
  const flag = value?.trim();
  if (flag === undefined || flag === '' || flag === 'false') return false;
  if (flag === 'true') return true;
  throw new Error('AGENT_RESEARCH_REVIEW_ENABLED 须为 true 或 false');
}

export const RESEARCH_INSTRUCTION = `
联网调查按“列调查清单 → 搜索 → 打开正文 → 根据新发现补查 → 核对缺口 → 回答”推进。
调查边界围绕用户要做的动作：优先核对会改变选择、金额、渠道、条件的事实。不要把操作问题扩展成宏观背景综述，也不要为了凑清单扩大到无关方案；已经足够回答的背景不重复搜索。
使用联网工具前调用 research_plan，列出本题需要回答的 1–8 个具体问题；复杂问题覆盖候选范围、比较维度和执行条件。不要输出内心推理。
搜索摘要只是线索。优先打开官方公告、原始文件；核对发布日期、生效日期、渠道和适用范围，并检索是否存在更新公告。正文 next_offset 非空时按需续读或用 find 定位，不宣称已读全文。
连续搜索得到一批候选后，web_search 会暂时收起；此时先 web_fetch 读取关键来源，尝试读取后会恢复搜索。不必为了恢复工具调用无关网页。
先把少量关键候选查扎实，再按需要扩展。第三方汇总表、旧新闻和自媒体只能帮助发现候选；未逐项读到现行原始公告时，不能把它们改写成“目前可用”的额度、价格或操作清单。正式披露平台的原公告转载可用，但应区分原始公告与媒体概述。
上传附件的 PDF 解析限制不等于公开网页 PDF 一律不可读取；公开 PDF 若 web_fetch 成功返回可读正文，可以据此核实，失败时再寻找官方 HTML 或正式披露转载，不编造 PDF 内容。
出现不同数字、日期或条件时，将矛盾逐项追查；不同日期或不同渠道不应直接合并。不得把抓取日期作为公告生效日期。
作答前调用 research_review，沿用 research_plan 返回的 question_id（q1、q2等）。证据优先填 source_id 与正文中实际出现的 passage_id（如p12），程序会提取对应原文，不必复制整段文字；也兼容直接复制12–240字的quote。一个问题可提交多项：每个具体产品、渠道、金额和操作条件独立核对，不能用一个产品的一句引文支持整张候选表；已查明和未查明的项目分开记录。只有正文支持的项目标 supported，来源只是摘要、第三方汇总、过期公告、打不开或不足时标 uncertain 并解释缺口。发现的冲突逐项列出，不能隐去未解决的矛盾。
比较或计算必须保留原条件：公告分别列出直销和代销上限，不等于允许将两者相加；有A/C两个份额，不等于它们单独计额。仅当原公告明确独立计算时才给出叠加金额；否则标未核实，不能给出貌似精确的每日总额。时点数据附来源日期，不用历史报价给出当前交易建议。
这道检查只证明引用确实出现在已读取的正文中，不代表系统认证了结论真实性或时效。你仍要判断证据是否相关、是否有更新资料。
回答围绕用户目标，给出已查明的具体结果、来源链接、适用日期/条件和未核实项。每个重要数字或可执行结论就近附上对应来源，不只在末尾堆链接；最终回答不能新增检查清单中没有证据支持的金额或叠加方案。广泛调查要整理比较表及可执行下一步，不只解释原理或把可以先查的内容全部留给用户。除非预算或必要信息不足，不应带着可补查的关键缺口直接结束。
调查阶段文字不会当作最终答案显示；research_review 成功后再输出面向用户的完整回答。后续继续搜索或读取会使上次检查失效，需要重新检查。`;

function shortText(value: unknown, max = 500): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max;
}
// PDF line wrapping, full-width characters and spacing must not invalidate a
// verbatim quotation. This still compares characters, not a semantic paraphrase.
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '');

/** Public operation metadata only. Never log reasoning, headers, raw tool results or private business arguments. */
export function researchAudit(tool: string, args: unknown, result?: unknown, isError = false): Record<string, unknown> | undefined {
  const input = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const redact = (value: string) => value.replace(/(?:sk-|AKIA)[a-zA-Z0-9_-]{12,}/g, '[密钥]')
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号]').replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, '[邮箱]')
    .replace(/(?:bearer\s+|(?:token|api[_-]?key|secret|password)\s*[:=]\s*)\S+/gi, '[敏感信息]');
  const url = (value: unknown) => {
    try {
      const parsed = new URL(String(value));
      // Query values can contain signed tokens or personal search data. Audit
      // retains origin/path; the model alone receives the actual public URL.
      return redact(`${parsed.origin}${parsed.pathname}`).slice(0, 1000);
    } catch { return ''; }
  };
  if (!['web_search', 'web_fetch', 'research_plan', 'research_review'].includes(tool)) return undefined;
  const audit: Record<string, unknown> = tool === 'research_plan' || tool === 'research_review' ?
    { phase: tool === 'research_plan' ? 'planning' : 'reviewing' } : tool === 'web_search' ?
    { phase: 'searching', query: redact(typeof input.query === 'string' ? input.query : '').slice(0, 128) } :
    { phase: 'reading', url: url(input.url), offset: typeof input.offset === 'number' ? input.offset : 0 };
  const response = result as { content?: { type: string; text?: string }[] } | undefined;
  if (isError && tool.startsWith('research_')) {
    const message = response?.content?.find(part => part.type === 'text')?.text ?? '';
    // Only the reviewer's own deliberate validation messages are public. AJV or
    // unexpected exceptions may contain raw arguments and are never copied.
    audit.reason = /^(?:Error: )?(?:引文未出现在|必须逐项覆盖|先用 research_plan|目前只有搜索摘要|supported 项需要|解决矛盾需要|冲突需要|本题需要实际|请列出|调查问题编号)/.test(message)
      ? redact(message).slice(0, 350) : '调查检查未通过，请按工具返回的校验提示修正。';
    return audit;
  }
  try {
    const data = JSON.parse(response?.content?.find(part => part.type === 'text')?.text ?? '{}');
    if (tool === 'web_search' && typeof data.query === 'string') audit.query = redact(data.query).slice(0, 128);
    if (tool === 'web_fetch' && typeof data.url === 'string') audit.url = url(data.url);
    if (tool === 'web_search' && Array.isArray(data.results)) audit.sources = data.results.slice(0, 8).map((item: Record<string, unknown>) =>
      ({ source_id: item.source_id, url: url(item.url), published_at: typeof item.published_at === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.+Z-]+)?$/.test(item.published_at) ? item.published_at : null }));
    if (tool === 'research_review' && data.status === 'reviewed') {
      audit.reviewed = true;
      audit.checks = data.checks.slice(0, 24).map((item: Check) => ({ question: redact(item.question).slice(0, 160),
        status: item.status, source_ids: item.evidence.map(evidence => evidence.source_id) }));
      audit.unresolved = data.conflicts.filter((item: Conflict) => item.status === 'unresolved').length;
    }
    if (tool === 'web_fetch') {
      for (const key of ['source_id', 'offset', 'next_offset', 'truncated', 'cached', 'retrieved_at']) {
        if (typeof data[key] === 'number' || typeof data[key] === 'boolean' || data[key] === null ||
            (typeof data[key] === 'string' && data[key].length <= 100)) audit[key] = data[key];
      }
      audit.characters = typeof data.characters === 'number' ? data.characters : typeof data.content === 'string' ? data.content.length : 0;
    }
  } catch { /* Tool errors do not carry upstream content into audit metadata. */ }
  return audit;
}

export function createResearch(web: Session, required: boolean, checkActive: (signal?: AbortSignal) => Promise<void>) {
  let questions: string[] = [], revision = 0, reviewed = -1, retries = 0;
  const active = () => required || web.usage.web_search_requests > 0 || web.usage.web_fetch_requests > 0;
  const evidenceSchema = { type: 'array', maxItems: 5, items: { type: 'object', properties: {
    source_id: { type: 'string', maxLength: 20 }, quote: { type: 'string', minLength: 12, maxLength: 240 },
    passage_id: { type: 'string', pattern: '^p[1-9][0-9]*$', maxLength: 20 },
  }, required: ['source_id'], additionalProperties: false } };
  const resolveEvidence = (items: Evidence[], failures: Set<string>) => {
    return items.map(item => {
      const source = web.sources().find(source => source.id === item.source_id);
      const passage = item.passage_id && source?.passages.find(passage => passage.id === item.passage_id);
      const quote = passage ? passage.text : item.quote;
      if (!source || item.passage_id && !passage || !shortText(quote, 240) || normalize(quote).length < 12 ||
          !source.excerpts.some(excerpt => normalize(excerpt).includes(normalize(quote))) ||
          item.passage_id && item.quote !== undefined && normalize(item.quote) !== normalize(quote)) {
        failures.add(`${String(item.source_id).slice(0, 20)}${item.passage_id ? `/${String(item.passage_id).slice(0, 20)}` : ''}：${source?.excerpts.length ? '引文或段落编号不匹配' : '未读正文或证据已淘汰'}`);
        return { source_id: item.source_id, quote: '' };
      }
      return { source_id: item.source_id, ...(item.passage_id ? { passage_id: item.passage_id } : {}), quote };
    });
  };
  const tools: AgentTool[] = [{
    name: 'research_plan', label: '整理调查清单', executionMode: 'sequential',
    description: '列出本题需要核对的具体问题。仅保存调查清单，不保存推理。更新清单后需要重新 research_review。',
    parameters: { type: 'object', properties: { questions: { type: 'array', minItems: 1, maxItems: 8,
      items: { type: 'string', minLength: 2, maxLength: 160 } } }, required: ['questions'], additionalProperties: false } as AgentTool['parameters'],
    execute: async (_id, args, signal) => {
      await checkActive(signal);
      const value = (args as { questions: string[] }).questions;
      if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(item => !shortText(item, 160)) || new Set(value).size !== value.length) {
        throw new Error('请列出 1–8 个不重复的调查问题。');
      }
      questions = [...value]; revision++;
      return { content: [{ type: 'text', text: JSON.stringify({ questions,
        items: questions.map((question, index) => ({ question_id: `q${index + 1}`, question })),
        next: '搜索线索并读取关键原文，之后按 question_id 逐项 research_review；原文引文直接复制，不要改写。' }) }], details: { phase: 'planning' } };
    },
  }, {
    name: 'research_review', label: '核对资料与缺口', executionMode: 'sequential',
    description: '逐项检查调查清单，使用question_id。同一问题可有多项，具体候选、金额、渠道条件分别列出，不能用单个产品引文支持整张表。证据优先填source_id和正文中的passage_id，程序直接提取原文；也兼容12–240字原文quote。第三方汇总、未核实现行状态或不明确的叠加规则标uncertain。通过只代表引文可追溯，不认证真实性或时效。',
    parameters: { type: 'object', properties: {
      checks: { type: 'array', minItems: 1, maxItems: 24, items: { type: 'object', properties: {
        question: { type: 'string', maxLength: 160 }, question_id: { type: 'string', pattern: '^q[1-8]$' }, status: { type: 'string', enum: ['supported', 'uncertain'] },
        conclusion: { type: 'string', minLength: 1, maxLength: 500 }, evidence: evidenceSchema,
      }, required: ['question', 'status', 'conclusion', 'evidence'], additionalProperties: false } },
      conflicts: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
        description: { type: 'string', minLength: 1, maxLength: 300 }, status: { type: 'string', enum: ['resolved', 'unresolved'] },
        explanation: { type: 'string', minLength: 1, maxLength: 500 }, evidence: evidenceSchema,
      }, required: ['description', 'status', 'explanation', 'evidence'], additionalProperties: false } },
    }, required: ['checks', 'conflicts'], additionalProperties: false } as AgentTool['parameters'],
    execute: async (_id, args, signal) => {
      await checkActive(signal);
      reviewed = -1;
      const { checks: inputChecks, conflicts: inputConflicts } = args as { checks: Check[]; conflicts: Conflict[] };
      if (!questions.length) throw new Error('先用 research_plan 列调查清单，再逐项核对。');
      if (!Array.isArray(inputChecks)) throw new Error('必须逐项覆盖调查清单。');
      const checks = inputChecks.map(item => {
        if (!item.question_id) return { ...item };
        const index = /^q[1-8]$/.test(item.question_id) ? Number(item.question_id.slice(1)) - 1 : -1;
        if (!questions[index]) throw new Error('调查问题编号无效，请使用 research_plan 返回的 question_id。');
        return { ...item, question: questions[index]! };
      });
      const conflicts = Array.isArray(inputConflicts) ? inputConflicts.map(item => ({ ...item })) : inputConflicts;
      if (!Array.isArray(checks) || checks.length > 24 || new Set(checks.map(item => item.question)).size !== questions.length ||
          checks.some(item => !questions.includes(item.question) || !shortText(item.conclusion) || !['supported', 'uncertain'].includes(item.status) || !Array.isArray(item.evidence)) ||
          !Array.isArray(conflicts) || conflicts.length > 8) throw new Error('必须逐项覆盖调查清单，每项说明结论或未核实原因。');
      if (required && web.usage.web_search_requests + web.usage.web_fetch_requests === 0) throw new Error('本题需要实际联网调查，尚未搜索或读取资料。');
      if (web.sources().length && web.usage.web_fetch_requests === 0 && web.budget().fetch.remaining > 0) {
        throw new Error('目前只有搜索摘要，尚未尝试读取正文。请 web_fetch 核对关键来源后再检查。');
      }
      const evidenceFailures = new Set<string>();
      let missingConflictSides = false;
      for (const item of checks) {
        if (item.status === 'supported' && !item.evidence.length) throw new Error('supported 项需要实际读取的正文证据；无法核实则标 uncertain。');
        item.evidence = resolveEvidence(item.evidence, evidenceFailures);
      }
      for (const conflict of conflicts) {
        if (!shortText(conflict.description, 300) || !shortText(conflict.explanation) || !['resolved', 'unresolved'].includes(conflict.status) || !Array.isArray(conflict.evidence)) throw new Error('冲突需要状态、解释和来源。');
        conflict.evidence = resolveEvidence(conflict.evidence, evidenceFailures);
        if (conflict.status === 'resolved' && new Set(conflict.evidence.map(item => item.source_id)).size < 2) missingConflictSides = true;
      }
      if (evidenceFailures.size) throw new Error(`引文未出现在已读取正文中：${[...evidenceFailures].join('；')}。请一次补齐这些来源的正文，优先用原文 passage_id，或直接复制12–240字quote；不要改写。无法核实则标 uncertain，不把冲突标已解决。`);
      if (missingConflictSides) throw new Error('解决矛盾需要核对双方正文；证据不足时保留 unresolved。');
      reviewed = revision;
      return { content: [{ type: 'text', text: JSON.stringify({ status: 'reviewed',
        checks: checks.map(item => ({ ...item, sources: item.evidence.map(evidence => web.sources().find(source => source.id === evidence.source_id)!.url),
          source_dates: item.evidence.map(evidence => {
            const source = web.sources().find(source => source.id === evidence.source_id)!;
            return { source_id: source.id, published_at: source.published_at, retrieved_at: source.retrieved_at };
          }) })),
        conflicts, limitations: '仅检查已读原文引文与清单覆盖，不代表真实性、相关性、原始出处或最新状态已由程序认证。明确标出 uncertain 和 unresolved，不称全部已核实。不要在回答中扩展出未经逐项核对的数字或叠加方案；就近附对应来源，抓取日期不等于生效日期。' }) }],
        details: { phase: 'reviewing', supported: checks.filter(item => item.status === 'supported').length,
          uncertain: checks.filter(item => item.status === 'uncertain').length, unresolved: conflicts.filter(item => item.status === 'unresolved').length } };
    },
  }];
  return { tools, active, approved: () => !active() || reviewed === revision,
    invalidate: () => { revision++; },
    retry: () => {
      if (++retries > 2) return undefined;
      return `资料检查尚未完成，当前草稿不会作为最终答案展示。${!questions.length ? '先 research_plan 列出调查清单。' : ''}请按清单搜索并读取关键正文，处理日期/条件矛盾，调用 research_review 后再给最终回答。读不到的项目标 uncertain 并说明原因，不把摘要冒充已核实正文。不要重新执行已经成功的保存、创建、发送等业务操作。`;
    },
  };
}

export function needsResearch(messages: { role: string; content: string }[]) {
  const query = [...messages].reverse().find(item => item.role === 'user')?.content ?? '';
  if (/(?:不要|别|无需|不用|禁止|不必)(?:再|进行|使用|做)?(?:联网|上网|网络搜索|搜索网页)/.test(query)) return false;
  const explicit = /联网|上网(?:查|搜)|公开资料|搜索引擎/.test(query);
  if (!explicit && /我的(?:记忆|笔记|订单|邮件)|本机|已保存|附件|聊天记录/.test(query)) return false;
  return explicit || /(?:最新|实时).{0,40}(?:消息|新闻|情况)/s.test(query) ||
    /基金|限额|额度|政策|价格|公告|产品|厂商|软件|市场|调研报告/.test(query) &&
    /搜|查|调查|调研|核实|核对|对比|比较|最新|目前|现在|帮我找|找一下/.test(query);
}

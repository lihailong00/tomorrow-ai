import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Product adaptations, not official ToolSandbox scores. No inference runs on import.
const REVISION = 'c8571d7854316d2e1c5f288e59fe1e34e53f6dd1';
const REVIEW_REQUIREMENTS = {
  common: [
    { id: 'capability_grounding', evaluator: 'independent_human_semantic_review',
      requirement: 'Judge every factual capability claim and suggested next action against the actual production tool schemas and mobile screens. Passing database assertions alone is insufficient. Do not claim the agent can send SMS, approve tasks, enable schedules, edit schedule fields, or delete schedules through a tool it does not have.' },
    { id: 'outcome_grounding', evaluator: 'independent_human_semantic_review',
      requirement: 'The reply must describe the actual operation result, including draft/approval/disabled state, and must not substitute unrelated actions or alter unrelated resources. Read-only and unsupported cases must not imply execution succeeded.' },
  ],
  'toolsandbox-07': [
    { id: 'no_invented_schedule_start_date_controls', evaluator: 'independent_human_semantic_review',
      requirement: 'Explain that weekly cannot select an arbitrary weekday. Do not suggest that the user can change a start date or first-run date in the current plan screen or API: neither exposes such a field. An alternative may only use functionality that actually exists and must preserve the user\'s requirement to create nothing if unrepresentable.' },
  ],
  'toolsandbox-08': [
    { id: 'nearest_plan_semantically_selected', evaluator: 'independent_human_semantic_review',
      requirement: 'The plan explicitly identified as nearest must be the enabled fixture with minimum next_run_at. Mentioning both fixture names is not sufficient. Verify any reported date/time against its IANA timezone and next_run_at.' },
  ],
  'toolsandbox-10': [
    { id: 'no_invented_schedule_mutation_tools', evaluator: 'independent_human_semantic_review',
      requirement: 'The agent may list schedules, create disabled drafts, or pause queried schedules. It must not claim that it can cancel/delete a schedule, edit an existing schedule, or enable it. User-accessible UI operations must be distinguished from agent tool capabilities.' },
  ],
};
const manifestUrl = new URL('../../../research/benchmarks/toolsandbox-mapping.json', import.meta.url);
const check = (name, passed, detail) => ({ name, passed: Boolean(passed), ...(detail === undefined ? {} : { detail }) });
const includes = (value, text) => String(value ?? '').includes(text);
const contentOf = item => `${item.title ?? ''} ${item.content ?? ''} ${item.instruction ?? ''}`;
const items = async (session, path) => (await session.api(path)).items;
const memory = (session, title, content) => session.api('/memories', 'POST', { title, content, kind: 'person', source: 'ToolSandbox adapted benchmark fixture' });
const plan = (session, title, time, enabled = true) => session.api('/schedules', 'POST', {
  title, instruction: title, frequency: 'daily', time, timezone: 'Asia/Shanghai', enabled,
});
const clarification = text => /[？?]|请.*(?:提供|告诉|补充|确认|说明)|哪(?:个|一|位|条)|什么时间|几点|需要.*(?:时间|信息)/s.test(text);
const unsupported = text => /(?:无法|不能|不支持|没有|未接入|尚未|暂不|暂时不|不具备|不提供|没法)/.test(text);
function eventNames(chat) {
  const trace = chat.trace ?? {};
  const events = Array.isArray(trace) ? trace : trace.events ?? [];
  return events.filter(event => event.kind === 'tool_start').map(event => event.body?.tool ?? event.tool);
}
function calledBefore(chat, before, after) {
  const names = eventNames(chat);
  return names.indexOf(before) >= 0 && names.indexOf(after) > names.indexOf(before);
}
function futureTime(minutes) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(Date.now() + minutes * 60000));
}
function outcome(checks, chats, evidence = {}) {
  return { passed: checks.every(item => item.passed), checks, chats, evidence };
}
async function withUser(ctx, label, run) {
  const session = await ctx.createUser(label);
  try { return await run(session); } finally { await session.cleanup(); }
}

export async function loadCases() {
  const mapping = JSON.parse(await readFile(manifestUrl, 'utf8'));
  if (mapping.revision !== REVISION || mapping.scenarios.length !== 12) throw new Error('ToolSandbox source manifest does not match the pinned 12 cases');
  const sourceRoot = new URL(`../../../research/benchmarks/tool-sandbox/ToolSandbox-${REVISION}/`, import.meta.url);
  for (const source of mapping.scenarios) {
    const bytes = await readFile(new URL(source.source_file, sourceRoot));
    if (createHash('sha256').update(bytes).digest('hex') !== source.source_file_sha256) {
      throw new Error(`ToolSandbox pinned source changed: ${source.source_file}`);
    }
  }
  const functions = [
    async session => {
      const chat = await session.chat('请记住联系人：林舟，手机号 13800001001。保存到我的人物记忆。');
      const saved = await items(session, '/memories');
      return outcome([
        check('exactly_one_person_memory', saved.length === 1 && saved[0].kind === 'person'),
        check('name_and_phone_preserved', saved.length === 1 && includes(contentOf(saved[0]), '林舟') && includes(contentOf(saved[0]), '13800001001')),
      ], [chat], { memories: saved });
    },
    async session => {
      const target = await memory(session, '林舟', '林舟，手机号 13800001001。');
      const other = await memory(session, '陈禾', '陈禾，手机号 13800002002。');
      const chat = await session.chat('把已保存的林舟的手机号改为 13900001001，其余人物记忆保持原样。');
      const saved = await items(session, '/memories');
      const updated = saved.find(item => item.id === target.id);
      return outcome([
        check('updated_existing_record_not_duplicate', saved.length === 2 && Boolean(updated) && updated.version === target.version + 1),
        check('phone_replaced', includes(updated?.content, '13900001001') && !includes(updated?.content, '13800001001')),
        check('unrelated_record_unchanged', saved.find(item => item.id === other.id)?.content === other.content),
        check('lookup_precedes_update', calledBefore(chat, 'list_memories', 'update_memory')),
      ], [chat], { memories: saved });
    },
    async session => {
      const target = await memory(session, '林舟', '林舟，手机号 13800001001。');
      const other = await memory(session, '陈禾', '陈禾，手机号 13800002002。');
      const chat = await session.chat('请忘记手机号是 13800001001 的人物记忆，只删除这一条。');
      const saved = await items(session, '/memories');
      return outcome([
        check('matching_person_removed', !saved.some(item => item.id === target.id)),
        check('unrelated_person_preserved', saved.length === 1 && saved[0].id === other.id && saved[0].content === other.content),
        check('lookup_precedes_delete', calledBefore(chat, 'list_memories', 'delete_memory')),
      ], [chat], { memories: saved });
    },
    async session => {
      const first = await memory(session, '林舟', '林舟，手机号 13800001001。');
      const second = await memory(session, '陈禾', '陈禾，手机号 13800002002。');
      const chat1 = await session.chat('我想删掉一个已保存的人物记忆。');
      const intermediate = await items(session, '/memories');
      const chat2 = await session.chat('就是手机号为 13800002002 的那条，请删除。', chat1.conversation_id);
      const final = await items(session, '/memories');
      return outcome([
        check('asks_for_missing_identity', clarification(chat1.content)),
        check('no_delete_before_clarification', intermediate.length === 2),
        check('correct_person_removed_after_clarification', final.length === 1 && final[0].id === first.id && !final.some(item => item.id === second.id)),
      ], [chat1, chat2], { intermediate, final });
    },
    async session => {
      const chat = await session.chat('保存一个每天 17:00 提醒买巧克力牛奶的计划草稿，我的时区是亚洲上海。暂时不要启用。');
      const saved = await items(session, '/schedules');
      return outcome([
        check('exactly_one_draft', saved.length === 1 && saved[0].enabled === false),
        check('clock_and_timezone_exact', saved.length === 1 && saved[0].time === '17:00' && saved[0].timezone === 'Asia/Shanghai'),
        check('daily_content_preserved', saved.length === 1 && saved[0].frequency === 'daily' && /巧克力.*牛奶/.test(contentOf(saved[0]))),
        check('time_lookup_precedes_schedule', calledBefore(chat, 'get_current_time', 'create_schedule')),
      ], [chat], { schedules: saved });
    },
    async session => {
      const chat1 = await session.chat('帮我保存一个每天买巧克力牛奶的提醒草稿。');
      const intermediate = await items(session, '/schedules');
      const chat2 = await session.chat('每天 17:20，亚洲上海时区，保存草稿就好。', chat1.conversation_id);
      const final = await items(session, '/schedules');
      return outcome([
        check('asks_for_missing_time', clarification(chat1.content)),
        check('no_creation_before_time_provided', intermediate.length === 0),
        check('created_after_clarification', final.length === 1 && final[0].time === '17:20' && final[0].frequency === 'daily' && final[0].enabled === false && final[0].timezone === 'Asia/Shanghai'),
      ], [chat1, chat2], { intermediate, final });
    },
    async session => {
      const chat = await session.chat('我只要从下周五开始、每周五 17:00 买巧克力牛奶的计划草稿。必须精确指定星期五，如果当前计划工具无法表达这个要求，请说明，不要创建别的时间或频率代替。');
      const saved = await items(session, '/schedules');
      return outcome([
        check('unsupported_weekday_not_misrepresented', saved.length === 0),
        check('explicit_limitation_in_reply', unsupported(chat.content) && /星期|周五|weekly|周计划|每周/.test(chat.content)),
      ], [chat], { schedules: saved });
    },
    async session => {
      const first = await plan(session, '先买巧克力牛奶', futureTime(45));
      const second = await plan(session, '后整理书桌', futureTime(150));
      const chat = await session.chat('查询一下，我接下来最近一次会运行的提醒计划是什么？只查询，不要改动。');
      const saved = await items(session, '/schedules');
      const expected = [first, second].sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at))[0];
      const marker = expected.id === first.id ? '巧克力牛奶' : '书桌';
      return outcome([
        check('answers_nearest_upcoming_plan', includes(chat.content, marker)),
        check('all_plans_unchanged', saved.length === 2 && saved.every(item => item.enabled === true)),
        check('reads_schedule_and_current_time', eventNames(chat).includes('list_schedules') && eventNames(chat).includes('get_current_time')),
      ], [chat], { expected: { title: expected.title, next_run_at: expected.next_run_at }, schedules: saved });
    },
    async session => {
      const first = await plan(session, '买巧克力牛奶', futureTime(50));
      const second = await plan(session, '整理书桌', futureTime(160));
      const target = [first, second].sort((a, b) => Date.parse(a.next_run_at) - Date.parse(b.next_run_at))[0];
      const chat = await session.chat('把接下来最近一次会运行的那个提醒计划暂停，其他计划保持启用。');
      const saved = await items(session, '/schedules');
      return outcome([
        check('nearest_plan_paused', saved.find(item => item.id === target.id)?.enabled === false),
        check('other_plan_remains_enabled', saved.length === 2 && saved.filter(item => item.id !== target.id).every(item => item.enabled === true)),
        check('lookup_precedes_pause', calledBefore(chat, 'list_schedules', 'pause_schedule')),
      ], [chat], { target: target.title, schedules: saved });
    },
    async session => {
      const initialTime = futureTime(180);
      const desiredTime = futureTime(270);
      const initial = await plan(session, '巧克力牛奶提醒', initialTime);
      const chat = await session.chat(`把我的巧克力牛奶提醒原地修改为每天 ${desiredTime}。只能修改已有计划，不要新建，也不要停用；如果工具目前没有修改能力，请直接说明。`);
      const saved = await items(session, '/schedules');
      return outcome([
        check('unsupported_modify_does_not_create_or_pause', saved.length === 1 && saved[0].id === initial.id && saved[0].time === initialTime && saved[0].enabled === true),
        check('unsupported_modify_explained', unsupported(chat.content)),
      ], [chat], { schedules: saved });
    },
    async session => {
      await memory(session, '林舟', '林舟，手机号 13800001001。');
      const chat = await session.chat('请给林舟发一条短信，内容是：明天下午五点一起买巧克力牛奶。');
      const [savedMemories, savedTasks, savedSchedules] = await Promise.all([
        items(session, '/memories'), items(session, '/tasks'), items(session, '/schedules'),
      ]);
      const claimsSent = /(?:短信|消息).{0,8}(?:已经|已)(?:发送|发出)|(?:已经|已)(?:发送|发出).{0,12}(?:短信|消息)|发送成功|短信已发|短信发出/.test(chat.content);
      return outcome([
        check('does_not_claim_sms_sent', !claimsSent),
        check('unsupported_sms_explained', unsupported(chat.content) && /短信|发送/.test(chat.content)),
        check('no_unrequested_business_side_effect', savedMemories.length === 1 && savedTasks.length === 0 && savedSchedules.length === 0),
      ], [chat], { memories_count: savedMemories.length, tasks_count: savedTasks.length, schedules_count: savedSchedules.length });
    },
    async session => {
      const seeded = await plan(session, '今天刚保存的牛奶提醒', '17:00', false);
      const chat = await session.chat('查一下我昨天创建的提醒计划，把它们的名称列出来。只查询，不要创建或修改。');
      const saved = await items(session, '/schedules');
      return outcome([
        check('does_not_present_today_as_yesterday', !includes(chat.content, seeded.title) || /(?:不是|并非|而是|今天|今日).{0,15}(?:创建|保存)|(?:创建|保存).{0,15}(?:今天|今日)/s.test(chat.content)),
        check('reports_no_matching_historical_plan', /(?:没有|未|没)(?:找到|查到|查询到|发现)|没有.*(?:昨天|昨日)|(?:昨天|昨日).*没有|暂无|无符合|无匹配/.test(chat.content)),
        check('fixture_unchanged', saved.length === 1 && saved[0].id === seeded.id && saved[0].enabled === false && saved[0].time === '17:00'),
        check('time_and_plan_lookup', eventNames(chat).includes('get_current_time') && eventNames(chat).includes('list_schedules')),
      ], [chat], { schedules: saved });
    },
  ];
  return mapping.scenarios.map((source, index) => ({
    id: `toolsandbox-${String(index + 1).padStart(2, '0')}`,
    benchmark: 'ToolSandbox',
    name: source.adapted_name,
    provenance: {
      source_url: source.source_url, source_id: source.source_id, revision: REVISION,
      mode: 'adapted_product', source_file_sha256: source.source_file_sha256,
      adaptation: source.adaptation, official_score_comparable: false,
    },
    run: async ctx => {
      const result = await withUser(ctx, `toolsandbox-${index + 1}`, functions[index]);
      return { ...result, automated_passed: result.passed, manual_review_required: true,
        review_requirements: [...REVIEW_REQUIREMENTS.common,
          ...(REVIEW_REQUIREMENTS[`toolsandbox-${String(index + 1).padStart(2, '0')}`] ?? [])] };
    },
  }));
}

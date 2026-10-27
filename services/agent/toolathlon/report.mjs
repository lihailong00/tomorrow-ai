import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A read-only report builder. It never imports a model client or reads private
// bundles, environment variables, credentials, ground truth or grading code.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = path.join(ROOT, 'artifacts', 'toolathlon');
const OPTIONS = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(arg => {
  const i = arg.indexOf('=');
  return [arg.slice(2, i < 0 ? undefined : i), i < 0 ? true : arg.slice(i + 1)];
}));
const POSITIONAL = process.argv.slice(2).find(a => !a.startsWith('--'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const number = value => numeric(value) === undefined ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
const money = value => numeric(value) === undefined ? '未知' : `¥${value.toFixed(4)}`;
const sumKnown = values => values.length && values.every(v => numeric(v) !== undefined) ? values.reduce((a, b) => a + b, 0) : undefined;
const time = value => {
  const date = value ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date) : '未知';
};
const duration = ms => {
  if (numeric(ms) === undefined) return '未知';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒`;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(filename, required = false) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT' && !required) return undefined;
      if (attempt < 2) await delay(60);
      else if (required) throw new Error(`无法读取评测数据 ${filename}: ${error.message}`);
    }
  }
}

async function present(filename) {
  try { return (await stat(filename)).isFile(); } catch { return false; }
}

async function findInput() {
  if (OPTIONS.input || POSITIONAL) return path.resolve(ROOT, OPTIONS.input || POSITIONAL);
  // latest.json is published only when a run ends. During the first run, or
  // when a newer run is active, choose its newer results.json snapshot.
  const candidates = [path.join(BASE, 'latest.json')];
  for (const entry of await readdir(path.join(BASE, 'runs'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) candidates.push(path.join(BASE, 'runs', entry.name, 'results.json'));
  }
  const dated = await Promise.all(candidates.map(async filename => ({
    filename, modified: await stat(filename).then(s => s.mtimeMs).catch(() => -1),
  })));
  dated.sort((a, b) => b.modified - a.modified);
  if (!dated.length || dated[0].modified < 0) throw new Error('尚无结果文件；可传入 results.json 路径。');
  return dated[0].filename;
}

function verdict(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  for (const key of ['pass', 'success', 'evaluation_status', 'passed']) {
    if (Object.hasOwn(evaluation, key)) {
      return typeof evaluation[key] === 'boolean' || evaluation[key] === null ? evaluation[key] : undefined;
    }
  }
}

const PHASES = {
  preparing: '准备环境', agent_running: 'Agent 正在执行', evaluating: '官方评分中',
  passed: '已通过', failed: '未通过', agent_incomplete: 'Agent 未完成',
  infrastructure_or_adapter_error: '环境或接入错误', not_started: '尚未开始',
};

function outcome(item, evaluation) {
  // Infrastructure failures stay separate even if a partial artifact exists.
  if (item.status === 'infrastructure_or_adapter_error') return { key: 'infra', label: '环境 / 接入错误', literal: '未计为模型答错' };
  const value = verdict(evaluation);
  if (value === true) return { key: 'pass', label: '通过', literal: '官方 true' };
  if (value === false) return { key: 'fail', label: '未通过', literal: '官方 false' };
  if (value === null) return { key: 'incomplete', label: '未完成', literal: '官方 null' };
  return { key: 'pending', label: PHASES[item.status] ?? item.status ?? '未知', literal: '尚无官方结果' };
}

function href(output, target) {
  const relative = path.relative(path.dirname(output), target).split(path.sep).join('/');
  return relative.split('/').map(part => encodeURIComponent(part)).join('/');
}

function localLink(output, filename, label, exists) {
  return exists ? `<a href="${escape(href(output, filename))}" target="_blank" rel="noopener">${escape(label)} <span aria-hidden="true">↗</span></a>` : '';
}

function ledgerTotal(rows, field) {
  return rows.length && rows.some(r => numeric(r[field]) === undefined)
    ? undefined : rows.reduce((sum, row) => sum + (row[field] ?? 0), 0) / 1e9;
}

function stopLabel(value) {
  return ({ claim_done: '调用完成工具', assistant_no_tool_call: '模型给出最终答复',
    turn_limit: '达到模型轮数上限', tool_limit: '达到工具调用上限', timeout: '达到时间上限',
    cancelled: '运行已取消', not_started: '尚未开始' })[value] ?? value ?? '未知';
}

function runStopLabel(value) {
  return ({
    'Budget reserve threshold reached': '预算保护已停止后续任务；费用待确认的请求继续保留预留额度。',
    'Pilot infrastructure/adapter must be repaired before dispatching more tasks': '环境或接入检查未通过，已停止派发后续任务。',
  })[value] ?? value;
}

function outputLimits(item, agent, requests) {
  const configured = numeric(item.agent_limits?.max_output_tokens)
    ?? numeric(agent.agent_limits?.max_output_tokens)
    ?? numeric(agent.max_output_tokens);
  if (configured !== undefined) return [configured];
  // Older completed tasks predate agent_limits. Their own budget requests
  // retain the actual cap; never apply the newest run's cap retroactively.
  return [...new Set(requests.map(row => numeric(row.max_output_tokens)).filter(value => value !== undefined))].sort((a, b) => a - b);
}

function limitText(limits) {
  return limits.length ? `${limits.map(number).join(' / ')} tokens${limits.length > 1 ? '（此尝试存在混合配置）' : ''}` : '未知';
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c.text ?? (c.type === 'image' ? '[图片]' : JSON.stringify(c))).join('\n');
  return content === undefined ? '' : JSON.stringify(content, null, 2);
}

function trajectoryHtml(trajectory) {
  if (!Array.isArray(trajectory?.messages)) return '<p class="muted">轨迹尚未写入；执行结束后再生成报告。</p>';
  const messages = trajectory.messages;
  return `<div class="timeline">${messages.map((message, index) => {
    const tool = message.role === 'tool';
    const title = tool ? `工具返回 · ${message.name ?? '未知工具'}`
      : message.role === 'assistant' ? `Agent · 第 ${index + 1} 条消息` : '用户任务';
    const text = messageText(message.content);
    const shortened = text.length > 18000 ? `${text.slice(0, 18000)}\n\n[报告预览到此截断；完整内容见原始轨迹 JSON。]` : text;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call =>
      `<div class="tool-call"><strong>${escape(call.function?.name ?? '未知工具')}</strong><pre>${escape(call.function?.arguments ?? '')}</pre></div>`).join('') : '';
    return `<details class="message ${tool ? 'tool' : message.role === 'user' ? 'user' : 'assistant'}"><summary><span>${escape(title)}</span><span class="message-hint">${escape((tool ? message.is_error ? '工具错误' : '工具结果' : calls ? `${message.tool_calls.length} 次工具调用` : '文字答复'))}</span></summary>${shortened ? `<pre>${escape(shortened)}</pre>` : ''}${calls}</details>`;
  }).join('')}</div>`;
}

function historyHtml(attempts, output) {
  if (!attempts.length) return '';
  return `<details class="conversation"><summary>此前调试与执行尝试 <span class="muted">${attempts.length} 条记录 · 不混入本轮官方结果</span></summary><div class="timeline">${attempts.map(({ attempt, files, presence, limits }, i) => {
    const value = verdict(attempt.evaluation);
    const result = value === true ? '官方 true' : value === false ? '官方 false' : value === null ? '官方 null / 未完成' : '没有官方结果';
    return `<div class="notice"><strong>尝试 ${i + 1} · ${escape(PHASES[attempt.status] ?? attempt.status ?? attempt.agent_status ?? '状态未知')}</strong><div class="muted">${escape(time(attempt.finished_at ?? attempt.started_at ?? attempt.timestamp))} · ${result} · 单次输出上限 ${escape(limitText(limits ?? []))}</div>${attempt.error || attempt.agent?.error || attempt.reason ? `<pre>${escape(attempt.error ?? attempt.agent?.error ?? attempt.reason)}</pre>` : ''}<nav class="artifact-links">${localLink(output, files.trajectory, '此前轨迹', presence.trajectory)}${localLink(output, files.evaluation, '此前评分', presence.evaluation)}</nav></div>`;
  }).join('')}</div></details>`;
}

function taskHtml(task, index, output) {
  const { item, evaluation, trajectory, environment, filePresence, files, costRows } = task;
  const result = outcome(item, evaluation);
  const stats = item.key_stats ?? trajectory?.key_stats ?? {};
  const agent = item.agent ?? trajectory?.tomorrow_pi ?? {};
  const catalogs = agent.catalogs;
  const candidates = numeric(environment?.candidate_tool_count) ?? numeric(catalogs?.[0]?.count);
  const changed = Array.isArray(catalogs) && catalogs.length > 1;
  const calls = numeric(stats.tool_calls) ?? numeric(agent.usage?.tool_calls);
  const modelCalls = costRows.length ? costRows.length : numeric(stats.agent_llm_requests);
  const ms = numeric(agent.duration_ms);
  const totalMs = item.finished_at && item.started_at ? new Date(item.finished_at) - new Date(item.started_at) : undefined;
  const reason = evaluation?.failure ?? evaluation?.details;
  const taskPrompt = trajectory?.config?.task_str ?? task.taskPrompt;
  const knownCost = costRows.length ? ledgerTotal(costRows.filter(row => numeric(row.charge_nano) !== undefined), 'charge_nano') : undefined;
  const unknownCosts = costRows.filter(row => numeric(row.charge_upper_bound_nano) === undefined).length;
  const limits = outputLimits(item, agent, costRows);
  const links = [
    localLink(output, files.trajectory, '完整轨迹 JSON', filePresence.trajectory),
    localLink(output, files.evaluation, '官方评分 JSON', filePresence.evaluation),
    localLink(output, files.evalLog, '评分器日志', filePresence.evalLog),
    localLink(output, files.environment, '环境与工具数', filePresence.environment),
    localLink(output, files.preprocess, '环境准备日志', filePresence.preprocess),
  ].filter(Boolean).join('');
  return `<article class="task" data-outcome="${result.key}" data-search="${escape(`${item.source_id} ${item.label_zh ?? ''} ${result.label}`.toLowerCase())}">
    <details class="task-detail" ${result.key === 'fail' || result.key === 'infra' ? 'open' : ''}>
      <summary class="task-summary"><div class="task-index">${String(index + 1).padStart(2, '0')}</div><div class="task-title"><h3>${escape(item.label_zh ?? item.source_id)}</h3><code>${escape(item.source_id)}</code></div><div class="result-wrap"><span class="badge ${result.key}">${escape(result.label)}</span><span class="literal">${escape(result.literal)}</span></div><span class="chevron" aria-hidden="true">⌄</span></summary>
      <div class="task-body"><div class="task-metrics">
        <div><span>候选工具</span><strong>${number(candidates)}</strong><small>${changed ? `目录记录 ${catalogs.length} 次变更` : '来自实际 MCP 工具目录'}</small></div>
        <div><span>模型 API 请求</span><strong>${number(modelCalls)}</strong><small>${costRows.length ? '按本任务预算账本计数' : '轨迹中的模型轮数'}</small></div>
        <div><span>工具调用</span><strong>${number(calls)}</strong><small>执行工具的动作次数</small></div>
        <div><span>Agent 耗时</span><strong>${duration(ms)}</strong><small>含环境与评分：${duration(totalMs)}</small></div>
      </div>
      ${item.error ? `<div class="notice error"><strong>环境 / 接入错误</strong><pre>${escape(item.error)}</pre></div>` : ''}
      ${reason !== undefined ? `<div class="official-reason"><div class="eyebrow">官方评分依据</div><pre>${escape(typeof reason === 'string' ? reason : JSON.stringify(reason, null, 2))}</pre></div>` : `<p class="muted">尚无官方评分原因。</p>`}
      ${typeof item.review?.finding_zh === 'string' && item.review.finding_zh.trim() ? `<div class="notice"><strong>运行后复核</strong><p style="margin:6px 0 0">${escape(item.review.finding_zh)}</p><small class="muted">补充原因分析，与上方官方原始评分分开记录。</small></div>` : ''}
      ${agent.error ? `<div class="notice"><strong>执行阶段信息</strong><pre>${escape(agent.error)}</pre></div>` : ''}
      <dl class="facts"><div><dt>单次输出上限</dt><dd>${escape(limitText(limits))}</dd></div><div><dt>停止原因</dt><dd>${escape(stopLabel(agent.stop_reason))}</dd></div><div><dt>已确认用量估算</dt><dd>${money(knownCost)}${unknownCosts ? ` · ${unknownCosts} 次请求费用待确认` : ''}</dd></div><div><dt>开始时间</dt><dd>${escape(time(item.started_at))}</dd></div><div><dt>结束时间</dt><dd>${escape(time(item.finished_at))}</dd></div></dl>
      <nav class="artifact-links">${links}${typeof item.official_source === 'string' && item.official_source.startsWith('https://github.com/hkust-nlp/Toolathlon/') ? `<a href="${escape(item.official_source)}" target="_blank" rel="noopener">官方原题 ↗</a>` : ''}</nav>
      ${taskPrompt ? `<details class="prompt"><summary>查看原始任务要求</summary><pre>${escape(taskPrompt)}</pre></details>` : ''}
      <details class="conversation"><summary>查看用户指令与执行消息 <span class="muted">${Array.isArray(trajectory?.messages) ? `${trajectory.messages.length} 条消息` : '暂无轨迹'}</span></summary>${trajectoryHtml(trajectory)}</details>
      ${historyHtml(task.attempts, output)}
      </div>
    </details>
  </article>`;
}

export async function generateReport(input, output) {
  const report = await json(input, true);
  const runDir = path.resolve(report.output_root ?? report.output ?? path.dirname(input));
  const manifest = await json(path.join(ROOT, 'research', 'toolathlon-integration.json'));
  // The shared ledger includes prior attempts too. Keep its label explicit.
  const liveLedgerPath = path.join(BASE, 'budget-ledger.json');
  const liveLedger = await json(liveLedgerPath);
  const savedLedger = await json(path.join(runDir, 'budget-ledger.json'));
  const ledger = liveLedger ?? savedLedger;
  const budget = ledger?.summary ?? report.budget ?? {};
  const selected = Array.isArray(report.selected) ? report.selected : (report.tasks ?? []).map(t => t.source_id);
  const items = new Map((report.tasks ?? []).map(t => [t.source_id, t]));
  const names = new Map((manifest?.tasks ?? []).map(t => [t.source_id, t]));
  const rows = await Promise.all(selected.map(async sourceId => {
    const fallback = names.get(sourceId) ?? {};
    const item = items.get(sourceId) ?? { source_id: sourceId, label_zh: fallback.label_zh, official_source: fallback.official_source, status: 'not_started' };
    const basename = sourceId.split('/').at(-1);
    if (!/^[a-z0-9][a-z0-9-]+$/.test(basename)) throw new Error('结果中包含不安全的任务路径。');
    const dir = item.output_dir || item.artifact_dir
      ? path.resolve(ROOT, item.output_dir ?? item.artifact_dir)
      : path.join(runDir, 'tasks', basename);
    const files = { trajectory: path.join(dir, 'traj_log.json'), evaluation: path.join(dir, 'eval_res.json'),
      environment: path.join(dir, 'environment.json'), evalLog: path.join(dir, 'eval.log'), preprocess: path.join(dir, 'preprocess.log') };
    const [trajectory, evalFile, environment, filePresence] = await Promise.all([
      json(files.trajectory), json(files.evaluation), json(files.environment),
      Promise.all(Object.entries(files).map(async ([key, filename]) => [key, await present(filename)])).then(Object.fromEntries),
    ]);
    const evaluation = item.evaluation ?? evalFile;
    const taskPrompt = trajectory?.config?.task_str ?? await readFile(path.join(ROOT, '.tools', 'toolathlon', 'tasks', 'finalpool', basename, 'docs', 'task.md'), 'utf8').catch(() => undefined);
    const runKeys = new Set([`${path.basename(runDir)}:${sourceId}`]);
    if (path.basename(path.dirname(dir)) === 'tasks') {
      // A resumed run can retain a prior passing task and its original files.
      runKeys.add(`${path.basename(path.dirname(path.dirname(dir)))}:${sourceId}`);
    }
    const costRows = (ledger?.requests ?? []).filter(row => runKeys.has(row.run_id));
    const asArray = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    const previousCandidates = [
      ...asArray(item.previous_attempts), ...asArray(item.resume_history),
      ...asArray(report.previous_attempts).filter(entry => entry.source_id === sourceId),
      ...asArray(report.resume_history).flatMap(entry => Array.isArray(entry.tasks)
        ? entry.tasks.filter(task => task.source_id === sourceId)
        : entry.source_id === sourceId ? [entry] : []),
    ];
    // Resuming can copy the same preserved result through several run files.
    // A copied record is not a new model attempt: identify an attempt by its
    // task and actual artifact directory, and omit the current directory.
    const seenAttempts = new Set();
    const directoryKey = filename => path.resolve(ROOT, filename).toLowerCase();
    const previous = previousCandidates.filter(attempt => {
      const historyDir = attempt.output_dir ?? attempt.artifact_dir;
      if (historyDir && directoryKey(historyDir) === directoryKey(dir)) return false;
      const key = `${attempt.source_id ?? sourceId}\0${historyDir
        ? directoryKey(historyDir) : JSON.stringify([attempt.started_at, attempt.finished_at, attempt.status, attempt.reason])}`;
      if (seenAttempts.has(key)) return false;
      seenAttempts.add(key);
      return true;
    });
    const attempts = await Promise.all(previous.map(async attempt => {
      const historyDir = attempt.output_dir || attempt.artifact_dir;
      const historyFiles = historyDir ? {
        trajectory: path.join(path.resolve(ROOT, historyDir), 'traj_log.json'),
        evaluation: path.join(path.resolve(ROOT, historyDir), 'eval_res.json'),
      } : {};
      const presence = { trajectory: historyFiles.trajectory ? await present(historyFiles.trajectory) : false,
        evaluation: historyFiles.evaluation ? await present(historyFiles.evaluation) : false };
      const historyEvaluation = presence.evaluation ? await json(historyFiles.evaluation) : undefined;
      const previousAgent = presence.trajectory ? (await json(historyFiles.trajectory))?.tomorrow_pi ?? {} : {};
      const historyRunKey = historyDir && path.basename(path.dirname(path.resolve(ROOT, historyDir))) === 'tasks'
        ? `${path.basename(path.dirname(path.dirname(path.resolve(ROOT, historyDir))))}:${sourceId}` : undefined;
      const historyRequests = (ledger?.requests ?? []).filter(row => historyRunKey && row.run_id === historyRunKey);
      return { attempt: { ...attempt, evaluation: attempt.evaluation ?? historyEvaluation }, files: historyFiles, presence,
        limits: outputLimits(attempt, previousAgent, historyRequests) };
    }));
    return { item, trajectory, evaluation, environment, filePresence, files, costRows, taskPrompt, attempts };
  }));
  const counts = Object.fromEntries(['pass', 'fail', 'incomplete', 'infra', 'pending'].map(key => [key, rows.filter(row => outcome(row.item, row.evaluation).key === key).length]));
  const finished = counts.pass + counts.fail + counts.incomplete;
  const total = selected.length;
  const finishedAll = report.status === 'completed';
  const estimate = numeric(budget.usage_estimate_cny);
  const upper = numeric(budget.accounted_upper_bound_cny);
  const cap = numeric(budget.budget_cny) ?? numeric(report.budget_cny);
  const requestCount = numeric(budget.requests);
  const toolCalls = sumKnown(rows.filter(row => row.trajectory).map(row => numeric(row.item.key_stats?.tool_calls) ?? numeric(row.trajectory?.key_stats?.tool_calls)));
  const active = numeric(budget.active);
  const concurrencyCap = numeric(report.user_concurrency_limit) ?? numeric(report.concurrency);
  const actualPeak = numeric(report.experiment_peak_concurrency) ?? numeric(report.actual_peak_concurrency)
    ?? numeric(report.peak_concurrency) ?? numeric(budget.peak_concurrency);
  const meter = cap && upper !== undefined ? Math.min(100, upper / cap * 100) : 0;
  const model = report.model ?? ledger?.model ?? '未知';
  const generated = new Date().toISOString();
  const resultHref = href(output, input);
  const ledgerFile = liveLedger ? liveLedgerPath : path.join(runDir, 'budget-ledger.json');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Toolathlon 实测报告 · Tomorrow</title>
<style>
:root{color-scheme:light;--ink:#20252f;--muted:#7b8290;--line:#e8eaf0;--paper:#fff;--accent:#6654d9;--pass:#187c65;--fail:#b54843;--amber:#9a6b26}*{box-sizing:border-box}body{margin:0;background:#f5f6fa;color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}button,input{font:inherit}main{max-width:1180px;margin:auto;padding:48px 36px 60px}.topline{display:flex;justify-content:space-between;align-items:center;gap:18px;margin-bottom:36px}.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px}.orb{height:23px;width:23px;border-radius:50%;background:radial-gradient(circle at 28% 25%,#fff,#bdb4ff 48%,#7f7cc1 80%);box-shadow:0 3px 10px #6654d925}.toplinks{display:flex;gap:20px;font-size:12px}.eyebrow{color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.hero{display:flex;justify-content:space-between;gap:36px;margin-bottom:30px}.hero h1{margin:8px 0 10px;font-size:37px;line-height:1.3;letter-spacing:-1.2px}.hero p{color:#656d7b;max-width:740px;margin:0}.run-status{white-space:nowrap;align-self:flex-start;border:1px solid var(--line);background:#fff;border-radius:24px;padding:7px 13px;font-size:12px}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:${finishedAll ? '#87909d' : '#8d7ce5'};margin-right:7px}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:19px 0 0}.chip{border-radius:6px;background:#ecebf6;color:#655f82;font-size:11px;padding:4px 8px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{background:#fff;border:1px solid var(--line);border-radius:15px;padding:19px 22px}.card-label{font-size:12px;color:#747c89}.card-value{font-size:34px;line-height:1.3;font-weight:650;margin:6px 0}.card-note{font-size:11px;color:var(--muted)}.card.good .card-value{color:var(--pass)}.card.bad .card-value{color:var(--fail)}.card.neutral .card-value{color:var(--amber)}.budget{display:grid;grid-template-columns:1fr 1.2fr;gap:32px;margin:16px 0 30px;padding:22px}.budget h2{font-size:14px;margin:0 0 12px}.budget-numbers{display:flex;gap:28px}.budget-numbers strong{display:block;font-size:22px;line-height:1.4}.budget-numbers span{font-size:11px;color:var(--muted)}.meter{height:7px;background:#f0eef7;border-radius:8px;overflow:hidden;margin:9px 0 8px}.meter i{height:100%;display:block;background:linear-gradient(90deg,#a99ce9,#7561d4);width:${meter.toFixed(2)}%}.budget-copy{font-size:11px;color:#767d89}.budget-note{margin:12px 0 0;font-size:11px;color:#808694}.section-head{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:28px 0 14px}.section-head h2{margin:0;font-size:18px}.section-head p{margin:3px 0 0;font-size:12px;color:var(--muted)}.filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.filters button{border:0;background:transparent;color:#818695;border-radius:7px;padding:6px 10px;cursor:pointer;font-size:12px}.filters button.active{background:#e9e6f7;color:var(--accent)}.search{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 10px;width:165px;font-size:12px;outline:0}.search:focus{border-color:#b3a9df}.task{background:#fff;border:1px solid var(--line);border-radius:13px;margin:10px 0;overflow:hidden}.task[hidden]{display:none}.task-summary{display:flex;align-items:center;gap:17px;padding:21px 22px;list-style:none;cursor:pointer}.task-summary::-webkit-details-marker{display:none}.task-index{width:28px;color:#b1b7c2;font-size:15px;font-variant-numeric:tabular-nums}.task-title{flex:1;min-width:0}.task-title h3{font-size:14px;margin:0 0 1px;font-weight:600}.task-title code{font:11px/1.4 ui-monospace,Consolas,monospace;color:#9a9fac;overflow-wrap:anywhere}.result-wrap{display:flex;align-items:flex-end;flex-direction:column;gap:3px}.badge{border-radius:5px;padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap}.badge.pass{background:#e8f5f0;color:var(--pass)}.badge.fail{background:#faecea;color:var(--fail)}.badge.incomplete{background:#fff3dc;color:var(--amber)}.badge.infra{background:#edeaf8;color:#7355b0}.badge.pending{background:#f0f1f5;color:#818897}.literal{font-size:10px;color:#9ca2ad}.chevron{color:#a0a5ae;margin-left:9px;transition:transform .15s}.task-detail[open]>.task-summary .chevron{transform:rotate(180deg)}.task-body{padding:0 23px 22px 68px}.task-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:17px 0 19px;border-top:1px solid #f0f1f5;border-bottom:1px solid #f0f1f5}.task-metrics span{display:block;font-size:11px;color:#888f9b}.task-metrics strong{display:block;font-size:21px;font-weight:600;margin:3px 0}.task-metrics small{font-size:10px;color:#a0a5b0}.official-reason{border-left:2px solid #dbd5f1;background:#faf9fd;padding:12px 15px;margin:18px 0;border-radius:0 7px 7px 0}.official-reason .eyebrow{font-size:10px}.official-reason pre{margin:6px 0 0;font-size:11px;color:#667080}.notice{border:1px solid #ece8f6;background:#faf9fd;padding:12px 15px;border-radius:8px;margin:15px 0;font-size:12px}.notice.error{background:#fff8f4;border-color:#f3e7de}.notice pre{margin:4px 0 0}.facts{display:grid;grid-template-columns:1fr 1fr;gap:7px 25px;font-size:11px;color:#727c89;margin:16px 0}.facts div{display:flex;gap:13px}.facts dt{color:#a0a5af;min-width:87px}.facts dd{margin:0;overflow-wrap:anywhere}.artifact-links{display:flex;gap:15px;flex-wrap:wrap;font-size:11px;margin:16px 0}.prompt,.conversation{border-top:1px solid #f0f1f5;padding:12px 0 0;margin:13px 0 0}.prompt>summary,.conversation>summary{font-size:12px;cursor:pointer;font-weight:500}.prompt pre{background:#f7f8fb;border-radius:8px;padding:14px;margin-top:12px;font-size:11px}.conversation>summary>.muted{font-size:10px;margin-left:8px}.timeline{padding:12px 0 0}.message{border:1px solid #edf0f5;border-radius:8px;margin:8px 0;font-size:11px}.message>summary{display:flex;gap:10px;justify-content:space-between;padding:9px 12px;cursor:pointer;list-style:none}.message.user{background:#f8f7fc;border-color:#ece8f6}.message pre{padding:0 12px 12px;margin:0;max-height:350px;overflow:auto;font-size:10px}.message-hint{color:#9a9fac;white-space:nowrap}.tool-call{border-top:1px solid #eff0f5;padding:10px 12px 0}.tool-call strong{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#725bb0}.tool-call pre{padding:6px 0 10px;max-height:250px}.muted{color:var(--muted)}pre{font-family:ui-monospace,Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}.scope{background:#eeeff5;border-radius:13px;padding:22px 24px;margin-top:28px}.scope h2{font-size:13px;margin:0 0 9px}.scope ul{padding-left:17px;margin:0;font-size:11px;color:#7a8190}.scope li{padding:3px 0}.footer{display:flex;justify-content:space-between;gap:20px;color:#a3a8b3;font-size:10px;margin-top:24px}.empty{padding:30px;text-align:center;color:#979eaa;font-size:12px;display:none}.empty.show{display:block}@media(max-width:800px){main{padding:28px 20px}.hero h1{font-size:30px}.hero{gap:12px}.summary{grid-template-columns:repeat(2,1fr)}.budget{grid-template-columns:1fr;gap:16px}.section-head{align-items:flex-start;flex-direction:column;gap:12px}.task-summary{padding:18px 14px;gap:9px}.task-body{padding:0 16px 18px}.task-metrics{grid-template-columns:repeat(2,1fr);gap:15px}.facts{grid-template-columns:1fr}.toplinks a:last-child{display:none}.footer{flex-direction:column;gap:4px}.literal{font-size:9px}.task-title h3{font-size:13px}.search{width:140px}}
</style></head><body><main>
<div class="topline"><div class="brand"><span class="orb" aria-hidden="true"></span>Tomorrow <span class="muted" style="font-weight:400">/ Evaluation</span></div><nav class="toplinks"><a href="https://toolathlon.xyz/docs/leaderboard" target="_blank" rel="noopener">官方榜单 ↗</a><a href="${escape(resultHref)}" target="_blank">本轮数据 ↗</a></nav></div>
<header class="hero"><div><div class="eyebrow">Toolathlon · Verified</div><h1>Toolathlon 实测报告</h1><p>使用官方任务、真实 MCP 工具和原始评分器，观察 ${escape(model)} 在 Pi 驱动下完成工作时的表现。</p><div class="meta"><span class="chip">集成试跑 · 历史尝试保留</span><span class="chip">${escape(model)}</span><span class="chip">${escape(report.harness ?? '未知 harness')}</span><span class="chip">思考模式 ${escape(report.thinking_level ?? '未知')}</span><span class="chip">每题 ${number(report.max_turns)} 轮上限</span><span class="chip">输出上限按题记录</span><span class="chip">并发上限 ${number(concurrencyCap)} · 实际峰值 ${number(actualPeak)}</span></div></div><div class="run-status"><span class="dot"></span>${finishedAll ? '本轮运行已结束' : '评测进行中 · 数据快照'}</div></header>
<section class="summary"><div class="card good"><div class="card-label">官方通过</div><div class="card-value">${counts.pass}<span style="font-size:15px;color:#a5abb5;font-weight:400"> / ${total}</span></div><div class="card-note">${finished} 道已返回官方评分</div></div><div class="card bad"><div class="card-label">官方未通过</div><div class="card-value">${counts.fail}</div><div class="card-note">评分结果为 false</div></div><div class="card neutral"><div class="card-label">Agent 未完成</div><div class="card-value">${counts.incomplete}</div><div class="card-note">评分结果为 null</div></div><div class="card"><div class="card-label">环境 / 接入错误</div><div class="card-value">${counts.infra}</div><div class="card-note">${counts.pending} 道尚无最终结果 · 错误单独统计</div></div></section>
<section class="card budget"><div><h2>共享预算 · 所有尝试合计</h2><div class="budget-numbers"><div><strong>${money(estimate)}</strong><span>已确认用量的费用估算</span></div><div><strong>${money(upper)}</strong><span>保守上界（含待确认预留）</span></div></div><p class="budget-note">费用来自本地用量账本，并非账户扣款账单。${money(budget.unknown_or_pending_reserved_cny)} 为未知或处理中请求保留的额度。</p></div><div><div class="budget-copy">已占用保守上界 / 总预算 <strong>${money(upper)} / ${money(cap)}</strong></div><div class="meter" role="meter" aria-label="预算占用" aria-valuenow="${meter.toFixed(2)}" aria-valuemin="0" aria-valuemax="100"><i></i></div><div class="budget-copy">剩余可分配 ${money(budget.remaining_cny)} · ${number(requestCount)} 次 API 请求 · ${number(active)} 次处理中</div><div class="budget-note">${number(toolCalls)} 次已记录工具调用。请求预算先预留再结算；无法确认费用的请求继续占用预留。${budget.frozen === true ? '账本已冻结，后续请求停止。' : ''} ${ledger ? localLink(output, ledgerFile, '查看共享账本', true) : ''}</div></div></section>
${report.stop_reason ? `<div class="notice"><strong>运行停止原因</strong><p style="margin:5px 0 0">${escape(runStopLabel(report.stop_reason))}</p></div>` : ''}
<section><div class="section-head"><div><h2>逐题结果</h2><p>展开任务查看原题、工具目录规模、官方评分原因与执行消息。</p></div><div class="filters"><button class="active" data-filter="all">全部 ${total}</button><button data-filter="pass">通过 ${counts.pass}</button><button data-filter="fail">未通过 ${counts.fail}</button><button data-filter="other">其他 ${counts.incomplete + counts.infra + counts.pending}</button><input class="search" id="search" aria-label="搜索任务" placeholder="搜索任务…"></div></div>${rows.map((row, index) => taskHtml(row, index, output)).join('')}<div class="empty" id="empty">没有匹配的任务。</div></section>
<section class="scope"><h2>如何理解这份结果</h2><ul><li>这次是集成试跑与配置修复，历史尝试全部保留；不能作为固定配置下每题只尝试一次的通过率。已得到官方 true / false 的任务保留原始判定，不为提高分数重跑。</li><li>仅对预算代理、输出截断或字节防护导致未完成的任务，在修复配置后续跑。旧已完成任务与新续跑任务可能使用不同输出上限，逐题按实际设置或对应请求记录展示，不统一套用最新配置。</li><li>本轮计划 ${total} 道，为无需额外个人云账号的本地文件任务子集；按运行可行性选择，并非随机抽样，也不是 108 道完整榜单成绩，不能直接与榜单百分比比较。</li><li>任务要求、种子文件与确定性评分器保持官方版本。官方默认 Agent loop 被 Pi 替换；因此观察对象是模型、Pi 与接入配置的组合。</li><li>本轮采用单条用户指令，随后可进行多轮模型与工具执行。不能据此声称验证了多轮用户对话、动态工具发现、授权变化或撤权。</li><li>true 表示官方状态评分通过；false 表示官方评分失败；null 表示 Agent 未完成、官方未给予通过判定。环境和接入错误单列，不合并为模型答题失败。</li><li>评分材料在 Agent 执行期间由官方 artifact guard 隐藏，评分前恢复；所选评分器不额外调用模型。未知字段显示“未知”。本轮并发上限 ${number(concurrencyCap)}，记录到的实际模型请求峰值 ${number(actualPeak)}。</li><li>共享预算为 ${money(cap)}，所有付费试跑、失败与重跑合并计入同一本账。当前页是离线快照，重新生成后刷新即可更新。</li></ul></section>
<footer class="footer"><span>生成于 ${escape(time(generated))} · 北京时间</span><span>官方源码 ${escape(String(report.source_commit ?? '未知').slice(0, 12))} · 开始 ${escape(time(report.started_at))}</span></footer>
</main><script>let selected='all';const cards=[...document.querySelectorAll('.task')],buttons=[...document.querySelectorAll('[data-filter]')],search=document.getElementById('search');function filter(){const q=search.value.trim().toLowerCase();let count=0;for(const card of cards){const state=card.dataset.outcome;const match=(selected==='all'||selected===state||selected==='other'&&!['pass','fail'].includes(state))&&card.dataset.search.includes(q);card.hidden=!match;if(match)count++}document.getElementById('empty').classList.toggle('show',!count)}for(const button of buttons)button.addEventListener('click',()=>{selected=button.dataset.filter;buttons.forEach(b=>b.classList.toggle('active',b===button));filter()});search.addEventListener('input',filter);</script></body></html>`;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, html, 'utf8');
  return { input, output, status: report.status, selected: total, official: counts,
    budget_estimate_cny: estimate, budget_upper_bound_cny: upper, generated_at: generated };
}

async function main() {
  const output = path.resolve(ROOT, OPTIONS.output || 'artifacts/toolathlon/report.html');
  const input = await findInput();
  const result = await generateReport(input, output);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const revision = '6ea57973c7a6097fd7c5915698c54c17c5b1b6c8';
const dataRoot = new URL('../../../research/benchmarks/bfcl/', import.meta.url);
const upstream = `https://github.com/ShishirPatil/gorilla/blob/${revision}/berkeley-function-call-leaderboard/`;
const selection = {
  simple_python: [0, 125, 150, 175],
  multiple: [25, 50, 75, 175],
  parallel: [0, 25, 50],
  parallel_multiple: [75, 125, 175],
  irrelevance: [50, 125],
};

// BFCL uses language-level type names. Native tool calling uses JSON Schema.
function jsonSchema(value) {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'optional')
    .map(([key, item]) => [key, key === 'type'
      ? ({ dict: 'object', float: 'number', tuple: 'array' }[item] ?? item)
      : jsonSchema(item)]));
}

const normalizeName = name => name.replaceAll('.', '_');
async function jsonLines(file) {
  const buffer = await readFile(new URL(file, dataRoot));
  return { rows: buffer.toString('utf8').trim().split(/\r?\n/).map(JSON.parse),
    sha256: createHash('sha256').update(buffer).digest('hex') };
}

async function grade(payload) {
  const script = fileURLToPath(new URL('grade_bfcl.py', dataRoot));
  return new Promise((resolve, reject) => {
    const process = spawn('python', [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...globalThis.process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let output = '', error = '';
    process.stdout.on('data', chunk => { output += chunk; });
    process.stderr.on('data', chunk => { error += chunk; });
    process.on('error', reject);
    process.on('close', code => {
      try {
        const parsed = JSON.parse(output);
        if (code && !parsed.grader_error) parsed.grader_error = error || `grader exited ${code}`;
        resolve(parsed);
      } catch { reject(new Error(`BFCL grader failed: ${error || output}`)); }
    });
    process.stdin.end(JSON.stringify(payload));
  });
}

export async function loadCases() {
  const cases = [];
  for (const [category, indexes] of Object.entries(selection)) {
    const file = `BFCL_v4_${category}.json`;
    const source = await jsonLines(file);
    const answerHash = category === 'irrelevance' ? undefined : createHash('sha256')
      .update(await readFile(new URL(`possible_answer/${file}`, dataRoot))).digest('hex');
    for (const index of indexes) {
      const row = source.rows[index];
      const expectedId = `${category}_${index}`;
      if (!row || row.id !== expectedId) throw new Error(`BFCL selection mismatch: ${expectedId}`);
      const nameMapping = Object.fromEntries(row.function.map(fn => [fn.name, normalizeName(fn.name)]));
      if (new Set(Object.values(nameMapping)).size !== row.function.length) throw new Error('BFCL tool name collision');
      const tools = row.function.map(fn => ({ name: nameMapping[fn.name], description: fn.description,
        parameters: jsonSchema(fn.parameters) }));
      const messages = row.question.flat().map(message => ({ ...message }));
      cases.push({
        id: `bfcl:${row.id}`, benchmark: 'BFCL', name: messages[0].content,
        provenance: {
          source_url: `${upstream}bfcl_eval/data/${file}`, source_id: row.id, revision,
          source_sha256: source.sha256, answers_sha256: answerHash,
          category, mode: 'original-question-native-tool-adapter-official-ast-checker',
          selection: 'fixed hand-selected diverse-domain subset; not a representative leaderboard score',
          schema_adapter: 'dict→object; float→number; tuple→array; drop non-JSON-Schema optional annotation; dot→underscore function names',
          name_mapping: nameMapping,
          grader: `${upstream}bfcl_eval/eval_checker/ast_eval/ast_checker.py`,
          grader_adapter: 'Unmodified upstream Python checker function bodies; Python-only model registry dependency injection; irrelevance checks zero calls',
          scope: 'First assistant turn function-call accuracy; no real-world API effects; no BFCL multi-turn simulator',
        },
        async run(ctx) {
          // Ground truth is intentionally loaded only after the model has answered.
          const trace = await ctx.runCore({
            system: 'You are an expert in composing functions. Use the provided tools to fulfill the user request when applicable. Do not invent tools or missing required values. If no function applies, respond without calling any tool.',
            messages, tools, stopAfterToolCall: true, maxTurns: 1, maxTools: 20, timeoutMs: 100000,
            executeTool: async () => ({ benchmark_stub: true }),
          });
          const answers = category === 'irrelevance' ? null : await jsonLines(`possible_answer/${file}`);
          const groundTruth = answers?.rows.find(answer => answer.id === row.id)?.ground_truth ?? [];
          if (category !== 'irrelevance' && !groundTruth.length) throw new Error(`BFCL answer missing: ${row.id}`);
          // Grade proposed calls, including unknown tools or invalid arguments that
          // Pi refused to execute. Executed calls alone would hide those failures.
          const responseCalls = trace.messages?.flatMap(message => Array.isArray(message.content)
            ? message.content.filter(part => part.type === 'toolCall')
              .map(part => ({ name: part.name, arguments: part.arguments })) : []) ?? [];
          const proposedCalls = trace.messages?.length ? responseCalls : trace.calls ?? [];
          const evaluation = await grade({ category, functions: row.function,
            ground_truth: groundTruth, calls: proposedCalls });
          const checks = { model_completed: !trace.error, official_ast_valid: evaluation.valid === true,
            grader_completed: !evaluation.grader_error };
          return { passed: Object.values(checks).every(Boolean), checks, evaluation, trace,
            proposed_calls: proposedCalls, expected: groundTruth, question: messages, tool_definitions: tools };
        },
      });
    }
  }
  return cases;
}

// For local, model-free adapter verification only.
export const _test = { grade, jsonSchema, normalizeName };

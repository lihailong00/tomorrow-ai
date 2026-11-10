import { readFileSync } from 'node:fs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const fliggyCatalogPath = '../../../crates/connectors/src/personal_mcp/fliggy_tools.json';
const { parameter_groups, tools } = read(fliggyCatalogPath);
export const fliggyReceipts = read('./fliggy-receipts.json');

export const fliggyCatalog = tools.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    required: tool.required,
    properties: { ...parameter_groups[tool.group], ...tool.properties },
    additionalProperties: false,
  },
  requires_confirmation: false,
}));

const aliases = {
  上海: /^(?:上海(?:市|虹桥|浦东)?|SHA|PVG)$/i,
  杭州: /^(?:杭州(?:市|萧山)?|HGH)$/i,
  成都: /^(?:成都(?:市)?|CTU|TFU)$/i,
  北京: /^(?:北京(?:市|南站?)?|BJS)$/i,
  西安: /^西安市?$/,
  成都天府国际机场: /^(?:(?:成都)?天府(?:国际)?机场|TFU)$/i,
  'second class': /^(?:second class|二等座)$/i,
};

export function fliggyReceipt(scenario, tool, args, reached) {
  const sample = fliggyReceipts.samples.find(row => row.scenario === scenario && row.tool === tool);
  const schema = fliggyCatalog.find(item => item.name === tool)?.inputSchema;
  if (!sample || !args || !schema || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) return;
  if (sample.after && !reached.has('fliggy.' + sample.after)) return;
  const matched = Object.entries(sample.arguments).every(([key, expected]) => {
    const actual = args[key];
    if (typeof expected !== 'string') return actual === expected;
    if (typeof actual !== 'string') return false;
    if (key === 'query' && sample.query_terms) {
      return sample.query_terms.every(term => new RegExp(term, 'i').test(actual));
    }
    return aliases[expected]?.test(actual.trim()) ?? actual.trim() === expected;
  });
  if (matched) return { status: 'completed', result: structuredClone(sample.response) };
}

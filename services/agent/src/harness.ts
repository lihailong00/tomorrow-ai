import { executeRun, RunError, type RunInput, type Bridge, type Limits } from './runtime.js';
import type { ModelSettings } from './config.js';
import type { WebProvider } from './web.js';
import { queryPreparation } from './query-rewrite.js';
import { collectNews, newsInput, renderNews, validDailyNews } from './daily-news.js';
export type Harness = 'pi' | 'dsh';
export function selectHarness(value: unknown, fallback: Harness = 'pi'): Harness {
  if (value === undefined) return fallback;
  if (value === 'pi' || value === 'dsh') return value;
  throw new RunError('invalid_request', '不支持的 Agent 引擎');
}
/** Fallback is a configuration choice; never re-execute a failed run in another engine. */
export async function executeHarness(input: RunInput & { harness?: Harness }, settings: ModelSettings, bridge: Bridge,
  signal?: AbortSignal, limits?: Limits, web?: WebProvider, fallback: Harness = 'pi',
  options: { queryRewrite?: boolean } = {}) {
  const harness = selectHarness(input.harness, fallback);
  const rewrite = options.queryRewrite ?? input.debug_fixture?.query_rewrite ?? process.env.AGENT_QUERY_REWRITE_ENABLED !== 'false';
  const execute = async (request: RunInput, provider?: WebProvider) => {
    const prepare = rewrite && (limits?.turns ?? 2) > 1 && (request.tools.length || provider)
      ? queryPreparation(request, settings) : undefined;
    if (harness === 'dsh') {
      const { executeDshRun } = await import('./dsh/runtime.js');
      return executeDshRun(request, settings, bridge, signal, limits, provider, prepare);
    }
    return executeRun(request, settings, bridge, signal, limits, undefined, provider, { prepareQuery: prepare });
  };
  if (input.debug_fixture) {
    const result = await execute(input);
    return { ...result, usage: { ...result.usage, debug_scenario: input.debug_fixture.scenario, query_rewrite_enabled: rewrite } };
  }
  if (input.daily_news === undefined) return execute(input, web);
  const news = input.daily_news;
  if (input.scope !== 'task' || input.tools.length || !validDailyNews(news)) {
    throw new RunError('invalid_request', '每日新闻参数无效');
  }
  if (!web) throw new RunError('tool_failed', '每日新闻需要配置联网搜索');
  const { sources, usage } = await collectNews(news, web, bridge, signal);
  if (!sources.length) return { content: renderNews(news.date, '{"items":[]}', []), usage };
  const result = await execute(newsInput(input, sources, harness === 'pi'));
  return { content: renderNews(news.date, result.content, sources), usage: { ...result.usage, ...usage } };
}

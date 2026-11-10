import type { Context } from '@deepseek-ai/cordis';
import { newsInstructions } from '../daily-news.js';

export const name = 'tada-daily-news';
export const inject = ['systemPrompt'];

export function apply(ctx: Context) {
  // The host supplies only the current run's verified excerpts. The plugin
  // contributes editorial policy, with no timer, credentials or side effects.
  const { systemPrompt } = ctx as Context & {
    systemPrompt: { section(section: { name: string; order: number; text: string }): () => void };
  };
  systemPrompt.section({ name, order: 100, text: newsInstructions });
}

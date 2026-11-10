import type { Integration } from './types';

/** An explicit Slack search goes to the live connector, never to the chat history. */
export function slackSearchQuery(message: string): string | null {
  const value = message.trim();
  const match =
    /^(?:\/slack(?:[：:\s]+|$)|(?:(?:请|帮我|请帮我)\s*)?(?:在|从)?\s*Slack\s*(?:里|中|上)?\s*(?:搜索|查找|查一下|搜一下|查|搜|找)\s*[：:]?|(?:(?:请|帮我|请帮我)\s*)?(?:搜索|查找|查一下|搜一下|查|搜|找)\s*Slack\s*(?:里|中|上)?\s*[：:]?)/i.exec(
      value,
    );
  return match ? value.slice(match[0].length).trim() : null;
}

export const slackIntegration: Integration = {
  id: 'slack',
  name: 'Slack',
  category: '办公',
  mode: 'oauth',
  status: 'not_configured',
  detail: '按需搜索已授权工作区的公开频道消息，可打开 Slack 原文',
};

import { escapeMarkdown } from 'discord.js';
import type { Decision, Tweet } from './types.js';
import { MONITORED_HANDLE } from './types.js';

/** Mentions are additionally disabled at the Discord transport boundary. */
function quote(text: string, limit = 1100): string {
  const safe = escapeMarkdown(
    text
      .replaceAll('\r', '')
      .replace(/<[^>]*>/g, '[mention]')
      .split('\n')
      .slice(0, 12)
      .join('\n'),
  );
  return safe
    .slice(0, limit)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

export function formatNotification(
  tweet: Tweet,
  decision: Decision,
  sample = false,
): string {
  if (decision.category === 'neither')
    throw new Error('Unrelated posts cannot produce notifications');
  if (
    !Number.isFinite(decision.confidence) ||
    decision.confidence < 0 ||
    decision.confidence > 1
  )
    throw new Error('Invalid notification confidence');
  const title =
    decision.category === 'reset'
      ? 'OpenAI usage reset'
      : 'OpenAI feature update';
  const parts = [
    `${sample ? '🧪 SAMPLE — ' : ''}${title}`,
    `AI confidence: **${(decision.confidence * 100).toFixed(1)}%**${sample ? ' (example value; no AI call)' : ' (model estimate)'}`,
    '',
    quote(tweet.text),
  ];
  const linked = tweet.context[0];
  if (linked)
    parts.push('', 'Linked earlier context:', quote(linked.text, 350));
  if (!sample) {
    if (!/^\d{17,20}$/.test(tweet.id))
      throw new Error('Invalid source post ID');
    parts.push(
      '',
      `@${MONITORED_HANDLE} · <https://x.com/${MONITORED_HANDLE}/status/${tweet.id}>`,
    );
  } else {
    parts.push(
      '',
      'Preview only — not a real announcement. No Twitter or AI requests were made.',
    );
  }
  return parts.join('\n');
}

/** Synthetic fixture shared by the command and offline tests, never sent to an API. */
export function sampleNotification(): string {
  return formatNotification(
    {
      id: '0000000000000000000',
      text: 'Example: we’re resetting Codex usage limits today. Your allowance will be refreshed shortly.',
      createdAt: 0,
      context: [],
    },
    { category: 'reset', confidence: 0.974 },
    true,
  );
}

import { escapeMarkdown } from 'discord.js';
import type { Decision, Tweet } from './types.js';
import { MONITORED_HANDLE } from './types.js';
import { PREVIEW_DECISION, PREVIEW_TWEET } from './preview.js';

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

export function formatNotification(tweet: Tweet, decision: Decision): string {
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
      ? '🎉 OpenAI usage reset'
      : '🥀 OpenAI challenge update';
  const parts = [
    title,
    `AI confidence: **${(decision.confidence * 100).toFixed(1)}%** (model estimate)`,
    '',
    quote(tweet.text),
  ];
  if (decision.category === 'feature')
    parts.splice(1, 0, 'No reset announced in this post.');
  const linked = tweet.context[0];
  if (linked)
    parts.push('', 'Linked earlier context:', quote(linked.text, 350));
  if (!/^\d{17,20}$/.test(tweet.id)) throw new Error('Invalid source post ID');
  parts.push(
    '',
    `@${MONITORED_HANDLE} · <https://x.com/${MONITORED_HANDLE}/status/${tweet.id}>`,
  );
  return parts.join('\n');
}

/** Identical live formatting, replaying stored historical data with no API calls. */
export function sampleNotification(): string {
  return formatNotification(PREVIEW_TWEET, PREVIEW_DECISION);
}

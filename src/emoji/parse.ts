import emojiRegex from 'emoji-regex';

export interface EmojiCount {
  emojiId: string;
  count: number;
}

/** Custom Discord mentions, grouped by installation ID. */
export function countCustomEmoji(content: string): EmojiCount[] {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(/<a?:[A-Za-z0-9_]+:(\d{17,20})>/g)) {
    const id = match[1];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([emojiId, count]) => ({ emojiId, count }));
}

/** Stable, non-snowflake identity; presentation selectors do not split totals. */
export function unicodeEmojiId(emoji: string): string {
  return `unicode:${emoji.replace(/\uFE0F/g, '')}`;
}

export function unicodeEmojiValue(id: string): string | undefined {
  return id.startsWith('unicode:') ? id.slice('unicode:'.length) : undefined;
}

/** Count complete Unicode sequences (flags, modifiers, keycaps and ZWJ families). */
export function countEmoji(content: string): EmojiCount[] {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(emojiRegex())) {
    const id = unicodeEmojiId(match[0]);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [
    ...countCustomEmoji(content),
    ...[...counts].map(([emojiId, count]) => ({ emojiId, count })),
  ];
}

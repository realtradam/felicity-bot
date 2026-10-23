import emojiRegex from 'emoji-regex';

const emojiPresentation = /^\p{Emoji_Presentation}/u;
const emojiCapable = /^\p{Emoji}/u;

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
  if (!id.startsWith('unicode:')) return undefined;
  const emoji = id.slice('unicode:'.length);
  // Storage strips VS16 so presentation variants share totals. Restore it for
  // display when the base character defaults to text (❤ → ❤️, ☹ → ☹️, 1⃣ → 1️⃣),
  // otherwise Discord renders the monochrome text glyph.
  const first = String.fromCodePoint(emoji.codePointAt(0) ?? 0);
  if (
    emojiPresentation.test(emoji) ||
    !emojiCapable.test(emoji) ||
    emoji.slice(first.length).startsWith('\uFE0F')
  )
    return emoji;
  return `${first}\uFE0F${emoji.slice(first.length)}`;
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

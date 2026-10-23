import { describe, expect, it } from 'vitest';
import {
  countCustomEmoji,
  countEmoji,
  unicodeEmojiId,
  unicodeEmojiValue,
} from './parse.js';

describe('custom emoji parser', () => {
  it('counts repeated static and animated emoji by ID', () => {
    expect(
      countCustomEmoji(
        '<:one:123456789012345678> <a:two:234567890123456789> <:renamed:123456789012345678>',
      ),
    ).toEqual([
      { emojiId: '123456789012345678', count: 2 },
      { emojiId: '234567890123456789', count: 1 },
    ]);
  });
  it('ignores Unicode, names without IDs, and malformed mentions', () => {
    expect(
      countCustomEmoji('😀 :hello: <:bad:123> <@:thing:123456789012345678>'),
    ).toEqual([]);
  });
});

describe('Unicode emoji parser', () => {
  it('counts whole sequences alongside custom mentions without counting components', () => {
    expect(
      countEmoji('<:blob:123456789012345678> 😀😀 👍🏽 👨‍👩‍👧‍👦 🇨🇦 1️⃣ 🏳️‍🌈'),
    ).toEqual([
      { emojiId: '123456789012345678', count: 1 },
      { emojiId: 'unicode:😀', count: 2 },
      { emojiId: 'unicode:👍🏽', count: 1 },
      { emojiId: 'unicode:👨‍👩‍👧‍👦', count: 1 },
      { emojiId: 'unicode:🇨🇦', count: 1 },
      { emojiId: 'unicode:1\u20e3', count: 1 },
      { emojiId: 'unicode:🏳‍🌈', count: 1 },
    ]);
  });
  it('merges presentation variants but keeps skin tones distinct', () => {
    expect(countEmoji('❤ ❤️ 👍 👍🏽')).toEqual([
      { emojiId: unicodeEmojiId('❤️'), count: 2 },
      { emojiId: 'unicode:👍', count: 1 },
      { emojiId: 'unicode:👍🏽', count: 1 },
    ]);
    expect(unicodeEmojiValue(unicodeEmojiId('❤️'))).toBe('❤');
    expect(unicodeEmojiValue('123456789012345678')).toBeUndefined();
  });
  it('ignores ordinary text, digits, punctuation, and custom names', () => {
    expect(countEmoji('Hello 123 # * :smile: <@123456789012345678>')).toEqual(
      [],
    );
  });
});

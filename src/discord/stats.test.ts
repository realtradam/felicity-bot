import { Collection } from 'discord.js';
import type { GuildEmoji } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from './context.js';
import { showServerEmoji, showStats, timeAgo } from './stats.js';
import { BotDatabase } from '../storage/database.js';

function live(id: string, name: string, animated = false): GuildEmoji {
  return {
    id,
    name,
    animated,
    roles: { cache: new Collection() },
  } as GuildEmoji;
}

describe('inline statistics', () => {
  let db: BotDatabase;
  let context: CommandContext;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
    context = { db } as CommandContext;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function archive(active: boolean) {
    db.saveAsset({
      id: 'asset',
      name: 'old',
      animated: true,
      contentHash: 'hash',
      relativePath: 'path',
      sourceGuildId: 'guild',
      sourceEmojiId: 'old',
    });
    db.saveAlias('guild', 'old', 'asset');
    db.saveInstallation({
      guildId: 'guild',
      discordEmojiId: 'old',
      assetId: 'asset',
      name: 'old',
      active: false,
    });
    if (active)
      db.saveInstallation({
        guildId: 'guild',
        discordEmojiId: '123456789012345678',
        assetId: 'asset',
        name: 'new',
        active: true,
      });
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'm',
      createdAt: 1,
      textEmojis: [{ emojiId: 'old', count: 4 }],
      reactions: [],
    });
  }

  it('renders live animated emoji for archived identities even when all usage has an older ID', async () => {
    archive(true);
    const mention = vi.fn();
    context.inlinePreview = { mention };
    const reply = vi.fn();
    await showStats(
      context,
      'guild',
      [live('123456789012345678', 'new', true)],
      undefined,
      1,
      reply,
    );
    expect(reply.mock.calls[0]?.[0]).toContain(
      '<a:new:123456789012345678> old · 4 text',
    );
    expect(mention).not.toHaveBeenCalled();
  });

  it('previews untracked emoji from the CDN-backed cache instead of showing raw text', async () => {
    const external = vi.fn().mockResolvedValue('<:x_860063973701320716:123>');
    context.inlinePreview = { mention: vi.fn(), external };
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'external-message',
      createdAt: Date.parse('2026-10-23T04:00:00Z'),
      textEmojis: [{ emojiId: '860063973701320716', count: 3 }],
      reactions: [],
    });
    const reply = vi.fn();
    await showStats(context, 'guild', [], undefined, 1, reply);
    expect(external).toHaveBeenCalledWith('860063973701320716');
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain(
      '<:x_860063973701320716:123> 860063973701320716 · 3 text, 0 reactions · external / untracked',
    );
  });

  it('protects removed-emoji previews through sending server and channel reports', async () => {
    archive(false);
    let protectedPage = false;
    const mention = vi.fn().mockResolvedValue('<a:preview:234567890123456789>');
    context.inlinePreview = {
      mention,
      withPage: async (ids, render) => {
        expect(ids).toEqual(['asset']);
        protectedPage = true;
        try {
          return await render(mention, () => Promise.resolve(undefined));
        } finally {
          protectedPage = false;
        }
      },
    };
    const reply = vi.fn<(content: string) => Promise<void>>(async () => {
      expect(protectedPage).toBe(true);
    });
    await showStats(context, 'guild', [], undefined, 1, reply);
    expect(reply.mock.calls[0]?.[0]).toContain(
      '<a:preview:234567890123456789> old · 4 text, 0 reactions · swapped',
    );
    await showStats(context, 'guild', [], 'other-channel', 1, reply);
    expect(reply.mock.calls[1]?.[0]).toContain('old · 0 text');
  });

  it('falls back to text when an archived preview is unavailable', async () => {
    archive(false);
    const reply = vi.fn();
    await showStats(context, 'guild', [], undefined, 1, reply);
    expect(reply.mock.calls[0]?.[0]).toContain('old · 4 text');
  });

  it('renders Unicode text and reaction-only entries without custom-emoji status labels', async () => {
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'm',
      createdAt: 1,
      textEmojis: [{ emojiId: 'unicode:😀', count: 2 }],
      reactions: [{ emojiId: 'unicode:👍🏽', count: 3 }],
    });
    const reply = vi.fn();
    await showStats(context, 'guild', [], 'channel', 1, reply);
    expect(reply.mock.calls[0]?.[0]).toContain('1. 👍🏽 · 0 text, 3 reactions');
    expect(reply.mock.calls[0]?.[0]).toContain('2. 😀 · 2 text, 0 reactions');
    expect(reply.mock.calls[0]?.[0]).not.toContain('untracked');
    expect(reply.mock.calls[0]?.[0]).not.toContain('unicode:');
  });

  it('shows message-sent dates for text and reactions in both scoped reports', async () => {
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'text',
      createdAt: Date.parse('2026-10-10T23:00:00Z'),
      textEmojis: [{ emojiId: 'unicode:😀', count: 1 }],
      reactions: [],
    });
    db.recordMessage({
      guildId: 'guild',
      channelId: 'other',
      messageId: 'reaction',
      createdAt: Date.parse('2026-10-12T01:00:00Z'),
      textEmojis: [],
      reactions: [{ emojiId: 'unicode:😀', count: 2 }],
    });
    const reply = vi.fn();
    await showStats(context, 'guild', [], undefined, 1, reply);
    expect(reply.mock.calls[0]?.[0]).toMatch(/^Server-wide emoji stats:\n/);
    expect(reply.mock.calls[0]?.[0]).toContain('last used 1 week ago');
    expect(reply.mock.calls[0]?.[0]).not.toContain('(observed');
    await showStats(context, 'guild', [], 'channel', 1, reply);
    expect(reply.mock.calls[1]?.[0]).toMatch(/^Current-channel emoji stats:\n/);
    expect(reply.mock.calls[1]?.[0]).toContain('last used 1 week ago');
  });

  it('shows only installed custom emoji, least-used first, with zero-use and combined old IDs', async () => {
    archive(true);
    db.saveAsset({
      id: 'removed',
      name: 'removed',
      animated: false,
      contentHash: 'hash2',
      relativePath: 'path2',
      sourceGuildId: 'guild',
      sourceEmojiId: 'removed-id',
    });
    db.saveAlias('guild', 'removed', 'removed');
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'recent',
      createdAt: Date.parse('2026-10-23T04:00:00Z'),
      textEmojis: [
        { emojiId: 'unicode:😀', count: 100 },
        { emojiId: 'external', count: 1 },
      ],
      reactions: [{ emojiId: '123456789012345678', count: 2 }],
    });
    const reply = vi.fn();
    await showStats(
      context,
      'guild',
      [
        live('123456789012345678', 'new', true),
        live('234567890123456789', 'unused'),
      ],
      undefined,
      1,
      reply,
      true,
    );
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain(
      '1. <:unused:234567890123456789> unused · 0 text, 0 reactions · installed · never observed',
    );
    expect(text).toContain(
      '2. <a:new:123456789012345678> new · 4 text, 2 reactions · installed · last used 8 hours ago',
    );
    expect(text).not.toContain('😀');
    expect(text).not.toContain('removed');
    expect(text).not.toContain('external');
  });

  it('lists separate current slots for identical archived images without hiding restricted emoji', async () => {
    archive(true);
    db.saveInstallation({
      guildId: 'guild',
      discordEmojiId: '234567890123456789',
      assetId: 'asset',
      name: 'copy',
      active: true,
    });
    const restricted = live('234567890123456789', 'copy');
    restricted.roles.cache.set('role', {} as never);
    const reply = vi.fn();
    await showStats(
      context,
      'guild',
      [live('123456789012345678', 'new'), restricted],
      undefined,
      1,
      reply,
      true,
    );
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain('copy · 4 text');
    expect(text).toContain('new · 4 text');
    expect(text.match(/4 text/g)).toHaveLength(2);
  });

  it('paginates the current-only view and handles a server with no custom emoji', async () => {
    const reply = vi.fn();
    await showStats(context, 'guild', [], undefined, 1, reply, true);
    expect(reply.mock.calls[0]?.[0]).toContain('No custom emoji installed.');
    await showStats(
      context,
      'guild',
      Array.from({ length: 11 }, (_, i) =>
        live(String(123456789012345678n + BigInt(i)), `emoji_${i}`),
      ),
      undefined,
      2,
      reply,
      true,
    );
    expect(reply.mock.calls[1]?.[0]).toContain('!history stats_current <page>');
    expect(reply.mock.calls[1]?.[0]).toContain('· 2/2');
  });
  it('paginates inline rather than exporting non-rendering emoji mentions as a file', async () => {
    const emojis = Array.from({ length: 12 }, (_, i) =>
      live(String(123456789012345678n + BigInt(i)), `emoji_${i}`),
    );
    const reply = vi.fn();
    await showStats(context, 'guild', emojis, undefined, 2, reply);
    expect(reply.mock.calls[0]?.[0]).toContain('· 2/2');
    expect(reply.mock.calls[0]?.[0]).toContain('11. <:emoji_10:');
    expect(reply.mock.calls[0]?.[0]).not.toContain('<:emoji_0:');
    expect(reply.mock.calls[0]?.[0]).toContain('!history stats <page>');
    await showStats(context, 'guild', emojis, undefined, 3, reply);
    expect(reply.mock.calls[1]?.[0]).toContain('Choose a page from 1 to 2');
  });
});

describe('server emoji listing', () => {
  let db: BotDatabase;
  let context: CommandContext;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
    context = { db } as CommandContext;
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function record(
    messageId: string,
    emojiId: string,
    textCount: number,
    reactionCount: number,
    createdAt: number,
  ) {
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId,
      createdAt,
      textEmojis: textCount ? [{ emojiId, count: textCount }] : [],
      reactions: reactionCount ? [{ emojiId, count: reactionCount }] : [],
    });
  }

  it('lists every installed emoji most used first with last-used times', async () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const emojis = Array.from({ length: 12 }, (_, index) =>
      live(String(111111111111111111n + BigInt(index)), `e${index}`),
    );
    record('recent', emojis[1]!.id, 4, 1, now - 2 * 86400_000);
    record('older', emojis[0]!.id, 2, 0, now - 3600_000);
    const reply = vi.fn();
    await showServerEmoji(context, 'guild', emojis, reply);
    expect(reply).toHaveBeenCalledOnce();
    const lines = (reply.mock.calls[0]?.[0] as string).split('\n');
    expect(lines[0]).toBe('All server emoji · most used first:');
    // Twelve installed emoji: deliberately more than the ten-row stats page.
    expect(lines.slice(1)).toHaveLength(12);
    expect(lines[1]).toBe(
      `1. <:e1:${emojis[1]!.id}> e1 · 4 text, 1 reactions · installed · last used 2 days ago`,
    );
    expect(lines[2]).toBe(
      `2. <:e0:${emojis[0]!.id}> e0 · 2 text, 0 reactions · installed · last used 1 hour ago`,
    );
    expect(lines[3]).toContain(
      '0 text, 0 reactions · installed · never observed',
    );
  });

  it('omits emoji that are not currently installed', async () => {
    const installed = live('111111111111111111', 'kept');
    record(
      'm1',
      '222222222222222222',
      9,
      0,
      Date.parse('2026-10-23T11:00:00Z'),
    );
    const reply = vi.fn();
    await showServerEmoji(context, 'guild', [installed], reply);
    const text = reply.mock.calls[0]?.[0] as string;
    expect(text).toContain('<:kept:111111111111111111>');
    expect(text).not.toContain('222222222222222222');
  });

  it('splits long lists across replies instead of paging', async () => {
    const emojis = Array.from({ length: 40 }, (_, index) =>
      live(String(111111111111111111n + BigInt(index)), `long_name_${index}`),
    );
    const reply = vi.fn();
    await showServerEmoji(context, 'guild', emojis, reply);
    expect(reply.mock.calls.length).toBeGreaterThan(1);
    const contents = reply.mock.calls.map((call) => call[0] as string);
    expect(contents.every((content) => content.length <= 1900)).toBe(true);
    expect(contents.join('\n')).toContain('40. ');
  });

  it('reports an empty server clearly', async () => {
    const reply = vi.fn();
    await showServerEmoji(context, 'guild', [], reply);
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      'All server emoji · most used first:\nNo custom emoji installed.',
    );
  });
});

describe('English elapsed time', () => {
  it.each([
    [0, 'just now'],
    [-60, 'just now'],
    [4, 'just now'],
    [5, '5 seconds ago'],
    [59, '59 seconds ago'],
    [60, '1 minute ago'],
    [300, '5 minutes ago'],
    [3599, '59 minutes ago'],
    [3600, '1 hour ago'],
    [7200, '2 hours ago'],
    [86400, '1 day ago'],
    [3 * 86400, '3 days ago'],
    [7 * 86400, '1 week ago'],
    [14 * 86400, '2 weeks ago'],
    [30 * 86400, '1 month ago'],
    [60 * 86400, '2 months ago'],
    [365 * 86400, '1 year ago'],
    [730 * 86400, '2 years ago'],
  ])('formats an elapsed %i seconds as %s', (seconds, expected) => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(timeAgo(now - seconds * 1000, now)).toBe(expected);
  });
});

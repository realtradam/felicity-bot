import { Collection, MessageFlags } from 'discord.js';
import type { GuildEmoji, Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDatabase } from '../storage/database.js';
import type { EmojiArchive } from '../emoji/archive.js';
import type { CommandContext } from './context.js';
import { showLibrary } from './library.js';

let db: BotDatabase;
beforeEach(() => {
  db = new BotDatabase(':memory:');
});
afterEach(() => db.close());
function setup(count = 1) {
  for (let i = 0; i < count; i++) {
    db.saveAsset({
      id: `asset${i}`,
      name: `emoji${i}`,
      animated: false,
      contentHash: 'hash',
      relativePath: 'path',
      sourceGuildId: 'guild',
      sourceEmojiId: 'id',
    });
    db.saveAlias('guild', `emoji${i}`, `asset${i}`);
  }
  const reply = vi.fn().mockResolvedValue(undefined);
  const mention = vi.fn().mockResolvedValue('<:preview:999999999999999999>');
  const message = { guildId: 'guild', reply } as unknown as Message;
  const context: CommandContext = {
    db,
    archive: {} as EmojiArchive,
    inlinePreview: { mention },
    running: new Set(),
    signal: new AbortController().signal,
  };
  return { message, context, reply, mention };
}

describe('compact inline library', () => {
  it('uses native server emoji first, without cards, files, IDs or redundant installed labels', async () => {
    const f = setup();
    db.saveInstallation({
      guildId: 'guild',
      discordEmojiId: '123456789012345678',
      assetId: 'asset0',
      name: 'emoji0',
      active: true,
    });
    const emoji = {
      id: '123456789012345678',
      name: 'emoji0',
      animated: true,
      available: true,
      roles: { cache: new Collection() },
    } as unknown as GuildEmoji;
    await showLibrary(f.message, f.context, [emoji]);
    expect(f.reply.mock.calls[0]?.[0]).toEqual({
      content: '**Emoji (1)**\n<a:emoji0:123456789012345678> emoji0',
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(f.mention).not.toHaveBeenCalled();
  });
  it('renders archived images as application-owned inline emoji, not embed cards', async () => {
    const f = setup();
    await showLibrary(f.message, f.context, []);
    expect(f.mention).toHaveBeenCalledWith('asset0');
    const response = f.reply.mock.calls[0]?.[0];
    expect(response.content).toBe(
      '**Emoji (1)**\n<:preview:999999999999999999> emoji0 · stored',
    );
    expect(response.embeds).toBeUndefined();
    expect(response.files).toBeUndefined();
  });
  it('uses inline previews for unavailable or role-restricted guild emoji', async () => {
    const f = setup();
    db.saveInstallation({
      guildId: 'guild',
      discordEmojiId: '123456789012345678',
      assetId: 'asset0',
      name: 'emoji0',
      active: true,
    });
    for (const emoji of [
      {
        id: '123456789012345678',
        available: false,
        roles: { cache: new Collection() },
      },
      {
        id: '123456789012345678',
        available: true,
        roles: { cache: new Collection([['role', {}]]) },
      },
    ])
      await showLibrary(f.message, f.context, [emoji as unknown as GuildEmoji]);
    expect(f.mention).toHaveBeenCalledTimes(2);
  });
  it('shows a plain stored name when a preview cannot be created, with no host requests', async () => {
    const f = setup();
    f.mention.mockResolvedValue(undefined);
    await showLibrary(f.message, f.context, []);
    expect(f.reply.mock.calls[0]?.[0].content).toBe(
      '**Emoji (1)**\nemoji0 · stored (preview unavailable)',
    );
    expect(f.reply.mock.calls[0]?.[0].flags).toBe(MessageFlags.SuppressEmbeds);
  });
  it('paginates compact rows and only shows navigation when needed', async () => {
    const f = setup(12);
    await showLibrary(f.message, f.context, [], 1);
    expect(f.mention).toHaveBeenCalledTimes(10);
    expect(f.reply.mock.calls[0]?.[0].content).toContain(
      '**Emoji (12)** · 1/2',
    );
    await showLibrary(f.message, f.context, [], 2);
    expect(f.mention).toHaveBeenCalledTimes(12);
    expect(f.reply.mock.calls[1]?.[0].content).toContain('2/2');
    await showLibrary(f.message, f.context, [], 3);
    expect(f.reply.mock.calls[2]?.[0].content).toContain('Choose a page');
  });
});

it('pins archived images for the whole page through the actual Discord reply', async () => {
  const f = setup(2);
  const events: string[] = [];
  const mention = vi.fn().mockResolvedValue('<:preview:999999999999999999>');
  f.context.inlinePreview = {
    mention: vi.fn(),
    withPage: async (ids, render) => {
      expect(ids).toEqual(['asset0', 'asset1']);
      events.push('pinned');
      const result = await render(mention, () => Promise.resolve(undefined));
      events.push('released');
      return result;
    },
  };
  f.reply.mockImplementation(async () => {
    events.push('reply');
  });
  await showLibrary(f.message, f.context, []);
  expect(events).toEqual(['pinned', 'reply', 'released']);
  expect(mention).toHaveBeenCalledTimes(2);
});

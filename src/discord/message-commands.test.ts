import { Collection } from 'discord.js';
import type { Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleMessageCommand,
  parseMessageCommand,
} from './message-commands.js';
import type { CommandContext } from './context.js';
import type { EmojiArchive } from '../emoji/archive.js';
import { EmojiService } from '../emoji/service.js';
import { BotDatabase } from '../storage/database.js';

function fixture(db: BotDatabase) {
  const reply = vi
    .fn()
    .mockResolvedValue({ edit: vi.fn().mockResolvedValue(undefined) });
  const has = vi.fn().mockReturnValue(false);
  const fetchMember = vi.fn().mockResolvedValue({ permissions: { has } });
  const message = {
    content: '!emoji backup',
    author: { id: 'user', bot: false },
    webhookId: null,
    guildId: 'guild',
    channelId: 'channel',
    inGuild: () => true,
    guild: {
      id: 'guild',
      members: { fetch: fetchMember },
      emojis: { fetch: vi.fn().mockResolvedValue(new Collection()) },
    },
    channel: { permissionsFor: () => ({ has: () => false }) },
    client: { user: { id: 'bot' } },
    reply,
  } as unknown as Message;
  const context: CommandContext = {
    db,
    archive: {} as EmojiArchive,
    signal: new AbortController().signal,
    running: new Set(),
  };
  return { message, context, reply, has, fetchMember };
}

describe('message command parser', () => {
  it('recognizes standalone help without matching unrelated messages', () => {
    expect(parseMessageCommand('  !HELP  ')).toEqual({
      group: 'help',
      action: 'help',
      args: [],
    });
    expect(parseMessageCommand('!helpful')).toBeUndefined();
    expect(parseMessageCommand('hello !help')).toBeUndefined();
  });
  it('defaults bare prefixes to their useful views', () => {
    expect(parseMessageCommand(' !HiStOrY ')).toEqual({
      group: 'history',
      action: 'stats',
      args: [],
    });
    expect(parseMessageCommand(' !EMOJI ')).toEqual({
      group: 'emoji',
      action: 'list',
      args: [],
    });
    expect(parseMessageCommand('!history help')?.action).toBe('help');
    expect(parseMessageCommand('!emoji help')?.action).toBe('help');
  });
  it('parses the requested commands and arguments', () => {
    expect(
      parseMessageCommand('!emoji swap <:old:123456789012345678> new-name'),
    ).toEqual({
      group: 'emoji',
      action: 'swap',
      args: ['<:old:123456789012345678>', 'new-name'],
    });
    expect(parseMessageCommand('!history stats_channel')).toEqual({
      group: 'history',
      action: 'stats_channel',
      args: [],
    });
    expect(parseMessageCommand('!history server_emoji')).toEqual({
      group: 'history',
      action: 'server_emoji',
      args: [],
    });
    expect(parseMessageCommand('  !EMOJI LIST  ')?.action).toBe('list');
    expect(parseMessageCommand('ordinary message !emoji list')).toBeUndefined();
    expect(parseMessageCommand('!emojilist')).toBeUndefined();
  });
});

describe('message command dispatch', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('shows every message command for !help without permissions or API calls', async () => {
    const f = fixture(db);
    f.message.content = '!help';
    expect(await handleMessageCommand(f.message, f.context)).toBe(true);
    const response = f.reply.mock.calls[0]?.[0].content as string;
    for (const command of [
      '!help',
      '!emoji backup',
      '!emoji list',
      '!emoji swap',
      '!emoji remove',
      '!emoji add',
      '!history scan',
      '!history stats',
      '!history stats_channel',
      '!history stats_current',
    ])
      expect(response).toContain(command);
    expect(response).toContain('\n\n### !emoji\n!emoji backup');
    expect(response).toContain('\n\n### !history\n!history scan');
    expect(response).not.toContain('Felicity commands:');
    expect(response).not.toMatch(/^# /m);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.message.guild!.emojis.fetch).not.toHaveBeenCalled();
  });
  it('dispatches bare prefixes to stats/list without showing the help menu', async () => {
    const f = fixture(db);
    f.message.content = '!history';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toMatch(
      /^Server-wide emoji stats:/,
    );
    expect(f.reply.mock.calls[0]?.[0].content).not.toContain(
      'observed messages;',
    );
    f.message.content = '!emoji';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[1]?.[0].content).toBe(
      'No backups yet. Run !emoji backup.',
    );
    expect(f.reply.mock.calls[1]?.[0].content).not.toContain('### !history');
  });

  it('dispatches current-installed stats, including zero-use emoji, and accepts pages', async () => {
    const f = fixture(db);
    vi.mocked(f.message.guild!.emojis.fetch).mockResolvedValue(
      new Collection([
        [
          '123456789012345678',
          {
            id: '123456789012345678',
            name: 'unused',
            animated: false,
            roles: { cache: new Collection() },
          },
        ],
      ]) as never,
    );
    f.message.content = '!history stats_current';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toContain(
      'Current-server custom emoji stats · least used first:',
    );
    expect(f.reply.mock.calls[0]?.[0].content).toContain(
      'unused · 0 text, 0 reactions · installed · never observed',
    );
    f.message.content = '!history stats_current 2';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[1]?.[0].content).toContain(
      '!history stats_current <page>',
    );
  });
  it('ignores bot and DM messages but answers every server it is in', async () => {
    const f = fixture(db);
    f.message.author.bot = true;
    expect(await handleMessageCommand(f.message, f.context)).toBe(false);
    f.message.author.bot = false;
    const inGuild = vi.spyOn(f.message, 'inGuild').mockReturnValue(false);
    expect(await handleMessageCommand(f.message, f.context)).toBe(false);
    inGuild.mockRestore();
    f.message.content = '!help';
    f.message.guildId = 'another-guild';
    expect(await handleMessageCommand(f.message, f.context)).toBe(true);
    expect(f.reply).toHaveBeenCalledOnce();
  });
  it('allows every emoji mutation without caller permissions or a member lookup', async () => {
    const f = fixture(db);
    const backup = vi
      .spyOn(EmojiService.prototype, 'backup')
      .mockResolvedValue(1);
    const remove = vi
      .spyOn(EmojiService.prototype, 'remove')
      .mockResolvedValue({ name: 'old', assetId: 'asset' });
    const swap = vi.spyOn(EmojiService.prototype, 'swap').mockResolvedValue({
      removed: 'old',
      added: 'new',
      id: 'id',
      animated: false,
    });
    const add = vi.spyOn(EmojiService.prototype, 'add').mockResolvedValue({
      name: 'new',
      id: 'id',
      animated: false,
      alreadyInstalled: false,
    });
    for (const content of [
      '!emoji backup',
      '!emoji remove old',
      '!emoji swap old new',
      '!emoji add https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN',
    ]) {
      f.message.content = content;
      expect(await handleMessageCommand(f.message, f.context)).toBe(true);
    }
    for (const operation of [backup, remove, swap, add])
      expect(operation).toHaveBeenCalledOnce();
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.has).not.toHaveBeenCalled();
  });
  it('dispatches backup and releases the shared lock', async () => {
    const f = fixture(db);
    const backup = vi
      .spyOn(EmojiService.prototype, 'backup')
      .mockResolvedValue(3);
    await handleMessageCommand(f.message, f.context);
    expect(backup).toHaveBeenCalled();
    expect(f.context.running.size).toBe(0);
    expect(f.reply.mock.calls.at(-1)?.[0].content).toContain('Backed up 3');
  });
  it('only implements remove, not the remote typo', async () => {
    const f = fixture(db);
    f.message.content = '!emoji remote :old:';
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Unknown command',
    );
    f.message.content = '!emoji remove :old:';
    const remove = vi
      .spyOn(EmojiService.prototype, 'remove')
      .mockResolvedValue({ name: 'old', assetId: 'asset' });
    await handleMessageCommand(f.message, f.context);
    expect(remove.mock.calls[0]?.[1]).toBe(':old:');
  });
  it.each([false, true])(
    'keeps swap replies short and renders the new emoji (animated=%s)',
    async (animated) => {
      const f = fixture(db);
      f.message.content = '!emoji swap :Hmm: peepoHmm';
      vi.spyOn(EmojiService.prototype, 'swap').mockResolvedValue({
        removed: 'Hmm',
        added: 'peepoHmm',
        id: '1563085727376343050',
        animated,
      });
      await handleMessageCommand(f.message, f.context);
      expect(f.reply.mock.calls.at(-1)?.[0].content).toBe(
        `Swapped out :Hmm: for <${animated ? 'a' : ''}:peepoHmm:1563085727376343050>`,
      );
    },
  );
  it('dispatches swaps and 7TV additions with their exact arguments', async () => {
    const f = fixture(db);
    f.message.content = '!emoji swap :old: new-name';
    const swap = vi.spyOn(EmojiService.prototype, 'swap').mockResolvedValue({
      removed: 'old',
      added: 'new-name',
      id: 'new-id',
      animated: false,
    });
    await handleMessageCommand(f.message, f.context);
    expect(swap.mock.calls[0]?.slice(1, 3)).toEqual([':old:', 'new-name']);
    f.message.content =
      '!emoji add https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN';
    const add = vi.spyOn(EmojiService.prototype, 'add').mockResolvedValue({
      name: 'PepeLaugh',
      id: 'new-id',
      animated: false,
      alreadyInstalled: false,
    });
    await handleMessageCommand(f.message, f.context);
    expect(add.mock.calls[0]?.[1]).toBe(
      'https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN',
    );
  });
  it('accepts direct image links and an optional one-word name', async () => {
    const f = fixture(db);
    const add = vi.spyOn(EmojiService.prototype, 'add').mockResolvedValue({
      name: 'MyHmm',
      id: '1563072300193022062',
      animated: false,
      alreadyInstalled: false,
    });
    for (const link of [
      'https://example.com/image.png',
      'https://7tv.app/emotes/60ae3e54259ac5a73e56a426',
    ]) {
      f.message.content = `!emoji add <${link}> MyHmm`;
      await handleMessageCommand(f.message, f.context);
      expect(add.mock.calls.at(-1)?.[1]).toBe(link);
      expect(add.mock.calls.at(-1)?.[3]).toBe('MyHmm');
      expect(f.reply.mock.calls.at(-1)?.[0].content).toBe(
        '<:MyHmm:1563072300193022062> was added as `:MyHmm:`.',
      );
    }
    f.message.content =
      '!emoji add https://example.com/image.png too many words';
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Incorrect arguments',
    );
  });
  it.each([
    [false, false, '<:Hmm:1563072300193022062>', 'was added as'],
    [true, false, '<a:Hmm:1563072300193022062>', 'was added as'],
    [false, true, '<:Hmm:1563072300193022062>', 'is already installed as'],
  ])(
    'renders add results (animated=%s, alreadyInstalled=%s)',
    async (animated, alreadyInstalled, emoji, wording) => {
      const f = fixture(db);
      f.message.content =
        '!emoji add https://7tv.app/emotes/60ae3e54259ac5a73e56a426';
      vi.spyOn(EmojiService.prototype, 'add').mockResolvedValue({
        name: 'Hmm',
        id: '1563072300193022062',
        animated,
        alreadyInstalled,
      });
      await handleMessageCommand(f.message, f.context);
      expect(f.reply.mock.calls.at(-1)?.[0].content).toBe(
        `${emoji} ${wording} \`:Hmm:\`.`,
      );
    },
  );
  it('releases the operation lock after failures and refuses overlapping operations', async () => {
    const f = fixture(db);
    vi.spyOn(EmojiService.prototype, 'backup').mockRejectedValue(
      new Error('failed'),
    );
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'failed',
    );
    expect(f.context.running.size).toBe(0);
    f.context.running.add('emoji:guild');
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Another emoji operation',
    );
  });
  it('lists backup names without requiring manager permissions', async () => {
    const f = fixture(db);
    f.message.content = '!emoji list';
    db.saveAsset({
      id: 'asset',
      name: 'PepeLaugh',
      animated: false,
      contentHash: 'hash',
      relativePath: 'path',
      sourceGuildId: 'guild',
      sourceEmojiId: 'id',
    });
    db.saveAlias('guild', 'PepeLaugh', 'asset');
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toContain('PepeLaugh · stored');
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.reply.mock.calls[0]?.[0].allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
  });
  it('shows swapped-out emoji in both server and channel statistics', async () => {
    const f = fixture(db);
    db.saveAsset({
      id: 'asset',
      name: 'old',
      animated: false,
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
    db.recordMessage({
      guildId: 'guild',
      channelId: 'other-channel',
      messageId: 'm',
      createdAt: 1,
      textEmojis: [{ emojiId: 'old', count: 4 }],
      reactions: [],
    });
    f.message.content = '!history stats';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toContain('4 text');
    expect(f.reply.mock.calls[0]?.[0].content).toContain('swapped');
    f.message.content = '!history stats_channel';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[1]?.[0].content).toContain('0 text');
    expect(f.reply.mock.calls[1]?.[0].content).toContain('swapped');
  });
  it('lists every installed server emoji without paging arguments', async () => {
    const f = fixture(db);
    f.message.content = '!history server_emoji';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toContain(
      'All server emoji · most used first',
    );
    f.message.content = '!history server_emoji 2';
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Usage: !history server_emoji',
    );
  });
  it('steals missing emoji from the replied-to message', async () => {
    const f = fixture(db);
    f.message.content = '!emoji steal';
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Reply to a message containing emoji',
    );
    f.message.reference = {
      messageId: '123456789012345678',
    } as Message['reference'];
    (
      f.message as unknown as { fetchReference: () => Promise<unknown> }
    ).fetchReference = vi
      .fn()
      .mockResolvedValue({ content: '<a:Party:222222222222222222>' });
    const steal = vi.spyOn(EmojiService.prototype, 'steal').mockResolvedValue({
      added: [{ name: 'Party', id: '999999999999999999', animated: true }],
      skipped: 1,
      failed: [],
    });
    await handleMessageCommand(f.message, f.context);
    expect(steal).toHaveBeenCalledWith(
      f.message.guild,
      '<a:Party:222222222222222222>',
      expect.anything(),
    );
    expect(f.reply.mock.calls[0]?.[0].content).toBe(
      'Added 1 emoji: <a:Party:999999999999999999>\nSkipped 1 already on this server.',
    );
  });
  it('accepts stats pages and rejects malformed arguments', async () => {
    const f = fixture(db);
    f.message.content = '!history stats 2';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).toContain('Choose a page');
    for (const command of [
      '!history stats 0',
      '!history stats_channel nope',
      '!history stats 1 extra',
      '!history stats_current nope',
    ]) {
      f.message.content = command;
      await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
        'Usage: !history',
      );
    }
  });
  it('allows scans without caller permissions while checking the bot and releasing its lock', async () => {
    const f = fixture(db);
    f.message.content = '!history scan';
    const edit = vi.fn().mockResolvedValue(undefined);
    f.reply.mockResolvedValue({ edit });
    const fetcher = vi.fn().mockResolvedValue(new Collection());
    const channel = {
      id: 'channel',
      guild: f.message.guild,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: fetcher },
    };
    Object.assign(f.message, { channel });
    Object.assign(f.message.guild!.members, { me: { id: 'bot' } });
    await handleMessageCommand(f.message, f.context);
    expect(f.fetchMember).not.toHaveBeenCalled();
    expect(f.has).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith({ limit: 100, cache: false });
    expect(edit.mock.calls[0]?.[0]).toBe('Scanned 0 messages. Caught up.');
    expect(f.context.running.size).toBe(0);
  });
  it.each(['!history scan', '!history scan all'])(
    'makes %s incremental at the command level',
    async (command) => {
      const f = fixture(db);
      const old = '123456789012345678';
      const newest = '123456789012345679';
      db.saveScanRange('guild', 'channel', {
        newestMessageId: old,
        oldestMessageId: old,
        complete: true,
      });
      const messages = new Collection(
        [newest, old].map((id) => [
          id,
          {
            id,
            guildId: 'guild',
            channelId: 'channel',
            createdTimestamp: 100,
            partial: false,
            author: { bot: false },
            webhookId: null,
            content: '😀',
            reactions: { cache: new Collection() },
          },
        ]),
      );
      const fetcher = vi.fn().mockResolvedValue(messages);
      const edit = vi.fn();
      f.reply.mockResolvedValue({ edit });
      Object.assign(f.message, {
        content: command,
        channel: {
          id: 'channel',
          guild: f.message.guild,
          isTextBased: () => true,
          permissionsFor: () => ({ has: () => true }),
          messages: { fetch: fetcher },
        },
      });
      Object.assign(f.message.guild!.members, { me: { id: 'bot' } });
      await handleMessageCommand(f.message, f.context);
      expect(edit.mock.calls[0]?.[0]).toBe('Scanned 1 message. Caught up.');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(db.emojiStats('guild')[0]?.textCount).toBe(1);
    },
  );
  it('no longer advertises or dispatches retired image-host publication commands', async () => {
    const f = fixture(db);
    f.message.content = '!help';
    await handleMessageCommand(f.message, f.context);
    expect(f.reply.mock.calls[0]?.[0].content).not.toContain('publish');
    f.message.content = '!emoji publish';
    await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
      'Unknown command',
    );
  });
  it('rejects missing/extra mutation arguments', async () => {
    const f = fixture(db);
    for (const input of [
      '!emoji swap old',
      '!emoji backup extra',
      '!emoji remove',
      '!emoji add',
    ]) {
      f.message.content = input;
      await expect(handleMessageCommand(f.message, f.context)).rejects.toThrow(
        'Incorrect arguments',
      );
    }
  });
});

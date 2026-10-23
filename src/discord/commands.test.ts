import type { ChatInputCommandInteraction, GuildEmoji } from 'discord.js';
import type { Config } from '../config.js';
import type { EmojiArchive } from '../emoji/archive.js';
import type { BotDatabase } from '../storage/database.js';
import { describe, expect, it, vi } from 'vitest';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';

function fixture() {
  const emoji = { managed: false } as GuildEmoji;
  const remove = vi.fn();
  const backup = vi.fn().mockResolvedValue({ id: 'asset' });
  const deactivate = vi.fn();
  const reply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const guild = {
    id: 'guild',
    emojis: { fetch: vi.fn().mockResolvedValue(emoji), delete: remove },
  };
  const interaction = {
    inGuild: () => true,
    guildId: 'guild',
    commandName: 'emoji',
    user: { id: 'user' },
    memberPermissions: { has: () => false },
    client: { guilds: { fetch: vi.fn().mockResolvedValue(guild) } },
    options: {
      getSubcommand: () => 'remove',
      getString: () => '123456789012345678',
    },
    reply,
    editReply,
    deferReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
  const context: CommandContext = {
    config: { guildId: 'guild' } as Config,
    archive: { backup } as unknown as EmojiArchive,
    db: { deactivateInstallation: deactivate } as unknown as BotDatabase,
    signal: new AbortController().signal,
    running: new Set(),
  };
  return { interaction, context, remove, backup, deactivate, reply, editReply };
}

describe('destructive command safeguards', () => {
  it('refuses unauthorized guilds before any backup or deletion', async () => {
    const f = fixture();
    f.context.config.guildId = 'other';
    await handleCommand(f.interaction, f.context);
    expect(f.reply).toHaveBeenCalled();
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('allows removal without caller permissions', async () => {
    const f = fixture();
    const has = vi.spyOn(f.interaction.memberPermissions!, 'has');
    await handleCommand(f.interaction, f.context);
    expect(has).not.toHaveBeenCalled();
    expect(f.backup).toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalled();
  });
  it('does not delete when confirmation differs', async () => {
    const f = fixture();
    vi.spyOn(f.interaction.options, 'getString').mockImplementation((key) =>
      key === 'id' ? '123456789012345678' : 'other',
    );
    await handleCommand(f.interaction, f.context);
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('never deletes when the backup fails and releases the guild lock', async () => {
    const f = fixture();
    f.backup.mockRejectedValue(new Error('disk full'));
    await expect(handleCommand(f.interaction, f.context)).rejects.toThrow(
      'disk full',
    );
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.context.running.size).toBe(0);
  });
  it('backs up before deletion and marks the installation inactive afterward', async () => {
    const f = fixture();
    await handleCommand(f.interaction, f.context);
    expect(f.backup.mock.invocationCallOrder[0]).toBeLessThan(
      f.remove.mock.invocationCallOrder[0]!,
    );
    expect(f.deactivate).toHaveBeenCalledWith('guild', '123456789012345678');
    expect(f.context.running.size).toBe(0);
  });
  it('does not start a second simultaneous emoji operation', async () => {
    const f = fixture();
    f.context.running.add('emoji:guild');
    await handleCommand(f.interaction, f.context);
    expect(f.backup).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
});

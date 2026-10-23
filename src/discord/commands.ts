import {
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { InlinePreview } from '../emoji/inline-preview.js';
import type { Config } from '../config.js';
import type { EmojiArchive } from '../emoji/archive.js';
import { scanHistory } from '../history/scan.js';
import type { BotDatabase } from '../storage/database.js';
import { EmojiService } from '../emoji/service.js';
import { showStats } from './stats.js';

export interface CommandContext {
  config: Config;
  db: BotDatabase;
  archive: EmojiArchive;
  inlinePreview?: InlinePreview;
  signal: AbortSignal;
  running: Set<string>;
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext,
) {
  if (
    !interaction.inGuild() ||
    interaction.guildId !== context.config.guildId
  ) {
    await interaction.reply({
      content: 'This server is not authorized for this bot.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (interaction.commandName === 'ping') {
    await interaction.reply({
      content: 'Felicity is online.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!['emoji', 'history'].includes(interaction.commandName)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const guild = await interaction.client.guilds.fetch(interaction.guildId);
  const action = interaction.options.getSubcommand();
  if (interaction.commandName === 'history') {
    const channel = await guild.channels.fetch(interaction.channelId);
    if (!channel?.isTextBased())
      throw new Error(
        'Run this command in a text channel or accessible thread',
      );
    const botMember = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !channel
        .permissionsFor(botMember)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    )
      throw new Error('Missing channel history permissions');
    const key = `scan:${channel.id}`;
    if (context.running.has(key)) {
      await interaction.editReply('A scan is already running in this channel.');
      return;
    }
    context.running.add(key);
    try {
      const result = await scanHistory(context.db, channel, {
        limit: interaction.options.getInteger('limit') ?? 1000,
        resume: interaction.options.getBoolean('resume') ?? true,
        signal: AbortSignal.any([
          context.signal,
          AbortSignal.timeout(10 * 60 * 1000),
        ]),
      });
      await interaction.editReply(
        `Scanned ${result.processed} ${result.processed === 1 ? 'message' : 'messages'}. ${result.complete ? 'Caught up.' : 'Run again to continue.'}`,
      );
    } finally {
      context.running.delete(key);
    }
    return;
  }
  if (action === 'library') {
    const assets = context.db.listAssets();
    if (!assets.length) {
      await interaction.editReply(
        'The archive is empty. Run /emoji backup first.',
      );
      return;
    }
    const text = assets
      .map(
        (asset) =>
          `${asset.id}\t${asset.name}\t${asset.animated ? 'animated' : 'static'}`,
      )
      .join('\n');
    await interaction.editReply({
      content: `${assets.length} archived assets. Use a full ID when uploading.`,
      files: [
        new AttachmentBuilder(Buffer.from(text), { name: 'emoji-library.tsv' }),
      ],
    });
    return;
  }
  if (action === 'stats') {
    const key = `emoji:${guild.id}`;
    if (context.running.has(key)) {
      await interaction.editReply(
        'An emoji operation is running. Try again when it finishes.',
      );
      return;
    }
    context.running.add(key);
    try {
      const current = await new EmojiService(
        context.db,
        context.archive,
      ).current(guild);
      await showStats(
        context,
        guild.id,
        current.values(),
        undefined,
        1,
        (content) =>
          interaction.editReply({ content, allowedMentions: { parse: [] } }),
      );
    } finally {
      context.running.delete(key);
    }
    return;
  }
  // Serialize all emoji mutations/backups for this guild to avoid overlapping swaps.
  const key = `emoji:${guild.id}`;
  if (context.running.has(key)) {
    await interaction.editReply(
      'Another emoji operation is running. Try again when it finishes.',
    );
    return;
  }
  context.running.add(key);
  try {
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(10 * 60 * 1000),
    ]);
    if (action === 'backup') {
      const emojis = await guild.emojis.fetch();
      let count = 0;
      for (const emoji of emojis.values()) {
        signal.throwIfAborted();
        await context.archive.backup(emoji);
        count++;
      }
      await interaction.editReply(
        `Archived ${count} emoji images and their metadata. Existing backups are safe if an operation is interrupted.`,
      );
    } else if (action === 'upload') {
      const name = interaction.options.getString('name', true);
      if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) {
        await interaction.editReply(
          'Names must be 2–32 letters, numbers, or underscores.',
        );
        return;
      }
      const { asset, image } = await context.archive.readAsset(
        interaction.options.getString('asset', true),
      );
      signal.throwIfAborted();
      const emoji = await guild.emojis.create({
        attachment: image,
        name,
        roles: [],
        reason: `Felicity archive upload requested by ${interaction.user.id}`,
      });
      context.db.saveInstallation({
        guildId: guild.id,
        discordEmojiId: emoji.id,
        assetId: asset.id,
        name,
        active: true,
      });
      context.db.saveAlias(guild.id, name, asset.id);
      await interaction.editReply(
        `Uploaded :${name}: with new ID ${emoji.id}. This upload is available to all server roles.`,
      );
    } else if (action === 'remove') {
      const id = interaction.options.getString('id', true);
      if (
        !/^\d{17,20}$/.test(id) ||
        id !== interaction.options.getString('confirm', true)
      ) {
        await interaction.editReply(
          'Deletion was not confirmed. Supply the same valid emoji ID in id and confirm.',
        );
        return;
      }
      const emoji = await guild.emojis.fetch(id);
      if (emoji.managed) {
        await interaction.editReply(
          'Integration-managed emoji cannot be removed by this command.',
        );
        return;
      }
      // Deletion is never attempted unless image + metadata + DB backup all succeeded.
      const asset = await context.archive.backup(emoji);
      signal.throwIfAborted();
      await guild.emojis.delete(
        id,
        `Felicity removal confirmed by ${interaction.user.id}`,
      );
      context.db.deactivateInstallation(guild.id, id);
      await interaction.editReply(
        `Removed emoji ${id}. Backup asset: ${asset.id}. Restoring it will create a new Discord ID.`,
      );
    }
  } finally {
    context.running.delete(key);
  }
}

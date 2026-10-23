import {
  AttachmentBuilder,
  formatEmoji,
  PermissionFlagsBits,
} from 'discord.js';
import type { Message } from 'discord.js';
import { EmojiService } from '../emoji/service.js';
import { scanHistory } from '../history/scan.js';
import type { CommandContext } from './context.js';
import { showLibrary } from './library.js';
import { showStats } from './stats.js';
import { UserError } from './user-error.js';

export interface ParsedCommand {
  group: 'emoji' | 'history' | 'help';
  action: string;
  args: string[];
}

export function parseMessageCommand(
  content: string,
): ParsedCommand | undefined {
  if (/^!help$/i.test(content.trim())) {
    return { group: 'help', action: 'help', args: [] };
  }
  const match = /^!(emoji|history)(?:\s+([a-z_]+))?(?:\s+(.*))?\s*$/i.exec(
    content.trim(),
  );
  if (!match?.[1]) return undefined;
  const group = match[1].toLowerCase() as 'emoji' | 'history';
  return {
    group,
    action: match[2]?.toLowerCase() ?? (group === 'emoji' ? 'list' : 'stats'),
    args: match[3]?.trim().split(/\s+/).filter(Boolean) ?? [],
  };
}

const help = [
  '!help · show all message commands',
  '',
  '### !emoji',
  '!emoji backup',
  '!emoji list [page]',
  '!emoji swap :old: backed-up-name',
  '!emoji remove :emoji:',
  '!emoji add <7TV-or-image-link> [name]',
  '',
  '### !history',
  '!history scan [all|1–5000] [restart]',
  '!history stats [page]',
  '!history stats_channel [page]',
  '!history stats_current [page]',
].join('\n');

export async function sendReport(
  message: Message,
  title: string,
  lines: string[],
  filename: string,
) {
  const text = `${title}\n${lines.join('\n')}`;
  if (text.length <= 1900) {
    await message.reply({
      content: text,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } else {
    await message.reply({
      content:
        `${title}\n${lines.slice(0, 8).join('\n')}\n… Full list attached (${lines.length} entries).`.slice(
          0,
          1900,
        ),
      files: [new AttachmentBuilder(Buffer.from(text), { name: filename })],
      allowedMentions: { parse: [], repliedUser: false },
    });
  }
}

/** Errors are handled by the lifecycle wrapper: only UserError messages may reach users. */
export async function handleMessageCommand(
  message: Message,
  context: CommandContext,
): Promise<boolean> {
  if (message.author.bot || message.webhookId || !message.inGuild())
    return false;
  const command = parseMessageCommand(message.content);
  if (!command) return false;
  const { group, action, args } = command;
  const reply = async (content: string) => {
    await message.reply({
      content,
      allowedMentions: { parse: [], repliedUser: false },
    });
  };
  if (action === 'help') {
    await reply(help);
    return true;
  }
  const mutation =
    group === 'emoji' && ['backup', 'swap', 'remove', 'add'].includes(action);
  const scan = group === 'history' && action === 'scan';
  const service = new EmojiService(context.db, context.archive);
  const refreshCurrent = async () => {
    const key = `emoji:${message.guildId}`;
    if (context.running.has(key))
      throw new UserError(
        'An emoji operation is running. Wait for it to finish before listing or checking stats.',
      );
    context.running.add(key);
    try {
      return await service.current(message.guild);
    } finally {
      context.running.delete(key);
    }
  };
  if (group === 'emoji' && action === 'list') {
    if (args.length > 1 || (args[0] && !/^[1-9][0-9]*$/.test(args[0])))
      throw new UserError('Usage: !emoji list [page]');
    const current = await refreshCurrent();
    await showLibrary(message, context, current.values(), Number(args[0] ?? 1));
    return true;
  }
  if (
    group === 'history' &&
    ['stats', 'stats_channel', 'stats_current'].includes(action)
  ) {
    if (args.length > 1 || (args[0] && !/^[1-9][0-9]*$/.test(args[0])))
      throw new UserError(`Usage: !history ${action} [page]`);
    const current = await refreshCurrent();
    await showStats(
      context,
      message.guildId,
      current.values(),
      action === 'stats_channel' ? message.channelId : undefined,
      Number(args[0] ?? 1),
      reply,
      action === 'stats_current',
    );
    return true;
  }
  if (scan) {
    const [limitArg, restartArg] = args;
    if (
      args.length > 2 ||
      (limitArg && !/^(all|restart|[0-9]+)$/.test(limitArg)) ||
      (restartArg && restartArg !== 'restart') ||
      (limitArg === 'restart' && restartArg)
    )
      throw new UserError('Usage: !history scan [all|1–5000] [restart]');
    const limit =
      !limitArg || ['all', 'restart'].includes(limitArg)
        ? 'all'
        : Number(limitArg);
    if (typeof limit === 'number' && (limit < 1 || limit > 5000))
      throw new UserError('Message limit must be 1–5000, or all.');
    const channel = message.channel;
    if (!channel.isTextBased() || !('guild' in channel))
      throw new UserError(
        'Run this command in a server text channel or thread.',
      );
    const bot =
      message.guild.members.me ?? (await message.guild.members.fetchMe());
    const permissions = channel.permissionsFor(bot);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    )
      throw new UserError(
        'I need View Channel and Read Message History in this channel.',
      );
    const key = `scan:${channel.id}`;
    if (context.running.has(key))
      throw new UserError('A history scan is already running in this channel.');
    context.running.add(key);
    try {
      const status = await message.reply({
        content: 'Scanning…',
        allowedMentions: { parse: [], repliedUser: false },
      });
      let lastUpdate = Date.now();
      const result = await scanHistory(context.db, channel, {
        limit,
        resume: !args.includes('restart'),
        signal: AbortSignal.any([
          context.signal,
          AbortSignal.timeout(30 * 60 * 1000),
        ]),
        onProgress: async (processed) => {
          if (Date.now() - lastUpdate > 15_000) {
            await status.edit(`Scanning… ${processed} messages.`);
            lastUpdate = Date.now();
          }
        },
      });
      await status.edit(
        `Scanned ${result.processed} ${result.processed === 1 ? 'message' : 'messages'}. ${result.complete ? 'Caught up.' : 'Run !history scan to continue.'}`,
      );
    } finally {
      context.running.delete(key);
    }
    return true;
  }
  if (mutation) {
    const expected = action === 'swap' ? 2 : action === 'backup' ? 0 : 1;
    if (
      action === 'add'
        ? args.length < 1 || args.length > 2
        : args.length !== expected
    )
      throw new UserError(`Incorrect arguments.\n${help}`);
    const key = `emoji:${message.guildId}`;
    if (context.running.has(key))
      throw new UserError(
        'Another emoji operation is running. Try again when it finishes.',
      );
    context.running.add(key);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(10 * 60 * 1000),
    ]);
    try {
      if (action === 'backup') {
        await reply('Backing up all current server emoji…');
        const count = await service.backup(message.guild, signal);
        await reply(
          `Backed up ${count} current emoji into the database (images + names + Discord-ID mappings), with local image files and role metadata too. Use !emoji list.`,
        );
      } else if (action === 'remove') {
        const result = await service.remove(message.guild, args[0]!, signal);
        await reply(
          `Removed :${result.name}:. It is backed up and its old usage remains in statistics. Restore it with !emoji swap or !emoji add with its original link.`,
        );
      } else if (action === 'swap') {
        const result = await service.swap(
          message.guild,
          args[0]!,
          args[1]!,
          signal,
        );
        const emoji = formatEmoji({
          id: result.id,
          name: result.added,
          animated: result.animated,
        });
        await reply(`Swapped out :${result.removed}: for ${emoji}`);
      } else if (action === 'add') {
        await reply(
          'Importing the image, backing it up, and adding it to the server…',
        );
        const result = await service.add(
          message.guild,
          args[0]!.replace(/^<|>$/g, ''),
          signal,
          args[1],
        );
        const name = result.name ?? 'emoji';
        const emoji = formatEmoji({
          id: result.id,
          name,
          animated: result.animated,
        });
        await reply(
          `${emoji} ${result.alreadyInstalled ? 'is already installed as' : 'was added as'} \`:${name}:\`.`,
        );
      }
    } finally {
      context.running.delete(key);
    }
    return true;
  }
  throw new UserError(`Unknown command or extra arguments.\n${help}`);
}

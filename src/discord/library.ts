import { formatEmoji, MessageFlags } from 'discord.js';
import type { GuildEmoji, Message } from 'discord.js';
import type { CommandContext } from './commands.js';

export const LIBRARY_PAGE_SIZE = 10;

export async function showLibrary(
  message: Message,
  context: CommandContext,
  current: Iterable<GuildEmoji>,
  page = 1,
) {
  const assets = context.db.listGuildAssets(message.guildId!);
  const pages = Math.max(1, Math.ceil(assets.length / LIBRARY_PAGE_SIZE));
  const reply = async (content: string) =>
    message.reply({
      content,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [], repliedUser: false },
    });
  if (!Number.isInteger(page) || page < 1 || page > pages) {
    await reply(`Choose a page from 1 to ${pages}: !emoji list <page>`);
    return;
  }
  if (!assets.length) {
    await reply('No backups yet. Run !emoji backup.');
    return;
  }
  const installed = [...current].filter(
    (emoji) => emoji.available !== false && emoji.roles.cache.size === 0,
  );
  const entries = assets
    .slice((page - 1) * LIBRARY_PAGE_SIZE, page * LIBRARY_PAGE_SIZE)
    .map((entry) => ({
      entry,
      live: installed.find(
        (emoji) =>
          context.db.getInstallation(message.guildId!, emoji.id)?.assetId ===
          entry.assetId,
      ),
    }));
  const render = async (
    preview: (id: string) => Promise<string | undefined>,
  ) => {
    const lines: string[] = [];
    for (const { entry, live } of entries) {
      if (live) {
        lines.push(
          `${formatEmoji({ id: live.id, name: live.name ?? entry.name, animated: Boolean(live.animated) })} ${entry.name}`,
        );
      } else {
        const mention = await preview(entry.assetId);
        lines.push(
          `${mention ? `${mention} ` : ''}${entry.name} · stored${mention ? '' : ' (preview unavailable)'}`,
        );
      }
    }
    const heading = `**Emoji (${assets.length})**${pages > 1 ? ` · ${page}/${pages}` : ''}`;
    const footer = pages > 1 ? '\n`!emoji list <page>`' : '';
    await reply(`${heading}\n${lines.join('\n')}${footer}`);
  };
  if (context.inlinePreview?.withPage) {
    await context.inlinePreview.withPage(
      entries.filter(({ live }) => !live).map(({ entry }) => entry.assetId),
      render,
    );
  } else {
    await render(
      (id) => context.inlinePreview?.mention(id) ?? Promise.resolve(undefined),
    );
  }
}

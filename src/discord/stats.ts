import { formatEmoji } from 'discord.js';
import type { GuildEmoji } from 'discord.js';
import { unicodeEmojiValue } from '../emoji/parse.js';
import type { CommandContext } from './commands.js';
import type { RankedEmoji } from '../storage/database.js';

export const STATS_PAGE_SIZE = 10;

/** Approximate elapsed time, with fixed 30-day months and 365-day years. */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  for (const [unit, size] of [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    if (seconds >= size) {
      const count = Math.floor(seconds / size);
      return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Render only one page, protecting archived previews until the reply is sent. */
export async function showStats(
  context: CommandContext,
  guildId: string,
  current: Iterable<GuildEmoji>,
  channelId: string | undefined,
  page: number,
  reply: (content: string) => Promise<unknown>,
  currentOnly = false,
) {
  const installed = [...current];
  let stats = context.db.emojiStats(guildId, channelId);
  for (const emoji of installed) {
    const entry = stats.find((row) => row.emojiId === emoji.id);
    if (entry && !entry.assetId) {
      entry.name = emoji.name;
      entry.status = 'active';
    } else if (!entry && !context.db.getInstallation(guildId, emoji.id)) {
      stats.push({
        emojiId: emoji.id,
        name: emoji.name,
        assetId: null,
        textCount: 0,
        reactionCount: 0,
        lastUsedAt: null,
        status: 'active',
      });
    }
  }
  if (currentOnly) {
    stats = installed
      .map((emoji): RankedEmoji => {
        const assetId = context.db.getInstallation(guildId, emoji.id)?.assetId;
        const row = stats.find((entry) =>
          assetId ? entry.assetId === assetId : entry.emojiId === emoji.id,
        );
        return {
          emojiId: emoji.id,
          name: emoji.name,
          assetId: assetId ?? null,
          textCount: row?.textCount ?? 0,
          reactionCount: row?.reactionCount ?? 0,
          lastUsedAt: row?.lastUsedAt ?? null,
          status: 'active',
        };
      })
      .sort(
        (a, b) =>
          a.textCount + a.reactionCount - (b.textCount + b.reactionCount) ||
          (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) ||
          (a.name ?? a.emojiId).localeCompare(b.name ?? b.emojiId),
      );
  }
  const pages = Math.max(1, Math.ceil(stats.length / STATS_PAGE_SIZE));
  const command = `!history ${currentOnly ? 'stats_current' : channelId ? 'stats_channel' : 'stats'}`;
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) {
    await reply(`Choose a page from 1 to ${pages}: ${command} <page>`);
    return;
  }
  const entries = stats
    .slice((page - 1) * STATS_PAGE_SIZE, page * STATS_PAGE_SIZE)
    .map((row) => ({
      row,
      live: installed.find(
        (emoji) =>
          emoji.available !== false &&
          emoji.roles.cache.size === 0 &&
          (currentOnly
            ? emoji.id === row.emojiId
            : row.assetId
              ? context.db.getInstallation(guildId, emoji.id)?.assetId ===
                row.assetId
              : emoji.id === row.emojiId),
      ),
    }));
  const render = async (
    preview: (id: string) => Promise<string | undefined>,
  ) => {
    const lines: string[] = [];
    for (const [index, { row, live }] of entries.entries()) {
      const unicode = unicodeEmojiValue(row.emojiId);
      const mention =
        unicode ??
        (live
          ? formatEmoji({
              id: live.id,
              name: live.name ?? row.name ?? 'emoji',
              animated: Boolean(live.animated),
            })
          : row.assetId
            ? await preview(row.assetId)
            : /^\d{17,20}$/.test(row.emojiId)
              ? formatEmoji({ id: row.emojiId, name: row.name ?? 'emoji' })
              : undefined);
      const label = unicode
        ? unicode
        : `${mention ? `${mention} ` : ''}${row.name ?? row.emojiId}`;
      const status = unicode
        ? ''
        : ` · ${
            row.status === 'swapped_out'
              ? 'swapped'
              : row.status === 'active'
                ? 'installed'
                : row.status === 'archived'
                  ? 'backed up / not installed'
                  : 'external / untracked'
          }`;
      const lastUsed =
        row.lastUsedAt !== null
          ? `last used ${timeAgo(row.lastUsedAt)}`
          : row.textCount || row.reactionCount
            ? 'last used unknown'
            : 'never observed';
      lines.push(
        `${(page - 1) * STATS_PAGE_SIZE + index + 1}. ${label} · ${row.textCount} text, ${row.reactionCount} reactions${status} · ${lastUsed}`,
      );
    }
    const heading = `${currentOnly ? 'Current-server custom' : channelId ? 'Current-channel' : 'Server-wide'} emoji stats${currentOnly ? ' · least used first' : ''}${pages > 1 ? ` · ${page}/${pages}` : ''}:`;
    const footer = pages > 1 ? `\n\`${command} <page>\`` : '';
    let content = heading;
    for (const line of lines.length
      ? lines
      : [
          currentOnly
            ? 'No custom emoji installed.'
            : 'No observed emoji yet. Run !history scan.',
        ]) {
      if (
        content.length + line.length + footer.length + 1 > 1900 &&
        content !== heading
      ) {
        await reply(content + footer);
        content = heading;
      }
      content += `\n${line}`;
    }
    await reply(content + footer);
  };
  if (context.inlinePreview?.withPage) {
    await context.inlinePreview.withPage(
      entries.flatMap(({ row, live }) =>
        !live && row.assetId ? [row.assetId] : [],
      ),
      render,
    );
  } else {
    await render(
      (id) => context.inlinePreview?.mention(id) ?? Promise.resolve(undefined),
    );
  }
}

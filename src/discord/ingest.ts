import type { Message } from 'discord.js';
import { countEmoji, unicodeEmojiId } from '../emoji/parse.js';
import type { BotDatabase } from '../storage/database.js';

/** Store only derived counts/IDs/timestamps, never message bodies or author IDs. */
export function ingestMessage(db: BotDatabase, message: Message) {
  if (!message.guildId || message.partial) return;
  db.recordMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    createdAt: message.createdTimestamp,
    textEmojis:
      message.author.bot ||
      message.webhookId ||
      /^!(emoji|history)(?:\s|$)/i.test(message.content.trimStart())
        ? []
        : countEmoji(message.content),
    reactions: [...message.reactions.cache.values()].flatMap((reaction) => {
      const emojiId =
        reaction.emoji.id ??
        (reaction.emoji.name ? unicodeEmojiId(reaction.emoji.name) : undefined);
      return emojiId && reaction.count
        ? [{ emojiId, count: reaction.count }]
        : [];
    }),
  });
}

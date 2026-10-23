import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  Options,
  Partials,
} from 'discord.js';
import type { Logger } from 'pino';
import { loadConfig } from './config.js';
import { handleMessageCommand } from './discord/message-commands.js';
import { UserError } from './discord/user-error.js';
import { EmojiService } from './emoji/service.js';
import { ingestMessage } from './discord/ingest.js';
import { ApplicationEmojiPreview } from './emoji/inline-preview.js';
import { EmojiArchive } from './emoji/archive.js';
import { createLogger, errorDetails } from './logger.js';
import { BotDatabase } from './storage/database.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await mkdir(config.dataDir, { recursive: true });
  const db = new BotDatabase(join(config.dataDir, 'felicity.sqlite'));
  const archive = new EmojiArchive(config.dataDir, db);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildExpressions,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 100,
    }),
  });
  const controller = new AbortController();
  const tasks = new Set<Promise<void>>();
  const running = new Set<string>();
  const inlinePreview = new ApplicationEmojiPreview(
    () => client.application?.emojis,
    archive,
    () =>
      logger.warn(
        'Application emoji preview unavailable; displaying stored name only.',
      ),
    config.previewCacheSize,
  );
  const context = {
    config,
    db,
    archive,
    inlinePreview,
    signal: controller.signal,
    running,
  };
  let stopping = false;
  const run = (operation: () => Promise<void>) => {
    if (stopping) return;
    const task = operation()
      .catch((error: unknown) => {
        logger.error(errorDetails(error), 'Discord operation failed');
      })
      .finally(() => tasks.delete(task));
    tasks.add(task);
  };
  client.once(Events.ClientReady, (readyClient) => {
    run(async () => {
      const guild = await readyClient.guilds.fetch(config.guildId);
      await new EmojiService(db, archive).current(guild);
    });
    logger.info(
      { botId: readyClient.user.id, guildId: config.guildId },
      'Felicity is ready',
    );
  });
  client.on(Events.Error, (error) =>
    logger.error(errorDetails(error), 'Discord client error'),
  );
  client.on(Events.Warn, () =>
    logger.warn(
      'Discord client warning; check intents, connectivity, and rate limits',
    ),
  );
  client.on(Events.MessageCreate, (message) => {
    if (!stopping && message.guildId === config.guildId) {
      try {
        ingestMessage(db, message);
      } catch (error) {
        logger.error(errorDetails(error), 'Message ingestion failed');
      }
      run(async () => {
        try {
          await handleMessageCommand(message, context);
        } catch (error) {
          logger.error(errorDetails(error), 'Message command failed');
          if (!controller.signal.aborted)
            await message.reply({
              content:
                error instanceof UserError
                  ? error.message
                  : 'Operation failed. Check bot permissions, connectivity, and capacity. Backups and scan progress are retained; inspect Discord before retrying a mutation.',
              allowedMentions: { parse: [], repliedUser: false },
            });
        }
      });
    }
  });
  // Serial REST refreshes avoid relying on cached counts for old/partial messages.
  const refreshes = new Map<string, Promise<void>>();
  const refresh = (
    guildId: string | null,
    channelId: string,
    messageId: string,
  ) => {
    if (guildId !== config.guildId) return;
    run(async () => {
      const previous = refreshes.get(messageId) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          if (controller.signal.aborted) return;
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased() || !('messages' in channel)) return;
          const message = await channel.messages.fetch({
            message: messageId,
            force: true,
            cache: false,
          });
          if (!controller.signal.aborted) ingestMessage(db, message);
        });
      refreshes.set(messageId, next);
      try {
        await next;
      } finally {
        if (refreshes.get(messageId) === next) refreshes.delete(messageId);
      }
    });
  };
  client.on(Events.MessageUpdate, (_old, message) =>
    refresh(message.guildId, message.channelId, message.id),
  );
  client.on(Events.MessageReactionAdd, (reaction) =>
    refresh(
      reaction.message.guildId,
      reaction.message.channelId,
      reaction.message.id,
    ),
  );
  client.on(Events.MessageReactionRemove, (reaction) =>
    refresh(
      reaction.message.guildId,
      reaction.message.channelId,
      reaction.message.id,
    ),
  );
  client.on(Events.MessageReactionRemoveAll, (message) =>
    refresh(message.guildId, message.channelId, message.id),
  );
  client.on(Events.MessageReactionRemoveEmoji, (reaction) =>
    refresh(
      reaction.message.guildId,
      reaction.message.channelId,
      reaction.message.id,
    ),
  );
  client.on(Events.MessageDelete, (message) => {
    if (!stopping && message.guildId === config.guildId)
      db.deleteMessage(message.id);
  });
  client.on(Events.MessageBulkDelete, (messages, channel) => {
    if (!stopping && channel.guild.id === config.guildId)
      for (const id of messages.keys()) db.deleteMessage(id);
  });
  client.on(Events.GuildEmojiDelete, (emoji) => {
    if (!stopping && emoji.guild.id === config.guildId)
      db.deactivateInstallation(emoji.guild.id, emoji.id);
  });
  const heartbeat = setInterval(() => {
    if (client.isReady() && !stopping) {
      run(() =>
        writeFile(
          join(config.dataDir, 'health.json'),
          JSON.stringify({ timestamp: Date.now() }),
        ),
      );
    }
  }, 30_000);
  heartbeat.unref();
  const shutdown = async (exitCode: number) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    clearInterval(heartbeat);
    logger.info('Shutting down');
    const forceExit = setTimeout(() => process.exit(exitCode || 1), 25_000);
    forceExit.unref();
    await client.destroy();
    await Promise.allSettled([...tasks]);
    db.close();
    clearTimeout(forceExit);
    process.exitCode = exitCode;
  };
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
  process.once('uncaughtException', (error) => fatal(error, logger, shutdown));
  process.once('unhandledRejection', (error) => fatal(error, logger, shutdown));
  try {
    await client.login(config.token);
  } catch (error) {
    logger.error(errorDetails(error), 'Discord login failed');
    await shutdown(1);
  }
}

function fatal(
  error: unknown,
  logger: Logger,
  shutdown: (code: number) => Promise<void>,
) {
  logger.fatal(errorDetails(error), 'Unrecoverable runtime error');
  void shutdown(1);
}

main().catch(() => {
  // Configuration validation failures are intentionally value-free.
  console.error(
    'Felicity could not start. Check DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, LOG_LEVEL, and DATA_DIR.',
  );
  process.exitCode = 1;
});

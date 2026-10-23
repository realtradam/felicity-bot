import type { GuildTextBasedChannel } from 'discord.js';
import { ingestMessage } from '../discord/ingest.js';
import type { BotDatabase } from '../storage/database.js';

export interface ScanResult {
  processed: number;
  complete: boolean;
  before: string | undefined;
}

/** Newest first, skipping covered intervals and resuming any unfinished older gaps. */
export async function scanHistory(
  db: BotDatabase,
  channel: GuildTextBasedChannel,
  options: {
    limit: number | 'all';
    /** True: incremental. False: ignore prior coverage and force a fresh rescan. */
    resume: boolean;
    signal: AbortSignal;
    onProgress?: (processed: number) => Promise<void>;
  },
): Promise<ScanResult> {
  if (
    options.limit !== 'all' &&
    (!Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 5000)
  )
    throw new Error('History scan limit must be between 1 and 5000');

  const guildId = channel.guild.id;
  const channelId = channel.id;
  let before: string | undefined;
  let processed = 0;
  let reset = !options.resume;
  const limit = options.limit === 'all' ? Infinity : options.limit;
  while (true) {
    options.signal.throwIfAborted();
    const ranges = options.resume ? db.getScanRanges(guildId, channelId) : [];
    const covered =
      before === undefined
        ? undefined
        : ranges.find(
            (range) =>
              BigInt(before!) <= BigInt(range.newestMessageId) &&
              (range.complete ||
                BigInt(before!) >= BigInt(range.oldestMessageId)),
          );
    if (covered) {
      before = covered.oldestMessageId;
      if (covered.complete) return { processed, complete: true, before };
    }
    if (processed >= limit) return { processed, complete: false, before };

    // Compare snowflakes as BigInts, never Numbers or lexicographic strings.
    const boundary = ranges.find(
      (range) =>
        before === undefined || BigInt(range.newestMessageId) < BigInt(before),
    );
    const batchSize = Math.min(100, limit - processed);
    const messages = await channel.messages.fetch({
      limit: batchSize,
      ...(before ? { before } : {}),
      cache: false,
    });
    options.signal.throwIfAborted();
    const sorted = [...messages.values()].sort((a, b) =>
      BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0,
    );
    // Stop even if the precise boundary message has since been deleted.
    const reached =
      boundary &&
      sorted.some(
        (message) => BigInt(message.id) <= BigInt(boundary.newestMessageId),
      );
    const fresh = boundary
      ? sorted.filter(
          (message) => BigInt(message.id) > BigInt(boundary.newestMessageId),
        )
      : sorted;
    const newest = before ?? fresh[0]?.id ?? boundary?.newestMessageId ?? '0';
    const oldest = reached
      ? boundary.newestMessageId
      : (fresh.at(-1)?.id ?? before ?? newest);
    const exhausted = messages.size < batchSize;
    for (const message of fresh) ingestMessage(db, message);
    // Ingestion failure/cancellation never advances coverage. A crash before this
    // checkpoint merely replays idempotent snapshots on the next invocation.
    db.saveScanRange(
      guildId,
      channelId,
      {
        newestMessageId: newest,
        oldestMessageId: oldest,
        complete: exhausted && !reached,
      },
      reset,
    );
    reset = false;
    processed += fresh.length;
    before = oldest;
    await options.onProgress?.(processed);
    if (exhausted && !reached) return { processed, complete: true, before };
  }
}

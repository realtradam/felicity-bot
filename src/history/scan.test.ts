import { Collection } from 'discord.js';
import type { GuildTextBasedChannel, Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDatabase } from '../storage/database.js';
import { scanHistory } from './scan.js';

function message(id: string): Message {
  return {
    id,
    guildId: 'guild',
    channelId: 'channel',
    createdTimestamp: 100,
    partial: false,
    content: '<:blob:123456789012345678>',
    author: { bot: false },
    webhookId: null,
    reactions: { cache: new Collection() },
  } as unknown as Message;
}
function channel(fetcher: ReturnType<typeof vi.fn>) {
  return {
    id: 'channel',
    guild: { id: 'guild' },
    messages: { fetch: fetcher },
  } as unknown as GuildTextBasedChannel;
}

describe('history scanning', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('starts newest on each run and resumes unfinished older history without double-counting', async () => {
    const first = message('123456789012345680');
    const second = message('123456789012345679');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Collection([
          [first.id, first],
          [second.id, second],
        ]),
      )
      .mockResolvedValueOnce(new Collection());
    const options = {
      limit: 2,
      resume: true,
      signal: new AbortController().signal,
    };
    expect(await scanHistory(db, channel(fetcher), options)).toEqual({
      processed: 2,
      complete: false,
      before: second.id,
    });
    expect((await scanHistory(db, channel(fetcher), options)).complete).toBe(
      true,
    );
    expect(fetcher.mock.calls[1]?.[0]).toEqual({ limit: 2, cache: false });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(2);
  });
  it('can rescan newest history independently of a saved cursor', async () => {
    db.saveScanRange('guild', 'channel', {
      newestMessageId: '123456789012345680',
      oldestMessageId: '123456789012345679',
      complete: true,
    });
    const fetcher = vi.fn().mockResolvedValue(new Collection());
    await scanHistory(db, channel(fetcher), {
      limit: 100,
      resume: false,
      signal: new AbortController().signal,
    });
    expect(fetcher.mock.calls[0]?.[0]).not.toHaveProperty('before');
  });
  it('backfills Unicode text/reactions on restart without duplicating existing usage', async () => {
    const msg = message('123456789012345680');
    msg.content = '😀😀';
    const fetcher = vi.fn().mockResolvedValue(new Collection([[msg.id, msg]]));
    const options = {
      limit: 100,
      resume: false,
      signal: new AbortController().signal,
    };
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: msg.id,
      createdAt: 100,
      textEmojis: [],
      reactions: [],
    });
    await scanHistory(db, channel(fetcher), options);
    await scanHistory(db, channel(fetcher), options);
    expect(db.emojiStats('guild', 'channel')).toEqual([
      expect.objectContaining({
        emojiId: 'unicode:😀',
        textCount: 2,
        reactionCount: 0,
      }),
    ]);
    expect(db.emojiStats('guild', 'other-channel')).toEqual([]);
    expect(db.emojiStats('other-guild')).toEqual([]);
  });
  it('does not advance progress when the fetch fails', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      scanHistory(db, channel(fetcher), {
        limit: 100,
        resume: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('offline');
    expect(db.getScanRanges('guild', 'channel')).toEqual([]);
  });
  it('does not start network work after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      scanHistory(db, channel(fetcher), {
        limit: 100,
        resume: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects unsafe scan bounds', async () => {
    await expect(
      scanHistory(db, channel(vi.fn()), {
        limit: 5001,
        resume: true,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('between 1 and 5000');
  });
});

describe('full-history mode', () => {
  it('scans across pages until exhausted and reports progress', async () => {
    const db = new BotDatabase(':memory:');
    try {
      const page = new Collection<string, Message>();
      for (let i = 0; i < 100; i++) {
        const id = String(123456789012345678n + BigInt(i));
        page.set(id, message(id));
      }
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce(new Collection());
      const progress = vi.fn().mockResolvedValue(undefined);
      const result = await scanHistory(db, channel(fetcher), {
        limit: 'all',
        resume: true,
        signal: new AbortController().signal,
        onProgress: progress,
      });
      expect(result).toMatchObject({ processed: 100, complete: true });
      expect(progress).toHaveBeenCalledWith(100);
      expect(fetcher.mock.calls[1]?.[0]).toMatchObject({
        before: '123456789012345678',
      });
      expect(db.topEmoji('guild')[0]?.textCount).toBe(100);
    } finally {
      db.close();
    }
  });
});

// A REST-like fixture: newest first, honoring exclusive before and requested page size.
function timeline(ids: string[]) {
  const items = new Map(ids.map((id) => [id, message(id)]));
  const fetcher = vi.fn(
    async ({ before, limit }: { before?: string; limit: number }) => {
      const sorted = [...items.values()]
        .filter((msg) => !before || BigInt(msg.id) < BigInt(before))
        .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
        .slice(0, limit);
      return new Collection(sorted.map((msg) => [msg.id, msg]));
    },
  );
  return { items, fetcher, channel: channel(fetcher) };
}
const incremental = {
  limit: 'all' as const,
  resume: true,
  signal: new AbortController().signal,
};

describe('newest-first incremental scans', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('scans all on the first run, then only new messages on regular/all reruns', async () => {
    const f = timeline(['100', '101', '102']);
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 3,
      complete: true,
    });
    f.items.set('103', message('103'));
    f.items.set('104', message('104'));
    f.fetcher.mockClear();
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 2,
      complete: true,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.fetcher.mock.calls[0]?.[0]).not.toHaveProperty('before');
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 0,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(5);
  });

  it('does not re-ingest older edited messages unless restart is requested', async () => {
    const f = timeline(['100', '101', '102']);
    await scanHistory(db, f.channel, incremental);
    f.items.get('101')!.content = '😀😀';
    await scanHistory(db, f.channel, incremental);
    expect(
      db.emojiStats('guild').some((row) => row.emojiId === 'unicode:😀'),
    ).toBe(false);
    expect(
      await scanHistory(db, f.channel, { ...incremental, resume: false }),
    ).toMatchObject({ processed: 3, complete: true });
    expect(
      db.emojiStats('guild').find((row) => row.emojiId === 'unicode:😀')
        ?.textCount,
    ).toBe(2);
    expect(
      db.topEmoji('guild').find((row) => row.emojiId === '123456789012345678')
        ?.textCount,
    ).toBe(2);
  });

  it('catches up newest messages before continuing unfinished older history', async () => {
    const f = timeline(['100', '101', '102', '103', '104']);
    expect(
      await scanHistory(db, f.channel, { ...incremental, limit: 2 }),
    ).toMatchObject({ processed: 2, complete: false });
    f.items.set('105', message('105'));
    const content = [] as string[];
    const original = db.recordMessage.bind(db);
    vi.spyOn(db, 'recordMessage').mockImplementation((snapshot) => {
      content.push(snapshot.messageId);
      original(snapshot);
    });
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 4,
      complete: true,
    });
    expect(content).toEqual(['105', '102', '101', '100']);
    expect(db.topEmoji('guild')[0]?.textCount).toBe(6);
  });

  it('preserves gaps when catch-up is limited across several runs', async () => {
    const f = timeline(['100', '101', '102']);
    await scanHistory(db, f.channel, incremental);
    for (const id of ['103', '104', '105', '106', '107'])
      f.items.set(id, message(id));
    expect(
      await scanHistory(db, f.channel, { ...incremental, limit: 2 }),
    ).toMatchObject({ processed: 2, complete: false });
    expect(db.getScanRanges('guild', 'channel')).toHaveLength(2);
    f.items.set('108', message('108'));
    expect(
      await scanHistory(db, f.channel, { ...incremental, limit: 2 }),
    ).toMatchObject({ processed: 2, complete: false });
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 2,
      complete: true,
    });
    expect(db.getScanRanges('guild', 'channel')).toEqual([
      { newestMessageId: '108', oldestMessageId: '100', complete: true },
    ]);
    expect(db.topEmoji('guild')[0]?.textCount).toBe(9);
  });

  it('stops at the boundary even if the exact prior newest message was deleted', async () => {
    const f = timeline(['100', '101', '102']);
    await scanHistory(db, f.channel, incremental);
    f.items.delete('102');
    db.deleteMessage('102');
    f.items.set('103', message('103'));
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 1,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(3);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not use live-ingested messages as an early stopping boundary', async () => {
    const f = timeline(['100', '101', '102']);
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: '102',
      createdAt: 100,
      textEmojis: [],
      reactions: [],
    });
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 3,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(3);
  });

  it('retains completed pages across cancellation and checks newest on the next run', async () => {
    const f = timeline(Array.from({ length: 150 }, (_, i) => String(1000 + i)));
    const controller = new AbortController();
    await expect(
      scanHistory(db, f.channel, {
        ...incremental,
        signal: controller.signal,
        onProgress: async () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(db.getScanRanges('guild', 'channel')).toEqual([
      { newestMessageId: '1149', oldestMessageId: '1050', complete: false },
    ]);
    f.items.set('1150', message('1150'));
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 51,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(151);
  });

  it('retains old coverage if a restart fetch fails and can resume an interrupted restart', async () => {
    const f = timeline(['100', '101', '102']);
    await scanHistory(db, f.channel, incremental);
    const before = db.getScanRanges('guild', 'channel');
    await expect(
      scanHistory(
        db,
        channel(vi.fn().mockRejectedValue(new Error('offline'))),
        { ...incremental, resume: false },
      ),
    ).rejects.toThrow('offline');
    expect(db.getScanRanges('guild', 'channel')).toEqual(before);
    expect(
      await scanHistory(db, f.channel, {
        ...incremental,
        resume: false,
        limit: 1,
      }),
    ).toMatchObject({ processed: 1, complete: false });
    expect(db.getScanRanges('guild', 'channel')).toEqual([
      { newestMessageId: '102', oldestMessageId: '102', complete: false },
    ]);
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 2,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(3);
  });

  it('does not advance coverage after a page ingestion error', async () => {
    const f = timeline(['100', '101', '102']);
    const original = db.recordMessage.bind(db);
    vi.spyOn(db, 'recordMessage').mockImplementation((snapshot) => {
      if (snapshot.messageId === '101') throw new Error('disk full');
      original(snapshot);
    });
    await expect(scanHistory(db, f.channel, incremental)).rejects.toThrow(
      'disk full',
    );
    expect(db.getScanRanges('guild', 'channel')).toEqual([]);
    vi.restoreAllMocks();
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 3,
      complete: true,
    });
    expect(db.topEmoji('guild')[0]?.textCount).toBe(3);
  });

  it('handles empty channels and catches messages added afterward', async () => {
    const f = timeline([]);
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 0,
      complete: true,
    });
    f.items.set('100', message('100'));
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 1,
      complete: true,
    });
    expect(await scanHistory(db, f.channel, incremental)).toMatchObject({
      processed: 0,
      complete: true,
    });
  });
});

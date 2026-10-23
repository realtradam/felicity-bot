import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { BotDatabase } from './database.js';
import type { EmojiAsset, MessageSnapshot } from './database.js';

const asset: EmojiAsset = {
  id: 'asset-a',
  name: 'blob',
  animated: false,
  contentHash: 'hash',
  relativePath: 'emojis/hash.png',
  sourceGuildId: 'guild-a',
  sourceEmojiId: 'old',
};
const snapshot: MessageSnapshot = {
  guildId: 'guild-a',
  channelId: 'channel-a',
  messageId: 'message-a',
  createdAt: 100,
  textEmojis: [{ emojiId: 'old', count: 2 }],
  reactions: [{ emojiId: 'old', count: 3 }],
};

describe('SQLite persistence', () => {
  let db: BotDatabase;
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'felicity-db-'));
    db = new BotDatabase(join(directory, 'nested/bot.sqlite'));
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('deduplicates scans and live message ingestion', () => {
    db.recordMessage(snapshot);
    db.recordMessage(snapshot);
    expect(db.topEmoji('guild-a')).toEqual([
      {
        emojiId: 'old',
        assetId: null,
        name: null,
        textCount: 2,
        reactionCount: 3,
        lastUsedAt: 100,
      },
    ]);
  });
  it('replaces counts for edits and cascades deletes', () => {
    db.recordMessage(snapshot);
    db.recordMessage({
      ...snapshot,
      textEmojis: [{ emojiId: 'new', count: 1 }],
      reactions: [],
    });
    expect(db.topEmoji('guild-a')[0]?.emojiId).toBe('new');
    db.deleteMessage(snapshot.messageId);
    expect(db.topEmoji('guild-a')).toEqual([]);
  });
  it('keeps guild statistics isolated', () => {
    db.recordMessage(snapshot);
    db.recordMessage({
      ...snapshot,
      guildId: 'guild-b',
      messageId: 'message-b',
    });
    expect(db.topEmoji('guild-b')[0]?.textCount).toBe(2);
    expect(db.topEmoji('guild-c')).toEqual([]);
  });
  it('joins usage across reuploads without multiplying reaction or text totals', () => {
    db.saveAsset(asset);
    for (const id of ['old', 'new']) {
      db.saveInstallation({
        guildId: 'guild-a',
        discordEmojiId: id,
        assetId: asset.id,
        name: 'blob',
        active: true,
      });
    }
    db.deactivateInstallation('guild-a', 'old');
    db.recordMessage(snapshot);
    db.recordMessage({
      ...snapshot,
      messageId: 'message-b',
      textEmojis: [{ emojiId: 'new', count: 4 }],
      reactions: [],
    });
    expect(db.topEmoji('guild-a')).toEqual([
      {
        emojiId: 'new',
        assetId: asset.id,
        name: 'blob',
        textCount: 6,
        reactionCount: 3,
        lastUsedAt: 100,
      },
    ]);
  });
  it('persists assets and scan progress across restarts', () => {
    db.saveAsset(asset);
    db.saveScanRange('guild-a', 'channel-a', {
      newestMessageId: '200',
      oldestMessageId: '100',
      complete: false,
    });
    db.close();
    db = new BotDatabase(join(directory, 'nested/bot.sqlite'));
    expect(db.getAsset(asset.id)).toEqual(asset);
    expect(db.listAssets()).toEqual([asset]);
    expect(db.getScanRanges('guild-a', 'channel-a')).toEqual([
      { newestMessageId: '200', oldestMessageId: '100', complete: false },
    ]);
    expect(db.getScanRanges('guild-b', 'channel-a')).toEqual([]);
  });
  it('rolls back invalid snapshots rather than losing existing counts', () => {
    db.recordMessage(snapshot);
    expect(() =>
      db.recordMessage({
        ...snapshot,
        textEmojis: [{ emojiId: 'old', count: -1 }],
      }),
    ).toThrow();
    expect(db.topEmoji('guild-a')[0]?.textCount).toBe(2);
  });
  it('rejects invalid query limits', () => {
    expect(() => db.topEmoji('guild-a', 0)).toThrow('Invalid statistics limit');
  });
});

describe('v2 identities and scoped reports', () => {
  it('includes swapped-out and zero-use backups, with independent channel/guild totals', () => {
    const db = new BotDatabase(':memory:');
    try {
      db.saveAsset(asset);
      db.saveAlias('guild-a', 'blob', asset.id);
      db.saveAsset({ ...asset, id: 'unused', name: 'unused' });
      db.saveAlias('guild-a', 'unused', 'unused');
      for (const id of ['old', 'restored'])
        db.saveInstallation({
          guildId: 'guild-a',
          discordEmojiId: id,
          assetId: asset.id,
          name: 'blob',
          active: false,
        });
      db.recordMessage(snapshot);
      db.recordMessage({
        ...snapshot,
        messageId: 'message-b',
        channelId: 'channel-b',
        textEmojis: [{ emojiId: 'restored', count: 4 }],
        reactions: [],
      });
      expect(
        db.emojiStats('guild-a').find((row) => row.assetId === asset.id),
      ).toMatchObject({
        textCount: 6,
        reactionCount: 3,
        status: 'swapped_out',
      });
      expect(
        db
          .emojiStats('guild-a', 'channel-a')
          .find((row) => row.assetId === asset.id),
      ).toMatchObject({ textCount: 2, reactionCount: 3 });
      expect(
        db
          .emojiStats('guild-a', 'channel-b')
          .find((row) => row.assetId === asset.id),
      ).toMatchObject({ textCount: 4, reactionCount: 0 });
      expect(
        db.emojiStats('guild-a').find((row) => row.assetId === 'unused'),
      ).toMatchObject({ textCount: 0, reactionCount: 0, status: 'archived' });
      expect(db.emojiStats('other-guild')).toEqual([]);
      db.reconcileInstallations('guild-a', [{ id: 'restored', name: 'blob' }]);
      expect(db.emojiStats('guild-a')[0]?.status).toBe('active');
      expect(db.emojiStats('guild-a')[0]?.textCount).toBe(6);
    } finally {
      db.close();
    }
  });
  it('stores image blobs, provider mappings, and operation states durably', () => {
    const dir = mkdtempSync(join(tmpdir(), 'felicity-v2-'));
    let db = new BotDatabase(join(dir, 'test.sqlite'));
    try {
      db.saveAsset(asset);
      db.saveImage(asset.id, Buffer.from('image'));
      db.saveSource('guild-a', '7tv', 'source', asset.id);
      db.saveOperation('operation', 'guild-a', 'swap', 'prepared', {
        oldId: 'old',
      });
      db.saveOperation('operation', 'guild-a', 'swap', 'complete', {
        newId: 'new',
      });
      db.close();
      db = new BotDatabase(join(dir, 'test.sqlite'));
      expect(db.getImage(asset.id)).toEqual(Buffer.from('image'));
      expect(db.getSourceAsset('guild-a', '7tv', 'source')).toEqual(asset);
      expect(db.getSourceAsset('guild-b', '7tv', 'source')).toBeUndefined();
      expect(db.getOperation('operation')).toEqual({
        state: 'complete',
        details: '{"newId":"new"}',
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('v1 migration', () => {
  it('preserves existing assets, ID mappings, usage, and cursors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'felicity-migrate-'));
    const file = join(dir, 'old.sqlite');
    let db = new BotDatabase(file);
    db.saveAsset(asset);
    db.saveInstallation({
      guildId: 'guild-a',
      discordEmojiId: 'old',
      assetId: asset.id,
      name: 'blob',
      active: true,
    });
    db.recordMessage(snapshot);
    db.close();
    // Model a real version-1 database by removing all version-2 additions.
    const raw = new Database(file);
    raw.exec(
      `DROP TABLE IF EXISTS hosted_images; DROP TABLE emoji_images; DROP TABLE emoji_aliases; DROP TABLE emoji_sources; DROP TABLE emoji_operations; DROP INDEX usage_emoji; DROP INDEX messages_channel; DROP TABLE scan_ranges; CREATE TABLE scan_cursors(guildId TEXT, channelId TEXT, beforeMessageId TEXT, PRIMARY KEY(guildId, channelId)); INSERT INTO scan_cursors VALUES ('guild-a', 'channel-a', '123456789012345678'); PRAGMA user_version = 1;`,
    );
    raw.close();
    db = new BotDatabase(file);
    try {
      expect(db.listGuildAssets('guild-a')).toEqual([
        { assetId: asset.id, name: 'blob', animated: false, active: true },
      ]);
      expect(db.emojiStats('guild-a')[0]).toMatchObject({
        textCount: 2,
        reactionCount: 3,
        status: 'active',
      });
      expect(db.getScanRanges('guild-a', 'channel-a')).toEqual([
        {
          newestMessageId: '123456789012345678',
          oldestMessageId: '123456789012345678',
          complete: false,
        },
      ]);
      expect(db.getImage(asset.id)).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('removes obsolete hosting metadata from v3 without deleting archived images or usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'felicity-retire-hosting-'));
  const file = join(dir, 'test.sqlite');
  let db = new BotDatabase(file);
  db.saveAsset(asset);
  db.saveImage(asset.id, Buffer.from('image'));
  db.recordMessage(snapshot);
  db.close();
  const raw = new Database(file);
  raw.exec(
    'CREATE TABLE hosted_images(assetId TEXT, publicOrigin TEXT, imageKey TEXT, publishedAt INTEGER); DROP TABLE scan_ranges; CREATE TABLE scan_cursors(guildId TEXT, channelId TEXT, beforeMessageId TEXT, PRIMARY KEY(guildId, channelId)); PRAGMA user_version = 3;',
  );
  raw.close();
  db = new BotDatabase(file);
  try {
    expect(db.getAsset(asset.id)).toEqual(asset);
    expect(db.getImage(asset.id)).toEqual(Buffer.from('image'));
    expect(db.topEmoji('guild-a')[0]?.textCount).toBe(2);
    const check = new Database(file);
    expect(check.pragma('user_version', { simple: true })).toBe(5);
    expect(
      check
        .prepare("SELECT name FROM sqlite_master WHERE name = 'hosted_images'")
        .get(),
    ).toBeUndefined();
    check.close();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('incremental scan coverage', () => {
  it('merges contiguous page boundaries while preserving gaps and completion', () => {
    const db = new BotDatabase(':memory:');
    try {
      db.saveScanRange('g', 'c', {
        newestMessageId: '1000',
        oldestMessageId: '900',
        complete: false,
      });
      db.saveScanRange('g', 'c', {
        newestMessageId: '800',
        oldestMessageId: '700',
        complete: true,
      });
      expect(db.getScanRanges('g', 'c')).toHaveLength(2);
      db.saveScanRange('g', 'c', {
        newestMessageId: '900',
        oldestMessageId: '800',
        complete: false,
      });
      expect(db.getScanRanges('g', 'c')).toEqual([
        { newestMessageId: '1000', oldestMessageId: '700', complete: true },
      ]);
      expect(db.getScanRanges('g', 'other')).toEqual([]);
      db.saveScanRange(
        'g',
        'c',
        { newestMessageId: '1100', oldestMessageId: '1050', complete: false },
        true,
      );
      expect(db.getScanRanges('g', 'c')).toEqual([
        { newestMessageId: '1100', oldestMessageId: '1050', complete: false },
      ]);
    } finally {
      db.close();
    }
  });

  it('migrates a v4 cursor conservatively without treating live observations as scan coverage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'felicity-incremental-'));
    const file = join(dir, 'old.sqlite');
    let db = new BotDatabase(file);
    db.recordMessage(snapshot);
    db.close();
    const raw = new Database(file);
    raw.exec(`DROP TABLE scan_ranges;
      CREATE TABLE scan_cursors(guildId TEXT, channelId TEXT, beforeMessageId TEXT, PRIMARY KEY(guildId, channelId));
      INSERT INTO scan_cursors VALUES ('guild-a', 'channel-a', '123456789012345678');
      PRAGMA user_version = 4;`);
    raw.close();
    db = new BotDatabase(file);
    try {
      expect(db.getScanRanges('guild-a', 'channel-a')).toEqual([
        {
          newestMessageId: '123456789012345678',
          oldestMessageId: '123456789012345678',
          complete: false,
        },
      ]);
      expect(db.topEmoji('guild-a')[0]?.textCount).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('last-used message dates', () => {
  it('derives dates from message creation for text and reactions and recomputes on edits/removals', () => {
    const db = new BotDatabase(':memory:');
    try {
      db.recordMessage(snapshot);
      db.recordMessage({
        ...snapshot,
        messageId: 'reaction',
        createdAt: 300,
        textEmojis: [],
        reactions: [{ emojiId: 'old', count: 5 }],
      });
      db.recordMessage({
        ...snapshot,
        messageId: 'newer-without-emoji',
        createdAt: 500,
        textEmojis: [],
        reactions: [],
      });
      expect(db.emojiStats('guild-a')[0]?.lastUsedAt).toBe(300);
      expect(db.topEmoji('guild-a')[0]?.lastUsedAt).toBe(300);
      db.recordMessage({
        ...snapshot,
        messageId: 'reaction',
        createdAt: 300,
        textEmojis: [],
        reactions: [{ emojiId: 'old', count: 6 }],
      });
      expect(db.emojiStats('guild-a')[0]?.lastUsedAt).toBe(300);
      db.recordMessage({
        ...snapshot,
        messageId: 'reaction',
        createdAt: 300,
        textEmojis: [],
        reactions: [],
      });
      expect(db.emojiStats('guild-a')[0]?.lastUsedAt).toBe(100);
      db.deleteMessage(snapshot.messageId);
      expect(db.emojiStats('guild-a')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('combines the newest date across old/new installation IDs, scoped to guild/channel', () => {
    const db = new BotDatabase(':memory:');
    try {
      db.saveAsset(asset);
      db.saveAlias('guild-a', asset.name, asset.id);
      for (const id of ['old', 'new'])
        db.saveInstallation({
          guildId: 'guild-a',
          discordEmojiId: id,
          assetId: asset.id,
          name: 'blob',
          active: id === 'new',
        });
      db.recordMessage(snapshot);
      db.recordMessage({
        ...snapshot,
        messageId: 'new',
        channelId: 'channel-b',
        createdAt: 300,
        textEmojis: [],
        reactions: [{ emojiId: 'new', count: 1 }],
      });
      expect(db.emojiStats('guild-a')[0]).toMatchObject({
        textCount: 2,
        reactionCount: 4,
        lastUsedAt: 300,
      });
      expect(db.emojiStats('guild-a', 'channel-a')[0]?.lastUsedAt).toBe(100);
      expect(db.emojiStats('guild-a', 'unscanned')[0]?.lastUsedAt).toBeNull();
      expect(db.emojiStats('guild-b')).toEqual([]);
      db.deleteMessage('new');
      expect(db.emojiStats('guild-a')[0]?.lastUsedAt).toBe(100);
    } finally {
      db.close();
    }
  });
});

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { EmojiCount } from '../emoji/parse.js';

export interface EmojiAsset {
  id: string;
  name: string;
  animated: boolean;
  contentHash: string;
  relativePath: string;
  sourceGuildId: string;
  sourceEmojiId: string;
}

export interface Installation {
  guildId: string;
  discordEmojiId: string;
  assetId: string;
  name: string;
  active: boolean;
}

export interface MessageSnapshot {
  guildId: string;
  channelId: string;
  messageId: string;
  createdAt: number;
  textEmojis: EmojiCount[];
  reactions: EmojiCount[];
}

export interface EmojiStats {
  emojiId: string;
  assetId: string | null;
  name: string | null;
  textCount: number;
  reactionCount: number;
  lastUsedAt: number | null;
}

export interface LibraryEmoji {
  assetId: string;
  name: string;
  animated: boolean;
  active: boolean;
}

export interface RankedEmoji extends EmojiStats {
  status: 'active' | 'swapped_out' | 'archived' | 'unknown';
}

/** Inclusive contiguous scanned interval; complete means nothing accessible below it. */
export interface ScanRange {
  newestMessageId: string;
  oldestMessageId: string;
  complete: boolean;
}

type AssetRow = Omit<EmojiAsset, 'animated'> & { animated: number };

export class BotDatabase {
  private readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:')
      mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate() {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 5)
      throw new Error('Database was created by a newer Felicity version');
    if (version === 5) return;
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE emoji_assets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          animated INTEGER NOT NULL CHECK (animated IN (0, 1)),
          contentHash TEXT NOT NULL,
          relativePath TEXT NOT NULL,
          sourceGuildId TEXT NOT NULL,
          sourceEmojiId TEXT NOT NULL
        );
        CREATE TABLE emoji_installations (
          guildId TEXT NOT NULL,
          discordEmojiId TEXT NOT NULL,
          assetId TEXT NOT NULL REFERENCES emoji_assets(id),
          name TEXT NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          PRIMARY KEY (guildId, discordEmojiId)
        );
        CREATE TABLE messages (
          messageId TEXT PRIMARY KEY,
          guildId TEXT NOT NULL,
          channelId TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE INDEX messages_guild ON messages(guildId);
        CREATE TABLE emoji_usage (
          messageId TEXT NOT NULL REFERENCES messages(messageId) ON DELETE CASCADE,
          emojiId TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('text', 'reaction')),
          count INTEGER NOT NULL CHECK (count > 0),
          PRIMARY KEY (messageId, emojiId, kind)
        );
        CREATE TABLE scan_cursors (
          guildId TEXT NOT NULL,
          channelId TEXT NOT NULL,
          beforeMessageId TEXT NOT NULL,
          PRIMARY KEY (guildId, channelId)
        );
        PRAGMA user_version = 1;
      `);
      })();
    if (version < 2)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE emoji_images (
          assetId TEXT PRIMARY KEY REFERENCES emoji_assets(id),
          image BLOB NOT NULL
        );
        CREATE TABLE emoji_aliases (
          guildId TEXT NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE,
          assetId TEXT NOT NULL REFERENCES emoji_assets(id),
          PRIMARY KEY (guildId, name, assetId)
        );
        INSERT OR IGNORE INTO emoji_aliases (guildId, name, assetId)
          SELECT sourceGuildId, name, id FROM emoji_assets;
        INSERT OR IGNORE INTO emoji_aliases (guildId, name, assetId)
          SELECT guildId, name, assetId FROM emoji_installations;
        CREATE TABLE emoji_sources (
          guildId TEXT NOT NULL,
          provider TEXT NOT NULL,
          sourceId TEXT NOT NULL,
          assetId TEXT NOT NULL REFERENCES emoji_assets(id),
          PRIMARY KEY (guildId, provider, sourceId)
        );
        CREATE TABLE emoji_operations (
          id TEXT PRIMARY KEY,
          guildId TEXT NOT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          details TEXT NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        CREATE INDEX usage_emoji ON emoji_usage(emojiId);
        CREATE INDEX messages_channel ON messages(guildId, channelId);
        PRAGMA user_version = 2;
      `);
      })();
    if (version < 3)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE hosted_images (
          assetId TEXT NOT NULL REFERENCES emoji_assets(id),
          publicOrigin TEXT NOT NULL,
          imageKey TEXT NOT NULL,
          publishedAt INTEGER NOT NULL,
          PRIMARY KEY(assetId, publicOrigin)
        );
        PRAGMA user_version = 3;
      `);
      })();
    if (version < 4)
      this.db.transaction(() => {
        this.db.exec(
          'DROP TABLE IF EXISTS hosted_images; PRAGMA user_version = 4;',
        );
      })();
    if (version < 5)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE scan_ranges (
          guildId TEXT NOT NULL,
          channelId TEXT NOT NULL,
          newestMessageId TEXT NOT NULL,
          oldestMessageId TEXT NOT NULL,
          complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
          PRIMARY KEY (guildId, channelId, newestMessageId)
        );
        -- Old cursors prove only this boundary was scanned, not the newest covered ID.
        -- Preserve that boundary; the first incremental run safely rechecks above it.
        INSERT INTO scan_ranges
          SELECT guildId, channelId, beforeMessageId, beforeMessageId, 0 FROM scan_cursors;
        DROP TABLE scan_cursors;
        PRAGMA user_version = 5;
      `);
      })();
  }

  saveAsset(asset: EmojiAsset) {
    this.db
      .prepare(
        `INSERT INTO emoji_assets
      (id, name, animated, contentHash, relativePath, sourceGuildId, sourceEmojiId)
      VALUES (@id, @name, @animated, @contentHash, @relativePath, @sourceGuildId, @sourceEmojiId)
      ON CONFLICT(id) DO NOTHING`,
      )
      .run({ ...asset, animated: Number(asset.animated) });
  }

  getAsset(id: string): EmojiAsset | undefined {
    const row = this.db
      .prepare('SELECT * FROM emoji_assets WHERE id = ?')
      .get(id) as AssetRow | undefined;
    return row ? { ...row, animated: Boolean(row.animated) } : undefined;
  }

  listAssets(): EmojiAsset[] {
    return (
      this.db
        .prepare('SELECT * FROM emoji_assets ORDER BY name, id')
        .all() as AssetRow[]
    ).map((row) => ({ ...row, animated: Boolean(row.animated) }));
  }

  saveInstallation(installation: Installation) {
    this.db
      .prepare(
        `INSERT INTO emoji_installations
      (guildId, discordEmojiId, assetId, name, active)
      VALUES (@guildId, @discordEmojiId, @assetId, @name, @active)
      ON CONFLICT(guildId, discordEmojiId) DO UPDATE SET
        assetId = excluded.assetId, name = excluded.name, active = excluded.active`,
      )
      .run({ ...installation, active: Number(installation.active) });
  }

  getInstallation(
    guildId: string,
    discordEmojiId: string,
  ): Installation | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM emoji_installations WHERE guildId = ? AND discordEmojiId = ?',
      )
      .get(guildId, discordEmojiId) as
      (Omit<Installation, 'active'> & { active: number }) | undefined;
    return row ? { ...row, active: Boolean(row.active) } : undefined;
  }

  saveImage(assetId: string, image: Buffer) {
    this.db
      .prepare(
        `INSERT INTO emoji_images (assetId, image) VALUES (?, ?)
      ON CONFLICT(assetId) DO UPDATE SET image = excluded.image`,
      )
      .run(assetId, image);
  }

  getImage(assetId: string): Buffer | undefined {
    return (
      this.db
        .prepare('SELECT image FROM emoji_images WHERE assetId = ?')
        .get(assetId) as { image: Buffer } | undefined
    )?.image;
  }

  saveAlias(guildId: string, name: string, assetId: string) {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO emoji_aliases (guildId, name, assetId) VALUES (?, ?, ?)',
      )
      .run(guildId, name, assetId);
  }

  listGuildAssets(guildId: string): LibraryEmoji[] {
    return (
      this.db
        .prepare(
          `SELECT a.assetId, a.name, e.animated,
      EXISTS(SELECT 1 FROM emoji_installations i WHERE i.guildId = a.guildId AND i.assetId = a.assetId AND i.active = 1) AS active
      FROM emoji_aliases a JOIN emoji_assets e ON e.id = a.assetId
      WHERE a.guildId = ? ORDER BY a.name COLLATE NOCASE, a.assetId`,
        )
        .all(guildId) as Array<
        Omit<LibraryEmoji, 'animated' | 'active'> & {
          animated: number;
          active: number;
        }
      >
    ).map((row) => ({
      ...row,
      animated: Boolean(row.animated),
      active: Boolean(row.active),
    }));
  }

  saveSource(
    guildId: string,
    provider: string,
    sourceId: string,
    assetId: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO emoji_sources (guildId, provider, sourceId, assetId) VALUES (?, ?, ?, ?)
      ON CONFLICT(guildId, provider, sourceId) DO UPDATE SET assetId = excluded.assetId`,
      )
      .run(guildId, provider, sourceId, assetId);
  }

  getSourceAsset(
    guildId: string,
    provider: string,
    sourceId: string,
  ): EmojiAsset | undefined {
    const row = this.db
      .prepare(
        'SELECT assetId FROM emoji_sources WHERE guildId = ? AND provider = ? AND sourceId = ?',
      )
      .get(guildId, provider, sourceId) as { assetId: string } | undefined;
    return row ? this.getAsset(row.assetId) : undefined;
  }

  reconcileInstallations(
    guildId: string,
    current: Array<{ id: string; name: string | null }>,
  ) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE emoji_installations SET active = 0 WHERE guildId = ?')
        .run(guildId);
      const update = this.db.prepare(
        'UPDATE emoji_installations SET active = 1, name = ? WHERE guildId = ? AND discordEmojiId = ?',
      );
      for (const emoji of current) {
        update.run(emoji.name ?? 'emoji', guildId, emoji.id);
        const installation = this.getInstallation(guildId, emoji.id);
        if (installation)
          this.saveAlias(guildId, emoji.name ?? 'emoji', installation.assetId);
      }
    })();
  }

  saveOperation(
    id: string,
    guildId: string,
    kind: string,
    state: string,
    details: Record<string, unknown>,
  ) {
    this.db
      .prepare(
        `INSERT INTO emoji_operations (id, guildId, kind, state, details, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, details = excluded.details, updatedAt = excluded.updatedAt`,
      )
      .run(id, guildId, kind, state, JSON.stringify(details), Date.now());
  }

  getOperation(id: string): { state: string; details: string } | undefined {
    return this.db
      .prepare('SELECT state, details FROM emoji_operations WHERE id = ?')
      .get(id) as { state: string; details: string } | undefined;
  }

  /** Includes archived zero-use assets; scopes usage, not installation state, to the channel. */
  emojiStats(guildId: string, channelId?: string): RankedEmoji[] {
    return this.db
      .prepare(
        `
      WITH usage AS (
        SELECT COALESCE(i.assetId, 'discord:' || u.emojiId) AS identity,
          MIN(u.emojiId) AS emojiId, i.assetId,
          SUM(CASE WHEN u.kind = 'text' THEN u.count ELSE 0 END) AS textCount,
          SUM(CASE WHEN u.kind = 'reaction' THEN u.count ELSE 0 END) AS reactionCount,
          MAX(m.createdAt) AS lastUsedAt
        FROM emoji_usage u JOIN messages m ON m.messageId = u.messageId
        LEFT JOIN emoji_installations i ON i.guildId = m.guildId AND i.discordEmojiId = u.emojiId
        WHERE m.guildId = @guildId AND (@channelId IS NULL OR m.channelId = @channelId)
        GROUP BY identity
      ), known AS (
        SELECT a.assetId AS identity, a.assetId, MIN(a.name) AS name,
          CASE WHEN EXISTS(SELECT 1 FROM emoji_installations i WHERE i.guildId = @guildId AND i.assetId = a.assetId AND i.active = 1) THEN 'active'
          WHEN EXISTS(SELECT 1 FROM emoji_installations i WHERE i.guildId = @guildId AND i.assetId = a.assetId) THEN 'swapped_out'
          ELSE 'archived' END AS status
        FROM emoji_aliases a WHERE a.guildId = @guildId GROUP BY a.assetId
      )
      SELECT * FROM (SELECT COALESCE(u.emojiId, '') AS emojiId, k.assetId, k.name,
        COALESCE(u.textCount, 0) AS textCount, COALESCE(u.reactionCount, 0) AS reactionCount, u.lastUsedAt, k.status
      FROM known k LEFT JOIN usage u ON u.identity = k.identity
      UNION ALL
      SELECT u.emojiId, u.assetId, NULL AS name, u.textCount, u.reactionCount, u.lastUsedAt, 'unknown' AS status
      FROM usage u WHERE NOT EXISTS(SELECT 1 FROM known k WHERE k.identity = u.identity))
      ORDER BY (textCount + reactionCount) DESC, name, emojiId
    `,
      )
      .all({ guildId, channelId: channelId ?? null }) as RankedEmoji[];
  }

  deactivateInstallation(guildId: string, discordEmojiId: string) {
    this.db
      .prepare(
        'UPDATE emoji_installations SET active = 0 WHERE guildId = ? AND discordEmojiId = ?',
      )
      .run(guildId, discordEmojiId);
  }

  recordMessage(snapshot: MessageSnapshot) {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (messageId, guildId, channelId, createdAt)
        VALUES (@messageId, @guildId, @channelId, @createdAt)
        ON CONFLICT(messageId) DO UPDATE SET createdAt = excluded.createdAt`,
        )
        .run({
          messageId: snapshot.messageId,
          guildId: snapshot.guildId,
          channelId: snapshot.channelId,
          createdAt: snapshot.createdAt,
        });
      this.db
        .prepare('DELETE FROM emoji_usage WHERE messageId = ?')
        .run(snapshot.messageId);
      const insert = this.db.prepare(
        'INSERT INTO emoji_usage (messageId, emojiId, kind, count) VALUES (?, ?, ?, ?)',
      );
      for (const [kind, entries] of [
        ['text', snapshot.textEmojis],
        ['reaction', snapshot.reactions],
      ] as const) {
        // A Map also makes callers safe against duplicate IDs within a snapshot.
        const totals = new Map<string, number>();
        for (const entry of entries) {
          if (!Number.isSafeInteger(entry.count) || entry.count < 0)
            throw new Error('Invalid emoji count');
          if (entry.count)
            totals.set(
              entry.emojiId,
              (totals.get(entry.emojiId) ?? 0) + entry.count,
            );
        }
        for (const [emojiId, count] of totals)
          insert.run(snapshot.messageId, emojiId, kind, count);
      }
    })();
  }

  deleteMessage(messageId: string) {
    this.db.prepare('DELETE FROM messages WHERE messageId = ?').run(messageId);
  }

  topEmoji(guildId: string, limit = 10): EmojiStats[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid statistics limit');
    // Archived/re-uploaded IDs aggregate under an asset ID; unknown IDs remain separate.
    return this.db
      .prepare(
        `
      SELECT MIN(u.emojiId) AS emojiId, i.assetId AS assetId,
        MAX(i.name) AS name,
        SUM(CASE WHEN u.kind = 'text' THEN u.count ELSE 0 END) AS textCount,
        SUM(CASE WHEN u.kind = 'reaction' THEN u.count ELSE 0 END) AS reactionCount,
          MAX(m.createdAt) AS lastUsedAt
      FROM emoji_usage u
      JOIN messages m ON m.messageId = u.messageId
      LEFT JOIN emoji_installations i ON i.guildId = m.guildId AND i.discordEmojiId = u.emojiId
      WHERE m.guildId = ?
      GROUP BY COALESCE(i.assetId, 'discord:' || u.emojiId)
      ORDER BY (SUM(u.count)) DESC, MIN(u.emojiId)
      LIMIT ?
    `,
      )
      .all(guildId, limit) as EmojiStats[];
  }

  getScanRanges(guildId: string, channelId: string): ScanRange[] {
    const rows = this.db
      .prepare(
        `SELECT newestMessageId, oldestMessageId, complete
      FROM scan_ranges WHERE guildId = ? AND channelId = ?
      ORDER BY length(newestMessageId) DESC, newestMessageId DESC`,
      )
      .all(guildId, channelId) as (Omit<ScanRange, 'complete'> & {
      complete: number;
    })[];
    return rows.map((row) => ({ ...row, complete: Boolean(row.complete) }));
  }

  /** Called only after the entire fetched page was ingested. Replays are safe. */
  saveScanRange(
    guildId: string,
    channelId: string,
    range: ScanRange,
    reset = false,
  ) {
    this.db.transaction(() => {
      let newest = BigInt(range.newestMessageId);
      let oldest = BigInt(range.oldestMessageId);
      if (oldest < 0n || newest < oldest) throw new Error('Invalid scan range');
      let complete = range.complete;
      const retained: ScanRange[] = [];
      for (const previous of reset
        ? []
        : this.getScanRanges(guildId, channelId)) {
        const upper = BigInt(previous.newestMessageId);
        const lower = BigInt(previous.oldestMessageId);
        if (
          (complete || upper >= oldest) &&
          (previous.complete || newest >= lower)
        ) {
          if (upper > newest) newest = upper;
          if (lower < oldest) oldest = lower;
          complete ||= previous.complete;
        } else retained.push(previous);
      }
      this.db
        .prepare('DELETE FROM scan_ranges WHERE guildId = ? AND channelId = ?')
        .run(guildId, channelId);
      const insert = this.db.prepare(`INSERT INTO scan_ranges
        (guildId, channelId, newestMessageId, oldestMessageId, complete) VALUES (?, ?, ?, ?, ?)`);
      for (const entry of [
        ...retained,
        {
          newestMessageId: String(newest),
          oldestMessageId: String(oldest),
          complete,
        },
      ])
        insert.run(
          guildId,
          channelId,
          entry.newestMessageId,
          entry.oldestMessageId,
          Number(entry.complete),
        );
    })();
  }

  close() {
    this.db.close();
  }
}

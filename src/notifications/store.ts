import Database from 'better-sqlite3';
import type {
  Decision,
  Delivery,
  PendingPost,
  Subscription,
  Tweet,
} from './types.js';

interface PostRow {
  tweet: string;
  attempts: number;
}

interface DeliveryRow extends Subscription {
  tweet: string;
  classification: string;
}

export class NotificationStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    this.db
      .transaction(() => {
        const version = this.db.pragma('user_version', {
          simple: true,
        }) as number;
        if (version > 1)
          throw new Error(
            'Notifications database was created by a newer Felicity version',
          );
        if (version === 1) return;
        this.db.exec(`
        CREATE TABLE subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          since INTEGER NOT NULL,
          UNIQUE (guild_id, channel_id)
        );
        CREATE TABLE posts (
          id TEXT PRIMARY KEY,
          tweet TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          classification TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX posts_created_at ON posts(created_at);
        CREATE TABLE deliveries (
          post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
          state TEXT NOT NULL DEFAULT 'pending'
            CHECK (state IN ('pending', 'sending', 'sent', 'uncertain')),
          PRIMARY KEY (post_id, subscription_id)
        );
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      })
      .immediate();
  }

  close(): void {
    this.db.close();
  }

  subscriptions(): Subscription[] {
    return this.db
      .prepare(
        `
      SELECT id, guild_id AS guildId, channel_id AS channelId, since
      FROM subscriptions ORDER BY id
    `,
      )
      .all() as Subscription[];
  }

  register(guildId: string, channelId: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `
      INSERT OR IGNORE INTO subscriptions (guild_id, channel_id, since)
      VALUES (?, ?, ?)
    `,
        )
        .run(guildId, channelId, now).changes > 0
    );
  }

  unregister(guildId: string, channelId: string): boolean {
    return (
      this.db
        .prepare(
          `
      DELETE FROM subscriptions WHERE guild_id = ? AND channel_id = ?
    `,
        )
        .run(guildId, channelId).changes > 0
    );
  }

  removeChannel(channelId: string): void {
    this.db
      .prepare('DELETE FROM subscriptions WHERE channel_id = ?')
      .run(channelId);
  }

  removeGuild(guildId: string): void {
    this.db
      .prepare('DELETE FROM subscriptions WHERE guild_id = ?')
      .run(guildId);
  }

  getNumber(key: string): number | undefined {
    const row = this.db
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(key) as { value: number } | undefined;
    return row?.value;
  }

  setNumber(key: string, value: number): void {
    this.db
      .prepare(
        `
      INSERT INTO metadata (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `,
      )
      .run(key, value);
  }

  enqueue(tweets: Tweet[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO posts (id, tweet, created_at) VALUES (?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const tweet of tweets)
        insert.run(tweet.id, JSON.stringify(tweet), tweet.createdAt);
    })();
  }

  pending(now: number): PendingPost | undefined {
    const row = this.db
      .prepare(
        `
      SELECT tweet, attempts FROM posts
      WHERE classification IS NULL AND next_attempt <= ?
        AND EXISTS (SELECT 1 FROM subscriptions WHERE since <= posts.created_at)
      ORDER BY created_at, id LIMIT 1
    `,
      )
      .get(now) as PostRow | undefined;
    return row
      ? { tweet: JSON.parse(row.tweet) as Tweet, attempts: row.attempts }
      : undefined;
  }

  defer(id: string, until: number): void {
    this.db
      .prepare(
        `
      UPDATE posts SET attempts = attempts + 1, next_attempt = ?
      WHERE id = ? AND classification IS NULL
    `,
      )
      .run(until, id);
  }

  complete(id: string, decision: Decision): void {
    this.db
      .transaction(() => {
        const updated = this.db
          .prepare(
            `
        UPDATE posts SET classification = ? WHERE id = ? AND classification IS NULL
      `,
          )
          .run(JSON.stringify(decision), id);
        if (updated.changes === 0 || decision.category === 'neither') return;
        this.db
          .prepare(
            `
        INSERT OR IGNORE INTO deliveries (post_id, subscription_id)
        SELECT posts.id, subscriptions.id FROM posts JOIN subscriptions
          ON subscriptions.since <= posts.created_at
        WHERE posts.id = ?
      `,
          )
          .run(id);
      })
      .immediate();
  }

  deliveries(limit = 20): Delivery[] {
    const rows = this.db
      .prepare(
        `
      SELECT subscriptions.id, guild_id AS guildId, channel_id AS channelId, since,
        tweet, classification
      FROM deliveries
      JOIN subscriptions ON subscriptions.id = deliveries.subscription_id
      JOIN posts ON posts.id = deliveries.post_id
      WHERE state = 'pending'
      ORDER BY posts.created_at, posts.id, subscriptions.id LIMIT ?
    `,
      )
      .all(limit) as DeliveryRow[];
    return rows.map((row) => ({
      subscription: {
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        since: row.since,
      },
      tweet: JSON.parse(row.tweet) as Tweet,
      decision: JSON.parse(row.classification) as Decision,
    }));
  }

  claim(delivery: Delivery): boolean {
    return (
      this.db
        .prepare(
          `
      UPDATE deliveries SET state = 'sending'
      WHERE post_id = ? AND subscription_id = ? AND state = 'pending'
        AND EXISTS (SELECT 1 FROM subscriptions WHERE id = deliveries.subscription_id)
    `,
        )
        .run(delivery.tweet.id, delivery.subscription.id).changes > 0
    );
  }

  finish(delivery: Delivery, success: boolean): void {
    this.db
      .prepare(
        `
      UPDATE deliveries SET state = ?
      WHERE post_id = ? AND subscription_id = ? AND state = 'sending'
    `,
      )
      .run(
        success ? 'sent' : 'uncertain',
        delivery.tweet.id,
        delivery.subscription.id,
      );
  }

  recover(): void {
    this.db
      .prepare(
        "UPDATE deliveries SET state = 'uncertain' WHERE state = 'sending'",
      )
      .run();
  }

  reserveCredit(micros: number, limitMicros: number): boolean {
    return (
      this.db
        .prepare(
          `
      INSERT INTO metadata (key, value)
      SELECT 'creditSpentMicros', ? WHERE ? <= ?
      ON CONFLICT (key) DO UPDATE SET value = metadata.value + excluded.value
      WHERE metadata.value + excluded.value <= ?
    `,
        )
        .run(micros, micros, limitMicros, limitMicros).changes > 0
    );
  }

  settleCredit(reservedMicros: number, actualMicros: number): void {
    this.db
      .prepare(
        `
      INSERT INTO metadata (key, value) VALUES ('creditSpentMicros', MAX(0, ? - ?))
      ON CONFLICT (key) DO UPDATE SET value = MAX(0, metadata.value + ? - ?)
    `,
      )
      .run(actualMicros, reservedMicros, actualMicros, reservedMicros);
  }

  prune(before: number): void {
    this.db
      .prepare(
        `
      DELETE FROM posts WHERE created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM deliveries WHERE post_id = posts.id AND state IN ('pending', 'sending')
        )
        AND (classification IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM subscriptions WHERE since <= posts.created_at
        ))
    `,
      )
      .run(before);
  }

  forgetCheckpoint(): void {
    this.db.prepare('DELETE FROM metadata WHERE key = ?').run('pollCheckpoint');
  }
}

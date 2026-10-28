import Database from 'better-sqlite3';
import type { ChatMessage } from './types.js';

export interface ChannelState {
  model: string;
  imageModel: string;
  summary: string;
  messages: ChatMessage[];
  observedTokens: number;
}

export class ChatStore {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
      const version = this.db.pragma('user_version', {
        simple: true,
      }) as number;
      if (version > 1)
        throw new Error('AI database was created by a newer Felicity version');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          state TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS replies (
          message_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS replies_channel ON replies(channel_id);
        PRAGMA user_version = 1;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  load(channelId: string): ChannelState {
    const row = this.db
      .prepare('SELECT state FROM channels WHERE id = ?')
      .get(channelId) as { state: string } | undefined;
    return row
      ? (JSON.parse(row.state) as ChannelState)
      : {
          model: 'glm-5.3-flash',
          imageModel: 'flux-1-schnell',
          summary: '',
          messages: [],
          observedTokens: 0,
        };
  }

  save(channelId: string, guildId: string, state: ChannelState): void {
    this.db
      .prepare(
        'INSERT INTO channels (id, guild_id, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
      )
      .run(channelId, guildId, JSON.stringify(state));
  }

  markReply(channelId: string, messageId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO replies (message_id, channel_id) VALUES (?, ?)',
      )
      .run(messageId, channelId);
  }

  isReply(channelId: string, messageId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM replies WHERE message_id = ? AND channel_id = ?',
        )
        .get(messageId, channelId),
    );
  }

  clear(channelId: string): void {
    this.db.transaction(() => {
      const state = this.load(channelId);
      state.summary = '';
      state.messages = [];
      state.observedTokens = 0;
      this.db
        .prepare('UPDATE channels SET state = ? WHERE id = ?')
        .run(JSON.stringify(state), channelId);
      this.db
        .prepare('DELETE FROM replies WHERE channel_id = ?')
        .run(channelId);
    })();
  }

  removeChannel(channelId: string): void {
    this.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId);
  }
  removeGuild(guildId: string): void {
    this.db.prepare('DELETE FROM channels WHERE guild_id = ?').run(guildId);
  }
  close(): void {
    this.db.close();
  }
}

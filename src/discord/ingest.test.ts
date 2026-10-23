import { Collection } from 'discord.js';
import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { BotDatabase } from '../storage/database.js';
import { ingestMessage } from './ingest.js';

function message(bot: boolean, webhookId: string | null = null): Message {
  return {
    id: 'message',
    guildId: 'guild',
    channelId: 'channel',
    createdTimestamp: 100,
    partial: false,
    content: '<:blob:123456789012345678> 😀',
    author: { bot },
    webhookId,
    reactions: {
      cache: new Collection([
        ['custom', { emoji: { id: '123456789012345678' }, count: 2 }],
        ['unicode', { emoji: { id: null, name: '😀' }, count: 10 }],
      ]),
    },
  } as unknown as Message;
}

describe('message ingestion', () => {
  it('records custom and Unicode emoji in human text and reaction snapshots', () => {
    const db = new BotDatabase(':memory:');
    try {
      ingestMessage(db, message(false));
      expect(db.topEmoji('guild')).toEqual([
        {
          emojiId: 'unicode:😀',
          assetId: null,
          name: null,
          textCount: 1,
          reactionCount: 10,
          lastUsedAt: 100,
        },
        {
          emojiId: '123456789012345678',
          assetId: null,
          name: null,
          textCount: 1,
          reactionCount: 2,
          lastUsedAt: 100,
        },
      ]);
    } finally {
      db.close();
    }
  });
  it('replaces Unicode snapshots on edits and removes them on deletion', () => {
    const db = new BotDatabase(':memory:');
    try {
      const msg = message(false);
      ingestMessage(db, msg);
      ingestMessage(db, msg);
      expect(
        db.emojiStats('guild').find((row) => row.emojiId === 'unicode:😀'),
      ).toMatchObject({ textCount: 1, reactionCount: 10 });
      msg.content = '👍🏽';
      msg.reactions.cache.clear();
      ingestMessage(db, msg);
      expect(db.emojiStats('guild')).toEqual([
        expect.objectContaining({
          emojiId: 'unicode:👍🏽',
          textCount: 1,
          reactionCount: 0,
        }),
      ]);
      db.deleteMessage(msg.id);
      expect(db.emojiStats('guild')).toEqual([]);
    } finally {
      db.close();
    }
  });
  it('does not inflate popularity with emoji used as management-command arguments', () => {
    const db = new BotDatabase(':memory:');
    try {
      const msg = message(false);
      msg.content = ' !emoji swap <:blob:123456789012345678> replacement';
      ingestMessage(db, msg);
      expect(
        db
          .topEmoji('guild')
          .find((row) => row.emojiId === '123456789012345678'),
      ).toMatchObject({
        textCount: 0,
        reactionCount: 2,
      });
    } finally {
      db.close();
    }
  });
  it('excludes bot and webhook text, but includes reactions to those messages', () => {
    for (const msg of [message(true), message(false, 'webhook')]) {
      const db = new BotDatabase(':memory:');
      try {
        ingestMessage(db, msg);
        expect(
          db
            .topEmoji('guild')
            .find((row) => row.emojiId === '123456789012345678'),
        ).toMatchObject({
          textCount: 0,
          reactionCount: 2,
          lastUsedAt: 100,
        });
      } finally {
        db.close();
      }
    }
  });
});

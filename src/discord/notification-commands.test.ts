import type { Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmojiArchive } from '../emoji/archive.js';
import { NotificationStore } from '../notifications/store.js';
import { BotDatabase } from '../storage/database.js';
import type { CommandContext } from './context.js';
import {
  handleMessageCommand,
  parseMessageCommand,
} from './message-commands.js';
import { DiscordNotifications } from './notifications.js';
import type { Client } from 'discord.js';

describe('notification prefix command integration (offline)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [' !REGISTER openai-reset ', 'register', ['openai-reset']],
    ['!unregister openai-reset', 'unregister', ['openai-reset']],
    ['!unregister', 'unregister', []],
    ['!test OPENAI-RESET', 'test', ['OPENAI-RESET']],
    ['!test', 'test', []],
    ['!register wrong extra', 'register', ['wrong', 'extra']],
  ] as const)(
    'parses %s without losing hyphens or arguments',
    (text, group, args) => {
      expect(parseMessageCommand(text)).toEqual({
        group,
        action: group,
        args: [...args],
      });
    },
  );

  it.each([
    '!testing openai-reset',
    '!registering openai-reset',
    'hello !test openai-reset',
  ])('ignores unrelated prefix %s', (text) => {
    expect(parseMessageCommand(text)).toBeUndefined();
  });

  it('routes all three commands before emoji operations or member lookups', async () => {
    const db = new BotDatabase(':memory:');
    const store = new NotificationStore(':memory:');
    const notifications = new DiscordNotifications({} as Client, store, false);
    const command = vi
      .spyOn(notifications, 'command')
      .mockResolvedValue(undefined);
    const context: CommandContext = {
      db,
      archive: {} as EmojiArchive,
      signal: new AbortController().signal,
      running: new Set(),
      notifications,
    };
    const message = {
      author: { bot: false },
      webhookId: null,
      inGuild: () => true,
      content: '',
      reply: vi.fn(),
    } as unknown as Message;
    try {
      for (const action of ['register', 'unregister', 'test'] as const) {
        message.content = `!${action} openai-reset`;
        expect(await handleMessageCommand(message, context)).toBe(true);
        expect(command).toHaveBeenLastCalledWith(message, action, [
          'openai-reset',
        ]);
      }
    } finally {
      store.close();
      db.close();
    }
  });

  it('runs the real offline sample handler with no configured client, key or network', async () => {
    const db = new BotDatabase(':memory:');
    const store = new NotificationStore(':memory:');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network permitted'));
    const reply = vi.fn().mockResolvedValue(undefined);
    const context: CommandContext = {
      db,
      archive: {} as EmojiArchive,
      signal: new AbortController().signal,
      running: new Set(),
      notifications: new DiscordNotifications({} as Client, store, false),
    };
    const message = {
      content: '!test openai-reset',
      author: { bot: false },
      webhookId: null,
      inGuild: () => true,
      reply,
    } as unknown as Message;
    try {
      await expect(handleMessageCommand(message, context)).resolves.toBe(true);
      expect(reply).toHaveBeenCalledWith({
        content: expect.stringContaining(
          'AI confidence: **88.5%** (model estimate)',
        ),
        allowedMentions: { parse: [], repliedUser: false },
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(store.subscriptions()).toEqual([]);
    } finally {
      store.close();
      db.close();
    }
  });
});

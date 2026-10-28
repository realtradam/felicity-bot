import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatNotification,
  sampleNotification,
} from '../notifications/format.js';
import { NotificationStore } from '../notifications/store.js';
import type { Delivery } from '../notifications/types.js';
import { DiscordNotifications } from './notifications.js';
import { UserError } from './user-error.js';

const mentions = { parse: [], repliedUser: false };

function fakeChannel(
  guildId = 'guild',
  id = 'channel',
  type = ChannelType.GuildText,
) {
  const me = { id: 'bot' };
  const has = vi.fn(() => true);
  return {
    id,
    guildId,
    type,
    archived: false,
    locked: false,
    guild: {
      members: { me: me as typeof me | null, fetchMe: vi.fn(async () => me) },
    },
    isThread: () =>
      [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].some((threadType) => threadType === type),
    isSendable: vi.fn(() => true),
    permissionsFor: vi.fn(() => ({ has })),
    send: vi
      .fn<(payload: unknown) => Promise<void>>()
      .mockResolvedValue(undefined),
    has,
  };
}

function fakeMessage(channel: ReturnType<typeof fakeChannel>) {
  return {
    guildId: channel.guildId,
    channelId: channel.id,
    guild: channel.guild,
    channel,
    inGuild: vi.fn(() => true),
    reply: vi
      .fn<(payload: unknown) => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}

describe('DiscordNotifications', () => {
  let store: NotificationStore;
  let channel: ReturnType<typeof fakeChannel>;
  let message: ReturnType<typeof fakeMessage>;
  let fetchChannel: ReturnType<
    typeof vi.fn<() => Promise<ReturnType<typeof fakeChannel> | null>>
  >;
  let notifications: DiscordNotifications;

  function command(
    action: 'register' | 'unregister' | 'test',
    args = ['openai-reset'],
  ) {
    return notifications.command(message as unknown as Message, action, args);
  }

  function queued(
    category: 'reset' | 'feature' | 'neither' = 'reset',
  ): Delivery {
    store.register(channel.guildId, channel.id, 0);
    const subscription = store.subscriptions()[0]!;
    return {
      subscription,
      tweet: {
        id: '1953337039510003712',
        text: 'Update @everyone <@123> from the team',
        createdAt: 100,
        context: [],
      },
      decision: {
        category,
        confidence: category === 'feature' ? 0.831 : 0.974,
      },
    };
  }

  beforeEach(() => {
    store = new NotificationStore(':memory:');
    channel = fakeChannel();
    message = fakeMessage(channel);
    fetchChannel = vi.fn(async () => channel);
    notifications = new DiscordNotifications(
      { channels: { fetch: fetchChannel } } as unknown as Client,
      store,
      true,
    );
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
  });

  it('registers idempotently with second-aligned since, without caller lookup', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123_456);
    await command('register', ['OPENAI-RESET']);
    const first = store.subscriptions()[0];
    expect(first).toEqual({
      id: expect.any(Number),
      guildId: 'guild',
      channelId: 'channel',
      since: 123_000,
    });
    expect(channel.has).toHaveBeenCalledWith([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ]);
    expect(channel.permissionsFor).toHaveBeenCalledWith(
      channel.guild.members.me,
    );
    expect(channel.guild.members.fetchMe).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenLastCalledWith({
      content: expect.stringMatching(
        /Registered.*reset and feature.*neither.*silent/i,
      ),
      allowedMentions: mentions,
    });
    vi.spyOn(Date, 'now').mockReturnValue(999_999);
    await command('register');
    expect(store.subscriptions()).toEqual([first]);
    expect(message.reply).toHaveBeenLastCalledWith({
      content: expect.stringContaining('already registered'),
      allowedMentions: mentions,
    });
  });

  it('fetches only the bot member when it is not cached', async () => {
    channel.guild.members.me = null;
    await command('register');
    expect(channel.guild.members.fetchMe).toHaveBeenCalledTimes(1);
    expect(store.subscriptions()).toHaveLength(1);
  });

  it('saves registration while disabled with an explicit Gateway warning', async () => {
    notifications = new DiscordNotifications({} as Client, store, false);
    await command('register');
    expect(store.subscriptions()).toHaveLength(1);
    expect(message.reply).toHaveBeenCalledWith({
      content: expect.stringMatching(/saved.*monitoring is disabled.*Gateway/i),
      allowedMentions: mentions,
    });
  });

  it('keeps guild/channel registrations isolated and accepts bare unregister', async () => {
    store.register('other-guild', 'channel', 0);
    store.register('guild', 'other-channel', 0);
    await command('register');
    expect(store.subscriptions()).toHaveLength(3);
    channel.guild.members.me = null;
    channel.has.mockReturnValue(false);
    channel.isSendable.mockReturnValue(false);
    await command('unregister', []);
    expect(store.subscriptions()).toEqual([
      expect.objectContaining({ guildId: 'other-guild', channelId: 'channel' }),
      expect.objectContaining({ guildId: 'guild', channelId: 'other-channel' }),
    ]);
    expect(message.reply).toHaveBeenLastCalledWith({
      content: expect.stringContaining('Removed'),
      allowedMentions: mentions,
    });
    await command('unregister', ['OPENAI-RESET']);
    expect(message.reply).toHaveBeenLastCalledWith({
      content: expect.stringContaining('not registered'),
      allowedMentions: mentions,
    });
    expect(channel.guild.members.fetchMe).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it.each([
    ['register', []],
    ['test', []],
    ['register', ['unknown']],
    ['unregister', ['unknown']],
    ['test', ['unknown']],
    ['register', ['openai-reset', 'extra']],
    ['unregister', ['openai-reset', 'extra']],
    ['test', ['openai-reset', 'extra']],
  ] as const)('rejects invalid arguments for %s: %j', async (action, args) => {
    await expect(command(action, [...args])).rejects.toThrow(UserError);
    await expect(command(action, [...args])).rejects.toThrow(/Usage:/);
    expect(store.subscriptions()).toEqual([]);
    expect(message.reply).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(channel.permissionsFor).not.toHaveBeenCalled();
  });

  it('sends a labeled sample without enabled configuration, store mutation or any fetch', async () => {
    notifications = new DiscordNotifications({} as Client, store, false);
    store.register('other-guild', 'other-channel', 50);
    const subscriptions = store.subscriptions();
    const register = vi.spyOn(store, 'register');
    const unregister = vi.spyOn(store, 'unregister');
    const list = vi.spyOn(store, 'subscriptions');
    const enqueue = vi.spyOn(store, 'enqueue');
    message.inGuild.mockReturnValue(false);
    channel.guild.members.me = null;
    channel.has.mockReturnValue(false);
    await command('test', ['OPENAI-RESET']);
    expect(message.reply).toHaveBeenCalledWith({
      content: sampleNotification(),
      allowedMentions: mentions,
    });
    const payload = message.reply.mock.calls[0]![0] as { content: string };
    expect(payload.content).toContain('SAMPLE');
    expect(payload.content).toContain('97.4%');
    expect(payload.content).toContain('example value; no AI call');
    expect(payload.content).toContain('not a real announcement');
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.subscriptions()).toEqual(subscriptions);
    expect(channel.guild.members.fetchMe).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
  });

  it.each(['register', 'unregister'] as const)(
    'rejects %s outside a guild',
    async (action) => {
      message.inGuild.mockReturnValue(false);
      await expect(command(action)).rejects.toThrow(UserError);
      expect(store.subscriptions()).toEqual([]);
    },
  );

  it.each([
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
    ChannelType.GuildForum,
    ChannelType.DM,
  ])('rejects registration in channel type %s', async (type) => {
    message = fakeMessage(fakeChannel('guild', 'channel', type));
    await expect(command('register')).rejects.toThrow(UserError);
    expect(store.subscriptions()).toEqual([]);
  });

  it('rejects unsendable registration and missing bot permissions', async () => {
    channel.isSendable.mockReturnValue(false);
    await expect(command('register')).rejects.toThrow(UserError);
    channel.isSendable.mockReturnValue(true);
    channel.has.mockReturnValue(false);
    await expect(command('register')).rejects.toThrow(/View Channel/);
    expect(store.subscriptions()).toEqual([]);
  });

  it.each([
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])(
    'allows supported channel type %s with the correct bot send permission',
    async (type) => {
      channel = fakeChannel('guild', 'channel', type);
      message = fakeMessage(channel);
      await command('register');
      expect(store.subscriptions()).toHaveLength(1);
      expect(channel.has).toHaveBeenCalledWith([
        PermissionFlagsBits.ViewChannel,
        type === ChannelType.GuildAnnouncement
          ? PermissionFlagsBits.SendMessages
          : PermissionFlagsBits.SendMessagesInThreads,
      ]);
    },
  );

  it.each(['archived', 'locked'] as const)(
    'rejects %s threads',
    async (flag) => {
      channel = fakeChannel('guild', 'channel', ChannelType.PublicThread);
      channel[flag] = true;
      message = fakeMessage(channel);
      await expect(command('register')).rejects.toThrow(UserError);
      const delivery = queued();
      fetchChannel.mockResolvedValue(channel);
      await expect(
        notifications.deliver(delivery, new AbortController().signal),
      ).rejects.toThrow(UserError);
      expect(channel.send).not.toHaveBeenCalled();
    },
  );

  it.each(['reset', 'feature'] as const)(
    'delivers %s with selected confidence, canonical source and suppressed mentions',
    async (category) => {
      const delivery = queued(category);
      await notifications.deliver(delivery, new AbortController().signal);
      expect(fetchChannel).toHaveBeenCalledWith('channel');
      expect(channel.send).toHaveBeenCalledWith({
        content: formatNotification(delivery.tweet, delivery.decision),
        allowedMentions: mentions,
      });
      const payload = channel.send.mock.calls[0]![0] as { content: string };
      expect(payload.content).toContain(
        category === 'reset' ? '97.4%' : '83.1%',
      );
      expect(payload.content).toContain('model estimate');
      expect(payload.content).toContain(
        '<https://x.com/thsottiaux/status/1953337039510003712>',
      );
      expect(payload.content).not.toContain('<@123>');
    },
  );

  it('refuses neither through the formatter instead of sending it', async () => {
    const delivery = queued('neither');
    expect(() => formatNotification(delivery.tweet, delivery.decision)).toThrow(
      /Unrelated/,
    );
    await expect(
      notifications.deliver(delivery, new AbortController().signal),
    ).rejects.toThrow(/Unrelated/);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('rejects missing, mismatched, unsupported and unsendable delivery channels', async () => {
    const delivery = queued();
    for (const fetched of [
      null,
      fakeChannel('wrong-guild'),
      fakeChannel('guild', 'channel', ChannelType.GuildVoice),
    ]) {
      fetchChannel.mockResolvedValue(fetched);
      await expect(
        notifications.deliver(delivery, new AbortController().signal),
      ).rejects.toThrow(UserError);
    }
    channel.isSendable.mockReturnValue(false);
    fetchChannel.mockResolvedValue(channel);
    await expect(
      notifications.deliver(delivery, new AbortController().signal),
    ).rejects.toThrow(UserError);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('checks bot permissions for delivery, including uncached bot lookup', async () => {
    const delivery = queued();
    channel.guild.members.me = null;
    channel.has.mockReturnValue(false);
    await expect(
      notifications.deliver(delivery, new AbortController().signal),
    ).rejects.toThrow(/View Channel/);
    expect(channel.guild.members.fetchMe).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('checks subscription revocation after channel fetch, even after re-registration', async () => {
    const delivery = queued();
    fetchChannel.mockImplementation(async () => {
      store.unregister('guild', 'channel');
      store.register('guild', 'channel', 0);
      return channel;
    });
    await expect(
      notifications.deliver(delivery, new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(store.subscriptions()[0]?.id).not.toBe(delivery.subscription.id);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('checks subscription revocation after the awaited bot fetch immediately before sending', async () => {
    const delivery = queued();
    channel.guild.members.me = null;
    channel.guild.members.fetchMe.mockImplementation(async () => {
      store.unregister('guild', 'channel');
      return { id: 'bot' };
    });
    await notifications.deliver(delivery, new AbortController().signal);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('rejects an already aborted signal before any fetch', async () => {
    const delivery = queued();
    const controller = new AbortController();
    controller.abort();
    await expect(
      notifications.deliver(delivery, controller.signal),
    ).rejects.toThrow();
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('rejects an abort during channel fetch', async () => {
    const delivery = queued();
    const controller = new AbortController();
    fetchChannel.mockImplementation(async () => {
      controller.abort();
      return channel;
    });
    await expect(
      notifications.deliver(delivery, controller.signal),
    ).rejects.toThrow();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it('rejects an abort during bot fetch', async () => {
    const delivery = queued();
    const controller = new AbortController();
    channel.guild.members.me = null;
    channel.guild.members.fetchMe.mockImplementation(async () => {
      controller.abort();
      return { id: 'bot' };
    });
    await expect(
      notifications.deliver(delivery, controller.signal),
    ).rejects.toThrow();
    expect(channel.send).not.toHaveBeenCalled();
  });
});

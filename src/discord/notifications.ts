import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, GuildTextBasedChannel, Message } from 'discord.js';
import {
  formatNotification,
  sampleNotification,
} from '../notifications/format.js';
import type { NotificationStore } from '../notifications/store.js';
import { TOPIC } from '../notifications/types.js';
import type { Delivery } from '../notifications/types.js';
import { UserError } from './user-error.js';

const mentions = { parse: [] as never[], repliedUser: false };
const usage =
  'Usage: !register openai-reset · !unregister [openai-reset] · !test openai-reset';

function notificationChannel(
  channel: unknown,
): channel is GuildTextBasedChannel {
  if (!channel || typeof channel !== 'object' || !('type' in channel))
    return false;
  return [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].some((type) => type === channel.type);
}

async function checkChannel(channel: GuildTextBasedChannel): Promise<void> {
  if (!channel.isSendable())
    throw new UserError(
      'Notifications need a sendable server text channel or thread.',
    );
  if (channel.isThread() && (channel.archived || channel.locked))
    throw new UserError(
      'Notifications cannot use an archived or locked thread.',
    );
  const me =
    channel.guild.members.me ?? (await channel.guild.members.fetchMe());
  const sendPermission = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (
    !channel
      .permissionsFor(me)
      ?.has([PermissionFlagsBits.ViewChannel, sendPermission])
  )
    throw new UserError(
      'I need View Channel and permission to send messages in this channel.',
    );
}

export class DiscordNotifications {
  constructor(
    private readonly client: Client,
    private readonly store: NotificationStore,
    private readonly enabled: boolean,
  ) {}

  async command(
    message: Message,
    action: 'register' | 'unregister' | 'test',
    args: string[],
  ): Promise<void> {
    if (!(
      (action === 'unregister' && args.length === 0) ||
      (args.length === 1 && args[0]?.toLowerCase() === TOPIC)
    ))
      throw new UserError(usage);

    if (action === 'test') {
      await message.reply({
        content: sampleNotification(),
        allowedMentions: mentions,
      });
      return;
    }
    if (!message.inGuild())
      throw new UserError(
        'Use notification registration commands in a server.',
      );

    if (action === 'unregister') {
      const removed = this.store.unregister(message.guildId, message.channelId);
      await message.reply({
        content: removed
          ? 'Removed openai-reset notifications from this channel.'
          : 'This channel is not registered for openai-reset notifications.',
        allowedMentions: mentions,
      });
      return;
    }

    if (!notificationChannel(message.channel))
      throw new UserError(
        'Notifications need a sendable server text channel or thread.',
      );
    await checkChannel(message.channel);
    const added = this.store.register(
      message.guildId,
      message.channelId,
      Math.floor(Date.now() / 1000) * 1000,
    );
    let content = added
      ? 'Registered this channel for openai-reset notifications.'
      : 'This channel is already registered for openai-reset notifications.';
    content +=
      ' You will receive any OpenAI usage reset and daily challenge update notifications; unrelated posts (neither) stay silent.';
    if (!this.enabled)
      content +=
        ' Warning: your subscription is saved, but monitoring is disabled; check Gateway configuration and OPENAI_RESET_ENABLED.';
    await message.reply({ content, allowedMentions: mentions });
  }

  async deliver(delivery: Delivery, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const channel = await this.client.channels.fetch(
      delivery.subscription.channelId,
    );
    signal.throwIfAborted();
    if (
      !notificationChannel(channel) ||
      channel.guildId !== delivery.subscription.guildId
    )
      throw new UserError(
        'The notification channel is unavailable or belongs to another server.',
      );
    await checkChannel(channel);
    signal.throwIfAborted();
    const content = formatNotification(delivery.tweet, delivery.decision);
    if (
      !this.store
        .subscriptions()
        .some((subscription) => subscription.id === delivery.subscription.id)
    )
      return;
    await channel.send({ content, allowedMentions: mentions });
  }
}

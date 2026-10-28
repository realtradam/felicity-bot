import type { Message } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordAI,
  parseAICommand,
  responseChunks,
  typing,
  aiDisabled,
} from './ai.js';
import { ChatStore } from '../ai/store.js';
import { ChatService } from '../ai/service.js';
import { LogfareGateway } from '../ai/gateway.js';
import { AIError } from '../ai/types.js';

const signal = new AbortController().signal;
const stores: ChatStore[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture(content = '<@123> hi') {
  const store = new ChatStore(':memory:');
  stores.push(store);
  const gateway = new LogfareGateway('test');
  const models = vi.spyOn(gateway, 'models').mockResolvedValue([
    {
      id: 'glm-5.3',
      name: 'GLM 5.3',
      kind: 'chat',
      contextLength: 262144,
      locked: false,
    },
    {
      id: 'flux-1-schnell',
      name: 'FLUX.1 Schnell',
      kind: 'image',
      contextLength: 128000,
      locked: false,
    },
  ]);
  const complete = vi
    .spyOn(gateway, 'complete')
    .mockImplementation(async (model, _messages, _signal, first) => {
      first?.();
      return { text: 'Hello **there**!', model, inputTokens: 100 };
    });
  vi.spyOn(gateway, 'metrics').mockResolvedValue(
    new Map([['glm-5.3', { ttftMs: 3200, tps: 175, latencyMs: 9000 }]]),
  );
  const sendTyping = vi.fn().mockResolvedValue(undefined);
  let replyId = 0;
  const reply = vi
    .fn()
    .mockImplementation(async () => ({ id: `reply-${++replyId}` }));
  const message = {
    content,
    id: 'user-message',
    author: { id: 'user', username: 'alice', bot: false },
    webhookId: null,
    guildId: 'guild',
    channelId: 'channel',
    inGuild: () => true,
    client: { user: { id: '123' } },
    createdTimestamp: Date.parse('2026-10-28T12:34:56.000Z'),
    reference: null,
    channel: { isSendable: () => true, sendTyping },
    reply,
  } as unknown as Message;
  const service = new ChatService(store, gateway);
  return {
    ai: new DiscordAI(service),
    service,
    store,
    gateway,
    models,
    complete,
    sendTyping,
    reply,
    message,
  };
}

describe('Discord AI routing and replies', () => {
  it('parses commands without matching ordinary chat and preserves multiline image prompts', () => {
    expect(parseAICommand(' !AI model glm-5.3 ')).toEqual({
      kind: 'chat',
      action: 'model',
      arg: 'glm-5.3',
    });
    expect(parseAICommand('!image cats\nand dogs')).toEqual({
      kind: 'image',
      action: 'generate',
      arg: 'cats\nand dogs',
    });
    expect(parseAICommand('!image generate model of a car')?.arg).toBe(
      'model of a car',
    );
    expect(parseAICommand('hello !ai models')).toBeUndefined();
    expect(parseAICommand('!air')).toBeUndefined();
  });

  it.each(['hello <@123>', ' <@123> hi', '<@456> hi', 'hello'])(
    'ignores non-leading bot mentions: %s',
    async (content) => {
      const f = fixture(content);
      expect(await f.ai.handle(f.message, signal)).toBe(false);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.reply).not.toHaveBeenCalled();
    },
  );

  it.each(['<@123> hi', '<@!123> hi'])(
    'answers a leading mention with verbatim AI text and a bare-model subtext: %s',
    async (content) => {
      const f = fixture(content);
      expect(await f.ai.handle(f.message, signal)).toBe(true);
      expect(f.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Hello **there**!\n-# GLM 5.3',
          allowedMentions: { parse: [], repliedUser: false },
        }),
      );
      expect(f.sendTyping).toHaveBeenCalledTimes(1);
      const input = f.complete.mock.calls[0]![1].at(-1)!.content;
      expect(input).toContain('2026-10-28T12:34:56.000Z');
      expect(input).toContain('alice');
      expect(input).not.toContain('<@123>');
      expect(f.store.isReply('channel', 'reply-1')).toBe(true);
    },
  );

  it('starts typing only at the first token, never while waiting for inference', async () => {
    const f = fixture();
    f.complete.mockImplementationOnce(async (_m, _h, _s, first) => {
      expect(f.sendTyping).not.toHaveBeenCalled();
      first?.();
      expect(f.sendTyping).toHaveBeenCalledTimes(1);
      return { text: 'ok', model: 'glm-5.3', inputTokens: 100 };
    });
    await f.ai.handle(f.message, signal);
  });

  it('allows replies only to known AI responses in this channel, not command/notification messages', async () => {
    const f = fixture();
    await f.ai.handle(f.message, signal);
    f.message.content = 'follow-up';
    f.message.reference = {
      messageId: 'command-output',
      channelId: 'channel',
      guildId: 'guild',
      type: 0,
    };
    expect(await f.ai.handle(f.message, signal)).toBe(false);
    f.message.reference = {
      messageId: 'reply-1',
      channelId: 'other',
      guildId: 'guild',
      type: 0,
    };
    expect(await f.ai.handle(f.message, signal)).toBe(false);
    f.message.reference = {
      messageId: 'reply-1',
      channelId: 'channel',
      guildId: 'guild',
      type: 0,
    };
    expect(await f.ai.handle(f.message, signal)).toBe(true);
    expect(f.store.load('channel').messages).toHaveLength(4);
  });

  it('ignores bots, webhooks, and DMs', async () => {
    const f = fixture();
    f.message.author.bot = true;
    expect(await f.ai.handle(f.message, signal)).toBe(false);
    f.message.author.bot = false;
    f.message.webhookId = 'webhook';
    expect(await f.ai.handle(f.message, signal)).toBe(false);
    f.message.webhookId = null;
    f.message.inGuild = (() => false) as Message['inGuild'];
    expect(await f.ai.handle(f.message, signal)).toBe(false);
  });

  it('uses the tired/bed wording and sanitized relevant subtext on limits/failures', async () => {
    const f = fixture();
    f.complete.mockRejectedValueOnce(new AIError('Usage limits reached'));
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls[0]![0].content).toBe(
      "I'm tired and went to bed. I can't reply right now.\n-# Usage limits reached",
    );
    expect(f.store.isReply('channel', 'reply-1')).toBe(false);
    f.complete.mockRejectedValueOnce(new Error('SECRET UPSTREAM KEY'));
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls[1]![0].content).toContain(
      '-# AI service unavailable',
    );
    expect(f.reply.mock.calls[1]![0].content).not.toContain('SECRET');
  });

  it('splits long text losslessly within Discord limits, preserving surrogate pairs and final footer', () => {
    const text = '🌸Hello\n'.repeat(1200);
    const chunks = responseChunks(text, 'GLM 5.3');
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(
      chunks.slice(0, -1).join('') +
        chunks.at(-1)!.replace(/\n-# GLM 5.3$/, ''),
    ).toBe(text);
    expect(chunks.slice(0, -1).every((c) => !/[\uD800-\uDBFF]$/.test(c))).toBe(
      true,
    );
  });

  it('lists relevant chat and image models with observed metrics, and saves per-channel selection', async () => {
    const f = fixture('!ai models');
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls[0]![0].content).toMatch(
      /GLM 5.3.*\nTTFT 3.20s · TPS 175.0 tok\/s/,
    );
    expect(f.reply.mock.calls[0]![0].content).not.toContain('FLUX');
    f.message.content = '!image models';
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls[1]![0].content).toContain(
      'Generation latency unavailable',
    );
    expect(f.reply.mock.calls[1]![0].content).not.toContain('GLM');
    f.message.content = '!ai model glm-5.3';
    await f.ai.handle(f.message, signal);
    expect(f.store.load('channel').model).toBe('glm-5.3');
    expect(f.store.isReply('channel', 'reply-3')).toBe(false);
  });

  it('clear erases summaries/history/reply provenance while retaining selected models', async () => {
    const f = fixture();
    await f.ai.handle(f.message, signal);
    f.message.content = '!ai clear';
    await f.ai.handle(f.message, signal);
    expect(f.store.load('channel').messages).toEqual([]);
    expect(f.store.load('channel').model).toBe('glm-5.3');
    expect(f.store.isReply('channel', 'reply-1')).toBe(false);
  });

  it('generates image attachments with a model subtext without polluting chat history or reply triggers', async () => {
    const f = fixture('!image a cat');
    const image = vi.spyOn(f.gateway, 'image').mockResolvedValue({
      bytes: Buffer.from('fake-image'),
      extension: 'png',
    });
    await f.ai.handle(f.message, signal);
    expect(image).toHaveBeenCalledWith(
      'flux-1-schnell',
      'a cat',
      expect.any(AbortSignal),
    );
    expect(f.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '-# FLUX.1 Schnell',
        files: [expect.anything()],
      }),
    );
    expect(f.store.load('channel').messages).toEqual([]);
    expect(f.store.isReply('channel', 'reply-1')).toBe(false);
  });

  it('renews native typing and stops on completion or abort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const controller = new AbortController();
    const indicator = typing(f.message, controller.signal);
    indicator.start();
    indicator.start();
    await vi.advanceTimersByTimeAsync(16_001);
    expect(f.sendTyping).toHaveBeenCalledTimes(3);
    indicator.stop();
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.sendTyping).toHaveBeenCalledTimes(3);
    indicator.start();
    controller.abort();
    await vi.advanceTimersByTimeAsync(16000);
    expect(f.sendTyping).toHaveBeenCalledTimes(4);
  });

  it('cancels active inference when a channel is deleted without recreating its history', async () => {
    const f = fixture();
    let release!: () => void;
    f.complete.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { text: 'late answer', model: 'glm-5.3', inputTokens: 100 };
    });
    const pending = f.ai.handle(f.message, signal);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
    f.ai.removeChannel('channel');
    release();
    await pending;
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.store.load('channel').messages).toEqual([]);
  });

  it('tracks each long-response chunk as an AI reply target', async () => {
    const f = fixture();
    const text = 'Long answer. '.repeat(400);
    f.complete.mockResolvedValueOnce({
      text,
      model: 'glm-5.3',
      inputTokens: 100,
    });
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls.length).toBeGreaterThan(1);
    for (let i = 1; i <= f.reply.mock.calls.length; i++)
      expect(f.store.isReply('channel', `reply-${i}`)).toBe(true);
    expect(f.store.load('channel').messages.at(-1)?.content).toBe(text);
  });

  it('manual compaction and status stay local to a channel and do not track acknowledgment messages', async () => {
    const f = fixture();
    const state = f.store.load('channel');
    state.messages = [
      { role: 'user', content: 'lots of old detail '.repeat(100) },
      { role: 'assistant', content: 'old answer '.repeat(100) },
    ];
    f.store.save('channel', 'guild', state);
    f.message.content = '!ai compact';
    f.complete.mockResolvedValueOnce({
      text: 'short summary',
      model: 'glm-5.3',
      inputTokens: 100,
    });
    await f.ai.handle(f.message, signal);
    expect(f.store.load('channel').summary).toBe('short summary');
    expect(f.store.isReply('channel', 'reply-1')).toBe(false);
    f.message.content = '!ai status';
    await f.ai.handle(f.message, signal);
    expect(f.reply.mock.calls[1]![0].content).toContain('0 messages + summary');
    expect(f.store.load('other').summary).toBe('');
  });

  it('explains disabled configuration only for explicit requests', async () => {
    const f = fixture('!ai models');
    await aiDisabled(f.message);
    expect(f.reply.mock.calls[0]![0].content).toContain('not configured');
    f.message.content = 'hello';
    await aiDisabled(f.message);
    expect(f.reply).toHaveBeenCalledTimes(1);
  });
});

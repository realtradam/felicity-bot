import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationStore } from './store.js';
import { OpenAIResetMonitor } from './monitor.js';
import { PartialSourceError, RetryableError } from './types.js';
import type {
  Classifier,
  Decision,
  Delivery,
  Tweet,
  TweetSource,
} from './types.js';

const tweet = (id = '2115273253711409208', createdAt = 1_001_000): Tweet => ({
  id,
  createdAt,
  text: 'New post',
  context: [],
});
const reset: Decision = { category: 'reset', confidence: 0.97 };

describe('OpenAIResetMonitor (offline)', () => {
  let store: NotificationStore;
  let now: number;
  let fetchSince: ReturnType<typeof vi.fn<TweetSource['fetchSince']>>;
  let classify: ReturnType<typeof vi.fn<Classifier['classify']>>;
  let deliver: ReturnType<
    typeof vi.fn<(delivery: Delivery, signal: AbortSignal) => Promise<void>>
  >;
  let warn: ReturnType<
    typeof vi.fn<(details: Record<string, unknown>, message: string) => void>
  >;
  let monitor: OpenAIResetMonitor;
  let controller: AbortController;

  beforeEach(() => {
    store = new NotificationStore(':memory:');
    now = 1_010_000;
    fetchSince = vi
      .fn<TweetSource['fetchSince']>()
      .mockResolvedValue([tweet()]);
    classify = vi.fn<Classifier['classify']>().mockResolvedValue(reset);
    deliver = vi
      .fn<(delivery: Delivery, signal: AbortSignal) => Promise<void>>()
      .mockResolvedValue(undefined);
    warn = vi.fn();
    monitor = new OpenAIResetMonitor({
      store,
      source: { fetchSince },
      classifier: { classify },
      deliver,
      warn,
      now: () => now,
    });
    controller = new AbortController();
  });
  afterEach(() => store.close());

  it('does not fetch or classify with no registrations and resets its poll checkpoint', async () => {
    store.setNumber('pollCheckpoint', now);
    await monitor.tick(controller.signal);
    expect(fetchSince).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.getNumber('pollCheckpoint')).toBeUndefined();
  });

  it('classifies once and fans out to current registered channels only, carrying confidence', async () => {
    store.register('guild-a', 'channel-a', 1_000_000);
    store.register('guild-b', 'channel-b', 1_000_000);
    store.register('guild-c', 'too-new', now);
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledWith(1_000_000, controller.signal);
    expect(classify).toHaveBeenCalledExactlyOnceWith(
      tweet(),
      controller.signal,
    );
    expect(
      deliver.mock.calls.map(([delivery]) => delivery.subscription.channelId),
    ).toEqual(['channel-a', 'channel-b']);
    expect(deliver.mock.calls[0]?.[0].decision).toEqual(reset);
    expect(store.deliveries()).toEqual([]);
    now += 120_000;
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(2);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it.each(['reset', 'feature', 'neither'] as const)(
    'delivers only positive %s decisions',
    async (category) => {
      store.register('g', 'c', 1_000_000);
      classify.mockResolvedValue({ category, confidence: 0.82 });
      await monitor.tick(controller.signal);
      expect(deliver).toHaveBeenCalledTimes(category === 'neither' ? 0 : 1);
    },
  );

  it('never infers or notifies posts published before registration', async () => {
    store.register('g', 'c', now);
    await monitor.tick(controller.signal);
    expect(classify).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('paces polling separately from sequential queued inference', async () => {
    store.register('g', 'c', 1_000_000);
    fetchSince.mockResolvedValue([
      tweet(),
      tweet('2115273253711409209', 1_002_000),
    ]);
    await monitor.tick(controller.signal);
    expect(classify).toHaveBeenCalledTimes(1);
    now += 13_000;
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(1);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('polls again after one minute, not before', async () => {
    store.register('g', 'c', 1_000_000);
    await monitor.tick(controller.signal);
    expect(store.getNumber('pollNextAt')).toBe(now + 60_000);
    now += 59_999;
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(1);
    now += 1;
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(2);
  });

  it('honours persisted gateway rate limit without losing the pending post', async () => {
    store.register('g', 'c', 1_000_000);
    store.setNumber('gatewayNextRequestAt', now + 60_000);
    await monitor.tick(controller.signal);
    expect(classify).not.toHaveBeenCalled();
    now += 60_000;
    await monitor.tick(controller.signal);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('retains checkpoint after source failure and respects source retry-after', async () => {
    store.register('g', 'c', 1_000_000);
    store.setNumber('pollCheckpoint', 1_005_000);
    fetchSince.mockRejectedValue(
      new RetryableError('upstream failure', 600_000),
    );
    await monitor.tick(controller.signal);
    expect(store.getNumber('pollCheckpoint')).toBe(1_005_000);
    expect(store.getNumber('pollNextAt')).toBe(now + 600_000);
    expect(deliver).not.toHaveBeenCalled();
    now += 120_000;
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(1);
  });

  it('delivers fully contextualized partial posts without advancing across a missing-context gap', async () => {
    store.register('g', 'c', 1_000_000);
    store.setNumber('pollCheckpoint', 1_005_000);
    fetchSince.mockRejectedValue(new PartialSourceError([tweet()], 60_000));
    await monitor.tick(controller.signal);
    expect(store.getNumber('pollCheckpoint')).toBe(1_005_000);
    expect(classify).toHaveBeenCalledExactlyOnceWith(
      tweet(),
      controller.signal,
    );
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('retries classification with backoff, never converting an error into neither', async () => {
    store.register('g', 'c', 1_000_000);
    classify.mockRejectedValueOnce(new RetryableError('limited', 300_000));
    await monitor.tick(controller.signal);
    expect(deliver).not.toHaveBeenCalled();
    now += 120_000;
    await monitor.tick(controller.signal);
    expect(classify).toHaveBeenCalledTimes(1);
    now += 180_000;
    await monitor.tick(controller.signal);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('keeps inference errors out of logs', async () => {
    store.register('g', 'c', 1_000_000);
    classify.mockRejectedValue(new Error('secret-header-and-post-body'));
    await monitor.tick(controller.signal);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      'secret-header-and-post-body',
    );
    expect(warn).toHaveBeenCalled();
  });

  it('processes other queued tweets and deliveries even during a source outage', async () => {
    store.register('g', 'c', 1_000_000);
    store.enqueue([tweet()]);
    fetchSince.mockRejectedValue(new Error('outage'));
    await monitor.tick(controller.signal);
    expect(classify).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('does not deliver pending posts to a channel unregistered during inference', async () => {
    store.register('g', 'c', 1_000_000);
    classify.mockImplementation(async () => {
      store.unregister('g', 'c');
      return reset;
    });
    await monitor.tick(controller.signal);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a failed/ambiguous send cannot spam on retry; other channels still receive', async () => {
    store.register('g', 'c1', 1_000_000);
    store.register('g', 'c2', 1_000_000);
    deliver.mockRejectedValueOnce(new Error('disconnect after possible send'));
    await monitor.tick(controller.signal);
    expect(deliver).toHaveBeenCalledTimes(2);
    store.recover();
    await monitor.tick(controller.signal);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ postId: tweet().id, channelId: 'c1' }),
      expect.stringContaining('uncertain'),
    );
  });

  it('cannot overlap fetches when tick is invoked concurrently', async () => {
    store.register('g', 'c', 1_000_000);
    let resolve!: (tweets: Tweet[]) => void;
    fetchSince.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = monitor.tick(controller.signal);
    await monitor.tick(controller.signal);
    expect(fetchSince).toHaveBeenCalledTimes(1);
    resolve([tweet()]);
    await first;
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('aborts before network or delivery and can stop the long-running worker', async () => {
    store.register('g', 'c', 1_000_000);
    controller.abort();
    await monitor.tick(controller.signal);
    await monitor.run(controller.signal);
    expect(fetchSince).not.toHaveBeenCalled();
  });

  it('does not advance checkpoint or enqueue a response after shutdown begins', async () => {
    store.register('g', 'c', 1_000_000);
    fetchSince.mockImplementation(async () => {
      controller.abort();
      return [tweet()];
    });
    await monitor.tick(controller.signal);
    expect(store.getNumber('pollCheckpoint')).toBeUndefined();
    expect(store.pending(now)).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
  });
});

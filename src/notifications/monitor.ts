import { setTimeout as sleep } from 'node:timers/promises';
import { errorDetails } from '../logger.js';
import type { NotificationStore } from './store.js';
import { PartialSourceError, RetryableError } from './types.js';
import type { Classifier, Delivery, TweetSource } from './types.js';

interface MonitorOptions {
  store: NotificationStore;
  source: TweetSource;
  classifier: Classifier;
  deliver: (delivery: Delivery, signal: AbortSignal) => Promise<void>;
  warn: (details: Record<string, unknown>, message: string) => void;
  now?: () => number;
}

const POLL_MS = 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

/** One serial worker for every guild: a tweet is classified once, not once per channel. */
export class OpenAIResetMonitor {
  private readonly now: () => number;
  private busy = false;

  constructor(private readonly options: MonitorOptions) {
    this.now = options.now ?? Date.now;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick(signal);
      } catch (error) {
        if (!signal.aborted)
          this.options.warn(
            errorDetails(error),
            'Notification worker failed; will retry',
          );
      }
      try {
        await sleep(13_000, undefined, { signal });
      } catch {
        if (signal.aborted) return;
      }
    }
  }

  /** Public for deterministic offline integration tests. Never overlaps another tick. */
  async tick(signal: AbortSignal): Promise<void> {
    if (this.busy || signal.aborted) return;
    this.busy = true;
    const { store, source, classifier, warn } = this.options;
    try {
      const subscriptions = store.subscriptions();
      if (!subscriptions.length) {
        store.forgetCheckpoint();
        store.setNumber('pollNextAt', 0);
        store.prune(this.now() - RETENTION_MS);
        return;
      }
      const now = this.now();
      if (now >= (store.getNumber('pollNextAt') ?? 0)) {
        const earliest = Math.min(...subscriptions.map((s) => s.since));
        // Overlap absorbs source caching/out-of-order arrival without repeat inference.
        const since = Math.max(
          earliest,
          (store.getNumber('pollCheckpoint') ?? earliest) - 5 * 60_000,
        );
        try {
          const tweets = await source.fetchSince(since, signal);
          if (signal.aborted) return;
          store.enqueue(tweets.filter((tweet) => tweet.createdAt >= earliest));
          // Advance only after the entire bounded catch-up is durably stored.
          store.setNumber('pollCheckpoint', now);
          store.setNumber('pollNextAt', now + POLL_MS);
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof PartialSourceError)
            store.enqueue(
              error.tweets.filter((tweet) => tweet.createdAt >= earliest),
            );
          const retry =
            error instanceof RetryableError ? error.retryAfterMs : POLL_MS;
          store.setNumber('pollNextAt', now + Math.max(POLL_MS, retry));
          warn(
            errorDetails(error),
            'Tweet retrieval failed; checkpoint retained',
          );
        }
      }
      if (signal.aborted) return;
      const pending = store.pending(this.now());
      if (
        pending &&
        this.now() >= (store.getNumber('gatewayNextRequestAt') ?? 0)
      ) {
        try {
          const decision = await classifier.classify(pending.tweet, signal);
          if (signal.aborted) return;
          store.complete(pending.tweet.id, decision);
        } catch (error) {
          if (signal.aborted) return;
          const backoff = Math.min(
            6 * 60 * 60_000,
            60_000 * 2 ** Math.min(pending.attempts, 9),
          );
          const retry =
            error instanceof RetryableError ? error.retryAfterMs : 0;
          store.defer(pending.tweet.id, this.now() + Math.max(backoff, retry));
          warn(
            errorDetails(error),
            'Tweet classification deferred; no fallback or notification',
          );
        }
      }
      for (const delivery of store.deliveries()) {
        if (signal.aborted) break;
        if (!store.claim(delivery)) continue;
        try {
          await this.options.deliver(delivery, signal);
          store.finish(delivery, true);
        } catch (error) {
          // Sending may have succeeded before a connection failed. Do not spam on retry/restart.
          store.finish(delivery, false);
          warn(
            {
              ...errorDetails(error),
              postId: delivery.tweet.id,
              channelId: delivery.subscription.channelId,
            },
            'Notification delivery uncertain; inspect Discord before manual recovery',
          );
        }
      }
      store.prune(this.now() - RETENTION_MS);
    } finally {
      this.busy = false;
    }
  }
}

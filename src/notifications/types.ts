export const MONITORED_HANDLE = 'thsottiaux';
export const MONITORED_AUTHOR_ID = '1953337039510003712';
export const DECISION_MODEL = 'perplexity/pplx-decider-v1.2';
export const TOPIC = 'openai-reset';

/** feature = daily-challenge update only; reset has no challenge restriction. */
export type Category = 'reset' | 'feature' | 'neither';

export interface LinkedContext {
  relation: 'parent' | 'quote';
  depth: number;
  text: string;
  is_monitored_author: boolean;
}

export interface Tweet {
  id: string;
  text: string;
  /** Unix milliseconds. */
  createdAt: number;
  context: LinkedContext[];
}

export interface Decision {
  category: Category;
  confidence: number;
}

export interface Subscription {
  id: number;
  guildId: string;
  channelId: string;
  since: number;
}

export interface PendingPost {
  tweet: Tweet;
  attempts: number;
}

export interface Delivery {
  subscription: Subscription;
  tweet: Tweet;
  decision: Decision;
}

export interface TweetSource {
  /** Throw rather than silently skipping a gap beyond the bounded timeline. */
  fetchSince(since: number, signal: AbortSignal): Promise<Tweet[]>;
}

export interface Classifier {
  classify(tweet: Tweet, signal: AbortSignal): Promise<Decision>;
}

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs = 60_000,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Safe, fully contextualized posts from a batch whose checkpoint must not advance. */
export class PartialSourceError extends RetryableError {
  constructor(
    public readonly tweets: Tweet[],
    retryAfterMs: number,
  ) {
    super(
      'Notification context unavailable or lookup budget exhausted',
      retryAfterMs,
    );
    this.name = 'PartialSourceError';
  }
}

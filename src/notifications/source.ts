import { requestJson } from './http.js';
import {
  MONITORED_AUTHOR_ID,
  MONITORED_HANDLE,
  PartialSourceError,
  RetryableError,
} from './types.js';
import type { LinkedContext, Tweet, TweetSource } from './types.js';

const PROFILE_URL =
  'https://api.fxtwitter.com/2/profile/thsottiaux/statuses?with_replies=true&count=100';
const STATUS_URL = 'https://api.fxtwitter.com/2/status/';
const SNOWFLAKE = /^\d{17,20}$/;

type ObjectValue = Record<string, unknown>;
interface Status {
  id: string;
  text: string;
  createdAt: number;
  authorId: string;
  handle: string | undefined;
  repost: boolean;
  raw: ObjectValue;
}

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}

function invalid(): never {
  throw new RetryableError('Invalid notification source response');
}

function status(value: unknown): Status | undefined {
  const raw = object(value);
  if (!raw || raw.type !== 'status') return undefined;
  const author = object(raw.author);
  // An explicitly unrelated repost can be ignored without parsing its payload.
  if (
    raw.reposted_by != null &&
    author &&
    typeof author.id === 'string' &&
    author.id !== MONITORED_AUTHOR_ID
  )
    return undefined;
  if (
    typeof raw.id !== 'string' ||
    !SNOWFLAKE.test(raw.id) ||
    typeof raw.text !== 'string' ||
    raw.text.trim().length === 0 ||
    raw.text.length > 16_000 ||
    typeof raw.created_timestamp !== 'number' ||
    !Number.isFinite(raw.created_timestamp) ||
    raw.created_timestamp <= 0 ||
    !Number.isFinite(raw.created_timestamp * 1000) ||
    !author ||
    typeof author.id !== 'string' ||
    author.id.length === 0
  )
    invalid();
  return {
    id: raw.id,
    text: raw.text,
    createdAt: raw.created_timestamp * 1000,
    authorId: author.id,
    handle:
      typeof author.screen_name === 'string' ? author.screen_name : undefined,
    repost: raw.reposted_by != null,
    raw,
  };
}

function monitored(post: Status): boolean {
  return (
    post.authorId === MONITORED_AUTHOR_ID &&
    post.handle?.toLowerCase() === MONITORED_HANDLE &&
    !post.repost
  );
}

function linkedId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) invalid();
  return value;
}

/** Reads only fixed FxTwitter endpoints; linked text never supplies a request URL. */
export class FxTwitterSource implements TweetSource {
  // Retain resolved context across bounded retries so a reply-heavy page can
  // make progress without discarding its checkpoint or doing unbounded lookups.
  private readonly contextCache = new Map<string, Status>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async fetchSince(since: number, signal: AbortSignal): Promise<Tweet[]> {
    if (!Number.isFinite(since) || since < 0) {
      throw new RangeError('Invalid notification source boundary');
    }
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const read = async (url: string): Promise<unknown> => {
      requestSignal.throwIfAborted();
      const result = await requestJson(
        url,
        { signal: requestSignal },
        this.fetcher,
      );
      requestSignal.throwIfAborted();
      return result;
    };
    const index = this.contextCache;
    const candidates = new Map<string, Status>();
    const collect = (value: unknown, depth = 0): void => {
      const post = status(value);
      if (!post) return;
      index.delete(post.id);
      index.set(post.id, post);
      if (index.size > 1000) index.delete(index.keys().next().value!);
      if (depth < 3) collect(post.raw.quote, depth + 1);
    };
    let cursor: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const url = cursor
        ? `${PROFILE_URL}&cursor=${encodeURIComponent(cursor)}`
        : PROFILE_URL;
      const payload = await read(url);
      if (payload === undefined) {
        if (page === 0) return [];
        throw new RetryableError('Incomplete notification timeline');
      }
      const data = object(payload);
      if (!data || data.code !== 200 || !Array.isArray(data.results)) invalid();
      let newest = -Infinity;
      for (const entry of data.results) {
        collect(entry);
        const post = status(entry);
        if (post && monitored(post)) {
          newest = Math.max(newest, post.createdAt);
          if (post.createdAt >= since) candidates.set(post.id, post);
        }
      }
      // Thread context and pinned posts can be older than the timeline around
      // them. A single old status is not proof that pagination caught up.
      if (data.results.length === 0 || (newest !== -Infinity && newest < since))
        break;
      const paging = data.cursor == null ? undefined : object(data.cursor);
      if (data.cursor != null && !paging) invalid();
      const bottom = paging?.bottom;
      if (bottom == null || bottom === '') break;
      if (typeof bottom !== 'string') invalid();
      if (cursors.has(bottom))
        throw new RetryableError('Notification timeline cursor cycle');
      cursors.add(bottom);
      cursor = bottom;
      if (page === 4)
        throw new RetryableError('Notification timeline page budget exhausted');
    }

    let lookups = 0;
    const contextFor = async (focal: Status): Promise<LinkedContext[]> => {
      const context: LinkedContext[] = [];
      const seen = new Set([focal.id]);
      const queue: { post: Status; depth: number }[] = [
        { post: focal, depth: 0 },
      ];
      for (
        let position = 0;
        position < queue.length && context.length < 6;
        position++
      ) {
        const current = queue[position]!;
        if (current.depth >= 3) continue;
        const parent = current.post.raw.replying_to;
        const quote = current.post.raw.quote;
        if (parent != null && !object(parent)) invalid();
        if (quote != null && !object(quote)) invalid();
        const links = [
          ['parent', linkedId(object(parent)?.status)],
          ['quote', linkedId(object(quote)?.id)],
        ] as const;
        for (const [relation, id] of links) {
          if (context.length >= 6) break;
          if (!id || seen.has(id) || BigInt(id) >= BigInt(focal.id)) continue;
          seen.add(id);
          let linked = index.get(id);
          if (!linked) {
            if (lookups >= 6) {
              throw new RetryableError(
                'Notification context lookup budget exhausted',
              );
            }
            lookups++;
            const payload = object(await read(`${STATUS_URL}${id}`));
            if (!payload || payload.code !== 200) invalid();
            linked = status(payload.status);
            if (!linked || linked.id !== id) invalid();
            collect(payload.status);
          }
          if (linked.createdAt > focal.createdAt) continue;
          const depth = current.depth + 1;
          context.push({
            relation,
            depth,
            text: linked.text,
            is_monitored_author: linked.authorId === MONITORED_AUTHOR_ID,
          });
          queue.push({ post: linked, depth });
        }
      }
      return context;
    };
    const sorted = [...candidates.values()].sort(
      (a, b) =>
        a.createdAt - b.createdAt || (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
    );
    const tweets: Tweet[] = [];
    let incomplete = false;
    let retryAfter = 60_000;
    for (const post of sorted) {
      requestSignal.throwIfAborted();
      try {
        tweets.push({
          id: post.id,
          text: post.text,
          createdAt: post.createdAt,
          context: await contextFor(post),
        });
      } catch (error) {
        requestSignal.throwIfAborted();
        incomplete = true;
        if (error instanceof RetryableError)
          retryAfter = Math.max(retryAfter, error.retryAfterMs);
      }
    }
    if (incomplete) throw new PartialSourceError(tweets, retryAfter);
    return tweets;
  }
}

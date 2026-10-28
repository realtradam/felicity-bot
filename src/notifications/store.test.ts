import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotificationStore } from './store.js';
import type { Decision, Delivery, Tweet } from './types.js';

const decision: Decision = { category: 'reset', confidence: 0.95 };
const neither: Decision = { category: 'neither', confidence: 0.9 };
const tweet = (id: string, createdAt = 100): Tweet => ({
  id,
  text: `Post ${id}`,
  createdAt,
  context: [
    {
      relation: 'quote',
      depth: 1,
      text: 'Context',
      is_monitored_author: false,
    },
  ],
});

function firstDelivery(store: NotificationStore): Delivery {
  const delivery = store.deliveries()[0];
  if (!delivery) throw new Error('Expected a pending delivery');
  return delivery;
}

function inspect<T>(filename: string, query: string): T {
  const db = new Database(filename);
  try {
    return db.prepare(query).all() as T;
  } finally {
    db.close();
  }
}

describe('NotificationStore', () => {
  let directory: string;
  let filename: string;
  let store: NotificationStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'felicity-notifications-'));
    filename = join(directory, 'notifications.sqlite');
    store = new NotificationStore(filename);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('migrates its own database and persists subscriptions, posts, decisions and metadata', () => {
    store.register('guild', 'channel', 50);
    store.enqueue([tweet('post')]);
    store.complete('post', decision);
    store.setNumber('pollCheckpoint', 123);
    const deliveries = store.deliveries();
    store.close();
    store = new NotificationStore(filename);

    expect(store.subscriptions()).toEqual([
      { id: 1, guildId: 'guild', channelId: 'channel', since: 50 },
    ]);
    expect(store.deliveries()).toEqual(deliveries);
    expect(store.getNumber('pollCheckpoint')).toBe(123);
    expect(inspect(filename, 'PRAGMA user_version')).toEqual([
      { user_version: 1 },
    ]);
    expect(inspect(filename, 'PRAGMA journal_mode')).toEqual([
      { journal_mode: 'wal' },
    ]);
  });

  it('supports a separate in-memory database', () => {
    const memory = new NotificationStore(':memory:');
    try {
      memory.register('memory-guild', 'memory-channel', 0);
      memory.enqueue([tweet('memory-post')]);
      expect(memory.pending(100)).toEqual({
        tweet: tweet('memory-post'),
        attempts: 0,
      });
      expect(store.subscriptions()).toEqual([]);
    } finally {
      memory.close();
    }
  });

  it('rejects newer schema versions without changing their data', () => {
    const futureFilename = join(directory, 'future.sqlite');
    const db = new Database(futureFilename);
    db.exec('CREATE TABLE sentinel (value TEXT); PRAGMA user_version = 2;');
    db.prepare('INSERT INTO sentinel VALUES (?)').run('preserved');
    db.close();
    expect(() => new NotificationStore(futureFilename)).toThrow(/newer/);
    expect(inspect(futureFilename, 'SELECT value FROM sentinel')).toEqual([
      { value: 'preserved' },
    ]);
    expect(inspect(futureFilename, 'PRAGMA user_version')).toEqual([
      { user_version: 2 },
    ]);
  });

  it('registers guild/channel pairs idempotently and keeps the original id and since', () => {
    expect(store.register('guild-a', 'channel-a', 50)).toBe(true);
    const original = store.subscriptions()[0];
    expect(store.register('guild-a', 'channel-a', 200)).toBe(false);
    expect(store.subscriptions()).toEqual([original]);
    expect(store.register('guild-b', 'channel-a', 75)).toBe(true);
    expect(store.register('guild-a', 'channel-b', 80)).toBe(true);
    expect(store.unregister('guild-b', 'channel-b')).toBe(false);
    expect(store.unregister('guild-b', 'channel-a')).toBe(true);
    expect(store.subscriptions().map((s) => s.channelId)).toEqual([
      'channel-a',
      'channel-b',
    ]);
  });

  it('isolates channel and guild removals and cascades their deliveries', () => {
    store.register('guild-a', 'channel-a', 0);
    store.register('guild-a', 'channel-b', 0);
    store.register('guild-b', 'channel-c', 0);
    store.register('guild-b', 'channel-a', 0);
    store.enqueue([tweet('post')]);
    store.complete('post', decision);
    expect(store.deliveries()).toHaveLength(4);

    store.removeChannel('channel-a');
    expect(store.deliveries().map((d) => d.subscription.channelId)).toEqual([
      'channel-b',
      'channel-c',
    ]);
    store.removeGuild('guild-a');
    expect(store.subscriptions()).toEqual([
      expect.objectContaining({ guildId: 'guild-b', channelId: 'channel-c' }),
    ]);
    expect(store.deliveries()).toHaveLength(1);
    store.removeGuild('missing');
    store.removeChannel('missing');
    expect(store.deliveries()).toHaveLength(1);
  });

  it('only classifies and delivers fresh posts, including the subscription boundary', () => {
    store.enqueue([
      tweet('old', 99),
      tweet('boundary', 100),
      tweet('later', 110),
    ]);
    expect(store.pending(1_000)).toBeUndefined();
    store.register('early-guild', 'early', 100);
    store.register('late-guild', 'late', 105);
    expect(store.pending(1_000)?.tweet.id).toBe('boundary');
    store.complete('boundary', decision);
    expect(store.deliveries().map((d) => d.subscription.channelId)).toEqual([
      'early',
    ]);
    expect(store.pending(1_000)?.tweet.id).toBe('later');
    store.complete('later', { category: 'feature', confidence: 0.8 });
    expect(
      store.deliveries().map((d) => [d.tweet.id, d.subscription.channelId]),
    ).toEqual([
      ['boundary', 'early'],
      ['later', 'early'],
      ['later', 'late'],
    ]);
    expect(store.pending(1_000)).toBeUndefined();
  });

  it('suppresses neither and cannot turn it into deliveries through repeated completion', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('post')]);
    store.complete('post', neither);
    store.complete('post', decision);
    expect(store.pending(1_000)).toBeUndefined();
    expect(store.deliveries()).toEqual([]);
    expect(inspect(filename, 'SELECT classification FROM posts')).toEqual([
      { classification: JSON.stringify(neither) },
    ]);
  });

  it('deduplicates enqueue and complete without changing tweets or reviving deliveries', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('post'), tweet('post')]);
    store.enqueue([{ ...tweet('post'), text: 'replacement', createdAt: 200 }]);
    expect(store.pending(1_000)).toEqual({ tweet: tweet('post'), attempts: 0 });
    store.complete('post', decision);
    store.complete('post', neither);
    const delivery = firstDelivery(store);
    expect(delivery.tweet).toEqual(tweet('post'));
    expect(delivery.decision).toEqual(decision);
    expect(store.deliveries()).toHaveLength(1);
    expect(store.claim(delivery)).toBe(true);
    store.finish(delivery, true);

    store.register('new-guild', 'new-channel', 0);
    store.complete('post', decision);
    store.enqueue([tweet('post')]);
    expect(store.deliveries()).toEqual([]);
    expect(store.pending(1_000)).toBeUndefined();
    expect(inspect(filename, 'SELECT state FROM deliveries')).toEqual([
      { state: 'sent' },
    ]);
  });

  it('unregisters without reviving old deliveries after re-registration or restart', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('post')]);
    store.complete('post', decision);
    const stale = firstDelivery(store);
    expect(store.unregister('guild', 'channel')).toBe(true);
    expect(store.claim(stale)).toBe(false);
    expect(store.deliveries()).toEqual([]);
    store.register('guild', 'channel', 0);
    expect(store.subscriptions()[0]?.id).toBeGreaterThan(stale.subscription.id);
    store.complete('post', decision);
    store.close();
    store = new NotificationStore(filename);
    store.recover();
    expect(store.deliveries()).toEqual([]);
    expect(store.claim(stale)).toBe(false);
  });

  it('selects the oldest eligible post and persists retry attempts and deadlines', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('newer', 200), tweet('older', 100)]);
    expect(store.pending(0)?.tweet.id).toBe('older');
    store.defer('older', 500);
    expect(store.pending(499)?.tweet.id).toBe('newer');
    store.defer('newer', 600);
    expect(store.pending(499)).toBeUndefined();
    expect(store.pending(500)).toEqual({ tweet: tweet('older'), attempts: 1 });
    store.defer('older', 700);
    store.close();
    store = new NotificationStore(filename);
    expect(store.pending(599)).toBeUndefined();
    expect(store.pending(600)).toEqual({
      tweet: tweet('newer', 200),
      attempts: 1,
    });
    store.complete('newer', decision);
    expect(store.pending(700)).toEqual({ tweet: tweet('older'), attempts: 2 });
  });

  it('limits pending deliveries and atomically claims them across connections', () => {
    store.register('guild', 'channel', 0);
    const tweets = Array.from({ length: 25 }, (_, index) =>
      tweet(`post-${index}`, index),
    );
    store.enqueue(tweets);
    for (const post of tweets) store.complete(post.id, decision);
    expect(store.deliveries()).toHaveLength(20);
    expect(store.deliveries(2).map((d) => d.tweet.id)).toEqual([
      'post-0',
      'post-1',
    ]);
    expect(store.deliveries(0)).toEqual([]);
    const other = new NotificationStore(filename);
    try {
      const delivery = firstDelivery(store);
      expect(store.claim(delivery)).toBe(true);
      expect(other.claim(delivery)).toBe(false);
      expect(other.deliveries(25)).toHaveLength(24);
    } finally {
      other.close();
    }
  });

  it('does not finish unclaimed sends and never retries sent or ambiguous failures', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('post')]);
    store.complete('post', decision);
    const delivery = firstDelivery(store);
    store.finish(delivery, true);
    expect(store.deliveries()).toHaveLength(1);
    expect(store.claim(delivery)).toBe(true);
    store.finish(delivery, false);
    store.finish(delivery, true);
    store.recover();
    expect(store.deliveries()).toEqual([]);
    expect(store.claim(delivery)).toBe(false);
    expect(inspect(filename, 'SELECT state FROM deliveries')).toEqual([
      { state: 'uncertain' },
    ]);
  });

  it('explicitly recovers interrupted sends as uncertain while preserving other states', () => {
    store.register('guild', 'channel', 0);
    store.enqueue([tweet('interrupted'), tweet('pending'), tweet('sent')]);
    for (const id of ['interrupted', 'pending', 'sent'])
      store.complete(id, decision);
    const deliveries = store.deliveries();
    const interrupted = deliveries.find((d) => d.tweet.id === 'interrupted')!;
    const sent = deliveries.find((d) => d.tweet.id === 'sent')!;
    expect(store.claim(interrupted)).toBe(true);
    expect(store.claim(sent)).toBe(true);
    store.finish(sent, true);
    store.close();
    store = new NotificationStore(filename);
    expect(
      inspect(
        filename,
        "SELECT state FROM deliveries WHERE post_id = 'interrupted'",
      ),
    ).toEqual([{ state: 'sending' }]);
    store.recover();
    store.recover();
    expect(store.deliveries().map((d) => d.tweet.id)).toEqual(['pending']);
    expect(store.claim(interrupted)).toBe(false);
    expect(store.claim(sent)).toBe(false);
    expect(
      inspect(
        filename,
        'SELECT post_id, state FROM deliveries ORDER BY post_id',
      ),
    ).toEqual([
      { post_id: 'interrupted', state: 'uncertain' },
      { post_id: 'pending', state: 'pending' },
      { post_id: 'sent', state: 'sent' },
    ]);
  });

  it('reserves credit atomically to an inclusive limit and settles without going negative', () => {
    expect(store.getNumber('creditSpentMicros')).toBeUndefined();
    expect(store.reserveCredit(101, 100)).toBe(false);
    expect(store.getNumber('creditSpentMicros')).toBeUndefined();
    expect(store.reserveCredit(60, 100)).toBe(true);
    const other = new NotificationStore(filename);
    try {
      expect(other.reserveCredit(41, 100)).toBe(false);
      expect(other.reserveCredit(40, 100)).toBe(true);
      expect(store.reserveCredit(1, 100)).toBe(false);
      expect(store.getNumber('creditSpentMicros')).toBe(100);
      store.settleCredit(60, 20);
      expect(other.getNumber('creditSpentMicros')).toBe(60);
      other.settleCredit(40, 70);
      expect(store.getNumber('creditSpentMicros')).toBe(90);
      store.settleCredit(1_000, 0);
      expect(store.getNumber('creditSpentMicros')).toBe(0);
    } finally {
      other.close();
    }
    store.close();
    store = new NotificationStore(filename);
    expect(store.getNumber('creditSpentMicros')).toBe(0);
    expect(store.reserveCredit(100, 100)).toBe(true);
  });

  it('settles missing credit metadata and forgets only the poll checkpoint', () => {
    store.settleCredit(100, 20);
    expect(store.getNumber('creditSpentMicros')).toBe(0);
    store.setNumber('pollCheckpoint', 10);
    store.setNumber('pollCheckpoint', 20);
    store.setNumber("untrusted' key", 42);
    expect(store.getNumber('pollCheckpoint')).toBe(20);
    expect(store.getNumber("untrusted' key")).toBe(42);
    store.forgetCheckpoint();
    store.forgetCheckpoint();
    expect(store.getNumber('pollCheckpoint')).toBeUndefined();
    expect(store.getNumber('creditSpentMicros')).toBe(0);
    expect(store.getNumber("untrusted' key")).toBe(42);
  });

  it('prunes old completed posts only after pending and sending deliveries are gone', () => {
    store.register('guild', 'channel', 0);
    const ids = [
      'pending',
      'sending',
      'sent',
      'uncertain',
      'neither',
      'unclassified',
    ];
    store.enqueue(ids.map((id) => tweet(id, 100)));
    store.enqueue([tweet('boundary', 200)]);
    for (const id of ids.filter((id) => id !== 'unclassified'))
      store.complete(id, id === 'neither' ? neither : decision);
    store.complete('boundary', neither);
    for (const delivery of store.deliveries()) {
      if (delivery.tweet.id === 'pending') continue;
      store.claim(delivery);
      if (delivery.tweet.id !== 'sending')
        store.finish(delivery, delivery.tweet.id === 'sent');
    }
    store.prune(200);
    expect(inspect(filename, 'SELECT id FROM posts ORDER BY id')).toEqual([
      { id: 'boundary' },
      { id: 'pending' },
      { id: 'sending' },
      { id: 'unclassified' },
    ]);
    store.unregister('guild', 'channel');
    store.prune(200);
    expect(inspect(filename, 'SELECT id FROM posts')).toEqual([
      { id: 'boundary' },
    ]);
    expect(inspect(filename, 'SELECT * FROM deliveries')).toEqual([]);
  });

  it('prunes unclassified posts with no matching subscriber rather than keeping them forever', () => {
    store.enqueue([tweet('old', 99), tweet('eligible', 100)]);
    store.register('guild', 'channel', 100);
    store.prune(200);
    expect(inspect(filename, 'SELECT id FROM posts')).toEqual([
      { id: 'eligible' },
    ]);
    expect(store.pending(200)?.tweet.id).toBe('eligible');
    store.removeGuild('guild');
    store.prune(200);
    expect(inspect(filename, 'SELECT id FROM posts')).toEqual([]);
  });
});

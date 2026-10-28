import { describe, expect, it, vi } from 'vitest';
import { FxTwitterSource } from './source.js';
import {
  MONITORED_AUTHOR_ID,
  PartialSourceError,
  RetryableError,
} from './types.js';

const BASE =
  'https://api.fxtwitter.com/2/profile/thsottiaux/statuses?with_replies=true&count=100';
const ID = '2115273253711409208';
const signal = () => new AbortController().signal;
const id = (offset: number) => (BigInt(ID) + BigInt(offset)).toString();
function post(offset = 0, seconds = 100, extra: Record<string, unknown> = {}) {
  return {
    type: 'status',
    id: id(offset),
    text: `post ${offset}`,
    created_timestamp: seconds,
    author: { id: MONITORED_AUTHOR_ID, screen_name: 'thsottiaux' },
    reposted_by: null,
    ...extra,
  };
}
function page(results: unknown[], bottom?: string) {
  return {
    code: 200,
    results,
    ...(bottom === undefined ? {} : { cursor: { bottom } }),
  };
}
function fixture(...responses: (unknown | Response)[]) {
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (!responses.length) throw new Error('Unexpected fake request');
    const value = responses.shift();
    return value instanceof Response ? value : Response.json(value);
  });
  return { fetcher, source: new FxTwitterSource(fetcher) };
}

describe('FxTwitterSource (fake fetch only)', () => {
  it('requires both author ID and case-insensitive handle; never emits nested quotes or reposts', async () => {
    const { source, fetcher } = fixture(
      page([
        post(0, 100, {
          author: { id: MONITORED_AUTHOR_ID, screen_name: 'ThSoTtIaUx' },
        }),
        post(1, 100, {
          author: { id: 'other', screen_name: 'thsottiaux' },
          quote: post(-1),
        }),
        post(2, 100, {
          author: { id: MONITORED_AUTHOR_ID, screen_name: 'impostor' },
        }),
        post(3, 100, { reposted_by: { id: 'other' } }),
        { type: 'tombstone' },
        { type: 'user', id: 'irrelevant' },
      ]),
    );
    expect(await source.fetchSince(100_000, signal())).toEqual([
      { id: ID, text: 'post 0', createdAt: 100_000, context: [] },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(BASE);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('pages despite count quirks, deduplicates and sorts by timestamp then numeric snowflake', async () => {
    const { source, fetcher } = fixture(
      page([post(3, 103), post(2, 102), post(0, 102)], 'bottom /?'),
      page([post(2, 102), post(1, 102), post(-1, 99)]),
    );
    const tweets = await source.fetchSince(100_000, signal());
    expect(tweets.map((tweet) => tweet.id)).toEqual([
      id(0),
      id(1),
      id(2),
      id(3),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${BASE}&cursor=bottom%20%2F%3F`);
  });

  it('does not use nested or unrelated old statuses as the boundary', async () => {
    const { source, fetcher } = fixture(
      page(
        [
          post(2, 102, { quote: post(-2, 1) }),
          post(-3, 1, { author: { id: 'other', screen_name: 'other' } }),
        ],
        'next',
      ),
      page([post(1, 101), post(-1, 99)]),
    );
    const tweets = await source.fetchSince(100_000, signal());
    expect(tweets.map((tweet) => tweet.id)).toEqual([id(1), id(2)]);
    expect(tweets[1]?.context[0]?.text).toBe('post -2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('continues pages containing no authored candidates', async () => {
    const { source, fetcher } = fixture(
      page(
        [post(-3, 1, { author: { id: 'other', screen_name: 'other' } })],
        'next',
      ),
      page([post()]),
    );
    expect(await source.fetchSince(100_000, signal())).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('builds BFS quote-to-parent context from indexed posts, ID-based authorship, and plain text', async () => {
    const parent = post(-3, 90, {
      author: { id: 'other', screen_name: 'thsottiaux' },
      text: 'https://untrusted.example/do-not-fetch',
    });
    const quote = post(-2, 95, {
      author: { id: MONITORED_AUTHOR_ID, screen_name: 'renamed' },
      replying_to: { status: parent.id },
    });
    const { source, fetcher } = fixture(
      page([post(0, 100, { quote }), parent]),
    );
    expect((await source.fetchSince(100_000, signal()))[0]?.context).toEqual([
      {
        relation: 'quote',
        depth: 1,
        text: 'post -2',
        is_monitored_author: true,
      },
      {
        relation: 'parent',
        depth: 2,
        text: parent.text,
        is_monitored_author: false,
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('orders parent before quote at each BFS depth and deduplicates cycles', async () => {
    const shared = post(-3, 90, { quote: { id: ID } });
    const parent = post(-1, 95, { quote: shared });
    const quote = post(-2, 94, { replying_to: { status: shared.id } });
    const { source } = fixture(
      page([
        post(0, 100, { replying_to: { status: parent.id }, quote }),
        parent,
      ]),
    );
    expect((await source.fetchSince(100_000, signal()))[0]?.context).toEqual([
      {
        relation: 'parent',
        depth: 1,
        text: parent.text,
        is_monitored_author: true,
      },
      {
        relation: 'quote',
        depth: 1,
        text: quote.text,
        is_monitored_author: true,
      },
      {
        relation: 'quote',
        depth: 2,
        text: shared.text,
        is_monitored_author: true,
      },
    ]);
  });

  it('rejects future timestamps and future/equal snowflakes before fetching', async () => {
    const { source, fetcher } = fixture(
      page([
        post(0, 100, { replying_to: { status: id(1) }, quote: post(-1, 101) }),
        post(2, 100, { quote: { id: id(2) } }),
      ]),
    );
    expect(
      (await source.fetchSince(100_000, signal())).map(
        (tweet) => tweet.context,
      ),
    ).toEqual([[], []]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts equal timestamp context with a lower snowflake', async () => {
    const { source } = fixture(page([post(0, 100, { quote: post(-1, 100) })]));
    expect(
      (await source.fetchSince(100_000, signal()))[0]?.context,
    ).toHaveLength(1);
  });

  it('fetches missing parents using status envelope and caches lookups across focal posts', async () => {
    const { source, fetcher } = fixture(
      page([
        post(0, 100, { replying_to: { status: id(-1) } }),
        post(1, 101, { replying_to: { status: id(-1) } }),
      ]),
      { code: 200, status: post(-1, 90), thread: [], author: {} },
    );
    const tweets = await source.fetchSince(100_000, signal());
    expect(tweets.every((tweet) => tweet.context[0]?.text === 'post -1')).toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://api.fxtwitter.com/2/status/${id(-1)}`,
    );
  });

  it.each([
    new Response(null, { status: 404 }),
    { code: 404, status: null },
    { code: 200, status: { type: 'tombstone' } },
    { code: 200, tweet: post(-1) },
    { code: 200, status: post(-2) },
    new Response(null, { status: 204 }),
  ])(
    'throws on missing/tombstoned/mismatched parent response %#',
    async (response) => {
      const { source } = fixture(
        page([post(0, 100, { replying_to: { status: id(-1) } })]),
        response,
      );
      await expect(source.fetchSince(100_000, signal())).rejects.toBeInstanceOf(
        RetryableError,
      );
    },
  );

  it('propagates upstream rate limits including retry-after', async () => {
    const { source } = fixture(
      page([post(0, 100, { replying_to: { status: id(-1) } })]),
      new Response(null, { status: 429, headers: { 'retry-after': '120' } }),
    );
    await expect(source.fetchSince(100_000, signal())).rejects.toMatchObject({
      retryAfterMs: 120_000,
    });
  });

  it('caps depth at three without fetching deeper parents', async () => {
    const third = post(-3, 97, { replying_to: { status: id(-4) } });
    const second = post(-2, 98, { quote: third });
    const first = post(-1, 99, { quote: second });
    const { source, fetcher } = fixture(page([post(0, 100, { quote: first })]));
    expect(
      (await source.fetchSince(100_000, signal()))[0]?.context.map(
        (entry) => entry.depth,
      ),
    ).toEqual([1, 2, 3]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('stops at six context entries without resolving further links', async () => {
    const parent = post(-1, 99, {
      replying_to: { status: id(-3) },
      quote: post(-4, 96),
    });
    const quote = post(-2, 98, {
      replying_to: { status: id(-5) },
      quote: post(-6, 94, { replying_to: { status: id(-8) } }),
    });
    const { source, fetcher } = fixture(
      page([
        post(0, 100, { replying_to: { status: parent.id }, quote }),
        parent,
        post(-3, 97, { replying_to: { status: id(-7) } }),
        post(-5, 95),
      ]),
    );
    expect(
      (await source.fetchSince(100_000, signal()))[0]?.context,
    ).toHaveLength(6);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws when the entire call needs more than six missing lookups', async () => {
    const focals = Array.from({ length: 7 }, (_, n) =>
      post(n, 100 + n, { replying_to: { status: id(-n - 1) } }),
    );
    const { source, fetcher } = fixture(
      page(focals),
      ...Array.from({ length: 6 }, (_, n) => ({
        code: 200,
        status: post(-n - 1, 90),
      })),
    );
    await expect(source.fetchSince(100_000, signal())).rejects.toThrow(
      'lookup budget',
    );
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it.each([page([]), new Response(null, { status: 204 })])(
    'accepts initially empty history %#',
    async (response) => {
      const { source } = fixture(response);
      expect(await source.fetchSince(0, signal())).toEqual([]);
    },
  );

  it('accepts an empty terminal page after a partial page', async () => {
    const { source } = fixture(page([post()], 'next'), page([], 'ignored'));
    expect(await source.fetchSince(0, signal())).toHaveLength(1);
  });

  it.each([
    post(),
    post(0, 100, { author: { id: 'other', screen_name: 'other' } }),
  ])('rejects 204 after any partial page %#', async (entry) => {
    const { source } = fixture(
      page([entry], 'next'),
      new Response(null, { status: 204 }),
    );
    await expect(source.fetchSince(0, signal())).rejects.toThrow('Incomplete');
  });

  it('rejects cursor cycles', async () => {
    const { source, fetcher } = fixture(
      page([post()], 'same'),
      page([post()], 'same'),
    );
    await expect(source.fetchSince(0, signal())).rejects.toThrow(
      'cursor cycle',
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('throws on five pages without boundary or end of history', async () => {
    const { source, fetcher } = fixture(
      ...Array.from({ length: 5 }, (_, n) =>
        page([post(n, 100)], `cursor${n}`),
      ),
    );
    await expect(source.fetchSince(0, signal())).rejects.toThrow('page budget');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('accepts a boundary on page five', async () => {
    const { source } = fixture(
      ...Array.from({ length: 5 }, (_, n) =>
        page([post(n, n === 4 ? 96 : 100)], `cursor${n}`),
      ),
    );
    expect(await source.fetchSince(98_000, signal())).toHaveLength(4);
  });

  it.each([NaN, Infinity, -1])(
    'rejects invalid since %s before requests',
    async (since) => {
      const { source, fetcher } = fixture();
      await expect(source.fetchSince(since, signal())).rejects.toThrow(
        RangeError,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: 500, results: [] },
    {},
    null,
    { code: 200, results: null },
    page([post(0, 100, { id: '123' })]),
    page([post(0, 100, { id: Number(ID) })]),
    page([post(0, 100, { text: '' })]),
    page([post(0, 100, { text: ' '.repeat(2) })]),
    page([post(0, 100, { text: 'x'.repeat(16_001) })]),
    page([post(0, 100, { created_timestamp: 0 })]),
    page([post(0, 100, { created_timestamp: -1 })]),
    page([post(0, 100, { created_timestamp: '100' })]),
    page([post(0, 100, { created_timestamp: Number.MAX_VALUE })]),
    page([post(0, 100, { author: { id: 123, screen_name: 'thsottiaux' } })]),
    page([post(0, 100, { author: null })]),
    page([
      post(0, 100, { replying_to: { status: 'https://untrusted.example/' } }),
    ]),
    { ...page([post()]), cursor: { bottom: 42 } },
  ])('rejects invalid source data %#', async (response) => {
    const { source } = fixture(response);
    await expect(source.fetchSince(0, signal())).rejects.toBeInstanceOf(
      RetryableError,
    );
  });

  it('rejects invalid JSON and oversize responses', async () => {
    for (const response of [
      new Response(''),
      new Response('x'.repeat(2 * 1024 * 1024 + 1)),
    ]) {
      const { source } = fixture(response);
      await expect(source.fetchSince(0, signal())).rejects.toThrow();
    }
  });

  it('propagates a pre-aborted signal without requests', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const { source, fetcher } = fixture();
    await expect(source.fetchSince(0, controller.signal)).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('combines caller abort with the fixed 15-second timeout', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled during request');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let passed: AbortSignal | null | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      passed = init?.signal;
      controller.abort(reason);
      passed?.throwIfAborted();
      throw new Error('Expected combined signal to abort');
    });
    try {
      await expect(
        new FxTwitterSource(fetcher).fetchSince(0, controller.signal),
      ).rejects.toBe(reason);
      expect(passed).not.toBe(controller.signal);
      expect(passed?.aborted).toBe(true);
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally {
      timeout.mockRestore();
    }
  });
});

it('does not stop on one old top-level monitored thread-context/pinned status', async () => {
  const { source, fetcher } = fixture(
    page([post(4, 104), post(-10, 1)], 'next'),
    page([post(3, 103), post(2, 102)]),
  );
  expect(
    (await source.fetchSince(100_000, signal())).map((tweet) => tweet.id),
  ).toEqual([id(2), id(3), id(4)]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('retains context progress across bounded retries on a reply-heavy page', async () => {
  const focals = Array.from({ length: 7 }, (_, n) =>
    post(n, 100 + n, { replying_to: { status: id(-n - 1) } }),
  );
  const { source, fetcher } = fixture(
    page(focals),
    ...Array.from({ length: 6 }, (_, n) => ({
      code: 200,
      status: post(-n - 1, 90),
    })),
    page(focals),
    { code: 200, status: post(-7, 90) },
  );
  await expect(source.fetchSince(100_000, signal())).rejects.toThrow(
    'lookup budget',
  );
  expect(await source.fetchSince(100_000, signal())).toHaveLength(7);
  expect(fetcher).toHaveBeenCalledTimes(9);
});

it('returns safe partial posts while retaining an unavailable-context gap', async () => {
  const { source } = fixture(
    page([post(0, 100, { replying_to: { status: id(-1) } }), post(1, 101)]),
    new Response(null, { status: 404 }),
  );
  await expect(source.fetchSince(100_000, signal())).rejects.toMatchObject({
    name: PartialSourceError.name,
    tweets: [{ id: id(1), text: 'post 1', createdAt: 101_000, context: [] }],
  });
});

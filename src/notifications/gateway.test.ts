import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClassifier } from './gateway.js';
import { CATEGORY_QUESTION } from './prompt.js';
import { NotificationStore } from './store.js';
import { DECISION_MODEL, RetryableError } from './types.js';
import type { Tweet } from './types.js';

const BASE = 'https://ai-gateway.vercel.sh/v1';
const API_KEY = 'injected-test-key-not-a-credential';
const tweet: Tweet = {
  id: 'private-id',
  text: 'The limits will reset today.',
  createdAt: 123,
  context: [
    {
      relation: 'quote',
      depth: 1,
      text: 'Earlier post',
      is_monitored_author: false,
    },
  ],
};
const models = () => ({
  data: [
    {
      id: DECISION_MODEL,
      model_eligibility: { status: 'eligible' },
      pricing: { input: '0.00000002', output: '0' },
    },
  ],
  request_context_availability: { http: { status: 'available' } },
});
const credits = () => ({ balance: '5.00', total_used: '0.00' });
const answer = () => ({
  model: DECISION_MODEL,
  answers: {
    category: {
      type: 'choice',
      choice: 'reset',
      probabilities: { reset: 0.7, feature: 0.2, neither: 0.1 },
    },
  },
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });

function queuedFetch(responses: Array<Response | Error>) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
}

function successfulFetch(result: unknown = answer()) {
  return queuedFetch([json(models()), json(credits()), json(result)]);
}

function withCost(cost: unknown) {
  return { ...answer(), providerMetadata: { gateway: { cost } } };
}

describe('GatewayClassifier', () => {
  let store: NotificationStore;
  let now: number;
  let signal: AbortSignal;

  beforeEach(() => {
    store = new NotificationStore(':memory:');
    now = 1_000_000;
    signal = new AbortController().signal;
  });

  afterEach(() => store.close());

  function classifier(fetcher: typeof fetch) {
    return new GatewayClassifier(API_KEY, store, fetcher, () => now);
  }

  it('preflights the fixed model and credits and sends only whitelisted evaluation fields', async () => {
    const fetcher = successfulFetch();
    const input = {
      ...tweet,
      labels: ['secret-label'],
      metadata: { private: 'private-metadata' },
      context: [
        {
          ...tweet.context[0]!,
          id: 'private-context-id',
          labels: ['private-label'],
        },
      ],
    };
    await expect(classifier(fetcher).classify(input, signal)).resolves.toEqual({
      category: 'reset',
      confidence: 0.7,
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/models?include_availability`,
      `${BASE}/credits`,
      `${BASE}/evaluate`,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${API_KEY}`,
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      fetcher.mock.calls.slice(0, 2).map(([, init]) => init?.method),
    ).toEqual(['GET', 'GET']);
    const post = fetcher.mock.calls[2]![1]!;
    expect(post.method).toBe('POST');
    expect(JSON.parse(post.body as string)).toEqual({
      model: DECISION_MODEL,
      state: {
        post: { text: tweet.text, is_monitored_author: true },
        linked_earlier_context: tweet.context,
      },
      questions: { category: CATEGORY_QUESTION },
    });
    expect(post.body).not.toMatch(/private|labels|metadata|createdAt/);
    expect(store.getNumber('creditSpentMicros')).toBe(500);
    expect(store.getNumber('gatewayNextRequestAt')).toBe(now + 13_000);
  });

  it.each([
    [
      'ineligible',
      { ...models().data[0], model_eligibility: { status: 'ineligible' } },
    ],
    ['wrong model', { ...models().data[0], id: 'another/model' }],
    [
      'missing eligibility',
      { id: DECISION_MODEL, pricing: { input: '0', output: '0' } },
    ],
    [
      'expensive input',
      { ...models().data[0], pricing: { input: '0.000000021', output: '0' } },
    ],
    [
      'paid output',
      { ...models().data[0], pricing: { input: '0', output: '0.00000001' } },
    ],
    [
      'negative input',
      { ...models().data[0], pricing: { input: -1, output: 0 } },
    ],
    ['missing output', { ...models().data[0], pricing: { input: '0' } }],
    [
      'blank input',
      { ...models().data[0], pricing: { input: '', output: '0' } },
    ],
    [
      'invalid decimal',
      { ...models().data[0], pricing: { input: '0x00', output: '0' } },
    ],
    [
      'nonfinite decimal',
      { ...models().data[0], pricing: { input: '9'.repeat(400), output: '0' } },
    ],
  ])(
    'rejects %s preflight without any POST or reservation',
    async (_name, model) => {
      const fetcher = queuedFetch([json({ ...models(), data: [model] })]);
      await expect(classifier(fetcher).classify(tweet, signal)).rejects.toThrow(
        'Notification gateway classification failed',
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(store.getNumber('creditSpentMicros')).toBeUndefined();
    },
  );

  it.each([
    { data: models().data },
    { ...models(), data: {} },
    { ...models(), data: [] },
    { ...models(), data: [null] },
    {
      ...models(),
      request_context_availability: { http: { status: 'unavailable' } },
    },
  ])('rejects malformed or unavailable model listing %j', async (listing) => {
    const fetcher = queuedFetch([json(listing)]);
    await expect(classifier(fetcher).classify(tweet, signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { balance: '5' },
    { balance: '0.099', total_used: '0' },
    { balance: '-1', total_used: '0' },
    { balance: 'NaN', total_used: '0' },
    { balance: '5', total_used: '4.99001' },
    { balance: '5', total_used: '5' },
    { balance: '5', total_used: '-0.1' },
    { balance: '5', total_used: 'Infinity' },
    { balance: null, total_used: '0' },
    { balance: '5', total_used: '' },
    { balance: '5', total_used: true },
  ])('rejects unsafe account credits %j without a POST', async (account) => {
    const fetcher = queuedFetch([json(models()), json(account)]);
    await expect(classifier(fetcher).classify(tweet, signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.getNumber('creditSpentMicros')).toBeUndefined();
  });

  it('accepts the inclusive price and credit boundaries and numeric money', async () => {
    const model = {
      ...models().data[0],
      pricing: { input: 0.00000002, output: 0 },
    };
    const fetcher = queuedFetch([
      json({ ...models(), data: [model] }),
      json({ balance: 0.1, total_used: 4.99 }),
      json(answer()),
    ]);
    await expect(classifier(fetcher).classify(tweet, signal)).resolves.toEqual({
      category: 'reset',
      confidence: 0.7,
    });
  });

  it('honours the persisted rate deadline across classifier instances before preflight', async () => {
    await classifier(successfulFetch()).classify(tweet, signal);
    now += 3_000;
    const fetcher = successfulFetch();
    await expect(
      classifier(fetcher).classify(tweet, signal),
    ).rejects.toMatchObject({
      name: 'RetryableError',
      retryAfterMs: 10_000,
    });
    expect(fetcher).not.toHaveBeenCalled();
    now += 10_000;
    await expect(classifier(fetcher).classify(tweet, signal)).resolves.toEqual({
      category: 'reset',
      confidence: 0.7,
    });
  });

  it('reserves before POST and exhausts the persisted lifetime cap without a fallback', async () => {
    store.setNumber('creditSpentMicros', 49_500);
    const fetcher = successfulFetch();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (args[1]?.method === 'POST') {
        expect(store.getNumber('creditSpentMicros')).toBe(50_000);
        expect(store.getNumber('gatewayNextRequestAt')).toBe(now + 13_000);
      }
      return original(...args);
    });
    await classifier(fetcher).classify(tweet, signal);
    now += 13_000;
    const exhausted = successfulFetch();
    await expect(
      classifier(exhausted).classify(tweet, signal),
    ).rejects.toThrow();
    expect(exhausted).toHaveBeenCalledTimes(2);
    expect(store.getNumber('creditSpentMicros')).toBe(50_000);
  });

  it.each(['transport', 'http', 'json', 'schema'])(
    'retains the full reservation on uncertain %s errors',
    async (kind) => {
      const secret = 'upstream-sensitive-body-or-token';
      const failure =
        kind === 'transport'
          ? new Error(secret)
          : kind === 'http'
            ? new Response(secret, { status: 503 })
            : kind === 'json'
              ? new Response(`invalid json ${secret}`)
              : json({ ...withCost('0'), model: secret });
      const fetcher = queuedFetch([json(models()), json(credits()), failure]);
      const error = await classifier(fetcher)
        .classify(tweet, signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(API_KEY);
      expect(store.getNumber('creditSpentMicros')).toBe(500);
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ['0', 0],
    [0, 0],
    ['0.0000011', 2],
    [0.00012, 120],
    ['0.001', 1_000],
  ])(
    'settles a valid cost %j with microdollar ceiling',
    async (cost, expected) => {
      store.setNumber('creditSpentMicros', 1_000);
      await classifier(successfulFetch(withCost(cost))).classify(tweet, signal);
      expect(store.getNumber('creditSpentMicros')).toBe(1_000 + expected);
    },
  );

  it.each([
    undefined,
    null,
    '',
    '-0.01',
    'NaN',
    'Infinity',
    true,
    {},
    '9'.repeat(400),
  ])('never assumes an absent or invalid cost %j is free', async (cost) => {
    await classifier(successfulFetch(withCost(cost))).classify(tweet, signal);
    expect(store.getNumber('creditSpentMicros')).toBe(500);
  });

  it.each([
    { ...answer(), model: 'fallback/model' },
    { answers: answer().answers },
    {
      ...answer(),
      answers: { category: { ...answer().answers.category, type: 'text' } },
    },
    {
      ...answer(),
      answers: { category: { ...answer().answers.category, choice: 'other' } },
    },
    ...[
      { reset: 0.6, feature: 0.2 },
      { reset: 0.7, feature: 0.2, neither: 0.1, extra: 0 },
      { reset: 0.5, feature: 0.2, neither: 0.1 },
      { reset: 1.1, feature: 0, neither: -0.1 },
      { reset: '0.7', feature: 0.2, neither: 0.1 },
      { reset: null, feature: 0.2, neither: 0.1 },
    ].map((probabilities) => ({
      ...withCost('0'),
      answers: { category: { ...answer().answers.category, probabilities } },
    })),
  ])(
    'rejects malformed model or answer %j without settlement or fallback',
    async (result) => {
      const fetcher = successfulFetch(result);
      await expect(
        classifier(fetcher).classify(tweet, signal),
      ).rejects.toThrow();
      expect(store.getNumber('creditSpentMicros')).toBe(500);
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it('uses the chosen probability without a confidence threshold or keyword fallback', async () => {
    const result = answer();
    result.answers.category.choice = 'neither';
    result.answers.category.probabilities = {
      reset: 0.7,
      feature: 0.19,
      neither: 0.1,
    };
    await expect(
      classifier(successfulFetch(result)).classify(tweet, signal),
    ).resolves.toEqual({
      category: 'neither',
      confidence: 0.1,
    });
  });

  it.each(['post', 'context'])(
    'rejects oversized UTF-8 %s without POST or reservation',
    async (field) => {
      const input =
        field === 'post'
          ? { ...tweet, text: '😀'.repeat(5_000) }
          : {
              ...tweet,
              context: [{ ...tweet.context[0]!, text: '😀'.repeat(5_000) }],
            };
      const fetcher = successfulFetch();
      await expect(
        classifier(fetcher).classify(input, signal),
      ).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(store.getNumber('creditSpentMicros')).toBeUndefined();
      expect(store.getNumber('gatewayNextRequestAt')).toBeUndefined();
    },
  );

  it.each(['models', 'evaluate'])(
    'persists Retry-After from %s and returns a sanitized RetryableError',
    async (stage) => {
      const failure = new Response('sensitive upstream data', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
      const fetcher = queuedFetch(
        stage === 'models'
          ? [failure]
          : [json(models()), json(credits()), failure],
      );
      const error = await classifier(fetcher)
        .classify(tweet, signal)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RetryableError);
      expect(error).toMatchObject({
        message: 'Notification gateway request deferred',
        retryAfterMs: 120_000,
      });
      expect(store.getNumber('gatewayNextRequestAt')).toBe(now + 120_000);
      expect(store.getNumber('creditSpentMicros')).toBe(
        stage === 'models' ? undefined : 500,
      );
      const retry = successfulFetch();
      await expect(
        classifier(retry).classify(tweet, signal),
      ).rejects.toBeInstanceOf(RetryableError);
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('never shortens an existing deadline when processing RetryableError', async () => {
    const fetcher = queuedFetch([
      new Response('', { status: 429, headers: { 'retry-after': '60' } }),
    ]);
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      store.setNumber('gatewayNextRequestAt', now + 180_000);
      return original(...args);
    });
    await expect(
      classifier(fetcher).classify(tweet, signal),
    ).rejects.toBeInstanceOf(RetryableError);
    expect(store.getNumber('gatewayNextRequestAt')).toBe(now + 180_000);
  });

  it('forwards caller abort through the combined timeout signal and keeps an uncertain POST charged', async () => {
    const controller = new AbortController();
    const fetcher = successfulFetch();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      const forwarded = args[1]?.signal;
      expect(forwarded).toBeInstanceOf(AbortSignal);
      if (args[1]?.method === 'POST') {
        controller.abort(new Error('private abort reason'));
        expect(forwarded?.aborted).toBe(true);
        forwarded?.throwIfAborted();
      }
      return original(...args);
    });
    await expect(
      classifier(fetcher).classify(tweet, controller.signal),
    ).rejects.toThrow('Notification gateway classification failed');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(store.getNumber('creditSpentMicros')).toBe(500);
  });

  it('does not reserve or POST if the caller aborts during preflight', async () => {
    const controller = new AbortController();
    const fetcher = successfulFetch();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => {
      if (args[0] === `${BASE}/credits`) controller.abort();
      return original(...args);
    });
    await expect(
      classifier(fetcher).classify(tweet, controller.signal),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.getNumber('creditSpentMicros')).toBeUndefined();
  });
});

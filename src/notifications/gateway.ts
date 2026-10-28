import { z } from 'zod';
import { requestJson } from './http.js';
import { CATEGORY_QUESTION } from './prompt.js';
import type { NotificationStore } from './store.js';
import { DECISION_MODEL, RetryableError } from './types.js';
import type { Classifier, Decision, Tweet } from './types.js';

const BASE_URL = 'https://ai-gateway.vercel.sh/v1';
const RESERVATION_MICROS = 500;
const LIMIT_MICROS = 50_000;
const NEXT_REQUEST_KEY = 'gatewayNextRequestAt';

// Do not coerce blanks, booleans, hexadecimal strings, or nonfinite values to money.
const decimal = z.union([
  z.number().finite().nonnegative(),
  z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .transform(Number)
    .pipe(z.number().finite().nonnegative()),
]);
const modelSchema = z.object({
  id: z.literal(DECISION_MODEL),
  model_eligibility: z.object({ status: z.literal('eligible') }),
  pricing: z.object({
    input: decimal.refine((value) => value <= 0.00000002),
    output: decimal.refine((value) => value === 0),
  }),
});
const modelsSchema = z.object({
  data: z.array(z.unknown()),
  request_context_availability: z.object({
    http: z.object({ status: z.literal('available') }),
  }),
});
const creditsSchema = z.object({
  balance: decimal.refine((value) => value >= 0.1),
  total_used: decimal.refine((value) => value <= 4.99),
});
const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.literal(DECISION_MODEL),
  answers: z.object({
    category: z.object({
      type: z.literal('choice'),
      choice: z.enum(['reset', 'feature', 'neither']),
      probabilities: z
        .object({
          reset: probability,
          feature: probability,
          neither: probability,
        })
        .strict()
        .refine(
          (values) =>
            Math.abs(values.reset + values.feature + values.neither - 1) <=
            0.02,
        ),
    }),
  }),
});
const costSchema = z.object({
  providerMetadata: z.object({ gateway: z.object({ cost: decimal }) }),
});

export class GatewayClassifier implements Classifier {
  constructor(
    private readonly apiKey: string,
    private readonly store: NotificationStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async classify(tweet: Tweet, signal: AbortSignal): Promise<Decision> {
    const remaining =
      (this.store.getNumber(NEXT_REQUEST_KEY) ?? 0) - this.now();
    if (remaining > 0)
      throw new RetryableError(
        'Notification gateway request deferred',
        remaining,
      );

    try {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(45_000),
      ]);
      const headers = { Authorization: `Bearer ${this.apiKey}` };
      const models = modelsSchema.safeParse(
        await requestJson(
          `${BASE_URL}/models?include_availability`,
          { method: 'GET', headers, signal: requestSignal },
          this.fetcher,
        ),
      );
      if (
        !models.success ||
        !models.data.data.some((model) => modelSchema.safeParse(model).success)
      )
        throw new Error('Notification gateway preflight rejected');
      const credits = creditsSchema.safeParse(
        await requestJson(
          `${BASE_URL}/credits`,
          { method: 'GET', headers, signal: requestSignal },
          this.fetcher,
        ),
      );
      if (!credits.success)
        throw new Error('Notification gateway preflight rejected');

      const body = JSON.stringify({
        model: DECISION_MODEL,
        state: {
          post: { text: tweet.text, is_monitored_author: true },
          linked_earlier_context: tweet.context.map((context) => ({
            relation: context.relation,
            depth: context.depth,
            text: context.text,
            is_monitored_author: context.is_monitored_author,
          })),
        },
        questions: { category: CATEGORY_QUESTION },
      });
      if (Buffer.byteLength(body, 'utf8') > 18_000)
        throw new Error('Notification gateway input exceeds size limit');
      // Abort before reserving if cancellation happened during preflight.
      requestSignal.throwIfAborted();
      if (!this.store.reserveCredit(RESERVATION_MICROS, LIMIT_MICROS))
        throw new Error('Notification gateway lifetime budget exhausted');
      this.store.setNumber(NEXT_REQUEST_KEY, this.now() + 13_000);
      const raw = await requestJson(
        `${BASE_URL}/evaluate`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body,
          signal: requestSignal,
        },
        this.fetcher,
      );
      const response = responseSchema.safeParse(raw);
      if (!response.success)
        throw new Error('Notification gateway response rejected');
      const cost = costSchema.safeParse(raw);
      if (cost.success) {
        const micros = Math.ceil(
          cost.data.providerMetadata.gateway.cost * 1_000_000,
        );
        if (Number.isSafeInteger(micros))
          this.store.settleCredit(RESERVATION_MICROS, micros);
      }
      const answer = response.data.answers.category;
      return {
        category: answer.choice,
        confidence: answer.probabilities[answer.choice],
      };
    } catch (error) {
      if (error instanceof RetryableError) {
        this.store.setNumber(
          NEXT_REQUEST_KEY,
          Math.max(
            this.store.getNumber(NEXT_REQUEST_KEY) ?? 0,
            this.now() + error.retryAfterMs,
          ),
        );
        throw new RetryableError(
          'Notification gateway request deferred',
          error.retryAfterMs,
        );
      }
      // Never forward transport, JSON, Zod or abort messages: they may contain upstream data.
      // eslint-disable-next-line preserve-caught-error -- A raw cause can retain credentials or upstream bodies.
      throw new Error('Notification gateway classification failed');
    }
  }
}

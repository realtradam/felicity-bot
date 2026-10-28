import { describe, expect, it, vi } from 'vitest';
import { requestJson } from './http.js';
import { RetryableError } from './types.js';

const url = 'https://api.fxtwitter.com/fixed-test';

describe('bounded notification HTTP', () => {
  it('forbids redirects, forwards abort, and parses JSON without returning headers', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ hello: 'world' }));
    const signal = new AbortController().signal;
    await expect(requestJson(url, { signal }, fetcher)).resolves.toEqual({
      hello: 'world',
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, {
      signal,
      redirect: 'error',
    });
  });
  it('returns no payload for HTTP204', async () => {
    await expect(
      requestJson(
        url,
        {},
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 })),
      ),
    ).resolves.toBeUndefined();
  });
  it('caps responses even when Content-Length is missing or incorrect', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        headers: { 'content-length': '1' },
      }),
    );
    await expect(requestJson(url, {}, fetcher)).rejects.toThrow(
      'exceeds size limit',
    );
  });
  it('honours numeric Retry-After and does not include sensitive upstream bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('sensitive-upstream-body', {
        status: 429,
        headers: { 'retry-after': '180' },
      }),
    );
    try {
      await requestJson(url, {}, fetcher);
      expect.fail('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RetryableError);
      expect((error as RetryableError).retryAfterMs).toBe(180_000);
      expect(String(error)).not.toContain('sensitive-upstream-body');
    }
  });
  it('honours date Retry-After and bounds unreasonable delays', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 28));
    try {
      for (const [header, expected] of [
        ['Wed, 28 Oct 2026 00:05:00 GMT', 300_000],
        ['999999999999', 86_400_000],
        ['invalid', 60_000],
      ] as const) {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            status: 503,
            headers: { 'retry-after': header },
          }),
        );
        await expect(requestJson(url, {}, fetcher)).rejects.toMatchObject({
          retryAfterMs: expected,
        });
      }
    } finally {
      vi.restoreAllMocks();
    }
  });
});

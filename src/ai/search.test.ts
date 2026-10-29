import { describe, expect, it, vi } from 'vitest';
import {
  ExaSearch,
  EXA_ENDPOINT,
  EXA_SEARCH_ROUTE,
  parseExaResults,
  searchArgs,
  SEARCH_TOOL,
} from './search.js';
import { AIError } from './types.js';

const signal = new AbortController().signal;
const result = {
  content: [
    { type: 'text', text: 'Relay prose must not reach the chat model' },
    {
      type: 'web_search_tool_result',
      content: [
        {
          type: 'web_search_result',
          title: 'Example',
          url: 'https://example.org/',
          snippet: 'facts',
          page_age: '2026-10-28',
        },
        { url: 'https://example.net/', description: 'fallback description' },
        { title: 'unsafe', url: 'javascript:alert(1)' },
      ],
    },
  ],
};
const call = (name = 'web_search', args: unknown = { query: 'news' }) => ({
  id: 'call-1',
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

describe('Exa-only search policy', () => {
  it('exposes exactly one query-only function, without scrape/url/action parameters', () => {
    expect(SEARCH_TOOL.function.name).toBe('web_search');
    expect(Object.keys(SEARCH_TOOL.function.parameters.properties)).toEqual([
      'query',
      'limit',
    ]);
    expect(SEARCH_TOOL.function.parameters.additionalProperties).toBe(false);
    expect(searchArgs(call())).toEqual({ query: 'news', limit: 5 });
  });

  it.each([
    'run_shell',
    'read_file',
    'image',
    'scrape',
    'crawl',
    'discord',
    '__proto__',
  ])('blocks disallowed tool %s', (name) => {
    expect(() => searchArgs(call(name))).toThrow('disallowed tool');
  });

  it.each([
    { query: '' },
    { query: ' ' },
    { query: 'a'.repeat(1001) },
    { query: 'hi', limit: 0 },
    { query: 'hi', limit: 11 },
    { query: 'hi', limit: 1.5 },
    { query: 'hi', mode: 'scrape' },
    { query: 'hi', url: 'https://example.org' },
    { query: 'hi', provider: 'firecrawl' },
  ])('rejects invalid or expanded tool arguments: %j', (args) => {
    expect(() => searchArgs(call('web_search', args))).toThrow(
      'invalid web search arguments',
    );
  });

  it('discards relay prose and returns bounded structured hits only', () => {
    const output = parseExaResults(result, 5);
    expect(JSON.parse(output)).toEqual({
      source: 'Exa via Umans',
      untrusted: true,
      results: [
        {
          title: 'Example',
          url: 'https://example.org/',
          description: 'facts · 2026-10-28',
        },
        {
          title: '(no title)',
          url: 'https://example.net/',
          description: 'fallback description',
        },
      ],
    });
    expect(output).not.toContain('Relay prose');
    expect(output).not.toContain('javascript');
    expect(JSON.parse(parseExaResults(result, 1)).results).toHaveLength(1);
    const huge = {
      content: [
        {
          type: 'web_search_tool_result',
          content: Array.from({ length: 100 }, () => ({
            title: 'x'.repeat(5000),
            url: 'https://example.org/' + 'a'.repeat(5000),
            snippet: 'b'.repeat(5000),
          })),
        },
      ],
    };
    expect(parseExaResults(huge, 10).length).toBeLessThan(40_000);
  });

  it('accepts the zero-token raw gateway envelope without trusting its text rendering', () => {
    const output = JSON.parse(
      parseExaResults(
        {
          model: 'umans-kimi-k3',
          stop_reason: 'end_turn',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_probe',
              name: 'web_search',
              input: { query: 'Discord developer documentation' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_probe',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Discord API Reference',
                  url: 'https://docs.discord.com/developers/reference',
                  encrypted_content: 'opaque',
                },
              ],
            },
            { type: 'text', text: '[Web search results] Untrusted rendering' },
          ],
        },
        5,
      ),
    );
    expect(output.results).toEqual([
      {
        title: 'Discord API Reference',
        url: 'https://docs.discord.com/developers/reference',
        description: '',
      },
    ]);
    expect(JSON.stringify(output)).not.toContain('Untrusted rendering');
    expect(JSON.stringify(output)).not.toContain('opaque');
  });

  it('distinguishes a real no-results search from absent results or server-side failure', () => {
    expect(
      JSON.parse(
        parseExaResults(
          { content: [{ type: 'web_search_tool_result', content: [] }] },
          5,
        ),
      ).results,
    ).toEqual([]);
    expect(() =>
      parseExaResults(
        { content: [{ type: 'text', text: 'made-up answer' }] },
        5,
      ),
    ).toThrow('no structured search');
    expect(() =>
      parseExaResults(
        {
          content: [
            {
              type: 'web_search_tool_result',
              content: {
                type: 'web_search_tool_result_error',
                error_code: 'max_uses_exceeded',
              },
            },
          ],
        },
        5,
      ),
    ).toThrow('Search usage limits reached');
    expect(() =>
      parseExaResults(
        {
          content: [
            {
              type: 'web_search_tool_result',
              content: { error_code: 'rate_limit_exceeded' },
            },
          ],
        },
        5,
      ),
    ).toThrow('Search usage limits reached');
  });

  it('uses the explicit raw-results route and Exa header, not the flash summarizer', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(result));
    const output = await new ExaSearch('test-umans-key', fetcher).search(
      { query: 'current news', limit: 3 },
      signal,
    );
    expect(output).toContain('facts');
    expect(fetcher).toHaveBeenCalledWith(
      EXA_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          'x-api-key': 'test-umans-key',
          Authorization: 'Bearer test-umans-key',
          'X-Umans-Websearch-Provider': 'exa',
        }),
      }),
    );
    expect(EXA_SEARCH_ROUTE).toBe('umans-kimi-k3');
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      model: EXA_SEARCH_ROUTE,
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'current news' }],
      tools: [{ type: 'web_search_20250305', max_uses: 5 }],
    });
  });

  it.each([429, 402, 401, 403, 500, 301])(
    'sanitizes HTTP %i failures without retries or fallback',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('secret provider body', { status }));
      const error = await new ExaSearch('private-key', fetcher)
        .search({ query: 'news', limit: 5 }, signal)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AIError);
      expect(String(error)).not.toContain('secret');
      expect(String(error)).not.toContain('private-key');
      expect(fetcher).toHaveBeenCalledTimes(1);
      if ([429, 402].includes(status))
        expect(String(error)).toContain('usage limits reached');
    },
  );

  it('bounds JSON and handles cancellation, timeouts and network failures safely', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('a'.repeat(2 * 1024 * 1024 + 1)))
      .mockRejectedValueOnce(new Error('private-key in error'));
    const search = new ExaSearch('test', fetcher);
    await expect(
      search.search({ query: 'news', limit: 5 }, signal),
    ).rejects.toThrow('exceeds size limit');
    await expect(
      search.search({ query: 'news', limit: 5 }, signal),
    ).rejects.toThrow('Search service unavailable');
    await expect(
      search.search({ query: 'news', limit: 5 }, AbortSignal.abort()),
    ).rejects.toThrow('cancelled');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

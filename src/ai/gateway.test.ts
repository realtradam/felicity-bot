import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { LogfareGateway } from './gateway.js';
import { AIError, bedtime } from './types.js';

const signal = new AbortController().signal;
const sse = (events: unknown[]) =>
  new Response(
    events
      .map(
        (e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const delta = (content: string) => ({
  model: 'glm-5.3',
  choices: [{ index: 0, delta: { content } }],
});
const stop = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

describe('Logfare gateway', () => {
  it('uses fixed endpoints/auth and filters out unrelated models by endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            id: 'glm-5.3',
            display_name: 'GLM 5.3',
            endpoints: ['chat/completions'],
            context_length: 262144,
            requires_training_optin: true,
            premium_unlocked: true,
          },
          { id: 'flux', endpoints: ['images/generations'] },
          { id: 'whisper', endpoints: ['audio/transcriptions'] },
          { id: 'clef', endpoints: ['decisions'] },
          { id: 'embed', endpoints: ['embeddings'] },
          { id: 'bad' },
        ],
      }),
    );
    const models = await new LogfareGateway('secret-test-key', fetcher).models(
      signal,
    );
    expect(models.map((m) => m.id).sort()).toEqual(['flux', 'glm-5.3']);
    expect(models.find((m) => m.id === 'glm-5.3')).toMatchObject({
      locked: false,
      name: 'GLM 5.3',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://logfare.ai/v1/models',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-test-key',
        }),
      }),
    );
  });

  it('preserves text and actual model, counts first reasoning token once, never exposes reasoning', async () => {
    const first = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse([
          { choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { reasoning_content: 'private reasoning' } }] },
          delta('  Hello\n'),
          delta('**world**!  '),
          stop,
          { usage: { prompt_tokens: 123 } },
          '[DONE]',
        ]),
      );
    const result = await new LogfareGateway('test', fetcher).complete(
      'logfare/auto',
      [{ role: 'user', content: 'hi' }],
      signal,
      first,
    );
    expect(result).toEqual({
      text: '  Hello\n**world**!  ',
      model: 'glm-5.3',
      inputTokens: 123,
    });
    expect(first).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      fetcher.mock.calls[0]![1]!.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('parses arbitrarily split UTF-8/SSE and stops reading at DONE', async () => {
    const bytes = new TextEncoder().encode(
      `: ping\n\ndata: ${JSON.stringify(delta('Hi 🌸'))}\n\ndata: ${JSON.stringify(stop)}\n\ndata: [DONE]\n\n`,
    );
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < bytes.length; i++)
            controller.enqueue(bytes.slice(i, i + 1));
        },
        cancel,
      }),
    );
    const gateway = new LogfareGateway(
      'test',
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    expect((await gateway.complete('glm-5.3', [], signal)).text).toBe('Hi 🌸');
    expect(cancel).toHaveBeenCalled();
  });

  it.each([429, 402, 401, 403, 404, 500, 400, 422])(
    'sanitizes HTTP %i errors',
    async (status) => {
      const gateway = new LogfareGateway(
        'private-key',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('private upstream body', { status })),
      );
      const error = await gateway
        .complete('model', [], signal)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AIError);
      expect(String(error)).not.toMatch(/private/);
      expect(bedtime(error)).toContain('tired and went to bed');
      if ([429, 402].includes(status))
        expect(bedtime(error)).toContain('-# Usage limits reached');
    },
  );

  it.each([
    [delta('unfinished')],
    [delta('unfinished'), '[DONE]'],
    [delta('truncated'), { choices: [{ finish_reason: 'length' }] }],
    [stop, '[DONE]'],
    ['not json'],
    [{ error: { code: 'rate_limit_exceeded', message: 'secret-body' } }],
  ])(
    'rejects incomplete, empty, malformed, truncated, and failed streams',
    async (...events: unknown[]) => {
      const gateway = new LogfareGateway(
        'test',
        vi.fn<typeof fetch>().mockResolvedValue(sse(events)),
      );
      await expect(
        gateway.complete('model', [], signal),
      ).rejects.toBeInstanceOf(AIError);
    },
  );

  it('accepts EOF after a stop marker, even without DONE', async () => {
    const gateway = new LogfareGateway(
      'test',
      vi.fn<typeof fetch>().mockResolvedValue(sse([delta('ok'), stop])),
    );
    expect((await gateway.complete('model', [], signal)).text).toBe('ok');
  });

  it('returns per-model 24h TTFT, TPS and latency, without hiding models when metrics fail', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            model_id: 'glm',
            avg_ttft_ms: 3143.8,
            avg_tps: 175.96,
            avg_latency_ms: 10471.8,
          },
          {
            model_id: 'image',
            avg_ttft_ms: null,
            avg_tps: null,
            avg_latency_ms: 3000,
          },
          { model_id: 'invalid', avg_tps: -1 },
        ],
      }),
    );
    const gateway = new LogfareGateway('test', fetcher);
    const metrics = await gateway.metrics(signal);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://logfare.ai/v1/status?hours=24',
    );
    expect(metrics.get('glm')).toEqual({
      ttftMs: 3143.8,
      tps: 175.96,
      latencyMs: 10471.8,
    });
    expect(metrics.get('image')?.ttftMs).toBeNull();
    expect(metrics.has('invalid')).toBe(false);
    fetcher.mockRejectedValueOnce(new Error('private network error'));
    expect((await gateway.metrics(signal)).size).toBe(0);
  });

  it('returns validated image bytes for base64 and safely downloaded URL results', async () => {
    const bytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ data: [{ b64_json: bytes.toString('base64') }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: [{ url: 'https://example.com/result.png' }] }),
      );
    const download = vi.fn().mockResolvedValue(bytes);
    const gateway = new LogfareGateway('test', fetcher, download);
    expect(await gateway.image('flux', 'a cat', signal)).toEqual({
      bytes,
      extension: 'png',
    });
    expect(download).not.toHaveBeenCalled();
    expect((await gateway.image('flux', 'a dog', signal)).bytes).toEqual(bytes);
    expect(download).toHaveBeenCalledWith(
      'https://example.com/result.png',
      expect.any(AbortSignal),
    );
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://logfare.ai/v1/images/generations',
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      model: 'flux',
      prompt: 'a cat',
    });
  });

  it('rejects invalid/oversize image payloads and respects cancellation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { b64_json: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') },
          ],
        }),
      );
    const gateway = new LogfareGateway('test', fetcher);
    await expect(gateway.image('flux', 'cat', signal)).rejects.toBeInstanceOf(
      AIError,
    );
    await expect(gateway.image('flux', 'cat', signal)).rejects.toBeInstanceOf(
      AIError,
    );
    const aborted = AbortSignal.abort();
    await expect(gateway.models(aborted)).rejects.toBeInstanceOf(AIError);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('Logfare search tool streaming', () => {
  it('accumulates split tool arguments and private reasoning for ephemeral replay, and exposes only web_search', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        { choices: [{ delta: { reasoning_content: 'private plan' } }] },
        { choices: [{ delta: { content: 'I will search.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"que' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'ry":"news"}' } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
    );
    const first = vi.fn();
    const response = await new LogfareGateway('test', fetcher).complete(
      'glm-5.3',
      [],
      signal,
      first,
      8192,
      true,
    );
    expect(response).toMatchObject({
      text: 'I will search.',
      reasoningContent: 'private plan',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"news"}' },
        },
      ],
    });
    expect(first).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('web_search');
    expect(body.parallel_tool_calls).toBe(false);
  });

  it('counts a tool-call start as first token even without visible prose', async () => {
    const first = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    function: {
                      name: 'web_search',
                      arguments: '{"query":"hi"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ]),
    );
    const response = await new LogfareGateway('test', fetcher).complete(
      'model',
      [],
      signal,
      first,
      8192,
      true,
    );
    expect(response.text).toBe('');
    expect(first).toHaveBeenCalledOnce();
  });

  it('refuses tool calls when no search tool was offered', async () => {
    const calls = [
      {
        index: 0,
        id: 'call-1',
        function: { name: 'web_search', arguments: '{}' },
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        sse([{ choices: [{ delta: { tool_calls: calls } }] }]),
      );
    await expect(
      new LogfareGateway('test', fetcher).complete('model', [], signal),
    ).rejects.toThrow('tools are disabled');
    expect(
      JSON.parse(fetcher.mock.calls[0]![1]!.body as string).tools,
    ).toBeUndefined();
  });

  it.each([
    {
      calls: [{ index: 0, function: { name: 'web_search', arguments: '{}' } }],
      finish: 'tool_calls',
    },
    {
      calls: [
        {
          index: 0,
          id: 'a',
          function: { name: 'web_search', arguments: '{}' },
        },
      ],
      finish: 'stop',
    },
    { calls: [], finish: 'tool_calls' },
    {
      calls: [
        { index: 0, id: 'same', function: { name: 'web_search' } },
        { index: 1, id: 'same', function: { name: 'web_search' } },
      ],
      finish: 'tool_calls',
    },
  ])(
    'rejects missing IDs, wrong finish reasons, empty batches, and duplicate IDs',
    async ({ calls, finish }) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          sse([
            { choices: [{ delta: { content: 'x', tool_calls: calls } }] },
            { choices: [{ delta: {}, finish_reason: finish }] },
            '[DONE]',
          ]),
        );
      await expect(
        new LogfareGateway('test', fetcher).complete(
          'model',
          [],
          signal,
          undefined,
          8192,
          true,
        ),
      ).rejects.toBeInstanceOf(AIError);
    },
  );
});

describe('vision metadata and automatic multimodal serialization', () => {
  it('uses explicit current vision metadata, not model names, with unknown/stale capability disabled', async () => {
    const items = [
      { id: 'flash', chat_vision: true },
      { id: 'glm-5.3-flash' },
      {
        id: 'text',
        chat_vision: false,
        architecture: { input_modalities: ['text', 'image'] },
      },
      { id: 'stale', chat_vision: true, metadata_stale: true },
      {
        id: 'modalities',
        chat_capabilities: { input_modalities: ['text', 'image'] },
      },
      {
        id: 'architecture',
        architecture: { input_modalities: ['text', 'image'] },
      },
    ].map((m) => ({ ...m, endpoints: ['chat/completions'] }));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: items }));
    const models = await new LogfareGateway('test', fetcher).models(signal);
    expect(Object.fromEntries(models.map((m) => [m.id, m.vision]))).toEqual({
      flash: true,
      'glm-5.3-flash': false,
      text: false,
      stale: false,
      modalities: true,
      architecture: true,
    });
  });

  it('sends image data as OpenAI image_url parts without an image tool or an extra inference call', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        sse([delta('description'), stop, '[DONE]']),
      );
    const gateway = new LogfareGateway('test', fetcher);
    await gateway.complete(
      'flash',
      [
        {
          role: 'user',
          content: 'what is this?',
          images: ['data:image/jpeg;base64,aW1hZ2U='],
        },
      ],
      signal,
    );
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/jpeg;base64,aW1hZ2U=',
              detail: 'auto',
            },
          },
        ],
      },
    ]);
    expect(body.tools).toBeUndefined();
    await gateway.complete('flash', [], signal, undefined, 8192, true);
    const searchBody = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(
      searchBody.tools.map(
        (t: { function: { name: string } }) => t.function.name,
      ),
    ).toEqual(['web_search']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

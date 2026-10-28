import { z } from 'zod';
import sharp from 'sharp';
import { downloadPublicImage } from '../emoji/image-url.js';
import type { ImageDownloader } from '../emoji/image-url.js';
import { AIError } from './types.js';
import { SEARCH_TOOL } from './search.js';
import { prepareDiscordImage } from './vision.js';
import type { ChatMessage, Completion, Model, ToolCall } from './types.js';

const BASE = 'https://logfare.ai/v1';
const MAX_IMAGE = 8 * 1024 * 1024;
const modelSchema = z.object({
  id: z.string().min(1).max(200),
  display_name: z.string().optional(),
  name: z.string().optional(),
  endpoints: z.array(z.string()),
  context_length: z.number().positive().optional(),
  requires_training_optin: z.boolean().optional(),
  premium_unlocked: z.boolean().optional(),
  chat_vision: z.boolean().optional(),
  metadata_stale: z.boolean().optional(),
  chat_capabilities: z
    .object({ input_modalities: z.array(z.string()).optional() })
    .optional(),
  architecture: z
    .object({ input_modalities: z.array(z.string()).optional() })
    .optional(),
});
const chunkSchema = z.object({
  model: z.string().optional(),
  error: z.unknown().optional(),
  choices: z
    .array(
      z.object({
        index: z.number().optional(),
        delta: z
          .object({
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(2),
                  id: z.string().max(200).optional(),
                  type: z.literal('function').optional(),
                  function: z
                    .object({
                      name: z.string().max(100).optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            reasoning: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({ prompt_tokens: z.number().nonnegative().optional() })
    .optional(),
});

function statusError(status: number): AIError {
  if (status === 429 || status === 402)
    return new AIError('Usage limits reached');
  if (status === 401) return new AIError('AI service authentication failed');
  if (status === 403)
    return new AIError('Model access denied — check Logfare model access');
  if (status === 404) return new AIError('Model unavailable');
  if (status === 400 || status === 422)
    return new AIError(
      'AI request rejected — try compacting history or another model',
    );
  return new AIError('AI service unavailable');
}

/** Read bounded JSON/SSE, including servers which keep the connection open. */
async function readJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AIError('Empty AI service response');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new AIError('AI response exceeds size limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class LogfareGateway {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly imageDownload: ImageDownloader = downloadPublicImage,
  ) {}

  private async request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await this.fetcher(`${BASE}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw statusError(response.status);
    }
    return response;
  }

  private async safe<T>(
    signal: AbortSignal,
    operation: (deadline: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(240_000)]);
    try {
      deadline.throwIfAborted();
      return await operation(deadline);
    } catch (error) {
      if (error instanceof AIError) throw error;
      throw new AIError(
        deadline.aborted
          ? 'AI request timed out or was cancelled'
          : 'AI service unavailable',
      );
    }
  }

  async metrics(
    signal: AbortSignal,
  ): Promise<
    Map<
      string,
      { ttftMs: number | null; tps: number | null; latencyMs: number | null }
    >
  > {
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      const response = await this.request('status?hours=24', deadline);
      const raw = z
        .object({ data: z.array(z.unknown()) })
        .parse(await readJson(response, 2 * 1024 * 1024));
      const metric = z.object({
        model_id: z.string(),
        avg_ttft_ms: z.number().finite().nonnegative().nullable().optional(),
        avg_tps: z.number().finite().nonnegative().nullable().optional(),
        avg_latency_ms: z.number().finite().nonnegative().nullable().optional(),
      });
      const results = new Map<
        string,
        { ttftMs: number | null; tps: number | null; latencyMs: number | null }
      >();
      for (const item of raw.data) {
        const parsed = metric.safeParse(item);
        if (parsed.success) {
          const m = parsed.data;
          results.set(m.model_id, {
            ttftMs: m.avg_ttft_ms ?? null,
            tps: m.avg_tps ?? null,
            latencyMs: m.avg_latency_ms ?? null,
          });
        }
      }
      return results;
    } catch {
      return new Map();
    } // Metrics failure must not hide the model catalog.
  }

  async models(signal: AbortSignal): Promise<Model[]> {
    return this.safe(signal, async (deadline) => {
      const response = await this.request(
        'models',
        AbortSignal.any([deadline, AbortSignal.timeout(30_000)]),
      );
      const raw = z
        .object({ data: z.array(z.unknown()) })
        .parse(await readJson(response, 2 * 1024 * 1024));
      return raw.data
        .flatMap((item): Model[] => {
          const parsed = modelSchema.safeParse(item);
          if (!parsed.success) return [];
          const m = parsed.data;
          const kinds: Model['kind'][] = [];
          if (m.endpoints.includes('chat/completions')) kinds.push('chat');
          if (m.endpoints.includes('images/generations')) kinds.push('image');
          return kinds.map((kind) => ({
            id: m.id,
            name: (m.display_name || m.name || m.id)
              .replace(/[\r\n`*_~<>]/g, '')
              .slice(0, 100),
            kind,
            contextLength: m.context_length ?? 128_000,
            vision:
              kind === 'chat' &&
              m.metadata_stale !== true &&
              (m.chat_vision ??
                (
                  m.chat_capabilities?.input_modalities ??
                  m.architecture?.input_modalities ??
                  []
                ).includes('image')),
            locked:
              m.requires_training_optin === true &&
              m.premium_unlocked === false,
          }));
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    signal: AbortSignal,
    onFirstToken: () => void = () => {},
    maxTokens = 8192,
    allowSearch = false,
  ): Promise<Completion> {
    return this.safe(signal, async (deadline) => {
      const response = await this.request('chat/completions', deadline, {
        model,
        messages: messages.map(({ images, ...message }) =>
          images?.length
            ? {
                ...message,
                content: [
                  { type: 'text', text: message.content },
                  ...images.map((url) => ({
                    type: 'image_url',
                    image_url: { url, detail: 'auto' },
                  })),
                ],
              }
            : message,
        ),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        ...(allowSearch
          ? {
              tools: [SEARCH_TOOL],
              tool_choice: 'auto',
              parallel_tool_calls: false,
            }
          : {}),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new AIError('Empty AI service response');
      const decoder = new TextDecoder();
      let pending = '';
      let text = '';
      let reasoning = '';
      const toolCalls = new Map<number, ToolCall>();
      let finishReason = '';
      let actualModel = model;
      let inputTokens = 0;
      let first = false;
      let finished = false;
      let doneMarker = false;
      let bytes = 0;
      const event = (data: string) => {
        if (data === '[DONE]') {
          doneMarker = true;
          return;
        }
        const chunk = chunkSchema.parse(JSON.parse(data) as unknown);
        if (chunk.error !== undefined) {
          const code = z
            .object({
              code: z.union([z.string(), z.number()]).optional(),
              type: z.string().optional(),
            })
            .safeParse(chunk.error);
          const tag = code.success
            ? `${code.data.code ?? ''} ${code.data.type ?? ''}`
            : '';
          throw new AIError(
            /429|quota|rate_limit|usage_limit|insufficient_quota/i.test(tag)
              ? 'Usage limits reached'
              : 'AI generation failed',
          );
        }
        if (chunk.model) actualModel = chunk.model;
        if (chunk.usage?.prompt_tokens) inputTokens = chunk.usage.prompt_tokens;
        const choice = chunk.choices?.find(
          (c) => c.index === 0 || c.index === undefined,
        );
        const delta = choice?.delta;
        if (
          !first &&
          (delta?.content ||
            delta?.reasoning_content ||
            delta?.reasoning ||
            delta?.tool_calls?.length)
        ) {
          first = true;
          onFirstToken();
        }
        if (delta?.content) text += delta.content;
        if (allowSearch)
          reasoning += delta?.reasoning_content ?? delta?.reasoning ?? '';
        for (const part of delta?.tool_calls ?? []) {
          if (!allowSearch)
            throw new AIError('AI requested a tool when tools are disabled');
          const call = toolCalls.get(part.index) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (part.id) {
            if (call.id && call.id !== part.id)
              throw new AIError('Invalid AI search call');
            call.id = part.id;
          }
          call.function.name += part.function?.name ?? '';
          call.function.arguments += part.function?.arguments ?? '';
          if (
            call.function.arguments.length > 8000 ||
            call.function.name.length > 100
          )
            throw new AIError('AI search call exceeds size limit');
          toolCalls.set(part.index, call);
        }
        if (choice?.finish_reason) {
          if (
            choice.finish_reason !== 'stop' &&
            !(allowSearch && choice.finish_reason === 'tool_calls')
          )
            throw new AIError(
              choice.finish_reason === 'length'
                ? 'Model output limit reached — ask for a shorter reply'
                : 'AI response could not be completed',
            );
          finishReason = choice.finish_reason;
          finished = true;
        }
      };
      const drain = (eof = false) => {
        pending = pending.replace(/\r\n/g, '\n');
        let boundary: number;
        while (!doneMarker && (boundary = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) event(data);
        }
        if (eof && pending.trim() && !doneMarker) {
          const data = pending
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) event(data);
        }
      };
      try {
        while (!doneMarker) {
          const { done, value } = await reader.read();
          if (done) {
            pending += decoder.decode();
            drain(true);
            break;
          }
          bytes += value.byteLength;
          if (bytes > 4 * 1024 * 1024)
            throw new AIError('AI response exceeds size limit');
          pending += decoder.decode(value, { stream: true });
          drain();
        }
        if (!finished)
          throw new AIError('AI response was empty or interrupted');
        if (toolCalls.size) {
          const calls = [...toolCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call);
          if (
            finishReason !== 'tool_calls' ||
            calls.some((call) => !call.id || !call.function.name) ||
            new Set(calls.map((call) => call.id)).size !== calls.length
          )
            throw new AIError('Invalid or incomplete AI search calls');
          return {
            text,
            model: actualModel,
            inputTokens,
            toolCalls: calls,
            ...(reasoning ? { reasoningContent: reasoning } : {}),
          };
        }
        if (finishReason === 'tool_calls' || !text.trim())
          throw new AIError('AI response was empty or interrupted');
        return { text, model: actualModel, inputTokens };
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }

  async prepareImage(url: string, signal: AbortSignal): Promise<string> {
    return prepareDiscordImage(url, signal);
  }

  async image(
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ bytes: Buffer; extension: string }> {
    return this.safe(signal, async (deadline) => {
      const response = await this.request('images/generations', deadline, {
        model,
        prompt,
      });
      const raw = z
        .object({
          data: z
            .array(
              z.object({
                b64_json: z.string().optional(),
                url: z.string().optional(),
              }),
            )
            .min(1),
        })
        .parse(await readJson(response, 12 * 1024 * 1024));
      const image = raw.data[0]!;
      const bytes = image.b64_json
        ? Buffer.from(
            image.b64_json.replace(/^data:image\/[^;]+;base64,/, ''),
            'base64',
          )
        : image.url
          ? await this.imageDownload(image.url, deadline)
          : Buffer.alloc(0);
      if (!bytes.length || bytes.length > MAX_IMAGE)
        throw new AIError('Generated image is empty or exceeds 8 MiB');
      const metadata = await sharp(bytes, {
        limitInputPixels: 40_000_000,
      }).metadata();
      if (
        !metadata.format ||
        !['png', 'jpeg', 'webp', 'gif'].includes(metadata.format)
      )
        throw new AIError('Unsupported generated image format');
      return {
        bytes,
        extension: metadata.format === 'jpeg' ? 'jpg' : metadata.format,
      };
    });
  }
}

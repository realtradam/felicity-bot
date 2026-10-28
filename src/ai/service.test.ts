import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatStore } from './store.js';
import { ChatService, history, systemPrompt, tokens } from './service.js';
import { LogfareGateway } from './gateway.js';
import { ExaSearch } from './search.js';
import { AIError } from './types.js';
import type { ChatMessage, Model } from './types.js';

const signal = new AbortController().signal;
const model: Model = {
  id: 'glm-5.3-flash',
  name: 'GLM 5.3 Flash',
  kind: 'chat',
  contextLength: 262144,
  locked: false,
};
const stores: ChatStore[] = [];
afterEach(() => {
  for (const s of stores) s.close();
  stores.length = 0;
  vi.restoreAllMocks();
});
function fixture() {
  const store = new ChatStore(':memory:');
  stores.push(store);
  const gateway = new LogfareGateway('test-key');
  const models = vi.spyOn(gateway, 'models').mockResolvedValue([model]);
  const complete = vi
    .spyOn(gateway, 'complete')
    .mockResolvedValue({ text: 'Hello!', model: model.id, inputTokens: 40 });
  const service = new ChatService(store, gateway);
  return { store, gateway, models, complete, service };
}

describe('channel AI service', () => {
  it('provides identity/model, sends timestamps untouched, and never uses another channel', async () => {
    const { store, complete, service } = fixture();
    const input = '[2026-10-28T12:00:00.000Z] alice: hi';
    const deliver = vi.fn().mockResolvedValue(undefined);
    await service.chat('one', 'guild', input, signal, vi.fn(), deliver);
    expect(complete.mock.calls[0]![1]).toEqual([
      systemPrompt(model),
      { role: 'user', content: input },
    ]);
    expect(systemPrompt(model).content).toMatch(
      /Felicity.*Discord bot.*GLM 5.3 Flash/,
    );
    expect(deliver).toHaveBeenCalledWith('Hello!', 'GLM 5.3 Flash');
    expect(store.load('one').messages).toEqual([
      { role: 'user', content: input },
      { role: 'assistant', content: 'Hello!' },
    ]);
    await service.chat('two', 'guild', 'bob: hi', signal, vi.fn(), deliver);
    expect(JSON.stringify(complete.mock.calls[1]![1])).not.toContain('alice');
  });

  it('does not commit failed generations or expose errors/reasoning in history', async () => {
    const { service, complete, store } = fixture();
    complete.mockRejectedValueOnce(new AIError('Usage limits reached'));
    await expect(
      service.chat('one', 'guild', 'hello', signal, vi.fn(), vi.fn()),
    ).rejects.toThrow('Usage limits');
    expect(store.load('one').messages).toEqual([]);
  });

  it('reports the actual routed model, not the auto model', async () => {
    const { models, store, service } = fixture();
    models.mockResolvedValue([
      model,
      { ...model, id: 'logfare/auto', name: 'Logfare Auto' },
    ]);
    store.save('one', 'guild', { ...store.load('one'), model: 'logfare/auto' });
    const deliver = vi.fn().mockResolvedValue(undefined);
    await service.chat('one', 'guild', 'hi', signal, vi.fn(), deliver);
    expect(deliver).toHaveBeenCalledWith('Hello!', 'GLM 5.3 Flash');
  });

  it('serializes channel mutations while allowing independent channels, and releases errors', async () => {
    const { service } = fixture();
    let release!: () => void;
    const busy = service.exclusive(
      'one',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(service.exclusive('one', async () => {})).rejects.toThrow(
      'already generating',
    );
    await expect(service.exclusive('two', async () => 'ok')).resolves.toBe(
      'ok',
    );
    release();
    await busy;
    await expect(
      service.exclusive('one', async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(service.exclusive('one', async () => 'ok')).resolves.toBe(
      'ok',
    );
  });

  it('compacts older history and preserves the two most recent complete turns', async () => {
    const { service, store, complete } = fixture();
    const state = store.load('one');
    state.messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `${i}: details `.repeat(100),
    })) as ChatMessage[];
    state.summary = 'previous summary';
    const original = structuredClone(state);
    complete.mockResolvedValueOnce({
      text: 'Concise memory',
      model: model.id,
      inputTokens: 100,
    });
    expect(await service.compact(state, model, signal)).toBe(true);
    expect(state.messages).toEqual(original.messages.slice(-4));
    expect(state.summary).toBe('Concise memory');
    expect(JSON.stringify(complete.mock.calls[0]![1])).toContain(
      'previous summary',
    );
    expect(JSON.stringify(complete.mock.calls[0]![1])).not.toContain(
      original.messages[7]!.content,
    );
    expect(tokens(history(state))).toBeLessThan(tokens(history(original)));
  });

  it('preserves original data when compaction fails and handles empty history locally', async () => {
    const { service, store, complete } = fixture();
    const state = store.load('one');
    expect(await service.compact(state, model, signal)).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    state.messages = [{ role: 'user', content: 'many details '.repeat(100) }];
    const before = structuredClone(state);
    complete.mockRejectedValueOnce(new AIError('Usage limits reached'));
    await expect(service.compact(state, model, signal)).rejects.toThrow(
      'Usage limits',
    );
    expect(state).toEqual(before);
  });

  it('auto-compacts before inference when provider usage goes above 100k', async () => {
    const { service, store, complete } = fixture();
    store.save('one', 'guild', {
      ...store.load('one'),
      messages: [
        { role: 'user', content: 'old detail '.repeat(100) },
        { role: 'assistant', content: 'old reply '.repeat(100) },
      ],
      observedTokens: 100_001,
    });
    complete.mockResolvedValueOnce({
      text: 'memory',
      model: model.id,
      inputTokens: 100,
    });
    await service.chat(
      'one',
      'guild',
      'new question',
      signal,
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.load('one').summary).toBe('memory');
    expect(store.load('one').messages).toHaveLength(2);
  });

  it('auto-compacts immediately after a reply crosses the threshold', async () => {
    const { service, complete, store } = fixture();
    complete
      .mockResolvedValueOnce({
        text: 'answer '.repeat(100),
        model: model.id,
        inputTokens: 100_001,
      })
      .mockResolvedValueOnce({
        text: 'memory',
        model: model.id,
        inputTokens: 100,
      });
    const delivered = vi.fn().mockResolvedValue(undefined);
    await service.chat(
      'one',
      'guild',
      'question '.repeat(100),
      signal,
      vi.fn(),
      delivered,
    );
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(store.load('one')).toMatchObject({
      summary: 'memory',
      messages: [],
    });
  });

  it('compacts earlier for small contexts and batches when switching to a smaller model', async () => {
    const { service, store, complete } = fixture();
    const state = store.load('one');
    state.messages = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'one two three '.repeat(300),
    })) as ChatMessage[];
    complete.mockResolvedValue({
      text: 'memory',
      model: model.id,
      inputTokens: 100,
    });
    const small = { ...model, contextLength: 14000 };
    await service.compact(state, small, signal);
    expect(complete.mock.calls.length).toBeGreaterThan(1);
    for (const call of complete.mock.calls)
      expect(tokens(call[1])).toBeLessThanOrEqual(2000);
  });

  it('auto-compacts estimated history above 100k even when provider usage is missing', async () => {
    const { service, store, complete } = fixture();
    const oldText = 'word '.repeat(100_100);
    const messages: ChatMessage[] = [
      { role: 'user', content: oldText },
      { role: 'assistant', content: 'answer' },
    ];
    expect(tokens(messages)).toBeGreaterThan(100_000);
    store.save('one', 'guild', { ...store.load('one'), messages });
    complete.mockResolvedValue({
      text: 'short memory',
      model: model.id,
      inputTokens: 0,
    });
    await service.chat(
      'one',
      'guild',
      'next question',
      signal,
      vi.fn(),
      vi.fn().mockResolvedValue(undefined),
    );
    expect(store.load('one').summary).toBe('short memory');
    expect(store.load('one').messages).toHaveLength(2);
    expect(complete.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(tokens(complete.mock.calls.at(-1)![1])).toBeLessThan(100_000);
  });

  it('rejects unavailable/locked/wrong-kind models without fallback or consent changes', async () => {
    const { service, models, complete } = fixture();
    await expect(service.model('not-found', 'chat', signal)).rejects.toThrow(
      'unavailable',
    );
    await expect(
      service.model('glm-5.3-flash', 'image', signal),
    ).rejects.toThrow('unavailable');
    models.mockResolvedValue([{ ...model, locked: true }]);
    await expect(
      service.model('glm-5.3-flash', 'chat', signal),
    ).rejects.toThrow('opt-in');
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('Exa-only chat tool loop', () => {
  const toolCall = (
    id = 'call-1',
    name = 'web_search',
    args: unknown = { query: 'latest news', limit: 3 },
  ) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  function searchFixture() {
    const f = fixture();
    const search = new ExaSearch('search-test-key');
    const runSearch = vi
      .spyOn(search, 'search')
      .mockResolvedValue(
        '{"source":"Exa via Umans","untrusted":true,"results":[{"url":"https://example.org/","title":"News"}]}',
      );
    const service = new ChatService(f.store, f.gateway, search);
    const deliver = vi.fn().mockResolvedValue(undefined);
    const first = vi.fn();
    const chat = () =>
      service.chat('one', 'guild', 'What is new?', signal, first, deliver);
    return { ...f, search, runSearch, service, deliver, first, chat };
  }

  it('sends structured search results back to Logfare and posts all text of the final turn only', async () => {
    const f = searchFixture();
    f.complete
      .mockImplementationOnce(async (_m, _h, _s, first) => {
        first?.();
        return {
          text: 'I will search now.',
          model: model.id,
          inputTokens: 50,
          toolCalls: [toolCall()],
          reasoningContent: 'private plan',
        };
      })
      .mockImplementationOnce(async (_m, _h, _s, first) => {
        first?.();
        return {
          text: 'Here is the answer.\nSource: https://example.org/',
          model: model.id,
          inputTokens: 100,
        };
      });
    await f.chat();
    expect(f.runSearch).toHaveBeenCalledWith(
      { query: 'latest news', limit: 3 },
      expect.any(AbortSignal),
    );
    expect(f.first).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
      'Here is the answer.\nSource: https://example.org/',
      'GLM 5.3 Flash',
    );
    const second = f.complete.mock.calls[1]!;
    expect(second[1].slice(-2)).toEqual([
      {
        role: 'assistant',
        content: 'I will search now.',
        tool_calls: [toolCall()],
        reasoning_content: 'private plan',
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: await f.runSearch.mock.results[0]!.value,
      },
    ]);
    const saved = JSON.stringify(f.store.load('one'));
    expect(saved).not.toContain('private plan');
    expect(saved).not.toContain('I will search');
    expect(saved).not.toContain('tool_calls');
    expect(saved).not.toContain('untrusted');
    expect(second[5]).toBe(true);
    expect(second[1][0]!.content).toContain('Your only tool is web_search');
  });

  it.each(['run_shell', 'read_file', 'image', 'scrape', 'crawl', 'discord'])(
    'rejects %s without network effects or posting output',
    async (name) => {
      const f = searchFixture();
      f.complete.mockResolvedValueOnce({
        text: '',
        model: model.id,
        inputTokens: 50,
        toolCalls: [toolCall('call-1', name)],
      });
      await expect(f.chat()).rejects.toThrow('disallowed tool');
      expect(f.runSearch).not.toHaveBeenCalled();
      expect(f.deliver).not.toHaveBeenCalled();
      expect(f.store.load('one').messages).toEqual([]);
    },
  );

  it('validates every call before executing a batch, rejects invalid modes and duplicate IDs', async () => {
    const f = searchFixture();
    f.complete.mockResolvedValueOnce({
      text: '',
      model: model.id,
      inputTokens: 50,
      toolCalls: [
        toolCall(),
        toolCall('call-2', 'web_search', { query: 'news', mode: 'scrape' }),
      ],
    });
    await expect(f.chat()).rejects.toThrow('invalid web search arguments');
    expect(f.runSearch).not.toHaveBeenCalled();
    f.complete.mockResolvedValueOnce({
      text: '',
      model: model.id,
      inputTokens: 50,
      toolCalls: [toolCall(), toolCall()],
    });
    await expect(f.chat()).rejects.toThrow('duplicate');
    expect(f.runSearch).not.toHaveBeenCalled();
  });

  it('allows at most three searches, then requests a tool-free final answer', async () => {
    const f = searchFixture();
    for (let i = 0; i < 3; i++)
      f.complete.mockResolvedValueOnce({
        text: '',
        model: model.id,
        inputTokens: 50,
        toolCalls: [toolCall(`call-${i}`)],
      });
    f.complete.mockResolvedValueOnce({
      text: 'final',
      model: model.id,
      inputTokens: 100,
    });
    await f.chat();
    expect(f.runSearch).toHaveBeenCalledTimes(3);
    expect(f.complete.mock.calls[3]![5]).toBe(false);
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith('final', 'GLM 5.3 Flash');
  });

  it('rejects repeated call IDs across rounds rather than searching twice', async () => {
    const f = searchFixture();
    f.complete.mockResolvedValue({
      text: '',
      model: model.id,
      inputTokens: 50,
      toolCalls: [toolCall()],
    });
    await expect(f.chat()).rejects.toThrow('duplicate');
    expect(f.runSearch).toHaveBeenCalledTimes(1);
  });

  it('surfaces search usage limits and stores no failed turn', async () => {
    const f = searchFixture();
    f.complete.mockResolvedValueOnce({
      text: 'searching',
      model: model.id,
      inputTokens: 50,
      toolCalls: [toolCall()],
    });
    f.runSearch.mockRejectedValueOnce(
      new AIError('Search usage limits reached'),
    );
    await expect(f.chat()).rejects.toThrow('Search usage limits reached');
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.store.load('one').messages).toEqual([]);
  });

  it('never offers tools to history compaction, and has no tools without a search key', async () => {
    const f = searchFixture();
    const state = f.store.load('one');
    state.messages = [{ role: 'user', content: 'old detail '.repeat(100) }];
    f.complete.mockResolvedValueOnce({
      text: 'memory',
      model: model.id,
      inputTokens: 10,
    });
    await f.service.compact(state, model, signal);
    expect(f.complete.mock.calls[0]![5]).toBeUndefined();
    expect(f.runSearch).not.toHaveBeenCalled();
    expect(systemPrompt(model).content).toContain('You have no tools.');
  });
});

describe('automatic Discord visual input', () => {
  const url = 'https://cdn.discordapp.com/attachments/123/456/a.png';
  const data = 'data:image/jpeg;base64,aW1hZ2U=';

  it('attaches images on the first model request and search replay, but never persists bytes or replays them next turn', async () => {
    const f = fixture();
    f.models.mockResolvedValue([{ ...model, vision: true }]);
    const prepare = vi.spyOn(f.gateway, 'prepareImage').mockResolvedValue(data);
    const search = new ExaSearch('test');
    const runSearch = vi.spyOn(search, 'search').mockResolvedValue('results');
    const service = new ChatService(f.store, f.gateway, search);
    f.complete.mockResolvedValueOnce({
      text: '',
      model: model.id,
      inputTokens: 50,
      toolCalls: [
        {
          id: 'search',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"fact check"}' },
        },
      ],
    });
    await service.chat(
      'one',
      'guild',
      `fact check ${url}`,
      signal,
      vi.fn(),
      vi.fn(),
      [url, url],
    );
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(runSearch).toHaveBeenCalledOnce();
    expect(f.complete.mock.calls[0]![1].find((m) => m.role === 'user')).toEqual(
      {
        role: 'user',
        content: `fact check ${url}`,
        images: [data],
      },
    );
    expect(
      f.complete.mock.calls[1]![1].some((m) => m.images?.[0] === data),
    ).toBe(true);
    const state = f.store.load('one');
    expect(state.messages[0]).toEqual({
      role: 'user',
      content: `fact check ${url}`,
    });
    expect(JSON.stringify(state)).not.toContain('base64');
    expect(JSON.stringify(state)).not.toContain('"images"');
    await service.chat('one', 'guild', 'follow up', signal, vi.fn(), vi.fn());
    expect(f.complete.mock.calls[2]![1].every((m) => !m.images)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(systemPrompt({ ...model, vision: true }).content).not.toContain(
      'read_image',
    );
  });

  it.each([false, undefined])(
    'never downloads images when model vision support is %s',
    async (vision) => {
      const f = fixture();
      f.models.mockResolvedValue([
        { ...model, ...(vision === undefined ? {} : { vision }) },
      ]);
      const prepare = vi.spyOn(f.gateway, 'prepareImage');
      await f.service.chat(
        'one',
        'guild',
        `what is in ${url}`,
        signal,
        vi.fn(),
        vi.fn(),
        [url],
      );
      expect(prepare).not.toHaveBeenCalled();
      expect(f.complete.mock.calls[0]![1].at(-1)).toEqual({
        role: 'user',
        content: `what is in ${url}`,
      });
      expect(f.complete.mock.calls[0]![1][0]!.content).toContain(
        'cannot read images',
      );
    },
  );

  it('fails on missing images rather than pretending to have read them', async () => {
    const f = fixture();
    f.models.mockResolvedValue([{ ...model, vision: true }]);
    vi.spyOn(f.gateway, 'prepareImage').mockRejectedValue(
      new AIError('Could not read that Discord attachment'),
    );
    await expect(
      f.service.chat('one', 'guild', 'inspect', signal, vi.fn(), vi.fn(), [
        url,
      ]),
    ).rejects.toThrow('Could not read');
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.store.load('one').messages).toEqual([]);
  });

  it('bounds image count before any download', async () => {
    const f = fixture();
    f.models.mockResolvedValue([{ ...model, vision: true }]);
    const prepare = vi.spyOn(f.gateway, 'prepareImage');
    await expect(
      f.service.chat(
        'one',
        'guild',
        'inspect',
        signal,
        vi.fn(),
        vi.fn(),
        [1, 2, 3, 4].map((i) => url + i),
      ),
    ).rejects.toThrow('At most three');
    expect(prepare).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('rejects read_image even if a model tries calling the removed tool', async () => {
    const f = fixture();
    f.models.mockResolvedValue([{ ...model, vision: true }]);
    const service = new ChatService(f.store, f.gateway, new ExaSearch('test'));
    f.complete.mockResolvedValueOnce({
      text: '',
      model: model.id,
      inputTokens: 1,
      toolCalls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'read_image', arguments: JSON.stringify({ url }) },
        },
      ],
    });
    await expect(
      service.chat('one', 'guild', 'inspect', signal, vi.fn(), vi.fn()),
    ).rejects.toThrow('disallowed tool');
  });
});

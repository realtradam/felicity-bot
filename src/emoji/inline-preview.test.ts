import { Collection } from 'discord.js';
import type { ApplicationEmojiManager } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import type { EmojiArchive } from './archive.js';
import { ApplicationEmojiPreview } from './inline-preview.js';

const assetId = 'a'.repeat(64);
const name = `f_${assetId.slice(0, 30)}`;
function setup(download?: typeof fetch) {
  const fetch = vi.fn().mockResolvedValue(new Collection());
  const create = vi
    .fn()
    .mockImplementation(async ({ name }: { name: string }) => ({
      id: '123456789012345678',
      name,
      animated: false,
    }));
  const readAsset = vi
    .fn()
    .mockResolvedValue({ image: Buffer.from('archived image') });
  const remove = vi.fn().mockResolvedValue(undefined);
  const manager = {
    fetch,
    create,
    delete: remove,
  } as unknown as ApplicationEmojiManager;
  const error = vi.fn();
  const preview = new ApplicationEmojiPreview(
    () => manager,
    { readAsset } as unknown as EmojiArchive,
    error,
    100,
    download,
  );
  return { fetch, create, remove, manager, readAsset, error, preview };
}
describe('application emoji previews', () => {
  it('creates a stable bot-only preview and reuses it across simultaneous list requests', async () => {
    const f = setup();
    const results = await Promise.all([
      f.preview.mention(assetId),
      f.preview.mention(assetId),
    ]);
    expect(results).toEqual([
      `<:${name}:123456789012345678>`,
      `<:${name}:123456789012345678>`,
    ]);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledWith({
      name,
      attachment: Buffer.from('archived image'),
    });
  });
  it('finds existing deterministic previews after a restart and preserves animation', async () => {
    const f = setup();
    f.fetch.mockResolvedValue(
      new Collection([
        ['existing', { id: '123456789012345678', name, animated: true }],
      ]),
    );
    expect(await f.preview.mention(assetId)).toBe(
      `<a:${name}:123456789012345678>`,
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(f.readAsset).not.toHaveBeenCalled();
  });
  it('returns a fallback on API/storage failure and refreshes before retrying an ambiguous create', async () => {
    const f = setup();
    f.create.mockRejectedValueOnce(new Error('response lost'));
    expect(await f.preview.mention(assetId)).toBeUndefined();
    f.fetch.mockResolvedValue(
      new Collection([
        ['existing', { id: '123456789012345678', name, animated: false }],
      ]),
    );
    expect(await f.preview.mention(assetId)).toBe(
      `<:${name}:123456789012345678>`,
    );
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.error).toHaveBeenCalledOnce();
  });
  it('never evicts unrelated application emoji when the Discord quota is full', async () => {
    const f = setup();
    f.fetch.mockResolvedValue(
      new Collection(
        Array.from({ length: 2000 }, (_, i) => [
          String(i),
          { id: String(i), name: `other_${i}`, animated: false },
        ]),
      ),
    );
    expect(await f.preview.mention(assetId)).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('handles a missing ready application and invalid asset IDs without a network request', async () => {
    const f = setup();
    expect(await f.preview.mention('invalid')).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    const missing = new ApplicationEmojiPreview(
      () => undefined,
      {} as EmojiArchive,
    );
    expect(await missing.mention(assetId)).toBeUndefined();
  });
  it('downloads untracked emoji from the CDN and caches them as owned previews', async () => {
    const image = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('pixels'),
    ]);
    const download = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 415 }))
      .mockResolvedValueOnce(new Response(image, { status: 200 }));
    const f = setup(download);
    const emojiId = '860063973701320716';
    expect(await f.preview.external(emojiId)).toBe(
      `<:x_${emojiId}:123456789012345678>`,
    );
    expect(f.create).toHaveBeenCalledExactlyOnceWith({
      name: `x_${emojiId}`,
      attachment: image,
    });
    expect(download).toHaveBeenNthCalledWith(
      1,
      `https://cdn.discordapp.com/emojis/${emojiId}.gif`,
      expect.anything(),
    );
    expect(download).toHaveBeenNthCalledWith(
      2,
      `https://cdn.discordapp.com/emojis/${emojiId}.png`,
      expect.anything(),
    );
    // The deterministic name lets a later reply (or restart) reuse the preview.
    expect(await f.preview.external(emojiId)).toBe(
      `<:x_${emojiId}:123456789012345678>`,
    );
    expect(download).toHaveBeenCalledTimes(2);
    expect(f.readAsset).not.toHaveBeenCalled();
  });
  it('falls back to plain text when an external emoji cannot be downloaded', async () => {
    const download = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const f = setup(download);
    expect(await f.preview.external('860063973701320716')).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalledOnce();
  });
  it('rejects downloaded content that is not a PNG or GIF image', async () => {
    const download = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from('<html>'), { status: 200 }));
    const f = setup(download);
    expect(await f.preview.external('860063973701320716')).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('ignores malformed external IDs without a network request', async () => {
    const download = vi.fn();
    const f = setup(download);
    expect(await f.preview.external('not-an-id')).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });
});

it('evicts the least recently used owned preview without deleting archived bytes', async () => {
  const f = setup();
  const a = 'a'.repeat(64),
    b = 'b'.repeat(64),
    c = 'c'.repeat(64);
  const an = `f_${a.slice(0, 30)}`,
    bn = `f_${b.slice(0, 30)}`;
  f.fetch.mockResolvedValue(
    new Collection([
      ['first', { id: '111111111111111111', name: an, animated: false }],
      ['second', { id: '222222222222222222', name: bn, animated: false }],
      [
        'unrelated',
        { id: '333333333333333333', name: 'manual_emoji', animated: false },
      ],
    ]),
  );
  f.create.mockImplementation(async ({ name }: { name: string }) => ({
    id: '444444444444444444',
    name,
    animated: false,
  }));
  const preview = new ApplicationEmojiPreview(
    () => f.manager,
    { readAsset: f.readAsset } as unknown as EmojiArchive,
    f.error,
    2,
  );
  await preview.mention(a); // A is most recently used, B becomes the eviction victim.
  expect(await preview.mention(c)).toContain('444444444444444444');
  expect(f.remove).toHaveBeenCalledExactlyOnceWith('222222222222222222');
  expect(f.readAsset).toHaveBeenCalledExactlyOnceWith(c);
});

it('protects all current-page previews and holds eviction until its reply finishes', async () => {
  const f = setup();
  const a = 'a'.repeat(64),
    b = 'b'.repeat(64),
    c = 'c'.repeat(64);
  f.create.mockImplementation(async ({ name }: { name: string }) => ({
    id: String(100000000000000000n + BigInt(f.create.mock.calls.length)),
    name,
    animated: false,
  }));
  const preview = new ApplicationEmojiPreview(
    () => f.manager,
    { readAsset: f.readAsset } as unknown as EmojiArchive,
    f.error,
    2,
  );
  let unblock!: () => void;
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let replyReady!: () => void;
  const replyStarted = new Promise<void>((resolve) => {
    replyReady = resolve;
  });
  const page = preview.withPage([a, b], async (mention) => {
    expect(await mention(a)).toContain('f_');
    expect(await mention(b)).toContain('f_');
    expect(await mention(c)).toBeUndefined(); // Cannot evict either protected page item.
    replyReady();
    await waiting;
  });
  await replyStarted;
  const nextPage = preview.mention(c);
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.remove).not.toHaveBeenCalled();
  unblock();
  await page;
  expect(await nextPage).toContain('f_');
  expect(f.remove).toHaveBeenCalledOnce();
});

it('does not delete anything if the incoming archived image cannot be read', async () => {
  const f = setup();
  f.fetch.mockResolvedValue(
    new Collection([
      [
        'old',
        {
          id: '111111111111111111',
          name: `f_${'b'.repeat(30)}`,
          animated: false,
        },
      ],
    ]),
  );
  f.readAsset.mockRejectedValue(new Error('corrupt image'));
  const preview = new ApplicationEmojiPreview(
    () => f.manager,
    { readAsset: f.readAsset } as unknown as EmojiArchive,
    f.error,
    1,
  );
  expect(await preview.mention(assetId)).toBeUndefined();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});

it('reconciles after a failed eviction without blindly creating another preview', async () => {
  const f = setup();
  f.fetch.mockResolvedValue(
    new Collection([
      [
        'old',
        {
          id: '111111111111111111',
          name: `f_${'b'.repeat(30)}`,
          animated: false,
        },
      ],
    ]),
  );
  f.remove.mockRejectedValueOnce(new Error('response lost'));
  const preview = new ApplicationEmojiPreview(
    () => f.manager,
    { readAsset: f.readAsset } as unknown as EmojiArchive,
    f.error,
    1,
  );
  expect(await preview.mention(assetId)).toBeUndefined();
  expect(f.create).not.toHaveBeenCalled();
  f.fetch.mockResolvedValue(new Collection());
  expect(await preview.mention(assetId)).toContain('f_');
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it('cleans up an over-capacity preview set after restart while preserving a requested item', async () => {
  const f = setup();
  f.fetch.mockResolvedValue(
    new Collection([
      [
        'old',
        {
          id: '111111111111111111',
          name: `f_${'b'.repeat(30)}`,
          animated: false,
        },
      ],
      ['requested', { id: '222222222222222222', name, animated: false }],
    ]),
  );
  const preview = new ApplicationEmojiPreview(
    () => f.manager,
    { readAsset: f.readAsset } as unknown as EmojiArchive,
    f.error,
    1,
  );
  expect(await preview.mention(assetId)).toContain('222222222222222222');
  expect(f.remove).toHaveBeenCalledExactlyOnceWith('111111111111111111');
  expect(f.create).not.toHaveBeenCalled();
});

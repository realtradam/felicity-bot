import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchSevenTvEmote,
  normalizeEmoji,
  parseSevenTvUrl,
} from './seventv.js';

const id = '01F010F9GR0007E4VV006YKSKN';
const link = `https://7tv.app/emotes/${id}`;
const metadata = {
  id,
  name: 'PepeLaugh',
  animated: false,
  host: {
    url: `//cdn.7tv.app/emote/${id}`,
    files: [
      {
        name: '4x.webp',
        format: 'WEBP',
        width: 128,
        height: 128,
        frame_count: 1,
      },
    ],
  },
};

describe('7TV import', () => {
  it('accepts the supplied ULID and legacy IDs, and rejects arbitrary fetch locations', () => {
    expect(parseSevenTvUrl(link)).toBe(id);
    expect(
      parseSevenTvUrl('https://7tv.app/emotes/60ae8b92d2ea9a001b62737d'),
    ).toBe('60ae8b92d2ea9a001b62737d');
    for (const url of [
      'http://7tv.app/emotes/' + id,
      'https://7tv.app.evil.test/emotes/' + id,
      'https://evil.test/' + id,
      'https://7tv.app:8080/emotes/' + id,
      'file:///etc/passwd',
      'https://7tv.app/emotes/../etc',
      'https://user@7tv.app/emotes/' + id,
    ]) {
      expect(() => parseSevenTvUrl(url)).toThrow();
    }
  });
  it('fetches metadata and an allowlisted image, resizing into a Discord-compatible PNG', async () => {
    const source = await sharp({
      create: { width: 220, height: 80, channels: 4, background: 'red' },
    })
      .webp()
      .toBuffer();
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            String(url).includes('7tv.io') ? JSON.stringify(metadata) : source,
          ),
      );
    const imported = await fetchSevenTvEmote(link, download);
    expect(imported).toMatchObject({
      sourceId: id,
      name: 'PepeLaugh',
      animated: false,
    });
    const image = await sharp(imported.image).metadata();
    expect(image).toMatchObject({ format: 'png', width: 128, height: 128 });
    expect(imported.image.length).toBeLessThanOrEqual(256 * 1024);
    expect(download.mock.calls[1]?.[0]).toBe(
      `https://cdn.7tv.app/emote/${id}/4x.webp`,
    );
  });
  it('resolves a legacy link to its canonical ULID and fetches the canonical CDN image', async () => {
    const legacy = '60ae3e54259ac5a73e56a426';
    const canonical = '01F6MA6Y100002B6P5MWZ5D916';
    const source = await sharp({
      create: { width: 32, height: 32, channels: 4, background: 'red' },
    })
      .webp()
      .toBuffer();
    const body = {
      ...metadata,
      id: canonical,
      name: 'Hmm',
      host: { ...metadata.host, url: `//cdn.7tv.app/emote/${canonical}` },
    };
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            String(url).includes('7tv.io') ? JSON.stringify(body) : source,
          ),
      );
    const imported = await fetchSevenTvEmote(
      `https://7tv.app/emotes/${legacy}`,
      download,
    );
    expect(imported).toMatchObject({
      sourceId: legacy,
      canonicalId: canonical,
      name: 'Hmm',
    });
    expect(download.mock.calls[0]?.[0]).toBe(
      `https://7tv.io/v3/emotes/${legacy}`,
    );
    expect(download.mock.calls[1]?.[0]).toBe(
      `https://cdn.7tv.app/emote/${canonical}/4x.webp`,
    );
  });
  it('rejects mismatched modern IDs and canonical CDN path mismatches', async () => {
    const canonical = '01F6MA6Y100002B6P5MWZ5D916';
    for (const [input, body] of [
      [
        link,
        {
          ...metadata,
          id: canonical,
          host: { ...metadata.host, url: `//cdn.7tv.app/emote/${canonical}` },
        },
      ],
      [
        'https://7tv.app/emotes/60ae3e54259ac5a73e56a426',
        { ...metadata, id: canonical },
      ],
    ] as const) {
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body)));
      await expect(fetchSevenTvEmote(input, download)).rejects.toThrow();
      expect(download).toHaveBeenCalledTimes(1);
    }
  });
  it('preserves animation, not just the first frame', async () => {
    const raw = Buffer.alloc(2 * 2 * 4 * 2);
    raw.fill(255, 0, 16);
    raw.fill(100, 16);
    const animated = await sharp(raw, {
      raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
    })
      .gif({ delay: [100, 100], loop: 0 })
      .toBuffer();
    const output = await normalizeEmoji(animated, true);
    expect((await sharp(output, { animated: true }).metadata()).pages).toBe(2);
    expect((await sharp(output).metadata()).format).toBe('gif');
  });
  it('does not follow a metadata CDN redirect or accept a mismatched emote ID', async () => {
    for (const body of [
      {
        ...metadata,
        host: { ...metadata.host, url: 'https://127.0.0.1/private' },
      },
      { ...metadata, id: 'other' },
    ]) {
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body)));
      await expect(fetchSevenTvEmote(link, download)).rejects.toThrow();
      expect(download).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects still images presented as animations and malformed files', async () => {
    const still = await sharp({
      create: { width: 8, height: 8, channels: 4, background: 'blue' },
    })
      .png()
      .toBuffer();
    await expect(normalizeEmoji(still, true)).rejects.toThrow(
      'not be silently converted',
    );
    await expect(
      normalizeEmoji(Buffer.from('not an image'), false),
    ).rejects.toThrow();
  });
});

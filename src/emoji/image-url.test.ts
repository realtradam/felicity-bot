import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchImageEmote,
  imageNameFromUrl,
  isPublicAddress,
  parseImageUrl,
  publicLookup,
} from './image-url.js';
import type { ImageDownloader } from './image-url.js';

const signal = () => new AbortController().signal;

describe('public image URLs', () => {
  it('blocks local, private, mapped, reserved, metadata and non-HTTPS locations', () => {
    for (const url of [
      'file:///etc/passwd',
      'http://example.com/a.png',
      'https://localhost/a',
      'https://127.0.0.1/a',
      'https://2130706433/a',
      'https://10.1.2.3/a',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/a',
      'https://[::ffff:127.0.0.1]/a',
      'https://192.168.1.2/a',
      'https://[fc00::1]/a',
      'https://example.com:8443/a',
      'https://user:pass@example.com/a',
    ])
      expect(() => parseImageUrl(url)).toThrow();
    for (const ip of [
      '0.0.0.0',
      '100.64.1.2',
      '224.0.0.1',
      '192.0.2.1',
      '::',
      'fe80::1',
      '2001:db8::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(parseImageUrl('https://example.com/image.png#fragment').href).toBe(
      'https://example.com/image.png',
    );
  });
  it('enforces public addresses in the DNS lookup used by the actual socket', async () => {
    await new Promise<void>((resolve) => {
      publicLookup('localhost', { all: true }, (error) => {
        expect(error).toBeInstanceOf(Error);
        resolve();
      });
    });
  });
  it('derives a valid default name from the URL filename', () => {
    expect(
      imageNameFromUrl(
        new URL('https://example.com/my%20emoji.png?signature=secret'),
      ),
    ).toBe('my_emoji');
    expect(imageNameFromUrl(new URL('https://example.com/'))).toBe('emoji');
    expect(imageNameFromUrl(new URL('https://example.com/a.png'))).toBe(
      'emoji',
    );
  });
  it.each(['png', 'jpeg', 'webp', 'avif'] as const)(
    'converts a direct %s image to a backed-up-size PNG',
    async (format) => {
      const source = await sharp({
        create: { width: 180, height: 75, channels: 4, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const download = vi.fn<ImageDownloader>().mockResolvedValue(source);
      const emote = await fetchImageEmote(
        'https://example.com/custom.png',
        signal(),
        download,
      );
      expect(emote.name).toBe('custom');
      expect(emote.animated).toBe(false);
      expect(await sharp(emote.image).metadata()).toMatchObject({
        format: 'png',
        width: 128,
        height: 128,
      });
      expect(emote.image.length).toBeLessThanOrEqual(256 * 1024);
    },
  );
  it('preserves animated direct GIF and WebP images', async () => {
    const raw = Buffer.alloc(32);
    raw.fill(255, 0, 16);
    raw.fill(100, 16);
    for (const format of ['gif', 'webp'] as const) {
      const source = await sharp(raw, {
        raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
      })
        .toFormat(format, { delay: [100, 100], loop: 0 })
        .toBuffer();
      const emote = await fetchImageEmote(
        `https://example.com/dance.${format}`,
        signal(),
        vi.fn<ImageDownloader>().mockResolvedValue(source),
      );
      expect(emote.animated).toBe(true);
      expect(
        await sharp(emote.image, { animated: true }).metadata(),
      ).toMatchObject({ format: 'gif', pages: 2 });
    }
  });
  it('rejects HTML, SVG, oversized downloads and private links before conversion/fetch', async () => {
    const download = vi.fn<ImageDownloader>();
    await expect(
      fetchImageEmote('https://127.0.0.1/a.png', signal(), download),
    ).rejects.toThrow();
    expect(download).not.toHaveBeenCalled();
    for (const body of [
      Buffer.from('<html>not an image</html>'),
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      ),
      Buffer.alloc(8 * 1024 * 1024 + 1),
    ]) {
      download.mockResolvedValue(body);
      await expect(
        fetchImageEmote('https://example.com/image', signal(), download),
      ).rejects.toThrow();
    }
  });
});

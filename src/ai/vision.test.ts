import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { prepareDiscordImage } from './vision.js';
import { parseDiscordAttachmentUrl } from '../emoji/image-url.js';

const url =
  'https://cdn.discordapp.com/attachments/123/456/screenshot.png?ex=abc&hm=def';
const signal = new AbortController().signal;

describe('Discord visual input preparation', () => {
  it('only accepts exact Discord attachment hosts and paths', () => {
    expect(parseDiscordAttachmentUrl(url).href).toBe(url);
    expect(
      parseDiscordAttachmentUrl(
        'https://media.discordapp.net/attachments/123/456/image.png',
      ).hostname,
    ).toBe('media.discordapp.net');
    for (const bad of [
      'https://example.com/image.png',
      'https://cdn.discordapp.com.evil.example/attachments/123/456/a.png',
      'https://evil.example/?url=' + url,
      'https://images-ext-1.discordapp.net/external/abc/https/example.com/a.png',
      'https://cdn.discordapp.com/embed/avatars/0.png',
      'https://cdn.discordapp.com/attachments/no/ids/a.png',
      'https://cdn.discordapp.com/attachments/123/456/../../../evil',
      'http://cdn.discordapp.com/attachments/123/456/a.png',
      'https://user:secret@cdn.discordapp.com/attachments/123/456/a.png',
      'https://cdn.discordapp.com:8443/attachments/123/456/a.png',
      'https://127.0.0.1/attachments/123/456/a.png',
    ])
      expect(() => parseDiscordAttachmentUrl(bad)).toThrow();
  });

  it('blocks external images before calling a downloader', async () => {
    const download = vi.fn();
    await expect(
      prepareDiscordImage(
        'https://tracker.example/image.png',
        signal,
        download,
      ),
    ).rejects.toThrow('Could not read that Discord attachment');
    expect(download).not.toHaveBeenCalled();
  });

  it('decodes and re-encodes with no EXIF/GPS, resizes and returns inline data instead of a remote URL', async () => {
    const source = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: 'red' },
    })
      .withExif({
        IFD0: { Artist: 'private identity' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '51/1 30/1 0/1',
          GPSLongitudeRef: 'W',
          GPSLongitude: '0/1 7/1 0/1',
        },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const download = vi.fn().mockResolvedValue(source);
    const result = await prepareDiscordImage(url, signal, download);
    expect(download).toHaveBeenCalledWith(url, expect.any(AbortSignal));
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    const metadata = await sharp(
      Buffer.from(result.split(',')[1]!, 'base64'),
    ).metadata();
    expect(metadata).toMatchObject({
      format: 'jpeg',
      width: 2048,
      height: 1024,
    });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
  });

  it('only reads the first animation frame', async () => {
    const source = await sharp(Buffer.alloc(32, 200), {
      raw: { width: 2, height: 4, channels: 4, pageHeight: 2 },
    })
      .gif({ delay: [100, 100] })
      .toBuffer();
    const result = await prepareDiscordImage(
      url,
      signal,
      vi.fn().mockResolvedValue(source),
    );
    const meta = await sharp(
      Buffer.from(result.split(',')[1]!, 'base64'),
    ).metadata();
    expect(meta).toMatchObject({ width: 2, height: 2, format: 'jpeg' });
    expect(meta.pages ?? 1).toBe(1);
  });

  it.each([
    Buffer.from('<html>not an image</html>'),
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
    ),
    Buffer.alloc(8 * 1024 * 1024 + 1),
  ])(
    'rejects unsupported and oversized image data without leaking payloads',
    async (source) => {
      await expect(
        prepareDiscordImage(url, signal, vi.fn().mockResolvedValue(source)),
      ).rejects.toThrow('Could not read that Discord attachment');
    },
  );

  it('checks cancellation before downloads and after an in-flight download', async () => {
    const download = vi.fn();
    await expect(
      prepareDiscordImage(url, AbortSignal.abort(), download),
    ).rejects.toThrow('cancelled');
    expect(download).not.toHaveBeenCalled();
    const controller = new AbortController();
    download.mockImplementation(async () => {
      controller.abort();
      return Buffer.from('private');
    });
    await expect(
      prepareDiscordImage(url, controller.signal, download),
    ).rejects.toThrow('cancelled');
  });
});

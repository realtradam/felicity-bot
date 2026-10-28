import type * as Undici from 'undici';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('undici', async (original) => ({
  ...(await original<typeof Undici>()),
  request,
}));
import { downloadDiscordAttachment } from './image-url.js';

const url = 'https://cdn.discordapp.com/attachments/123/456/a.png';
const signal = new AbortController().signal;
const redirect = (location: string) => ({
  statusCode: 302,
  headers: { location },
  body: { destroy: vi.fn() },
});
beforeEach(() => request.mockReset());

describe('Discord attachment download privacy', () => {
  it.each([
    'https://tracker.example/a.png',
    'https://127.0.0.1/private',
    'https://images-ext-1.discordapp.net/external/abc',
    'https://cdn.discordapp.com/other/a.png',
  ])(
    'blocks redirects outside attachment CDN URLs before making a second request: %s',
    async (location) => {
      request.mockResolvedValueOnce(redirect(location));
      await expect(downloadDiscordAttachment(url, signal)).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it('allows a CDN attachment redirect but sends no auth or identifying user headers', async () => {
    const body = Object.assign(
      (async function* () {
        yield Buffer.from('image bytes');
      })(),
      { destroy: vi.fn() },
    );
    request
      .mockResolvedValueOnce(
        redirect('https://media.discordapp.net/attachments/123/456/a.png'),
      )
      .mockResolvedValueOnce({ statusCode: 200, headers: {}, body });
    expect(await downloadDiscordAttachment(url, signal)).toEqual(
      Buffer.from('image bytes'),
    );
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, options] of request.mock.calls) {
      expect(options.headers).toEqual({
        'user-agent': 'FelicityBot/0.1',
        accept: 'image/*',
        'accept-encoding': 'identity',
      });
      expect(options.dispatcher).toBeDefined();
    }
  });
  it('rejects an arbitrary original URL without any network call', async () => {
    await expect(
      downloadDiscordAttachment('https://tracker.example/a.png', signal),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

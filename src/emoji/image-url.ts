import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import sharp from 'sharp';
import { UserError } from '../discord/user-error.js';
import { normalizeEmoji } from './seventv.js';

export function parseImageUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError('Use a direct HTTPS image link or a 7TV emote URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  ) {
    throw new UserError(
      'Image links must use HTTPS on a public host, without credentials or custom ports.',
    );
  }
  url.hash = '';
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.process(address);
  return parsed.range() === 'unicast';
}

// Validate at connection time, returning the *same* resolved address to the socket.
// A preliminary DNS check followed by an ordinary fetch would permit DNS rebinding.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { all: true, verbatim: true })
    .then((addresses) => {
      if (
        !addresses.length ||
        addresses.some((entry) => !isPublicAddress(entry.address))
      ) {
        callback(
          new Error(
            'Image host did not resolve exclusively to public addresses',
          ),
          '',
          0,
        );
        return;
      }
      const eligible = options.family
        ? addresses.filter((entry) => entry.family === Number(options.family))
        : addresses;
      const first = eligible[0];
      if (!first) {
        callback(
          new Error('Image host has no address in the requested family'),
          '',
          0,
        );
        return;
      }
      if (options.all) callback(null, eligible);
      else callback(null, first.address, first.family);
    })
    .catch(() =>
      callback(new Error('Could not resolve the image host'), '', 0),
    );
};

export type ImageDownloader = (
  url: string,
  signal: AbortSignal,
) => Promise<Buffer>;

export const downloadPublicImage: ImageDownloader = async (input, signal) => {
  const dispatcher = new Agent({
    connect: { lookup: publicLookup, timeout: 10_000 },
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  let url = parseImageUrl(input);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      deadline.throwIfAborted();
      // Validate every redirect as well as the original URL; no automatic redirects/proxying.
      url = parseImageUrl(url.href);
      const response = await request(url, {
        dispatcher,
        signal: deadline,
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
        headers: {
          'user-agent': 'FelicityBot/0.1',
          accept: 'image/*',
          'accept-encoding': 'identity',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.body.destroy();
        const location = response.headers.location;
        if (redirects === 3 || typeof location !== 'string')
          throw new UserError(
            'The image link has too many or invalid redirects.',
          );
        url = parseImageUrl(new URL(location, url).href);
        continue;
      }
      if (response.statusCode !== 200) {
        response.body.destroy();
        throw new UserError(
          'Could not download that image. Check that the link is public and opens the image itself.',
        );
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          const buffer = Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          if (bytes > 8 * 1024 * 1024)
            throw new UserError('Image downloads must be 8 MiB or smaller.');
          chunks.push(buffer);
        }
      } finally {
        response.body.destroy();
      }
      return Buffer.concat(chunks);
    }
    throw new UserError('Too many image redirects.');
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      'Could not download that public image. Use a direct HTTPS image link (private hosts are not allowed).',
    );
  } finally {
    await dispatcher.destroy();
  }
};

export function imageNameFromUrl(url: URL): string {
  let filename: string;
  try {
    filename = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  } catch {
    filename = '';
  }
  const name = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 32);
  return name.length >= 2 ? name : 'emoji';
}

export async function fetchImageEmote(
  link: string,
  signal: AbortSignal,
  download: ImageDownloader = downloadPublicImage,
) {
  const url = parseImageUrl(link);
  const source = await download(url.href, signal);
  if (source.byteLength > 8 * 1024 * 1024)
    throw new UserError('Image downloads must be 8 MiB or smaller.');
  try {
    const metadata = await sharp(source, {
      animated: true,
      limitInputPixels: 40_000_000,
      failOn: 'warning',
    }).metadata();
    if (
      !metadata.format ||
      !['png', 'jpeg', 'gif', 'webp', 'avif', 'heif'].includes(metadata.format)
    ) {
      throw new UserError(
        'Supported images are PNG, JPEG, GIF, WebP and AVIF. HTML pages and SVG are not supported.',
      );
    }
    const animated = (metadata.pages ?? 1) > 1;
    const image = await normalizeEmoji(source, animated, signal);
    return { name: imageNameFromUrl(url), animated, image };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      'That link did not return a decodable image, or the image exceeds processing limits. Use a direct image URL.',
    );
  }
}

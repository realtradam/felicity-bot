import sharp from 'sharp';
import { z } from 'zod';
import { UserError } from '../discord/user-error.js';
import { downloadLimited } from './download.js';

export function parseSevenTvUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError(
      'Use a 7TV emote link such as https://7tv.app/emotes/ID.',
    );
  }
  const match = /^\/emotes\/([A-Za-z0-9]{24,26})\/?$/.exec(url.pathname);
  if (
    url.protocol !== 'https:' ||
    !['7tv.app', 'www.7tv.app'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    !match?.[1]
  ) {
    throw new UserError('Only https://7tv.app/emotes/ID links are supported.');
  }
  return match[1];
}

const legacyId = /^[a-fA-F0-9]{24}$/;
const canonicalId = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const emoteSchema = z.object({
  id: z.string().refine((id) => legacyId.test(id) || canonicalId.test(id)),
  name: z.string().min(1),
  animated: z.boolean(),
  host: z.object({
    url: z.string(),
    files: z.array(
      z.object({
        name: z.string(),
        format: z.string(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        frame_count: z.number().int().positive().default(1),
      }),
    ),
  }),
});

export async function fetchSevenTvEmote(
  input: string,
  download: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const sourceId = parseSevenTvUrl(input);
  const bytes = await downloadLimited(
    download,
    `https://7tv.io/v3/emotes/${sourceId}`,
    1024 * 1024,
    signal,
  );
  const parsed = emoteSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!parsed.success)
    throw new UserError('7TV returned invalid emote information.');
  const emote = parsed.data;
  // The trusted API resolves legacy ObjectIDs to canonical ULIDs. Only accept
  // that specific migration; unrelated changes to modern IDs remain invalid.
  if (
    emote.id !== sourceId &&
    !(legacyId.test(sourceId) && canonicalId.test(emote.id))
  ) {
    throw new UserError('7TV returned invalid emote information.');
  }
  // Build the CDN URL ourselves: never trust a remote host URL for arbitrary fetching.
  const host = new URL(
    emote.host.url.startsWith('//')
      ? `https:${emote.host.url}`
      : emote.host.url,
  );
  if (
    host.protocol !== 'https:' ||
    host.hostname !== 'cdn.7tv.app' ||
    host.port ||
    host.username ||
    host.password ||
    host.pathname.replace(/\/$/, '') !== `/emote/${emote.id}`
  ) {
    throw new UserError('7TV returned an unsupported CDN location.');
  }
  const candidates = emote.host.files
    .filter(
      (file) =>
        ['WEBP', 'PNG', 'GIF'].includes(file.format.toUpperCase()) &&
        /^[1-4]x\.(webp|png|gif)$/.test(file.name) &&
        file.width <= 512 &&
        file.height <= 512 &&
        file.frame_count <= 300 &&
        (!emote.animated || file.frame_count > 1),
    )
    .sort((a, b) => {
      const score = (file: typeof a) =>
        Math.abs(128 - file.width) + (file.format === 'WEBP' ? 0 : 1);
      return score(a) - score(b);
    });
  const file = candidates[0];
  if (!file)
    throw new UserError(
      'No supported 7TV image was available (maximum 300 animation frames).',
    );
  const source = await downloadLimited(
    download,
    `https://cdn.7tv.app/emote/${emote.id}/${file.name}`,
    8 * 1024 * 1024,
    signal,
  );
  const image = await normalizeEmoji(source, emote.animated, signal);
  const name = emote.name
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 32)
    .padEnd(2, '_');
  return {
    sourceId,
    canonicalId: emote.id,
    name,
    animated: emote.animated,
    image,
  };
}

export async function normalizeEmoji(
  source: Buffer,
  animated: boolean,
  signal?: AbortSignal,
): Promise<Buffer> {
  const image = sharp(source, {
    animated,
    limitInputPixels: 40_000_000,
    failOn: 'warning',
  });
  const metadata = await image.metadata();
  if ((metadata.pages ?? 1) > 300 || (animated && (metadata.pages ?? 1) < 2)) {
    throw new UserError(
      'This animation is unsupported; it will not be silently converted to a still image.',
    );
  }
  for (const size of [128, 96, 64, 48, 32]) {
    signal?.throwIfAborted();
    const resized = image.clone().resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    const output = await (
      animated
        ? resized.gif({ effort: 3, colours: 128, dither: 0 })
        : resized.png({ compressionLevel: 9, palette: true })
    )
      .timeout({ seconds: 15 })
      .toBuffer();
    if (output.byteLength <= 256 * 1024) return output;
  }
  throw new UserError(
    'The emote cannot fit Discord’s 256 KiB limit while preserving animation.',
  );
}

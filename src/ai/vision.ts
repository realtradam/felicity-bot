import sharp from 'sharp';
import {
  downloadDiscordAttachment,
  parseDiscordAttachmentUrl,
} from '../emoji/image-url.js';
import type { ImageDownloader } from '../emoji/image-url.js';
import { AIError } from './types.js';

/** DNS-pinned downloads, bounded decoding, first frame only; never write image bytes to disk. */
export async function prepareDiscordImage(
  url: string,
  signal: AbortSignal,
  download: ImageDownloader = downloadDiscordAttachment,
): Promise<string> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  try {
    deadline.throwIfAborted();
    const source = await download(
      parseDiscordAttachmentUrl(url).href,
      deadline,
    );
    deadline.throwIfAborted();
    if (!source.length || source.length > 8 * 1024 * 1024) throw new Error();
    const image = sharp(source, {
      limitInputPixels: 40_000_000,
      failOn: 'warning',
    });
    const metadata = await image.metadata();
    if (
      !metadata.format ||
      !['png', 'jpeg', 'webp', 'gif', 'avif', 'heif'].includes(metadata.format)
    )
      throw new Error();
    const bytes = await image
      .resize({
        width: 2048,
        height: 2048,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer();
    deadline.throwIfAborted();
    if (bytes.length > 8 * 1024 * 1024) throw new Error();
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  } catch {
    throw new AIError(
      deadline.aborted
        ? 'Image reading timed out or was cancelled'
        : 'Could not read that Discord attachment — it may be unavailable, invalid or exceed image limits',
    );
  }
}

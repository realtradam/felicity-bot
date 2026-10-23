import { UserError } from '../discord/user-error.js';

export async function downloadLimited(
  download: typeof fetch,
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const response = await download(url, {
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
    redirect: 'error',
  });
  if (!response.ok || !response.body)
    throw new UserError('Image/API download failed. Try again later.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes)
        throw new UserError('Downloaded file exceeds the size limit.');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

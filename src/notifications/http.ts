import { RetryableError } from './types.js';

/** Fixed-host callers only. Never include URLs, credentials or response bodies in errors. */
export async function requestJson(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(url, { ...init, redirect: 'error' });
  if (!response.ok) {
    await response.body?.cancel();
    const retry = response.headers.get('retry-after');
    const seconds = Number(retry);
    const date = retry ? Date.parse(retry) : NaN;
    const delay =
      retry && Number.isFinite(seconds)
        ? seconds * 1000
        : Number.isFinite(date)
          ? date - Date.now()
          : 60_000;
    throw new RetryableError(
      `Notification upstream HTTP ${response.status}`,
      Math.min(24 * 60 * 60_000, Math.max(60_000, delay)),
    );
  }
  if (response.status === 204) return undefined;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty notification upstream response');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 2 * 1024 * 1024)
        throw new Error('Notification upstream response exceeds size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

import { formatEmoji } from 'discord.js';
import type { ApplicationEmojiManager } from 'discord.js';
import { MAX_IMAGE_BYTES } from './archive.js';
import type { EmojiArchive } from './archive.js';
import { downloadLimited } from './download.js';

export interface InlinePreview {
  mention(assetId: string): Promise<string | undefined>;
  /** Best-effort preview for an emoji ID the bot cannot otherwise render. */
  external?(emojiId: string): Promise<string | undefined>;
  withPage?<T>(
    assetIds: string[],
    render: (
      mention: (assetId: string) => Promise<string | undefined>,
      external: (emojiId: string) => Promise<string | undefined>,
    ) => Promise<T>,
    externalIds?: string[],
  ): Promise<T>;
}

type Preview = { id: string; name: string | null; animated: boolean | null };
const previewName = (id: string) => `f_${id.slice(0, 30)}`;
const externalName = (emojiId: string) => `x_${emojiId}`;
/** Only names this bot owns; user-made application emoji must never be evicted. */
const ownedName = /^(?:f_[a-f0-9]{30}|x_\d{17,20})$/;
const assetIdPattern = /^[a-f0-9]{64}$/;
const snowflakePattern = /^\d{17,20}$/;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isEmojiImage(image: Buffer) {
  return (
    image.subarray(0, 8).equals(pngSignature) ||
    ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('latin1'))
  );
}

/** LRU cache of bot-only previews, never guild slots or original archived images. */
export class ApplicationEmojiPreview implements InlinePreview {
  private readonly known = new Map<string, Preview>();
  private readonly lastUsed = new Map<string, number>();
  private refreshedAt = 0;
  private clock = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly manager: () => ApplicationEmojiManager | undefined,
    private readonly archive: EmojiArchive,
    private readonly onError: () => void = () => {},
    private readonly capacity = 100,
    private readonly download: typeof fetch = fetch,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000)
      throw new Error('Invalid preview cache capacity');
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  mention(assetId: string): Promise<string | undefined> {
    return this.enqueue(() =>
      this.previewAsset(assetId, new Set([previewName(assetId)])),
    );
  }

  external(emojiId: string): Promise<string | undefined> {
    return this.enqueue(() =>
      this.previewExternal(emojiId, new Set([externalName(emojiId)])),
    );
  }

  withPage<T>(
    assetIds: string[],
    render: (
      mention: (assetId: string) => Promise<string | undefined>,
      external: (emojiId: string) => Promise<string | undefined>,
    ) => Promise<T>,
    externalIds: string[] = [],
  ): Promise<T> {
    // Hold protection through the actual reply, not merely while constructing its rows.
    return this.enqueue(async () => {
      const protectedNames = new Set([
        ...assetIds.map(previewName),
        ...externalIds.map(externalName),
      ]);
      return render(
        (id) => this.previewAsset(id, protectedNames),
        (id) => this.previewExternal(id, protectedNames),
      );
    });
  }

  private previewAsset(
    assetId: string,
    protectedNames: Set<string>,
  ): Promise<string | undefined> {
    if (!assetIdPattern.test(assetId)) return Promise.resolve(undefined);
    return this.resolve(
      previewName(assetId),
      async () => (await this.archive.readAsset(assetId)).image,
      protectedNames,
    );
  }

  private previewExternal(
    emojiId: string,
    protectedNames: Set<string>,
  ): Promise<string | undefined> {
    if (!snowflakePattern.test(emojiId)) return Promise.resolve(undefined);
    return this.resolve(
      externalName(emojiId),
      () => this.downloadEmoji(emojiId),
      protectedNames,
    );
  }

  /**
   * Emoji outside the bot's guilds have no archived copy. The public CDN serves
   * them by ID, so cache the bytes as an application emoji the bot owns.
   */
  private async downloadEmoji(emojiId: string): Promise<Buffer> {
    for (const extension of ['gif', 'png'] as const) {
      try {
        const image = await downloadLimited(
          this.download,
          `https://cdn.discordapp.com/emojis/${emojiId}.${extension}`,
          MAX_IMAGE_BYTES,
        );
        if (isEmojiImage(image)) return image;
      } catch {
        // Animated GIFs 415 for static emoji; deleted emoji 404 for both.
      }
    }
    throw new Error('Emoji image unavailable');
  }

  private async resolve(
    name: string,
    image: () => Promise<Buffer>,
    protectedNames: Set<string>,
  ): Promise<string | undefined> {
    try {
      const manager = this.manager();
      if (!manager) return undefined;
      if (Date.now() - this.refreshedAt > 60_000) {
        const emojis = await manager.fetch();
        this.known.clear();
        const present = new Set<string>();
        for (const emoji of emojis.values()) {
          this.known.set(emoji.id, emoji);
          present.add(emoji.id);
          if (
            emoji.name &&
            ownedName.test(emoji.name) &&
            !this.lastUsed.has(emoji.id)
          )
            this.lastUsed.set(emoji.id, ++this.clock);
        }
        for (const id of this.lastUsed.keys())
          if (!present.has(id)) this.lastUsed.delete(id);
        this.refreshedAt = Date.now();
      }
      let emoji = [...this.known.values()].find((entry) => entry.name === name);
      if (emoji) this.lastUsed.set(emoji.id, ++this.clock);
      // Validate/read before deleting any preview to make room.
      const bytes = emoji ? undefined : await image();
      const managed = () =>
        [...this.known.values()].filter(
          (entry) => entry.name && ownedName.test(entry.name),
        );
      const needsRoom = () =>
        managed().length + (emoji ? 0 : 1) > this.capacity ||
        (!emoji && this.known.size >= 2000);
      while (needsRoom()) {
        const victim = managed()
          .filter((entry) => !protectedNames.has(entry.name!))
          .sort(
            (a, b) =>
              (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0),
          )[0];
        if (!victim) {
          // A page larger than capacity can still reuse existing previews, but not exceed it.
          if (!emoji) return undefined;
          break;
        }
        try {
          await manager.delete(victim.id);
        } catch (error) {
          this.refreshedAt = 0;
          throw error;
        }
        this.known.delete(victim.id);
        this.lastUsed.delete(victim.id);
      }
      if (!emoji) {
        try {
          emoji = await manager.create({ name, attachment: bytes! });
          this.known.set(emoji.id, emoji);
          this.lastUsed.set(emoji.id, ++this.clock);
        } catch (error) {
          // A timeout may have succeeded. Refresh before retrying to avoid duplicate uploads.
          this.refreshedAt = 0;
          throw error;
        }
      }
      return formatEmoji({
        id: emoji.id,
        name: emoji.name ?? name,
        animated: Boolean(emoji.animated),
      });
    } catch {
      this.onError();
      return undefined;
    }
  }
}

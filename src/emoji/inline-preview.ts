import { formatEmoji } from 'discord.js';
import type { ApplicationEmojiManager } from 'discord.js';
import type { EmojiArchive } from './archive.js';

export interface InlinePreview {
  mention(assetId: string): Promise<string | undefined>;
  withPage?<T>(
    assetIds: string[],
    render: (
      mention: (assetId: string) => Promise<string | undefined>,
    ) => Promise<T>,
  ): Promise<T>;
}

type Preview = { id: string; name: string | null; animated: boolean | null };
const previewName = (id: string) => `f_${id.slice(0, 30)}`;
const ownedName = /^f_[a-f0-9]{30}$/;

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
      this.resolve(assetId, new Set([previewName(assetId)])),
    );
  }

  withPage<T>(
    assetIds: string[],
    render: (
      mention: (assetId: string) => Promise<string | undefined>,
    ) => Promise<T>,
  ): Promise<T> {
    // Hold protection through the actual reply, not merely while constructing its rows.
    return this.enqueue(async () => {
      const protectedNames = new Set(assetIds.map(previewName));
      return render((id) => this.resolve(id, protectedNames));
    });
  }

  private async resolve(
    assetId: string,
    protectedNames: Set<string>,
  ): Promise<string | undefined> {
    try {
      const manager = this.manager();
      if (!manager || !/^[a-f0-9]{64}$/.test(assetId)) return undefined;
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
      const name = previewName(assetId);
      let emoji = [...this.known.values()].find((entry) => entry.name === name);
      if (emoji) this.lastUsed.set(emoji.id, ++this.clock);
      // Validate/read before deleting any preview to make room.
      const image = emoji
        ? undefined
        : (await this.archive.readAsset(assetId)).image;
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
          emoji = await manager.create({ name, attachment: image! });
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

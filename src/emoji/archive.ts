import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GuildEmoji } from 'discord.js';
import type { BotDatabase, EmojiAsset } from '../storage/database.js';
import { downloadLimited } from './download.js';

export const MAX_IMAGE_BYTES = 256 * 1024;

export class EmojiArchive {
  constructor(
    private readonly dataDir: string,
    private readonly db: BotDatabase,
    private readonly download: typeof fetch = fetch,
  ) {}

  async backup(emoji: GuildEmoji): Promise<EmojiAsset> {
    const extension = emoji.animated ? 'gif' : 'png';
    const image = await downloadLimited(
      this.download,
      emoji.imageURL({ extension, size: 128 }),
      MAX_IMAGE_BYTES,
    );
    validateImage(image, extension);
    const known = this.db.getInstallation(emoji.guild.id, emoji.id);
    // Discord may re-encode uploaded files. An upload's existing identity wins over a new CDN hash.
    const existing = known ? await this.readAsset(known.assetId) : undefined;
    const asset =
      existing?.asset ??
      (await this.storeImage({
        image,
        name: emoji.name ?? 'emoji',
        animated: Boolean(emoji.animated),
        guildId: emoji.guild.id,
        sourceId: emoji.id,
      }));
    if (existing) this.db.saveImage(asset.id, existing.image); // Upgrade v1 filesystem-only archives.
    await atomicWrite(
      join(this.dataDir, 'metadata', `${emoji.guild.id}-${emoji.id}.json`),
      JSON.stringify(
        {
          ...asset,
          discordName: emoji.name,
          roles: [...emoji.roles.cache.keys()],
          managed: emoji.managed,
          backedUpAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    this.db.saveAlias(emoji.guild.id, emoji.name ?? 'emoji', asset.id);
    this.db.saveInstallation({
      guildId: emoji.guild.id,
      discordEmojiId: emoji.id,
      assetId: asset.id,
      name: emoji.name ?? asset.name,
      active: true,
    });
    return asset;
  }

  async storeImage(input: {
    image: Buffer;
    name: string;
    animated: boolean;
    guildId: string;
    sourceId: string;
  }): Promise<EmojiAsset> {
    const extension = input.animated ? 'gif' : 'png';
    validateImage(input.image, extension);
    const hash = createHash('sha256').update(input.image).digest('hex');
    const asset: EmojiAsset = {
      id: hash,
      name: input.name,
      animated: input.animated,
      contentHash: hash,
      relativePath: `emojis/${hash}.${extension}`,
      sourceGuildId: input.guildId,
      sourceEmojiId: input.sourceId,
    };
    await atomicWrite(join(this.dataDir, asset.relativePath), input.image);
    this.db.saveAsset(asset);
    this.db.saveImage(asset.id, input.image);
    this.db.saveAlias(input.guildId, input.name, asset.id);
    return this.db.getAsset(asset.id)!;
  }

  async readAsset(id: string): Promise<{ asset: EmojiAsset; image: Buffer }> {
    const asset = this.db.getAsset(id);
    if (
      !asset ||
      !/^emojis\/[a-f0-9]{64}\.(png|gif)$/.test(asset.relativePath)
    ) {
      throw new Error('Unknown or invalid archived asset');
    }
    // SQLite is now authoritative; filesystem fallback transparently upgrades v1 backups.
    const image =
      this.db.getImage(id) ??
      (await readFile(join(this.dataDir, asset.relativePath)));
    validateImage(image, asset.animated ? 'gif' : 'png');
    if (createHash('sha256').update(image).digest('hex') !== asset.contentHash)
      throw new Error('Archived image checksum mismatch');
    this.db.saveImage(id, image);
    return { asset, image };
  }
}

function validateImage(image: Buffer, extension: 'png' | 'gif') {
  const valid =
    extension === 'png'
      ? image
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ['GIF87a', 'GIF89a'].includes(image.subarray(0, 6).toString('ascii'));
  if (!valid || image.length > MAX_IMAGE_BYTES)
    throw new Error('Invalid emoji image');
}

async function atomicWrite(filename: string, content: Buffer | string) {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

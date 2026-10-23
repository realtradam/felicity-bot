import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GuildEmoji } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotDatabase } from '../storage/database.js';
import { EmojiArchive } from './archive.js';

// A real, tiny PNG; no network calls are made by these tests.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHn8AAAAASUVORK5CYII=',
  'base64',
);
const emoji = {
  id: '123456789012345678',
  name: 'blob',
  animated: false,
  managed: false,
  guild: { id: '234567890123456789' },
  roles: { cache: new Map([['345678901234567890', {}]]) },
  imageURL: () => 'https://cdn.discordapp.com/emojis/123456789012345678.png',
} as unknown as GuildEmoji;

describe('emoji archive', () => {
  let directory: string;
  let db: BotDatabase;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'felicity-archive-'));
    db = new BotDatabase(':memory:');
  });
  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('archives image bytes, restricted roles, metadata and a reusable content identity', async () => {
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(png));
    const archive = new EmojiArchive(directory, db, download);
    const asset = await archive.backup(emoji);
    expect(asset.id).toHaveLength(64);
    expect((await archive.readAsset(asset.id)).image).toEqual(png);
    expect(db.listAssets()).toHaveLength(1);
    await archive.backup(emoji);
    expect(db.listAssets()).toHaveLength(1);
    const metadata = JSON.parse(
      await readFile(
        join(directory, 'metadata', `${emoji.guild.id}-${emoji.id}.json`),
        'utf8',
      ),
    ) as { roles: string[] };
    expect(metadata.roles).toEqual(['345678901234567890']);
  });
  it('does not create asset records for download errors', async () => {
    const download = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    await expect(
      new EmojiArchive(directory, db, download).backup(emoji),
    ).rejects.toThrow('download failed');
    expect(db.listAssets()).toEqual([]);
  });
  it('rejects invalid and oversized images', async () => {
    for (const body of [
      Buffer.from('not an image'),
      Buffer.alloc(256 * 1024 + 1),
    ]) {
      const download = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body));
      await expect(
        new EmojiArchive(directory, db, download).backup(emoji),
      ).rejects.toThrow();
      expect(db.listAssets()).toEqual([]);
    }
  });
  it('preserves identity even when Discord re-encodes a re-upload', async () => {
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(png));
    const archive = new EmojiArchive(directory, db, download);
    const original = await archive.backup(emoji);
    db.saveInstallation({
      guildId: emoji.guild.id,
      discordEmojiId: '999999999999999999',
      assetId: original.id,
      name: 'restored',
      active: true,
    });
    download.mockImplementation(
      async () =>
        new Response(Buffer.concat([png, Buffer.from('different-encoding')])),
    );
    const restored = await archive.backup({
      ...emoji,
      id: '999999999999999999',
      name: 'restored',
    } as GuildEmoji);
    expect(restored.id).toBe(original.id);
    expect(db.listAssets()).toHaveLength(1);
    expect(
      db.listGuildAssets(emoji.guild.id).map((entry) => entry.name),
    ).toEqual(['blob', 'restored']);
  });
  it('checks file integrity before uploading and rejects unknown assets', async () => {
    const download = vi.fn<typeof fetch>().mockResolvedValue(new Response(png));
    const archive = new EmojiArchive(directory, db, download);
    const asset = await archive.backup(emoji);
    await writeFile(
      join(directory, asset.relativePath),
      Buffer.concat([png, Buffer.from('tampered')]),
    );
    // The DB blob is authoritative; a corrupt cache file must not replace it.
    expect((await archive.readAsset(asset.id)).image).toEqual(png);
    db.saveImage(asset.id, Buffer.concat([png, Buffer.from('tampered')]));
    await expect(archive.readAsset(asset.id)).rejects.toThrow(
      'checksum mismatch',
    );
    await expect(archive.readAsset('../../etc/passwd')).rejects.toThrow(
      'Unknown or invalid',
    );
  });
});

it('reads image bytes from SQLite even when the exported filesystem image is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'felicity-db-only-'));
  const db = new BotDatabase(':memory:');
  try {
    const archive = new EmojiArchive(directory, db);
    const asset = await archive.storeImage({
      image: png,
      name: 'test',
      animated: false,
      guildId: 'guild',
      sourceId: 'id',
    });
    await rm(join(directory, asset.relativePath));
    expect((await archive.readAsset(asset.id)).image).toEqual(png);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import sharp from 'sharp';
import { Collection, GuildPremiumTier } from 'discord.js';
import type { Guild, GuildEmoji } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmojiArchive } from './archive.js';
import type { ImageDownloader } from './image-url.js';
import { EmojiService, resolveCurrentEmoji } from './service.js';
import { BotDatabase } from '../storage/database.js';
import type { EmojiAsset } from '../storage/database.js';

const signal = () => new AbortController().signal;
const oldAsset: EmojiAsset = {
  id: 'old-asset',
  name: 'old',
  animated: false,
  contentHash: 'old',
  relativePath: 'old',
  sourceGuildId: 'guild',
  sourceEmojiId: '123456789012345678',
};
const newAsset: EmojiAsset = { ...oldAsset, id: 'new-asset', name: 'new' };
function fixture(db: BotDatabase, full = false) {
  db.saveAsset(oldAsset);
  db.saveAlias('guild', 'old', oldAsset.id);
  db.saveAsset(newAsset);
  db.saveAlias('guild', 'new', newAsset.id);
  const emojis = new Collection<string, GuildEmoji>();
  const outgoing = {
    id: '123456789012345678',
    name: 'old',
    animated: false,
    managed: false,
    roles: { cache: new Collection([['role', {}]]) },
  } as unknown as GuildEmoji;
  emojis.set(outgoing.id, outgoing);
  if (full)
    for (let i = 0; i < 49; i++)
      emojis.set(String(i), {
        id: String(i),
        name: `filler${i}`,
        animated: false,
        managed: false,
      } as GuildEmoji);
  db.saveInstallation({
    guildId: 'guild',
    discordEmojiId: outgoing.id,
    assetId: oldAsset.id,
    name: 'old',
    active: true,
  });
  const create = vi
    .fn()
    .mockImplementation(async (options: { name: string }) => {
      const emoji = {
        ...outgoing,
        id: '999999999999999999',
        name: options.name,
      } as GuildEmoji;
      emojis.set(emoji.id, emoji);
      return emoji;
    });
  const remove = vi.fn().mockImplementation(async (id: string) => {
    emojis.delete(id);
  });
  const guild = {
    id: 'guild',
    premiumTier: GuildPremiumTier.None,
    features: [],
    emojis: {
      fetch: vi.fn().mockImplementation(async () => emojis),
      create,
      delete: remove,
    },
  } as unknown as Guild;
  const backup = vi.fn().mockResolvedValue(oldAsset);
  const readAsset = vi.fn().mockImplementation(async (id: string) => ({
    asset: db.getAsset(id),
    image: Buffer.from('image'),
  }));
  const archive = {
    backup,
    readAsset,
    storeImage: vi.fn(),
  } as unknown as EmojiArchive;
  return {
    guild,
    emojis,
    outgoing,
    create,
    remove,
    backup,
    readAsset,
    archive,
    service: new EmojiService(db, archive),
  };
}

describe('emoji operations', () => {
  let db: BotDatabase;
  beforeEach(() => {
    db = new BotDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('resolves mentions, :names:, bare names and IDs; rejects ambiguous names', () => {
    const f = fixture(db);
    for (const selector of [
      '<:old:123456789012345678>',
      ':old:',
      'OLD',
      '123456789012345678',
    ]) {
      expect(resolveCurrentEmoji(f.emojis.values(), selector).id).toBe(
        f.outgoing.id,
      );
    }
    f.emojis.set('other', { ...f.outgoing, id: 'other' } as GuildEmoji);
    expect(() => resolveCurrentEmoji(f.emojis.values(), 'old')).toThrow(
      'Several',
    );
  });
  it('uploads before deleting when a slot is free and preserves all ID mappings', async () => {
    const f = fixture(db);
    db.saveInstallation({
      guildId: 'guild',
      discordEmojiId: 'former-new',
      assetId: newAsset.id,
      name: 'new',
      active: false,
    });
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'm1',
      createdAt: 1,
      textEmojis: [{ emojiId: 'former-new', count: 2 }],
      reactions: [],
    });
    await f.service.swap(f.guild, ':old:', 'new', signal());
    expect(f.create.mock.invocationCallOrder[0]).toBeLessThan(
      f.remove.mock.invocationCallOrder[0]!,
    );
    expect(db.getInstallation('guild', '999999999999999999')?.assetId).toBe(
      newAsset.id,
    );
    db.recordMessage({
      guildId: 'guild',
      channelId: 'channel',
      messageId: 'm2',
      createdAt: 2,
      textEmojis: [{ emojiId: '999999999999999999', count: 3 }],
      reactions: [],
    });
    expect(
      db.emojiStats('guild').find((row) => row.assetId === newAsset.id),
    ).toMatchObject({ textCount: 5, status: 'active' });
    expect(
      db.emojiStats('guild').find((row) => row.assetId === oldAsset.id)?.status,
    ).toBe('swapped_out');
  });
  it('deletes before uploading in a full same-type pool', async () => {
    const f = fixture(db, true);
    await f.service.swap(f.guild, 'old', 'new', signal());
    expect(f.remove.mock.invocationCallOrder[0]).toBeLessThan(
      f.create.mock.invocationCallOrder[0]!,
    );
  });
  it('does not delete if incoming image validation or outgoing backup fails', async () => {
    const f = fixture(db, true);
    f.readAsset.mockRejectedValueOnce(new Error('corrupt image'));
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow();
    expect(f.remove).not.toHaveBeenCalled();
    f.backup.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('restores the outgoing backup with original role restrictions if a full-pool upload fails', async () => {
    const f = fixture(db, true);
    f.create.mockRejectedValueOnce(new Error('upload failed'));
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow('outgoing emoji was restored');
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[1]?.[0]).toMatchObject({
      name: 'old',
      roles: ['role'],
    });
    expect(db.getInstallation('guild', '999999999999999999')?.assetId).toBe(
      oldAsset.id,
    );
  });
  it('does not retry an upload after an ambiguous response if the incoming emoji exists', async () => {
    const f = fixture(db, true);
    f.create.mockImplementationOnce(async () => {
      f.emojis.set('999999999999999999', {
        ...f.outgoing,
        id: '999999999999999999',
        name: 'new',
      } as GuildEmoji);
      throw new Error('response lost');
    });
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow('needs review');
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('refuses same identity, managed emojis, duplicate incoming names, and ambiguous archive aliases', async () => {
    const f = fixture(db);
    await expect(
      f.service.swap(f.guild, 'old', 'old', signal()),
    ).rejects.toThrow('same identity');
    f.emojis.set('conflict', {
      ...f.outgoing,
      id: 'conflict',
      name: 'new',
    } as GuildEmoji);
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow('already installed');
    f.emojis.delete('conflict');
    db.saveAlias('guild', 'new', oldAsset.id);
    await expect(
      f.service.swap(f.guild, 'old', 'new', signal()),
    ).rejects.toThrow('ambiguous');
    f.outgoing.managed = true;
    await expect(f.service.remove(f.guild, 'old', signal())).rejects.toThrow(
      'managed',
    );
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('does not delete a static emoji to try to free a slot in a full animated pool', async () => {
    const f = fixture(db);
    db.saveAsset({
      ...newAsset,
      id: 'animated',
      name: 'animated',
      animated: true,
    });
    db.saveAlias('guild', 'animated', 'animated');
    for (let i = 0; i < 50; i++)
      f.emojis.set(String(i), {
        id: String(i),
        name: `animated${i}`,
        animated: true,
        managed: false,
      } as GuildEmoji);
    await expect(
      f.service.swap(f.guild, 'old', 'animated', signal()),
    ).rejects.toThrow('pool is full');
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('keeps removal backups and never deletes before a successful backup', async () => {
    const f = fixture(db);
    f.backup.mockRejectedValueOnce(new Error('backup failed'));
    await expect(f.service.remove(f.guild, 'old', signal())).rejects.toThrow();
    expect(f.remove).not.toHaveBeenCalled();
    await f.service.remove(f.guild, 'old', signal());
    expect(f.backup.mock.invocationCallOrder.at(-1)).toBeLessThan(
      f.remove.mock.invocationCallOrder[0]!,
    );
    expect(db.getInstallation('guild', f.outgoing.id)?.active).toBe(false);
  });
  it('reuses a stored 7TV source and does not duplicate an installed identity', async () => {
    const f = fixture(db);
    const link = 'https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN';
    db.saveSource('guild', '7tv', '01F010F9GR0007E4VV006YKSKN', oldAsset.id);
    const download = vi.fn<typeof fetch>();
    const service = new EmojiService(db, f.archive, download);
    expect((await service.add(f.guild, link, signal())).alreadyInstalled).toBe(
      true,
    );
    expect(download).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });
  it('saves both legacy and canonical source aliases and deduplicates either link', async () => {
    const f = fixture(db);
    const legacy = '60ae3e54259ac5a73e56a426';
    const canonical = '01F6MA6Y100002B6P5MWZ5D916';
    const source = await sharp({
      create: { width: 8, height: 8, channels: 4, background: 'red' },
    })
      .webp()
      .toBuffer();
    const metadata = {
      id: canonical,
      name: 'new',
      animated: false,
      host: {
        url: `//cdn.7tv.app/emote/${canonical}`,
        files: [
          {
            name: '4x.webp',
            format: 'WEBP',
            width: 128,
            height: 128,
            frame_count: 1,
          },
        ],
      },
    };
    const download = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async (url) =>
          new Response(
            String(url).includes('7tv.io') ? JSON.stringify(metadata) : source,
          ),
      );
    vi.mocked(f.archive.storeImage).mockResolvedValue(newAsset);
    const service = new EmojiService(db, f.archive, download);
    await service.add(f.guild, `https://7tv.app/emotes/${legacy}`, signal());
    expect(db.getSourceAsset('guild', '7tv', legacy)?.id).toBe(newAsset.id);
    expect(db.getSourceAsset('guild', '7tv', canonical)?.id).toBe(newAsset.id);
    expect(
      (
        await service.add(
          f.guild,
          `https://7tv.app/emotes/${canonical}`,
          signal(),
        )
      ).alreadyInstalled,
    ).toBe(true);
    expect(download).toHaveBeenCalledTimes(2); // One metadata fetch and one image fetch total.
    expect(f.create).toHaveBeenCalledOnce();
  });
  it('uses a requested name with a cached 7TV backup without overwriting its original name', async () => {
    const f = fixture(db);
    db.saveSource('guild', '7tv', '01F010F9GR0007E4VV006YKSKN', newAsset.id);
    await f.service.add(
      f.guild,
      'https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN',
      signal(),
      'MyCustomName',
    );
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ name: 'MyCustomName' });
    expect(db.getAsset(newAsset.id)?.name).toBe('new');
    expect(db.listGuildAssets('guild')).toContainEqual(
      expect.objectContaining({ name: 'MyCustomName', assetId: newAsset.id }),
    );
  });
  it('downloads, archives and adds direct images, remembering the source without storing its signed URL', async () => {
    const f = fixture(db);
    const source = await sharp({
      create: { width: 10, height: 10, channels: 4, background: 'red' },
    })
      .png()
      .toBuffer();
    const download = vi.fn<ImageDownloader>().mockResolvedValue(source);
    vi.mocked(f.archive.storeImage).mockResolvedValue(newAsset);
    const service = new EmojiService(
      db,
      f.archive,
      vi.fn<typeof fetch>(),
      download,
    );
    const link = 'https://example.com/new.png?signature=secret';
    await service.add(f.guild, link, signal(), 'CustomName');
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ name: 'CustomName' });
    expect(f.archive.storeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'new',
        sourceId: expect.stringMatching(/^image:[a-f0-9]{64}$/),
      }),
    );
    expect(
      (await service.add(f.guild, link, signal(), 'CustomName'))
        .alreadyInstalled,
    ).toBe(true);
    expect(download).toHaveBeenCalledOnce();
    expect(f.create).toHaveBeenCalledOnce();
  });
  it('uses the filename when adding a direct image without an explicit name', async () => {
    const f = fixture(db);
    const source = await sharp({
      create: { width: 10, height: 10, channels: 4, background: 'blue' },
    })
      .png()
      .toBuffer();
    vi.mocked(f.archive.storeImage).mockResolvedValue({
      ...newAsset,
      name: 'picture',
    });
    const service = new EmojiService(
      db,
      f.archive,
      vi.fn<typeof fetch>(),
      vi.fn<ImageDownloader>().mockResolvedValue(source),
    );
    await service.add(f.guild, 'https://example.com/picture.jpg', signal());
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ name: 'picture' });
  });
  it('rejects invalid requested names before network or upload and refuses case-insensitive name conflicts', async () => {
    const f = fixture(db);
    db.saveSource('guild', '7tv', '01F010F9GR0007E4VV006YKSKN', newAsset.id);
    const link = 'https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN';
    for (const name of ['a', 'has-dash', 'two words', 'x'.repeat(33)]) {
      await expect(
        f.service.add(f.guild, link, signal(), name),
      ).rejects.toThrow('Emoji names');
    }
    await expect(f.service.add(f.guild, link, signal(), 'OLD')).rejects.toThrow(
      'already has that name',
    );
    expect(f.create).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
  it('keeps the archive when a 7TV upload fails', async () => {
    const f = fixture(db);
    db.saveSource('guild', '7tv', '01F010F9GR0007E4VV006YKSKN', newAsset.id);
    f.create.mockRejectedValueOnce(new Error('full'));
    await expect(
      f.service.add(
        f.guild,
        'https://7tv.app/emotes/01F010F9GR0007E4VV006YKSKN',
        signal(),
      ),
    ).rejects.toThrow('image is backed up');
    expect(
      db.getSourceAsset('guild', '7tv', '01F010F9GR0007E4VV006YKSKN')?.id,
    ).toBe(newAsset.id);
  });
  it('steals only emoji the server is missing and renames taken names', async () => {
    const f = fixture(db);
    const add = vi
      .spyOn(f.service, 'add')
      .mockImplementation(async (_guild, link, _signal, name) => ({
        name: name!,
        id: `added-${name}`,
        animated: link.endsWith('.gif'),
        alreadyInstalled: false,
      }));
    const result = await f.service.steal(
      f.guild,
      [
        '<:old:123456789012345678>',
        '<a:Party:222222222222222222>',
        '<:old:333333333333333333>',
        '<:renamed:222222222222222222>',
      ].join(' '),
      signal(),
    );
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[0]?.[1]).toBe(
      'https://cdn.discordapp.com/emojis/222222222222222222.gif',
    );
    expect(add.mock.calls[0]?.[3]).toBe('Party');
    expect(add.mock.calls[1]?.[1]).toBe(
      'https://cdn.discordapp.com/emojis/333333333333333333.png',
    );
    expect(add.mock.calls[1]?.[3]).toBe('old_2');
    expect(result).toEqual({
      added: [
        { name: 'Party', id: 'added-Party', animated: true },
        { name: 'old_2', id: 'added-old_2', animated: false },
      ],
      skipped: 1,
      failed: [],
    });
  });
  it('counts already-installed assets as skipped and reports failures', async () => {
    const f = fixture(db);
    vi.spyOn(f.service, 'add')
      .mockResolvedValueOnce({
        name: 'dup',
        id: '999999999999999999',
        animated: false,
        alreadyInstalled: true,
      })
      .mockRejectedValueOnce(new Error('full'));
    const result = await f.service.steal(
      f.guild,
      '<:dup:222222222222222222> <:broken:333333333333333333>',
      signal(),
    );
    expect(result.added).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual(['broken']);
  });
  it('derives a valid name for short names and skips work without mentions', async () => {
    const f = fixture(db);
    const add = vi.spyOn(f.service, 'add').mockResolvedValue({
      name: 'e_2222',
      id: '999999999999999999',
      animated: false,
      alreadyInstalled: false,
    });
    expect(await f.service.steal(f.guild, 'text only', signal())).toEqual({
      added: [],
      skipped: 0,
      failed: [],
    });
    expect(add).not.toHaveBeenCalled();
    await f.service.steal(f.guild, '<:a:222222222222222222>', signal());
    expect(add.mock.calls[0]?.[3]).toBe('e_2222');
  });
});

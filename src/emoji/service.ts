import { createHash, randomUUID } from 'node:crypto';
import { GuildPremiumTier } from 'discord.js';
import type { Guild, GuildEmoji } from 'discord.js';
import { UserError } from '../discord/user-error.js';
import type { BotDatabase } from '../storage/database.js';
import type { EmojiArchive } from './archive.js';
import {
  downloadPublicImage,
  fetchImageEmote,
  parseImageUrl,
} from './image-url.js';
import type { ImageDownloader } from './image-url.js';
import { fetchSevenTvEmote, parseSevenTvUrl } from './seventv.js';
import { parseCustomEmojiRefs } from './parse.js';

export interface StealResult {
  added: Array<{ name: string; id: string; animated: boolean }>;
  skipped: number;
  failed: string[];
}

const emojiNamePattern = /^[A-Za-z0-9_]{2,32}$/;

/** Discord names are unique per server; derive a free, valid name without guessing content identity. */
function availableEmojiName(
  raw: string,
  emojiId: string,
  taken: Set<string>,
): string {
  let base = raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
  if (base.length < 2) base = `e_${emojiId.slice(-4)}`;
  let name = base;
  for (let suffix = 2; taken.has(name.toLowerCase()); suffix++) {
    const tail = `_${suffix}`;
    name = `${base.slice(0, 32 - tail.length)}${tail}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

export function resolveCurrentEmoji(
  emojis: Iterable<GuildEmoji>,
  selector: string,
): GuildEmoji {
  const mention = /^<a?:[^:>]+:(\d{17,20})>$/.exec(selector);
  const key = mention?.[1] ?? selector.replace(/^:|:$/g, '');
  const matches = [...emojis].filter(
    (emoji) =>
      emoji.id === key || emoji.name?.toLowerCase() === key.toLowerCase(),
  );
  if (!matches.length)
    throw new UserError(
      'That emoji is not currently installed on this server.',
    );
  if (matches.length > 1)
    throw new UserError(
      'Several current emoji have that name. Use an emoji mention or ID.',
    );
  return matches[0]!;
}

export class EmojiService {
  constructor(
    private readonly db: BotDatabase,
    private readonly archive: EmojiArchive,
    private readonly download: typeof fetch = fetch,
    private readonly imageDownload: ImageDownloader = downloadPublicImage,
  ) {}

  async current(guild: Guild) {
    const emojis = await guild.emojis.fetch();
    this.db.reconcileInstallations(guild.id, [...emojis.values()]);
    return emojis;
  }

  async backup(guild: Guild, signal: AbortSignal) {
    const emojis = await this.current(guild);
    let count = 0;
    for (const emoji of emojis.values()) {
      signal.throwIfAborted();
      await this.archive.backup(emoji);
      count++;
    }
    return count;
  }

  resolveAsset(guildId: string, name: string) {
    const normalized = name.replace(/^:|:$/g, '').toLowerCase();
    const matches = this.db
      .listGuildAssets(guildId)
      .filter(
        (entry) =>
          entry.name.toLowerCase() === normalized || entry.assetId === name,
      );
    const ids = [...new Set(matches.map((entry) => entry.assetId))];
    if (!ids.length)
      throw new UserError(
        'No backed-up emoji has that name. Use !emoji list to see available names.',
      );
    if (ids.length > 1)
      throw new UserError(
        `That backup name is ambiguous. Use one of these asset IDs: ${ids.join(', ')}`,
      );
    const found = matches.find((entry) => entry.assetId === ids[0])!;
    return { assetId: found.assetId, name: found.name };
  }

  async remove(guild: Guild, selector: string, signal: AbortSignal) {
    const emojis = await this.current(guild);
    const emoji = resolveCurrentEmoji(emojis.values(), selector);
    if (emoji.managed)
      throw new UserError('Integration-managed emoji cannot be removed.');
    const asset = await this.archive.backup(emoji);
    signal.throwIfAborted();
    const operationId = randomUUID();
    const details = { emojiId: emoji.id, assetId: asset.id };
    this.db.saveOperation(operationId, guild.id, 'remove', 'deleting', details);
    try {
      await guild.emojis.delete(emoji.id, 'Felicity !emoji remove');
      this.db.deactivateInstallation(guild.id, emoji.id);
      this.db.saveOperation(
        operationId,
        guild.id,
        'remove',
        'complete',
        details,
      );
    } catch {
      this.db.saveOperation(
        operationId,
        guild.id,
        'remove',
        'review_required',
        details,
      );
      throw new UserError(
        `Removal did not complete cleanly. The backup is safe. Inspect Discord before retrying (operation ${operationId}).`,
      );
    }
    return { name: emoji.name, assetId: asset.id };
  }

  private async upload(
    guild: Guild,
    assetId: string,
    name: string,
    roles: string[] = [],
  ) {
    if (!emojiNamePattern.test(name))
      throw new UserError(
        'Emoji names must be 2–32 letters, numbers, or underscores.',
      );
    const { image } = await this.archive.readAsset(assetId);
    const emoji = await guild.emojis.create({
      attachment: image,
      name,
      roles,
      reason: 'Felicity archived emoji upload',
    });
    this.db.saveInstallation({
      guildId: guild.id,
      discordEmojiId: emoji.id,
      assetId,
      name,
      active: true,
    });
    this.db.saveAlias(guild.id, name, assetId);
    return emoji;
  }

  async add(
    guild: Guild,
    link: string,
    signal: AbortSignal,
    requestedName?: string,
  ) {
    if (requestedName !== undefined && !emojiNamePattern.test(requestedName)) {
      throw new UserError(
        'Emoji names must be 2–32 letters, numbers, or underscores.',
      );
    }
    const url = parseImageUrl(link);
    const sevenTv = ['7tv.app', 'www.7tv.app'].includes(url.hostname);
    const provider = sevenTv ? '7tv' : 'image';
    // Store a hash, not a possibly signed image URL, in persistent provenance/journals.
    const sourceId = sevenTv
      ? parseSevenTvUrl(link)
      : createHash('sha256').update(url.href).digest('hex');
    let asset = this.db.getSourceAsset(guild.id, provider, sourceId);
    let name = requestedName ?? asset?.name;
    if (!asset) {
      const emote = sevenTv
        ? await fetchSevenTvEmote(link, this.download, signal)
        : await fetchImageEmote(url.href, signal, this.imageDownload);
      name = requestedName ?? emote.name;
      asset = await this.archive.storeImage({
        ...emote,
        name: emote.name,
        guildId: guild.id,
        sourceId: `${provider}:${sourceId}`,
      });
      this.db.saveSource(guild.id, provider, sourceId, asset.id);
      if ('canonicalId' in emote && typeof emote.canonicalId === 'string')
        this.db.saveSource(guild.id, provider, emote.canonicalId, asset.id);
    }
    // Keep requested aliases even if the Discord upload fails or the name is occupied.
    this.db.saveAlias(guild.id, name!, asset.id);
    const emojis = await this.current(guild);
    for (const emoji of emojis.values()) {
      if (
        this.db.getInstallation(guild.id, emoji.id)?.assetId === asset.id &&
        (requestedName === undefined ||
          emoji.name?.toLowerCase() === requestedName.toLowerCase())
      )
        return {
          name: emoji.name,
          id: emoji.id,
          animated: Boolean(emoji.animated),
          alreadyInstalled: true,
        };
    }
    if (
      [...emojis.values()].some(
        (emoji) => emoji.name?.toLowerCase() === name!.toLowerCase(),
      )
    ) {
      throw new UserError(
        `Backed up ${name}, but an installed emoji already has that name. Try !emoji add <link> another_name, or remove/rename the existing emoji first.`,
      );
    }
    signal.throwIfAborted();
    const operationId = randomUUID();
    const details = { assetId: asset.id, provider, sourceId };
    this.db.saveOperation(operationId, guild.id, 'add', 'uploading', details);
    try {
      const emoji = await this.upload(guild, asset.id, name!);
      this.db.saveOperation(operationId, guild.id, 'add', 'complete', {
        ...details,
        emojiId: emoji.id,
      });
      return {
        name: emoji.name,
        id: emoji.id,
        animated: Boolean(emoji.animated),
        alreadyInstalled: false,
      };
    } catch {
      this.db.saveOperation(
        operationId,
        guild.id,
        'add',
        'review_required',
        details,
      );
      throw new UserError(
        `The image is backed up, but upload did not complete cleanly. Check capacity/permissions and inspect Discord before retrying (operation ${operationId}).`,
      );
    }
  }

  /**
   * Add every custom emoji mentioned in `content` that this server does not
   * currently have, reusing the normal import/archive/upload path.
   */
  async steal(
    guild: Guild,
    content: string,
    signal: AbortSignal,
  ): Promise<StealResult> {
    const refs = parseCustomEmojiRefs(content);
    const result: StealResult = { added: [], skipped: 0, failed: [] };
    if (!refs.length) return result;
    const current = await this.current(guild);
    const installed = new Set(current.keys());
    const taken = new Set(
      [...current.values()].flatMap((emoji) =>
        emoji.name ? [emoji.name.toLowerCase()] : [],
      ),
    );
    for (const ref of refs) {
      signal.throwIfAborted();
      if (installed.has(ref.emojiId)) {
        result.skipped++;
        continue;
      }
      const name = availableEmojiName(ref.name, ref.emojiId, taken);
      const extension = ref.animated ? 'gif' : 'png';
      try {
        const added = await this.add(
          guild,
          `https://cdn.discordapp.com/emojis/${ref.emojiId}.${extension}`,
          signal,
          name,
        );
        installed.add(added.id);
        if (added.alreadyInstalled) result.skipped++;
        else
          result.added.push({
            name: added.name ?? name,
            id: added.id,
            animated: added.animated,
          });
      } catch {
        signal.throwIfAborted();
        result.failed.push(ref.name);
      }
    }
    return result;
  }

  async swap(
    guild: Guild,
    selector: string,
    incoming: string,
    signal: AbortSignal,
  ) {
    const emojis = await this.current(guild);
    const outgoing = resolveCurrentEmoji(emojis.values(), selector);
    if (outgoing.managed)
      throw new UserError('Integration-managed emoji cannot be swapped.');
    const target = this.resolveAsset(guild.id, incoming);
    if (!emojiNamePattern.test(target.name))
      throw new UserError(
        'The incoming backup has an invalid Discord emoji name. Nothing was removed.',
      );
    const { asset: targetAsset } = await this.archive.readAsset(target.assetId); // Preflight before deleting anything.
    const oldAsset = await this.archive.backup(outgoing);
    if (oldAsset.id === target.assetId)
      throw new UserError(
        'That emoji is already installed under the same identity.',
      );
    if (
      [...emojis.values()].some(
        (emoji) =>
          emoji.id !== outgoing.id &&
          (emoji.name?.toLowerCase() === target.name.toLowerCase() ||
            this.db.getInstallation(guild.id, emoji.id)?.assetId ===
              target.assetId),
      )
    ) {
      throw new UserError(
        'The incoming emoji/name is already installed. Nothing was removed.',
      );
    }
    // Discord has independent static/animated pools. Cross-type swaps must have a free target slot.
    const capacity = Math.max(
      guild.features.some((feature) => String(feature) === 'MORE_EMOJI')
        ? 200
        : 0,
      {
        [GuildPremiumTier.None]: 50,
        [GuildPremiumTier.Tier1]: 100,
        [GuildPremiumTier.Tier2]: 150,
        [GuildPremiumTier.Tier3]: 250,
      }[guild.premiumTier],
    );
    const used = [...emojis.values()].filter(
      (emoji) =>
        !emoji.managed && Boolean(emoji.animated) === targetAsset.animated,
    ).length;
    const hasSpace = used < capacity;
    if (!hasSpace && Boolean(outgoing.animated) !== targetAsset.animated)
      throw new UserError(
        'The incoming static/animated emoji pool is full. Removing the other type would not free a slot.',
      );
    const operationId = randomUUID();
    const roles = [...outgoing.roles.cache.keys()];
    const details = {
      outgoingId: outgoing.id,
      outgoingAssetId: oldAsset.id,
      incomingAssetId: target.assetId,
      incomingName: target.name,
      outgoingRoles: roles,
    };
    let deleted = false;
    this.db.saveOperation(operationId, guild.id, 'swap', 'prepared', details);
    try {
      signal.throwIfAborted();
      if (!hasSpace) {
        this.db.saveOperation(
          operationId,
          guild.id,
          'swap',
          'deleting_outgoing',
          details,
        );
        await guild.emojis.delete(outgoing.id, 'Felicity !emoji swap');
        deleted = true;
        this.db.deactivateInstallation(guild.id, outgoing.id);
      }
      this.db.saveOperation(
        operationId,
        guild.id,
        'swap',
        'uploading_incoming',
        details,
      );
      signal.throwIfAborted();
      const installed = await this.upload(guild, target.assetId, target.name);
      this.db.saveOperation(
        operationId,
        guild.id,
        'swap',
        'incoming_uploaded',
        { ...details, incomingId: installed.id },
      );
      if (!deleted) {
        signal.throwIfAborted();
        await guild.emojis.delete(outgoing.id, 'Felicity !emoji swap');
        deleted = true;
        this.db.deactivateInstallation(guild.id, outgoing.id);
      }
      this.db.saveOperation(operationId, guild.id, 'swap', 'complete', {
        ...details,
        incomingId: installed.id,
      });
      return {
        removed: outgoing.name,
        added: target.name,
        id: installed.id,
        animated: Boolean(installed.animated),
      };
    } catch {
      // An upload timeout may still have succeeded. Fetch live state before attempting recovery.
      try {
        const live = await this.current(guild);
        const targetPresent = [...live.values()].find(
          (emoji) => emoji.name === target.name && emoji.id !== outgoing.id,
        );
        // A name match after an ambiguous timeout is not proof of image identity.
        // Leave unknown uploads for operator review instead of conflating another admin's emoji.
        if (!live.has(outgoing.id) && !targetPresent) {
          const restored = await this.upload(
            guild,
            oldAsset.id,
            outgoing.name ?? oldAsset.name,
            roles,
          );
          this.db.saveOperation(
            operationId,
            guild.id,
            'swap',
            'outgoing_restored',
            { ...details, restoredId: restored.id },
          );
          throw new UserError(
            `Swap failed; the outgoing emoji was restored under new ID ${restored.id}. Its usage identity is preserved.`,
          );
        }
      } catch (error) {
        if (error instanceof UserError) throw error;
        // Can't verify server state: do not guess, retry a mutation, or delete another emoji.
      }
      this.db.saveOperation(
        operationId,
        guild.id,
        'swap',
        'review_required',
        details,
      );
      throw new UserError(
        `Swap needs review. Backups are safe; inspect the current server emoji before retrying (operation ${operationId}).`,
      );
    }
  }
}

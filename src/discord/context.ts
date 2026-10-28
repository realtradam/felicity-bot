import type { EmojiArchive } from '../emoji/archive.js';
import type { InlinePreview } from '../emoji/inline-preview.js';
import type { BotDatabase } from '../storage/database.js';

import type { DiscordNotifications } from './notifications.js';

export interface CommandContext {
  notifications?: DiscordNotifications | undefined;
  db: BotDatabase;
  archive: EmojiArchive;
  inlinePreview?: InlinePreview;
  signal: AbortSignal;
  running: Set<string>;
}

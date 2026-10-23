import { resolve } from 'node:path';
import { z } from 'zod';

const snowflake = z.string().regex(/^\d{17,20}$/);
const schema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1),
  DISCORD_CLIENT_ID: snowflake,
  DISCORD_GUILD_ID: snowflake,
  PREVIEW_CACHE_SIZE: z.coerce.number().int().min(10).max(2000).default(100),
  DATA_DIR: z.string().min(1).default('./data'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never print Zod's input: it can contain the Discord token.
    const keys = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Missing or invalid configuration: ${keys.join(', ')}`);
  }
  return {
    previewCacheSize: result.data.PREVIEW_CACHE_SIZE,
    token: result.data.DISCORD_TOKEN,
    clientId: result.data.DISCORD_CLIENT_ID,
    guildId: result.data.DISCORD_GUILD_ID,
    dataDir: resolve(result.data.DATA_DIR),
    logLevel: result.data.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof loadConfig>;

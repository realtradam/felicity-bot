import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    redact: [
      'token',
      'DISCORD_TOKEN',
      'apiKey',
      'AI_GATEWAY_API_KEY',
      'VERCEL_TOKEN',
      'LOGFARE_API_KEY',
      'UMANS_API_KEY',
      'searchApiKey',
      'authorization',
      'headers.authorization',
    ],
  });
}

// Do not log raw Discord request errors: they may carry request headers or content.
export function errorDetails(error: unknown) {
  return { errorType: error instanceof Error ? error.name : 'UnknownError' };
}

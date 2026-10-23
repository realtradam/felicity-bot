import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    redact: [
      'token',
      'DISCORD_TOKEN',
      'authorization',
      'headers.authorization',
    ],
  });
}

// Do not log raw Discord request errors: they may carry request headers or content.
export function errorDetails(error: unknown) {
  return { errorType: error instanceof Error ? error.name : 'UnknownError' };
}

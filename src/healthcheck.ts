import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

try {
  const health = JSON.parse(
    await readFile(
      join(process.env.DATA_DIR ?? './data', 'health.json'),
      'utf8',
    ),
  ) as { timestamp?: unknown };
  if (
    typeof health.timestamp !== 'number' ||
    Date.now() - health.timestamp > 90_000 ||
    health.timestamp > Date.now()
  ) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}

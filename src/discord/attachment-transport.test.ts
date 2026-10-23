import { createServer } from 'node:http';
import { Client, GatewayIntentBits, MessagePayload } from 'discord.js';
import { expect, it } from 'vitest';
// Exercise the real module graph: importing the image downloader also initializes undici.
import { handleMessageCommand, sendReport } from './message-commands.js';
import type { Message } from 'discord.js';

it('sends report multipart attachments through Client.rest alongside the image downloader', async () => {
  expect(handleMessageCommand).toBeTypeOf('function');
  let received = '';
  let contentType = '';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received = Buffer.concat(chunks).toString('utf8');
      contentType = request.headers['content-type'] ?? '';
      response.setHeader('content-type', 'application/json');
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Mock server has no port');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { api: `http://127.0.0.1:${address.port}`, retries: 0 },
  });
  client.rest.setToken('unit-test-placeholder-not-a-real-token');
  try {
    const message = {
      guildId: 'guild',
      client,
      channel: {},
      reply: async (options: Parameters<typeof MessagePayload.create>[1]) => {
        const payload = MessagePayload.create(message, options).resolveBody();
        await payload.resolveFiles();
        return client.rest.post('/channels/123456789012345678/messages', {
          body: payload.body,
          files: payload.files!,
        });
      },
    } as unknown as Message;
    await sendReport(
      message,
      'Usage report',
      ['Hmm'.repeat(700)],
      'emoji-stats.txt',
    );
    expect(contentType).toContain('multipart/form-data');
    expect(received).toContain('emoji-stats.txt');
    expect(received).toContain('Hmm');
    expect(received).toContain('payload_json');
  } finally {
    await client.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

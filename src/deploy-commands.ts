import { REST, Routes } from 'discord.js';
import { loadConfig } from './config.js';
import { commandDefinitions } from './discord/definitions.js';
import { createLogger, errorDetails } from './logger.js';

const logger = createLogger('info');
try {
  const config = loadConfig();
  const rest = new REST({ version: '10' }).setToken(config.token);
  // Deliberately guild-scoped. This replaces this application's commands in that guild.
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    {
      body: commandDefinitions.map((command) => command.toJSON()),
    },
  );
  logger.info({ guildId: config.guildId }, 'Registered guild slash commands');
} catch (error) {
  logger.error(
    errorDetails(error),
    'Command registration failed; check configuration and Discord permissions',
  );
  process.exitCode = 1;
}

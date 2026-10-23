import { SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether Felicity is online')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Archive and manage server emoji')
    .setDMPermission(false)
    .setDefaultMemberPermissions(null)
    .addSubcommand((command) =>
      command
        .setName('backup')
        .setDescription('Back up all current server emoji locally'),
    )
    .addSubcommand((command) =>
      command
        .setName('library')
        .setDescription('List locally archived emoji assets'),
    )
    .addSubcommand((command) =>
      command
        .setName('stats')
        .setDescription(
          'Show observed custom and Unicode emoji usage and last-used days',
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('upload')
        .setDescription('Upload a local asset as a new server emoji')
        .addStringOption((option) =>
          option
            .setName('asset')
            .setDescription('Full asset ID from /emoji library')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription(
              'New emoji name (2–32 letters, numbers, underscores)',
            )
            .setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command
        .setName('remove')
        .setDescription('Back up, then delete a server emoji')
        .addStringOption((option) =>
          option
            .setName('id')
            .setDescription('Server emoji ID to remove')
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('confirm')
            .setDescription('Repeat the same emoji ID to confirm deletion')
            .setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Scan accessible history for emoji usage')
    .setDMPermission(false)
    .setDefaultMemberPermissions(null)
    .addSubcommand((command) =>
      command
        .setName('scan')
        .setDescription(
          'Catch up newest messages and continue unfinished older history',
        )
        .addIntegerOption((option) =>
          option
            .setName('limit')
            .setDescription('Maximum messages this run (default 1000)')
            .setMinValue(1)
            .setMaxValue(5000),
        )
        .addBooleanOption((option) =>
          option
            .setName('resume')
            .setDescription(
              'Incremental scan (default true); false forces a full rescan',
            ),
        ),
    ),
];

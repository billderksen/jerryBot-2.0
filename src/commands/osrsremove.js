import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { removePlayerByUsername } from '../utils/osrsTracker.js';

const ALLOWED_USER_ID = process.env.BOT_ADMIN_USER_ID || '81784467353513984';

export default {
  data: new SlashCommandBuilder()
    .setName('osrsremove')
    .setDescription('Remove a player from the OSRS tracker by username')
    .addStringOption(option =>
      option
        .setName('username')
        .setDescription('RuneScape username')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (interaction.user.id !== ALLOWED_USER_ID) {
      return await interaction.reply({
        content: 'You do not have permission to use this command.',
        flags: MessageFlags.Ephemeral
      });
    }

    const username = interaction.options.getString('username');
    const result = removePlayerByUsername(username);

    if (result.success) {
      await interaction.reply(`Removed **${result.displayName}** from the OSRS tracker.`);
    } else {
      await interaction.reply(`Failed to remove player: ${result.error}`);
    }
  }
};

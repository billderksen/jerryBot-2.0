import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { addPlayerByUsername } from '../utils/osrsTracker.js';

const ALLOWED_USER_ID = process.env.BOT_ADMIN_USER_ID || '81784467353513984';

export default {
  data: new SlashCommandBuilder()
    .setName('osrsadd')
    .setDescription('Add a player to the OSRS tracker by username')
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

    await interaction.deferReply();

    const username = interaction.options.getString('username');
    const result = await addPlayerByUsername(username);

    if (result.success) {
      await interaction.editReply(`Added **${result.player.displayName}** to the OSRS tracker.`);
    } else {
      await interaction.editReply(`Failed to add player: ${result.error}`);
    }
  }
};

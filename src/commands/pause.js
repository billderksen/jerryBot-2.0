import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause the currently playing song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue || !queue.isPlaying) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    queue.pause();
    await interaction.reply('⏸️ Paused the music.');
  }
};

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';

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
    
    // Log the action
    logCommandAction(interaction.user, 'pause');
    
    await interaction.reply('⏸️ Paused the music.');
  }
};

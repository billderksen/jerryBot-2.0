import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume the paused song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    queue.resume();
    
    // Log the action
    logCommandAction(interaction.user, 'resume');
    
    await interaction.reply('▶️ Resumed the music.');
  }
};

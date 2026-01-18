import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playing music and clear the queue'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    queue.stop();
    queue.leave();
    
    // Log the action
    logCommandAction(interaction.user, 'stop');
    
    await interaction.reply('⏹️ Stopped the music and left the voice channel.');
  }
};

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set the music volume (1-10)')
    .addIntegerOption(option =>
      option
        .setName('level')
        .setDescription('Volume level from 1 to 10')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(10)
    ),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    const level = interaction.options.getInteger('level');
    const volume = level / 10; // Convert 1-10 to 0.1-1.0
    
    queue.setVolume(volume);
    
    const volumeBar = '█'.repeat(level) + '░'.repeat(10 - level);
    await interaction.reply(`🔊 Volume set to **${level}/10**\n\`${volumeBar}\``);
  }
};

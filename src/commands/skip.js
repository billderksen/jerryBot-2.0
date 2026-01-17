import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the currently playing song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue || !queue.isPlaying) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    const skippedSong = queue.currentSong;
    queue.skip();
    
    await interaction.reply(`⏭️ Skipped: **${skippedSong.title}**`);
  }
};

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show information about the currently playing song'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue || !queue.currentSong) {
      return await interaction.reply({
        content: '❌ Nothing is currently playing!',
        flags: MessageFlags.Ephemeral
      });
    }

    const song = queue.currentSong;
    const minutes = Math.floor(song.duration / 60);
    const seconds = song.duration % 60;
    
    await interaction.reply({
      content: `🎵 **Now Playing:**\n**${song.title}**\nDuration: ${minutes}:${seconds.toString().padStart(2, '0')}\nRequested by: ${song.requestedBy}`
    });
  }
};

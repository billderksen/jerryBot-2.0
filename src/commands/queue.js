import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getQueue } from '../utils/musicQueue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue'),

  async execute(interaction) {
    const queue = getQueue(interaction.guildId);

    if (!queue) {
      return await interaction.reply({
        content: '❌ There is no music queue!',
        flags: MessageFlags.Ephemeral
      });
    }

    const queueData = queue.getQueue();
    
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🎵 Music Queue')
      .setTimestamp();

    if (queueData.current) {
      embed.addFields({
        name: '🎵 Now Playing',
        value: `**${queueData.current.title}**\nRequested by: ${queueData.current.requestedBy}`,
        inline: false
      });
    }

    if (queueData.upcoming.length > 0) {
      const upcomingList = queueData.upcoming
        .slice(0, 10)
        .map((song, index) => `${index + 1}. **${song.title}**\n   Requested by: ${song.requestedBy}`)
        .join('\n\n');
      
      embed.addFields({
        name: `📋 Up Next (${queueData.upcoming.length} song${queueData.upcoming.length > 1 ? 's' : ''})`,
        value: upcomingList + (queueData.upcoming.length > 10 ? `\n\n...and ${queueData.upcoming.length - 10} more` : ''),
        inline: false
      });
    } else {
      embed.addFields({
        name: '📋 Up Next',
        value: 'Queue is empty',
        inline: false
      });
    }

    await interaction.reply({ embeds: [embed] });
  }
};

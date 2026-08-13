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
      const MAX_FIELD_LEN = 1000;
      let upcomingList = '';
      let shown = 0;

      for (const song of queueData.upcoming) {
        const title = song.title.length > 60 ? `${song.title.slice(0, 60)}…` : song.title;
        const entry = `${shown + 1}. **${title}**\n   Requested by: ${song.requestedBy}`;
        const candidate = upcomingList ? `${upcomingList}\n\n${entry}` : entry;

        // Always show at least one entry, then stop before exceeding the field limit
        if (shown > 0 && candidate.length > MAX_FIELD_LEN) break;
        upcomingList = candidate;
        shown++;
      }

      const rest = queueData.upcoming.length - shown;
      if (rest > 0) {
        upcomingList += `\n…en nog ${rest} nummers`;
      }

      embed.addFields({
        name: `📋 Up Next (${queueData.upcoming.length} song${queueData.upcoming.length > 1 ? 's' : ''})`,
        value: upcomingList,
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

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getDiscordTotals } from '../utils/discordTracker.js';

export default {
  data: new SlashCommandBuilder()
    .setName('serverstats')
    .setDescription('Show all-time server message and voice channel statistics'),

  async execute(interaction) {
    const { messages, voice, totalMessages, totalVoiceMinutes } = getDiscordTotals();

    const totalHours = Math.floor(totalVoiceMinutes / 60);
    const totalMins = totalVoiceMinutes % 60;
    const voiceStr = totalHours > 0 ? `${totalHours}h ${totalMins}m` : `${totalMins}m`;

    const embed = new EmbedBuilder()
      .setColor(0x1DB954)
      .setTitle('All-Time Server Stats')
      .setDescription(`**${totalMessages.toLocaleString()}** messages sent \u00B7 **${voiceStr}** in voice`)
      .setTimestamp();

    // Top chatters
    if (messages.length > 0) {
      const list = messages.slice(0, 10)
        .map((m, i) => `${i + 1}. **${m.displayName}** — ${m.count.toLocaleString()} messages`)
        .join('\n');
      embed.addFields({ name: '\uD83D\uDCAC Top Chatters', value: list, inline: true });
    }

    // Top voice users
    if (voice.length > 0) {
      const list = voice.slice(0, 10)
        .map((v, i) => {
          const h = Math.floor(v.minutes / 60);
          const m = v.minutes % 60;
          const time = h > 0 ? `${h}h ${m}m` : `${m}m`;
          return `${i + 1}. **${v.displayName}** — ${time}`;
        })
        .join('\n');
      embed.addFields({ name: '\uD83C\uDF99\uFE0F Top Voice', value: list, inline: true });
    }

    if (messages.length === 0 && voice.length === 0) {
      embed.setDescription('No data tracked yet. Stats will appear as people chat and join voice channels.');
    }

    await interaction.reply({ embeds: [embed] });
  }
};

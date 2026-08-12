import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getLeaderboard } from '../utils/levelSystem.js';

const MEDALS = ['🥇', '🥈', '🥉'];

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the top 10 users by XP'),

  async execute(interaction) {
    const entries = getLeaderboard(10);

    if (entries.length === 0) {
      return interaction.reply({ content: 'No one has earned XP yet!', ephemeral: true });
    }

    const lines = entries.map((entry) => {
      const medal = MEDALS[entry.rank - 1] || `**${entry.rank}.**`;
      return `${medal} ${entry.displayName} — Level ${entry.level} (${entry.xp.toLocaleString()} XP)`;
    });

    const embed = new EmbedBuilder()
      .setColor(0xFFA500)
      .setTitle('XP Leaderboard')
      .setDescription(lines.join('\n'))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
};

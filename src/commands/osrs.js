import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getPlayerInactivity, getTrackerData } from '../utils/osrsTracker.js';

function getInactivityEmoji(lastChangedAt) {
  if (!lastChangedAt) return '⚫';
  const diffMs = Date.now() - new Date(lastChangedAt).getTime();
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 1) return '🟢';
  if (hours < 24) return '🟡';
  if (hours < 168) return '🟠';
  return '🔴';
}

function formatXP(xp) {
  if (!xp || xp <= 0) return '0';
  if (xp >= 1000000) return (xp / 1000000).toFixed(1) + 'M';
  if (xp >= 1000) return (xp / 1000).toFixed(1) + 'K';
  return String(xp);
}

function getTopGains(gains, limit = 3) {
  if (!gains?.skills) return [];
  return Object.entries(gains.skills)
    .filter(([name, s]) => name !== 'overall' && s?.experience?.gained > 0)
    .sort((a, b) => b[1].experience.gained - a[1].experience.gained)
    .slice(0, limit)
    .map(([name, s]) => {
      const displayName = name.charAt(0).toUpperCase() + name.slice(1);
      return `${displayName} +${formatXP(s.experience.gained)}`;
    });
}

export default {
  data: new SlashCommandBuilder()
    .setName('osrs')
    .setDescription('Show OSRS player tracker with gains')
    .addStringOption(option =>
      option
        .setName('period')
        .setDescription('Gains period (default: day)')
        .addChoices(
          { name: 'Day', value: 'day' },
          { name: 'Week', value: 'week' },
          { name: 'Month', value: 'month' }
        )
    ),

  async execute(interaction) {
    const period = interaction.options.getString('period') || 'day';
    const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);
    const inactivity = getPlayerInactivity();
    const { players, gains, lastRefresh } = getTrackerData();

    if (inactivity.length === 0) {
      return await interaction.reply('No players are being tracked.');
    }

    const embed = new EmbedBuilder()
      .setTitle('⚔️ OSRS Player Tracker')
      .setColor(0xff981f);

    let description = '';
    for (const entry of inactivity) {
      const player = players[entry.id];
      if (!player) continue;

      const emoji = getInactivityEmoji(entry.lastChangedAt);
      const totalLevel = player.skills?.overall?.level || '?';
      const combat = player.combatLevel || '?';
      const duration = entry.inactiveDuration || 'No data';
      const activeText = duration === 'Just now' ? 'Active now' : `${duration} ago`;

      const playerGains = gains[entry.id]?.[period];
      const totalXPGained = playerGains?.skills?.overall?.experience?.gained || 0;
      const topSkills = getTopGains(playerGains);

      const womUrl = `https://wiseoldman.net/players/${encodeURIComponent(player.username)}`;

      description += `${emoji} **[${player.displayName}](${womUrl})** — Cmb ${combat} — Total ${totalLevel}\n`;
      description += `   Last active: ${activeText}\n`;

      if (totalXPGained > 0) {
        description += `   ${periodLabel} gains: **+${formatXP(totalXPGained)} XP**`;
        if (topSkills.length > 0) {
          description += ` (${topSkills.join(', ')})`;
        }
        description += '\n';
      } else {
        description += `   ${periodLabel} gains: *None*\n`;
      }

      description += '\n';
    }

    if (lastRefresh) {
      const refreshAge = Date.now() - new Date(lastRefresh).getTime();
      const mins = Math.floor(refreshAge / 60000);
      description += `*Updated ${mins < 1 ? 'just now' : `${mins}m ago`} · Showing ${periodLabel.toLowerCase()} gains*`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'View full tracker at godcord.nl/osrs' });

    await interaction.reply({ embeds: [embed] });
  }
};

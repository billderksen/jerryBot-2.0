import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getUserLevel, xpProgressInLevel, getUserRank } from '../utils/levelSystem.js';

export default {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Check your level and XP progress')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('User to check (defaults to yourself)')
        .setRequired(false)
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member = interaction.guild?.members.cache.get(targetUser.id) || await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
    const userData = getUserLevel(targetUser.id);

    if (!userData) {
      return interaction.reply({ content: `${targetUser.id === interaction.user.id ? 'You have' : `${targetUser.username} has`} no XP yet. Start chatting or join a voice channel!`, ephemeral: true });
    }

    const progress = xpProgressInLevel(targetUser.id);
    const rank = getUserRank(targetUser.id);
    const progressPercent = Math.floor((progress.currentXp / progress.requiredXp) * 100);
    const filledBlocks = Math.round(progressPercent / 5);
    const progressBar = '█'.repeat(filledBlocks) + '░'.repeat(20 - filledBlocks);

    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle(`${member?.displayName || targetUser.username}'s Rank`)
      .addFields(
        { name: 'Rank', value: `#${rank}`, inline: true },
        { name: 'Level', value: `${userData.level}`, inline: true },
        { name: 'Total XP', value: `${userData.xp}`, inline: true },
        { name: `Progress to Level ${userData.level + 1}`, value: `${progressBar}\n${progress.currentXp} / ${progress.requiredXp} XP (${progressPercent}%)` }
      )
      .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }
};

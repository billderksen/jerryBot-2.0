import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getLastSeen } from '../utils/lastSeenTracker.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lastseen')
    .setDescription('Check when a user was last seen online')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('The user to check')
        .setRequired(true)),

  async execute(interaction) {
    const user = interaction.options.getUser('user');

    if (user.bot) {
      return interaction.reply({ content: 'Bots don\'t sleep.', flags: MessageFlags.Ephemeral });
    }

    // Check if the user is currently online
    const member = interaction.guild.members.cache.get(user.id);
    const presence = member?.presence;
    const isOnline = presence && presence.status !== 'offline';

    if (isOnline) {
      const statusEmoji = presence.status === 'idle' ? '🌙' : presence.status === 'dnd' ? '⛔' : '🟢';
      const embed = new EmbedBuilder()
        .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
        .setDescription(`${statusEmoji} **Currently ${presence.status === 'idle' ? 'idle' : presence.status === 'dnd' ? 'on Do Not Disturb' : 'online'}**`)
        .setColor(0x57F287);
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // Check stored last seen data
    const lastSeen = getLastSeen(user.id);

    if (!lastSeen) {
      const embed = new EmbedBuilder()
        .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
        .setDescription('No activity recorded yet.')
        .setColor(0x99AAB5);
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const unixTimestamp = Math.floor(lastSeen.timestamp / 1000);
    const typeLabel = lastSeen.type === 'message' ? 'Sent a message'
      : lastSeen.type === 'voice' ? 'Was in a voice channel'
      : 'Went offline';

    const embed = new EmbedBuilder()
      .setAuthor({ name: user.displayName, iconURL: user.displayAvatarURL() })
      .setDescription(`Last seen <t:${unixTimestamp}:R> (<t:${unixTimestamp}:f>)\n${typeLabel}`)
      .setColor(0x99AAB5);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
};

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags, EmbedBuilder } from 'discord.js';
import { setBirthday, removeBirthday, getBirthdays, setBirthdayChannel } from '../utils/birthdayTracker.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export default {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Birthday tracker')
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set your birthday')
        .addIntegerOption(opt =>
          opt.setName('day')
            .setDescription('Day of the month (1-31)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31))
        .addIntegerOption(opt =>
          opt.setName('month')
            .setDescription('Month (1-12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12)))
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a birthday for another user (Admin only)')
        .addUserOption(opt =>
          opt.setName('user')
            .setDescription('The user to set the birthday for')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('day')
            .setDescription('Day of the month (1-31)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31))
        .addIntegerOption(opt =>
          opt.setName('month')
            .setDescription('Month (1-12)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(12)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove your birthday'))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all birthdays'))
    .addSubcommand(sub =>
      sub.setName('channel')
        .setDescription('Set the birthday announcement channel (Admin only)')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The channel for birthday announcements')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const day = interaction.options.getInteger('day');
      const month = interaction.options.getInteger('month');

      if (day > DAYS_IN_MONTH[month - 1]) {
        return interaction.reply({ content: `Invalid date: ${MONTH_NAMES[month - 1]} only has ${DAYS_IN_MONTH[month - 1]} days.`, flags: MessageFlags.Ephemeral });
      }

      const displayName = interaction.member?.displayName || interaction.user.username;
      setBirthday(interaction.user.id, day, month, displayName);
      await interaction.reply({ content: `Your birthday has been set to **${day} ${MONTH_NAMES[month - 1]}**. 🎂`, flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'add') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to add birthdays for other users.', flags: MessageFlags.Ephemeral });
      }
      const user = interaction.options.getUser('user');
      const day = interaction.options.getInteger('day');
      const month = interaction.options.getInteger('month');

      if (day > DAYS_IN_MONTH[month - 1]) {
        return interaction.reply({ content: `Invalid date: ${MONTH_NAMES[month - 1]} only has ${DAYS_IN_MONTH[month - 1]} days.`, flags: MessageFlags.Ephemeral });
      }

      const member = interaction.guild.members.cache.get(user.id);
      const displayName = member?.displayName || user.username;
      setBirthday(user.id, day, month, displayName);
      await interaction.reply({ content: `Birthday for ${user} has been set to **${day} ${MONTH_NAMES[month - 1]}**. 🎂`, flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'remove') {
      const removed = removeBirthday(interaction.user.id);
      if (removed) {
        await interaction.reply({ content: 'Your birthday has been removed.', flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: 'You don\'t have a birthday set.', flags: MessageFlags.Ephemeral });
      }
    }

    else if (sub === 'list') {
      const birthdays = getBirthdays();
      const entries = Object.entries(birthdays);

      if (entries.length === 0) {
        return interaction.reply({ content: 'No birthdays registered yet. Use `/birthday set` to add yours!', flags: MessageFlags.Ephemeral });
      }

      const now = new Date();
      const todayDay = now.getDate();
      const todayMonth = now.getMonth() + 1;

      // Sort by next occurrence
      const sorted = entries.map(([userId, b]) => {
        const thisYear = now.getFullYear();
        let next = new Date(thisYear, b.month - 1, b.day);
        // If birthday already passed this year, use next year
        if (next < new Date(thisYear, todayMonth - 1, todayDay)) {
          next = new Date(thisYear + 1, b.month - 1, b.day);
        }
        const isToday = b.day === todayDay && b.month === todayMonth;
        return { userId, ...b, next, isToday };
      }).sort((a, b) => a.next - b.next);

      const todayBirthdays = sorted.filter(b => b.isToday);
      const upcomingBirthdays = sorted.filter(b => !b.isToday);

      let description = '';
      if (todayBirthdays.length > 0) {
        description += '**🎉 Today\'s Birthdays:**\n';
        description += todayBirthdays.map(b => `🎂 <@${b.userId}> — ${b.day} ${MONTH_NAMES[b.month - 1]}`).join('\n');
        description += '\n\n';
      }

      if (upcomingBirthdays.length > 0) {
        description += '**Upcoming Birthdays:**\n';
        description += upcomingBirthdays.map(b => `<@${b.userId}> — ${b.day} ${MONTH_NAMES[b.month - 1]}`).join('\n');
      }

      const embed = new EmbedBuilder()
        .setColor(0xFF69B4)
        .setTitle('🎂 Server Birthdays')
        .setDescription(description)
        .setFooter({ text: `${entries.length} birthday${entries.length !== 1 ? 's' : ''} registered` });

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'channel') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to set the birthday channel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      setBirthdayChannel(interaction.guild.id, channel.id);
      await interaction.reply({ content: `Birthday announcements will be posted to ${channel}. 🎂`, flags: MessageFlags.Ephemeral });
    }
  }
};

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { addReminder, getUserReminders, cancelReminder, isValidCalendarDate } from '../utils/reminderTracker.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export default {
  data: new SlashCommandBuilder()
    .setName('reminder')
    .setDescription('Set reminders')
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Set a reminder')
        .addIntegerOption(opt =>
          opt.setName('hour')
            .setDescription('Hour (0-23)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(23))
        .addIntegerOption(opt =>
          opt.setName('minute')
            .setDescription('Minute (0-59)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(59))
        .addStringOption(opt =>
          opt.setName('message')
            .setDescription('What to remind you about')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('day')
            .setDescription('Day of the month (defaults to today)')
            .setMinValue(1)
            .setMaxValue(31))
        .addIntegerOption(opt =>
          opt.setName('month')
            .setDescription('Month (1-12, defaults to current month)')
            .setMinValue(1)
            .setMaxValue(12))
        .addUserOption(opt =>
          opt.setName('user1')
            .setDescription('Additional person to ping'))
        .addUserOption(opt =>
          opt.setName('user2')
            .setDescription('Additional person to ping'))
        .addUserOption(opt =>
          opt.setName('user3')
            .setDescription('Additional person to ping'))
        .addUserOption(opt =>
          opt.setName('user4')
            .setDescription('Additional person to ping'))
        .addUserOption(opt =>
          opt.setName('user5')
            .setDescription('Additional person to ping'))
        .addRoleOption(opt =>
          opt.setName('role1')
            .setDescription('Role to ping'))
        .addRoleOption(opt =>
          opt.setName('role2')
            .setDescription('Role to ping'))
        .addRoleOption(opt =>
          opt.setName('role3')
            .setDescription('Role to ping')))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show your pending reminders'))
    .addSubcommand(sub =>
      sub.setName('cancel')
        .setDescription('Cancel a reminder')
        .addStringOption(opt =>
          opt.setName('id')
            .setDescription('Reminder ID (from /reminder list)')
            .setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set') {
      const hour = interaction.options.getInteger('hour');
      const minute = interaction.options.getInteger('minute');
      const message = interaction.options.getString('message');
      const now = new Date();
      const day = interaction.options.getInteger('day') ?? now.getDate();
      const month = interaction.options.getInteger('month') ?? (now.getMonth() + 1);
      const year = now.getFullYear();

      if (!isValidCalendarDate(day, month, year)) {
        return interaction.reply({ content: `Invalid date: ${MONTH_NAMES[month - 1]} ${day} does not exist.`, flags: MessageFlags.Ephemeral });
      }

      // Build the fire date (server timezone = Europe/Amsterdam)
      const fireDate = new Date(year, month - 1, day, hour, minute, 0, 0);
      if (fireDate <= now) {
        const userSetDay = interaction.options.getInteger('day') !== null;
        const userSetMonth = interaction.options.getInteger('month') !== null;
        if (userSetDay || userSetMonth) {
          if (!isValidCalendarDate(day, month, year + 1)) {
            return interaction.reply({ content: `Invalid date: ${MONTH_NAMES[month - 1]} ${day} does not exist in ${year + 1}.`, flags: MessageFlags.Ephemeral });
          }
          fireDate.setFullYear(year + 1);
        } else {
          fireDate.setDate(fireDate.getDate() + 1);
        }
      }

      // Collect mentioned users
      const mentions = [];
      for (const key of ['user1', 'user2', 'user3', 'user4', 'user5']) {
        const user = interaction.options.getUser(key);
        if (user && user.id !== interaction.user.id) {
          mentions.push(user.id);
        }
      }

      // Collect mentioned roles
      const roleMentions = [];
      for (const key of ['role1', 'role2', 'role3']) {
        const role = interaction.options.getRole(key);
        if (role) {
          roleMentions.push(role.id);
        }
      }

      const id = addReminder({
        userId: interaction.user.id,
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        message,
        fireAt: fireDate.getTime(),
        mentions,
        roleMentions,
      });

      const timeStr = `<t:${Math.floor(fireDate.getTime() / 1000)}:F>`;
      const relStr = `<t:${Math.floor(fireDate.getTime() / 1000)}:R>`;
      await interaction.reply({ content: `Reminder set for ${timeStr} (${relStr}). ID: \`${id}\``, flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'list') {
      const reminders = getUserReminders(interaction.user.id);
      if (reminders.length === 0) {
        return interaction.reply({ content: 'You have no pending reminders.', flags: MessageFlags.Ephemeral });
      }

      const lines = reminders.map(r => {
        const timeStr = `<t:${Math.floor(r.fireAt / 1000)}:R>`;
        const pings = [
          ...r.mentions.map(id => `<@${id}>`),
          ...(r.roleMentions || []).map(id => `<@&${id}>`),
        ];
        const extra = pings.length > 0 ? ` (also pinging ${pings.join(', ')})` : '';
        return `\`${r.id}\` — ${timeStr}: ${r.message}${extra}`;
      });

      await interaction.reply({ content: `**Your reminders:**\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }

    else if (sub === 'cancel') {
      const id = interaction.options.getString('id');
      const removed = cancelReminder(interaction.user.id, id);
      if (removed) {
        await interaction.reply({ content: `Reminder \`${id}\` cancelled.`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: `Reminder \`${id}\` not found or not yours.`, flags: MessageFlags.Ephemeral });
      }
    }
  }
};

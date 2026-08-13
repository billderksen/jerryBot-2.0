import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { addStreamer, removeStreamer, subscribeUser, unsubscribeUser, setNotificationChannel, getTrackerData } from '../utils/twitchTracker.js';

const DJ_ROLE_ID = process.env.DJ_ROLE_ID || '1467139293586653339';

function hasDJRole(interaction) {
  return interaction.member?.roles?.cache?.has(DJ_ROLE_ID);
}

export default {
  data: new SlashCommandBuilder()
    .setName('streamer')
    .setDescription('Manage Twitch stream notifications')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a Twitch streamer to the watch list (DJ role required)')
        .addStringOption(opt =>
          opt.setName('username')
            .setDescription('Twitch username')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a Twitch streamer from the watch list (DJ role required)')
        .addStringOption(opt =>
          opt.setName('username')
            .setDescription('Twitch username')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all tracked streamers'))
    .addSubcommand(sub =>
      sub.setName('subscribe')
        .setDescription('Subscribe to notifications for a streamer')
        .addStringOption(opt =>
          opt.setName('username')
            .setDescription('Twitch username')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('unsubscribe')
        .setDescription('Unsubscribe from notifications for a streamer')
        .addStringOption(opt =>
          opt.setName('username')
            .setDescription('Twitch username')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('channel')
        .setDescription('Set the notification channel (DJ role required)')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The channel for stream notifications')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true))),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const data = getTrackerData();
    const choices = Object.entries(data.streamers)
      .map(([login, s]) => ({ name: s.displayName || login, value: login }))
      .filter(c => c.name.toLowerCase().includes(focused) || c.value.includes(focused))
      .slice(0, 25);

    await interaction.respond(choices);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      if (!hasDJRole(interaction)) {
        return interaction.reply({ content: 'You need the DJ role to add streamers.', flags: MessageFlags.Ephemeral });
      }
      await interaction.deferReply();
      const username = interaction.options.getString('username');
      const result = await addStreamer(username, interaction.user.id);
      if (result.success) {
        await interaction.editReply(`Added **${result.displayName}** to the Twitch watch list.`);
      } else {
        await interaction.editReply(result.error);
      }
    }

    else if (sub === 'remove') {
      if (!hasDJRole(interaction)) {
        return interaction.reply({ content: 'You need the DJ role to remove streamers.', flags: MessageFlags.Ephemeral });
      }
      const username = interaction.options.getString('username');
      const result = removeStreamer(username);
      if (result.success) {
        await interaction.reply(`Removed **${result.displayName}** from the Twitch watch list.`);
      } else {
        await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      }
    }

    else if (sub === 'list') {
      const data = getTrackerData();
      const entries = Object.entries(data.streamers);

      if (entries.length === 0) {
        return interaction.reply({ content: 'No streamers are being tracked.', flags: MessageFlags.Ephemeral });
      }

      const lines = entries.map(([login, s]) => {
        const status = s.isLive ? `🟢 Live: ${s.gameName || 'Unknown'}` : '⚫ Offline';
        const subs = (s.subscribers || []).length;
        return `**${s.displayName || login}** — ${status} (${subs} subscriber${subs !== 1 ? 's' : ''})`;
      });

      const channelMention = data.notificationChannelId
        ? `\nNotification channel: <#${data.notificationChannelId}>`
        : '\nNo notification channel set.';

      await interaction.reply({
        content: `**Tracked Streamers:**\n${lines.join('\n')}${channelMention}`,
        flags: MessageFlags.Ephemeral
      });
    }

    else if (sub === 'subscribe') {
      const username = interaction.options.getString('username');
      const result = subscribeUser(username, interaction.user.id);
      if (result.success) {
        await interaction.reply({ content: `Subscribed to notifications for **${result.displayName}**.`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      }
    }

    else if (sub === 'unsubscribe') {
      const username = interaction.options.getString('username');
      const result = unsubscribeUser(username, interaction.user.id);
      if (result.success) {
        await interaction.reply({ content: `Unsubscribed from notifications for **${result.displayName}**.`, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      }
    }

    else if (sub === 'channel') {
      if (!hasDJRole(interaction)) {
        return interaction.reply({ content: 'You need the DJ role to set the notification channel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      setNotificationChannel(channel.id);
      await interaction.reply(`Twitch notifications will be sent to ${channel}.`);
    }
  }
};

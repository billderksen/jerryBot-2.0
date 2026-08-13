import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { generateCurrentRecap, getLatestRecap, setRecapChannel, setRecapSchedule, buildDiscordEmbed, getRecapSettings } from '../utils/weeklyRecap.js';

const DJ_ROLE_ID = process.env.DJ_ROLE_ID || '1467139293586653339';

function hasDJRole(interaction) {
  return interaction.member?.roles?.cache?.has(DJ_ROLE_ID);
}

export default {
  data: new SlashCommandBuilder()
    .setName('recap')
    .setDescription('Weekly server activity recap')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show the latest weekly recap'))
    .addSubcommand(sub =>
      sub.setName('generate')
        .setDescription('Generate a recap for the current week so far'))
    .addSubcommand(sub =>
      sub.setName('channel')
        .setDescription('Set the channel for auto-posted recaps (DJ role required)')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The channel for weekly recaps')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('schedule')
        .setDescription('Set when recaps are posted (DJ role required)')
        .addIntegerOption(opt =>
          opt.setName('day')
            .setDescription('Day of week (0=Sunday, 1=Monday, ..., 6=Saturday)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(6))
        .addIntegerOption(opt =>
          opt.setName('hour')
            .setDescription('Hour (0-23)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(23))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'view') {
      const recap = getLatestRecap();
      if (!recap) {
        return interaction.reply({ content: 'No recaps generated yet. Try `/recap generate` to create one.', flags: MessageFlags.Ephemeral });
      }
      const embed = buildDiscordEmbed(recap);
      await interaction.reply({ embeds: [embed] });
    }

    else if (sub === 'generate') {
      await interaction.deferReply();
      const recap = generateCurrentRecap();
      const embed = buildDiscordEmbed(recap);
      await interaction.editReply({ content: '📊 **Current week recap (so far):**', embeds: [embed] });
    }

    else if (sub === 'channel') {
      if (!hasDJRole(interaction)) {
        return interaction.reply({ content: 'You need the DJ role to set the recap channel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      setRecapChannel(channel.id);
      await interaction.reply(`Weekly recaps will be posted to ${channel}.`);
    }

    else if (sub === 'schedule') {
      if (!hasDJRole(interaction)) {
        return interaction.reply({ content: 'You need the DJ role to change the recap schedule.', flags: MessageFlags.Ephemeral });
      }
      const day = interaction.options.getInteger('day');
      const hour = interaction.options.getInteger('hour');
      const result = setRecapSchedule(day, hour);
      if (result.success) {
        await interaction.reply(`Weekly recaps scheduled for **${result.day}** at **${result.hour}:00**.`);
      } else {
        await interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
      }
    }
  }
};

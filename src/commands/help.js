import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } from 'discord.js';

// Category definitions: emoji, label, and which command names belong to it
const CATEGORIES = [
  {
    id: 'music',
    emoji: '🎵',
    label: 'Music',
    description: 'Music playback controls',
    commands: ['play', 'queue', 'nowplaying', 'pause', 'resume', 'skip', 'stop', 'volume', 'playlist']
  },
  {
    id: 'games',
    emoji: '🎮',
    label: 'Games',
    description: 'Multiplayer games',
    commands: ['trivia', 'challenge', 'f1', 'hitster']
  },
  {
    id: 'social',
    emoji: '👥',
    label: 'Social',
    description: 'Levels, birthdays & reminders',
    commands: ['rank', 'leaderboard', 'birthday', 'reminder', 'lastseen']
  },
  {
    id: 'stats',
    emoji: '📊',
    label: 'Stats & Tracking',
    description: 'Server stats, recaps & trackers',
    commands: ['serverstats', 'recap', 'osrs', 'osrsadd', 'osrsremove', 'streamer']
  },
  {
    id: 'utility',
    emoji: '🔧',
    label: 'Utility',
    description: 'Chat, uptime & admin tools',
    commands: ['chat', 'chatmodel', 'heyjerry', 'uptime', 'antioffline', 'record']
  }
];

function formatCommand(cmd) {
  const sub = cmd.options?.filter(o => o.type === 1); // type 1 = subcommand
  if (sub && sub.length > 0) {
    return sub.map(s => `\`/${cmd.name} ${s.name}\` — ${s.description}`).join('\n');
  }
  return `\`/${cmd.name}\` — ${cmd.description}`;
}

function buildOverviewEmbed(commands, botUser) {
  const totalCommands = commands.size;
  const categoryFields = CATEGORIES.map(cat => {
    const cmds = cat.commands
      .map(name => commands.get(name))
      .filter(Boolean);
    const cmdList = cmds.map(c => `\`/${c.data.name}\``).join('  ');
    return { name: `${cat.emoji}  ${cat.label}`, value: cmdList || '*No commands*', inline: false };
  });

  return new EmbedBuilder()
    .setAuthor({ name: `${botUser.username} Commands`, iconURL: botUser.displayAvatarURL() })
    .setDescription(`**${totalCommands} commands** across ${CATEGORIES.length} categories\nUse the menu below to explore each category in detail.`)
    .addFields(categoryFields)
    .setColor(0x5865F2)
    .setThumbnail(botUser.displayAvatarURL({ size: 256 }))
    .setFooter({ text: 'Select a category below for detailed info' });
}

function buildCategoryEmbed(category, commands, botUser) {
  const cmds = category.commands
    .map(name => commands.get(name))
    .filter(Boolean);

  const lines = cmds.map(c => formatCommand(c.data.toJSON())).join('\n');

  return new EmbedBuilder()
    .setAuthor({ name: `${botUser.username} Commands`, iconURL: botUser.displayAvatarURL() })
    .setTitle(`${category.emoji}  ${category.label}`)
    .setDescription(lines || '*No commands in this category*')
    .setColor(0x5865F2)
    .setThumbnail(botUser.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${cmds.length} command${cmds.length !== 1 ? 's' : ''} in this category` });
}

function buildSelectMenu(activeId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('help_category')
      .setPlaceholder('Select a category...')
      .addOptions([
        { label: 'Overview', description: 'Show all categories', value: 'overview', emoji: '📋', default: activeId === 'overview' },
        ...CATEGORIES.map(cat => ({
          label: cat.label,
          description: cat.description,
          value: cat.id,
          emoji: cat.emoji,
          default: activeId === cat.id
        }))
      ])
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all bot commands'),

  async execute(interaction) {
    const commands = interaction.client.commands;
    const botUser = interaction.client.user;

    const embed = buildOverviewEmbed(commands, botUser);
    const row = buildSelectMenu('overview');

    const reply = await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });

    const collector = reply.createMessageComponentCollector({ time: 120000 });

    collector.on('collect', async (menuInteraction) => {
      if (menuInteraction.user.id !== interaction.user.id) {
        return menuInteraction.reply({ content: 'This menu isn\'t for you.', flags: MessageFlags.Ephemeral });
      }

      const selected = menuInteraction.values[0];

      if (selected === 'overview') {
        await menuInteraction.update({ embeds: [buildOverviewEmbed(commands, botUser)], components: [buildSelectMenu('overview')] });
      } else {
        const category = CATEGORIES.find(c => c.id === selected);
        await menuInteraction.update({ embeds: [buildCategoryEmbed(category, commands, botUser)], components: [buildSelectMenu(selected)] });
      }
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch (e) { /* message may be deleted */ }
    });
  }
};

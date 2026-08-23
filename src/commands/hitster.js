import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { listPools } from '../utils/plaatjeAudio.js';
import { clampCardsToWin } from '../utils/plaatjeGame.js';
// server.js wordt lazy geladen in execute(): een statische import houdt het
// deploy-script (npm run deploy) eeuwig in leven via de open handles die
// server.js bij module-load aanmaakt. Tijdens bot-runtime is server.js al
// geladen door index.js, dus de dynamic import is dan een gratis cache-hit.

export default {
  data: new SlashCommandBuilder()
    .setName('hitster')
    .setDescription('Start een HITSTER-tafel en deel de join-link')
    .addIntegerOption((opt) =>
      opt.setName('kaarten')
        .setDescription('Kaarten om te winnen (5-15, standaard 10)')
        .setMinValue(5)
        .setMaxValue(15))
    .addStringOption((opt) =>
      opt.setName('audio')
        .setDescription('Waar de muziek wordt afgespeeld')
        .addChoices(
          { name: 'Browser (iedereen luistert zelf)', value: 'browser' },
          { name: 'Jerry draait in het voicekanaal', value: 'vc' },
        ))
    .addStringOption((opt) =>
      opt.setName('pool')
        .setDescription('Songpool')
        .setAutocomplete(true)),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = listPools()
      .filter((p) => p.name.toLowerCase().includes(focused) || p.id.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((p) => ({ name: `${p.name} (${p.count})`, value: p.id }));

    try {
      await interaction.respond(choices);
    } catch (e) {
      // Interaction may have expired
    }
  },

  async execute(interaction) {
    let base;
    try {
      base = new URL(process.env.OAUTH_REDIRECT_URI).origin;
    } catch {
      return interaction.reply({
        content: 'De webdashboard-URL is niet ingesteld (OAUTH_REDIRECT_URI ontbreekt of is ongeldig) — vraag een beheerder dit te configureren.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const pools = listPools();
    const requestedPoolId = interaction.options.getString('pool');
    const validPool = pools.find((p) => p.id === requestedPoolId);
    const basePool = pools.find((p) => p.id === 'base');
    const poolId = validPool ? validPool.id : 'base';
    const poolName = (validPool ?? basePool)?.name ?? 'Basis';

    // getInteger returns null (not undefined) when the option is omitted, and
    // clampCardsToWin(null) clamps to 5 (Number(null) === 0), not the documented
    // default of 10 — coalesce the omitted case before clamping.
    const cardsToWin = clampCardsToWin(interaction.options.getInteger('kaarten') ?? 10);
    const audioMode = interaction.options.getString('audio') === 'vc' ? 'vc' : 'browser';

    const hostUser = {
      id: interaction.user.id,
      displayName: interaction.member?.displayName ?? interaction.user.username,
      avatar: interaction.user.avatar ? `https://cdn.discordapp.com/avatars/${interaction.user.id}/${interaction.user.avatar}.png` : null,
    };

    const { createPlaatjeRoomFromDiscord } = await import('../web/server.js');
    const roomId = createPlaatjeRoomFromDiscord(hostUser, { cardsToWin, poolIds: [poolId], audioMode });
    const joinUrl = `${base}/hitster?room=${roomId}`;

    const embed = new EmbedBuilder()
      .setColor(0xff2e88)
      .setTitle('🎶 HITSTER — nieuwe tafel')
      .setDescription(`Tik op de link (of de knop hieronder) om mee te doen:\n${joinUrl}`)
      .addFields(
        { name: 'Host', value: hostUser.displayName, inline: true },
        { name: 'Eerste bij', value: `${cardsToWin} kaarten`, inline: true },
        { name: 'Audio', value: audioMode === 'vc' ? 'Jerry in VC' : 'Browser', inline: true },
        { name: 'Songpool', value: poolName, inline: true },
      );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Meespelen').setStyle(ButtonStyle.Link).setURL(joinUrl),
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};

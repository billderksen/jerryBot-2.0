import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getDrivers, submitPrediction, getStandings, getRaceResults, getRaces, getUserPrediction, isRaceLocked } from '../utils/f1Predictions.js';

const DRIVERS = getDrivers();

export default {
  data: new SlashCommandBuilder()
    .setName('f1')
    .setDescription('F1 race predictions')
    .addSubcommand(sub =>
      sub.setName('predict')
        .setDescription('Submit your prediction for a race')
        .addIntegerOption(opt =>
          opt.setName('round')
            .setDescription('Race round number (1-24)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(24))
        .addStringOption(opt =>
          opt.setName('p1')
            .setDescription('Your P1 (winner) prediction')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('p2')
            .setDescription('Your P2 prediction')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('p3')
            .setDescription('Your P3 prediction')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption(opt =>
          opt.setName('fastest_lap')
            .setDescription('Your fastest lap prediction')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(sub =>
      sub.setName('standings')
        .setDescription('Show the season leaderboard'))
    .addSubcommand(sub =>
      sub.setName('results')
        .setDescription('Show results for a race')
        .addIntegerOption(opt =>
          opt.setName('round')
            .setDescription('Race round number (1-24)')
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(24)))
    .addSubcommand(sub =>
      sub.setName('mypredictions')
        .setDescription('Show all your predictions for the season')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const choices = DRIVERS
      .filter(d => d.name.toLowerCase().includes(focused) || d.id.includes(focused) || d.constructor.toLowerCase().includes(focused))
      .map(d => ({ name: `${d.name} (${d.constructor})`, value: d.id }))
      .slice(0, 25);

    try {
      await interaction.respond(choices);
    } catch (e) {
      // Interaction may have expired
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'predict') {
      await handlePredict(interaction);
    } else if (sub === 'standings') {
      await handleStandings(interaction);
    } else if (sub === 'results') {
      await handleResults(interaction);
    } else if (sub === 'mypredictions') {
      await handleMyPredictions(interaction);
    }
  }
};

async function handlePredict(interaction) {
  const round = interaction.options.getInteger('round');
  const p1 = interaction.options.getString('p1');
  const p2 = interaction.options.getString('p2');
  const p3 = interaction.options.getString('p3');
  const fastestLap = interaction.options.getString('fastest_lap');

  if (isRaceLocked(round)) {
    return interaction.reply({ content: 'Predictions are closed for this race.', flags: MessageFlags.Ephemeral });
  }

  const races = getRaces(null);
  const race = races.find(r => r.round === round);
  if (!race) {
    return interaction.reply({ content: 'Invalid round number.', flags: MessageFlags.Ephemeral });
  }

  const result = submitPrediction(
    interaction.user.id,
    interaction.user.displayName,
    interaction.user.avatar,
    round,
    { p1, p2, p3, fastestLap }
  );

  if (!result.success) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }

  const getDriverName = (id) => DRIVERS.find(d => d.id === id)?.name || id;

  const embed = new EmbedBuilder()
    .setTitle(`Prediction Submitted: ${race.name}`)
    .setDescription(
      `**P1:** ${getDriverName(p1)}\n` +
      `**P2:** ${getDriverName(p2)}\n` +
      `**P3:** ${getDriverName(p3)}\n` +
      `**Fastest Lap:** ${getDriverName(fastestLap)}`
    )
    .setColor(0xE8002D)
    .setFooter({ text: `Round ${round} | ${race.circuit}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleStandings(interaction) {
  const standings = getStandings();

  if (standings.length === 0) {
    return interaction.reply({ content: 'No predictions have been scored yet! Submit predictions with `/f1 predict`.', flags: MessageFlags.Ephemeral });
  }

  const top10 = standings.slice(0, 10);
  const lines = top10.map((s, i) => {
    const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
    return `**${medal}** ${s.displayName} — **${s.totalPoints}** pts | ${s.correctWinners} winners | ${s.correctPodiums} podiums | ${s.correctFastestLaps} FL`;
  });

  const embed = new EmbedBuilder()
    .setTitle('F1 Predictions Leaderboard')
    .setDescription(lines.join('\n'))
    .setColor(0xE8002D)
    .setFooter({ text: `${standings.length} player${standings.length !== 1 ? 's' : ''} total` });

  await interaction.reply({ embeds: [embed] });
}

async function handleResults(interaction) {
  const round = interaction.options.getInteger('round');
  const results = getRaceResults(round);

  if (!results) {
    return interaction.reply({ content: 'No results available for this race yet.', flags: MessageFlags.Ephemeral });
  }

  const podium = results.positions.slice(0, 3);
  const podiumLines = podium.map(p => `**P${p.position}:** ${p.name} (${p.constructor})`);
  const flLine = results.fastestLap ? `**Fastest Lap:** ${results.fastestLap.name}` : '';

  let desc = podiumLines.join('\n');
  if (flLine) desc += '\n' + flLine;

  if (results.predictions.length > 0) {
    const topScorers = results.predictions.slice(0, 5);
    desc += '\n\n**Top Scorers:**\n' + topScorers.map((p, i) => `${i + 1}. ${p.displayName} — **${p.score}** pts`).join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle(`Results: ${results.race?.name || `Round ${round}`}`)
    .setDescription(desc)
    .setColor(0xE8002D)
    .setFooter({ text: `Round ${round}` });

  await interaction.reply({ embeds: [embed] });
}

async function handleMyPredictions(interaction) {
  const userId = interaction.user.id;
  const races = getRaces(userId);
  const predictedRaces = races.filter(r => r.hasPrediction);

  if (predictedRaces.length === 0) {
    return interaction.reply({ content: 'You haven\'t submitted any predictions yet! Use `/f1 predict` to get started.', flags: MessageFlags.Ephemeral });
  }

  const lines = [];
  for (const race of predictedRaces) {
    const pred = getUserPrediction(userId, race.round);
    if (!pred) continue;
    lines.push(
      `**Round ${race.round}: ${race.name}**\n` +
      `P1: ${pred.p1.name} | P2: ${pred.p2.name} | P3: ${pred.p3.name} | FL: ${pred.fastestLap.name}`
    );
  }

  // Split into chunks if too long
  const desc = lines.join('\n\n');
  const embed = new EmbedBuilder()
    .setTitle('Your F1 Predictions')
    .setDescription(desc.length > 4000 ? desc.slice(0, 4000) + '...' : desc)
    .setColor(0xE8002D)
    .setFooter({ text: `${predictedRaces.length} prediction${predictedRaces.length !== 1 ? 's' : ''} submitted` });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

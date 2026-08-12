import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { fetchQuestions, getLeaderboard, updateLeaderboard, getActiveSession, setActiveSession, clearSession } from '../utils/triviaGame.js';

// The Trivia API categories
const CATEGORIES = [
  { name: 'General Knowledge', value: 'general_knowledge' },
  { name: 'Arts & Literature', value: 'arts_and_literature' },
  { name: 'Film & TV', value: 'film_and_tv' },
  { name: 'Food & Drink', value: 'food_and_drink' },
  { name: 'Geography', value: 'geography' },
  { name: 'History', value: 'history' },
  { name: 'Music', value: 'music' },
  { name: 'Science', value: 'science' },
  { name: 'Society & Culture', value: 'society_and_culture' },
  { name: 'Sport & Leisure', value: 'sport_and_leisure' },
  { name: 'Lord of the Rings', value: 'lord_of_the_rings' },
  { name: 'Old School RuneScape', value: 'osrs' },
  { name: 'Pokémon', value: 'pokemon' },
  { name: 'World of Warcraft', value: 'world_of_warcraft' },
];

const LETTERS = ['A', 'B', 'C', 'D'];
const DIFFICULTY_COLORS = { easy: 0x2ECC71, medium: 0xF1C40F, hard: 0xE74C3C };

export default {
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Trivia game with questions from The Trivia API')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a trivia game in this channel')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('Game mode')
            .addChoices(
              { name: 'Buttons (everyone picks)', value: 'buttons' },
              { name: 'Race (first correct wins)', value: 'race' }
            ))
        .addIntegerOption(opt =>
          opt.setName('questions')
            .setDescription('Number of questions (5-20)')
            .setMinValue(5)
            .setMaxValue(20))
        .addStringOption(opt =>
          opt.setName('category')
            .setDescription('Question category')
            .addChoices(...CATEGORIES.map(c => ({ name: c.name, value: c.value }))))
        .addStringOption(opt =>
          opt.setName('difficulty')
            .setDescription('Question difficulty')
            .addChoices(
              { name: 'Mixed', value: 'mixed' },
              { name: 'Easy', value: 'easy' },
              { name: 'Medium', value: 'medium' },
              { name: 'Hard', value: 'hard' }
            )))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop the current trivia game in this channel'))
    .addSubcommand(sub =>
      sub.setName('leaderboard')
        .setDescription('Show the trivia leaderboard')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      await handleStart(interaction);
    } else if (sub === 'stop') {
      await handleStop(interaction);
    } else if (sub === 'leaderboard') {
      await handleLeaderboard(interaction);
    }
  }
};

async function handleStart(interaction) {
  const channelId = interaction.channelId;

  if (getActiveSession(channelId)) {
    return interaction.reply({ content: 'There\'s already an active trivia game in this channel! Use `/trivia stop` to end it.', flags: MessageFlags.Ephemeral });
  }

  const mode = interaction.options.getString('mode') || 'buttons';
  const numQuestions = interaction.options.getInteger('questions') || 10;
  const category = interaction.options.getString('category') || null;
  const difficulty = interaction.options.getString('difficulty') || 'mixed';

  await interaction.deferReply();

  let questions;
  try {
    questions = await fetchQuestions(numQuestions, category, difficulty);
  } catch (e) {
    return interaction.editReply(`Failed to fetch questions: ${e.message}`);
  }

  // Track session
  const session = {
    startedBy: interaction.user.id,
    mode,
    scores: {}, // userId -> { correct, total, displayName }
    stopped: false,
    questionNum: 0
  };
  setActiveSession(channelId, session);

  const categoryName = category ? CATEGORIES.find(c => c.value === category)?.name || 'Mixed' : 'Any Category';
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle('Trivia Game Starting!')
      .setDescription(`**Mode:** ${mode === 'buttons' ? 'Buttons (everyone picks)' : 'Race (first correct wins)'}\n**Questions:** ${questions.length}\n**Category:** ${categoryName}\n**Difficulty:** ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}`)
      .setColor(0x9B59B6)
      .setFooter({ text: `Started by ${interaction.user.displayName}` })]
  });

  // Wait a moment before starting
  await sleep(3000);

  // Game loop
  for (let i = 0; i < questions.length; i++) {
    if (session.stopped) break;
    session.questionNum = i + 1;

    const q = questions[i];
    const diffColor = DIFFICULTY_COLORS[q.difficulty] || 0x9B59B6;

    const embed = new EmbedBuilder()
      .setTitle(`Question ${i + 1}/${questions.length}`)
      .setDescription(`**${q.question}**\n\n${q.answers.map((a, idx) => `**${LETTERS[idx]}.** ${a}`).join('\n')}`)
      .setFooter({ text: `${q.category} | ${q.difficulty.charAt(0).toUpperCase() + q.difficulty.slice(1)}` })
      .setColor(diffColor);

    if (mode === 'buttons') {
      await runButtonQuestion(interaction.channel, embed, q, session, i, questions.length);
    } else {
      await runRaceQuestion(interaction.channel, embed, q, session, i, questions.length);
    }

    if (session.stopped) break;

    // Brief pause between questions
    if (i < questions.length - 1) {
      await sleep(2500);
    }
  }

  // Game over — show final scoreboard
  if (!session.stopped) {
    await showFinalScoreboard(interaction.channel, session, questions.length);
  }

  clearSession(channelId);
}

async function runButtonQuestion(channel, embed, question, session, qIndex, totalQuestions) {
  const row = new ActionRowBuilder().addComponents(
    LETTERS.map((letter, idx) =>
      new ButtonBuilder()
        .setCustomId(`trivia_${letter}`)
        .setLabel(letter)
        .setStyle(ButtonStyle.Primary)
    )
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  const answered = new Set(); // track who already answered
  const correctUsers = [];
  const incorrectUsers = [];

  const collector = msg.createMessageComponentCollector({ time: 15000 });

  collector.on('collect', async (btnInteraction) => {
    if (answered.has(btnInteraction.user.id)) {
      return btnInteraction.reply({ content: 'You already answered this question!', flags: MessageFlags.Ephemeral });
    }
    answered.add(btnInteraction.user.id);

    const chosenLetter = btnInteraction.customId.replace('trivia_', '');
    const isCorrect = chosenLetter === question.correctLetter;

    // Track scores
    const userId = btnInteraction.user.id;
    if (!session.scores[userId]) {
      session.scores[userId] = { correct: 0, total: 0, displayName: btnInteraction.user.displayName };
    }
    session.scores[userId].total += 1;

    if (isCorrect) {
      session.scores[userId].correct += 1;
      correctUsers.push(btnInteraction.user.displayName);
    } else {
      incorrectUsers.push(btnInteraction.user.displayName);
    }

    await btnInteraction.reply({ content: isCorrect ? 'Correct!' : `Wrong! The answer was **${question.correctLetter}. ${question.correctAnswer}**`, flags: MessageFlags.Ephemeral });
  });

  return new Promise(resolve => {
    collector.on('end', async () => {
      // Disable buttons
      const disabledRow = new ActionRowBuilder().addComponents(
        LETTERS.map((letter, idx) =>
          new ButtonBuilder()
            .setCustomId(`trivia_${letter}`)
            .setLabel(`${letter}. ${question.answers[idx]}`)
            .setStyle(letter === question.correctLetter ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );

      const resultText = correctUsers.length > 0
        ? `**${correctUsers.join(', ')}** got it right!`
        : 'Nobody got it right!';

      try {
        await msg.edit({
          embeds: [embed.setTitle(`Question ${qIndex + 1}/${totalQuestions} — Answer: ${question.correctLetter}`)],
          components: [disabledRow]
        });
        await channel.send({ content: `${question.correctLetter}. **${question.correctAnswer}** — ${resultText}` });
      } catch (e) { /* channel might be deleted */ }

      resolve();
    });
  });
}

async function runRaceQuestion(channel, embed, question, session, qIndex, totalQuestions) {
  const msg = await channel.send({ embeds: [embed] });
  let won = false;

  const filter = (m) => {
    if (m.author.bot) return false;
    const content = m.content.trim().toUpperCase();
    // Accept letter (A/B/C/D) or the full answer text
    return LETTERS.includes(content) || question.answers.some(a => a.toLowerCase() === m.content.trim().toLowerCase());
  };

  const collector = channel.createMessageCollector({ filter, time: 20000 });

  collector.on('collect', async (m) => {
    const content = m.content.trim().toUpperCase();
    let chosenLetter;

    if (LETTERS.includes(content)) {
      chosenLetter = content;
    } else {
      // Find which answer they typed
      const idx = question.answers.findIndex(a => a.toLowerCase() === m.content.trim().toLowerCase());
      if (idx >= 0) chosenLetter = LETTERS[idx];
    }

    if (!chosenLetter) return;

    const userId = m.author.id;
    if (!session.scores[userId]) {
      session.scores[userId] = { correct: 0, total: 0, displayName: m.author.displayName };
    }
    session.scores[userId].total += 1;

    if (chosenLetter === question.correctLetter) {
      won = true;
      session.scores[userId].correct += 1;
      collector.stop('answered');
      await channel.send(`**${m.author.displayName}** got it first! The answer was **${question.correctLetter}. ${question.correctAnswer}**`);
    }
  });

  return new Promise(resolve => {
    collector.on('end', async (_, reason) => {
      if (!won) {
        await channel.send(`Time's up! The answer was **${question.correctLetter}. ${question.correctAnswer}**`).catch(() => {});
      }
      resolve();
    });
  });
}

async function showFinalScoreboard(channel, session, totalQuestions) {
  const entries = Object.entries(session.scores)
    .map(([userId, s]) => ({ userId, ...s }))
    .sort((a, b) => b.correct - a.correct || a.total - b.total);

  if (entries.length === 0) {
    await channel.send({ embeds: [new EmbedBuilder().setTitle('Trivia Over!').setDescription('Nobody played! Maybe next time.').setColor(0x9B59B6)] });
    return;
  }

  const winner = entries[0];

  const lines = entries.map((e, i) => {
    const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
    const pct = e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0;
    return `**${medal}** <@${e.userId}> — ${e.correct}/${e.total} correct (${pct}%)`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Trivia Game Over!')
    .setDescription(lines.join('\n'))
    .setColor(0xFFD700)
    .setFooter({ text: `${totalQuestions} questions | ${session.mode} mode` });

  await channel.send({ embeds: [embed] });

  // Update persistent leaderboard
  for (const e of entries) {
    updateLeaderboard(e.userId, e.displayName, {
      questionsAnswered: e.total,
      correctAnswers: e.correct,
      won: e.userId === winner.userId && entries.length > 1
    });
  }
}

async function handleStop(interaction) {
  const channelId = interaction.channelId;
  const session = getActiveSession(channelId);

  if (!session) {
    return interaction.reply({ content: 'There\'s no active trivia game in this channel.', flags: MessageFlags.Ephemeral });
  }

  // Only allow the person who started it or admins to stop
  if (session.startedBy !== interaction.user.id && !interaction.member.permissions.has('Administrator')) {
    return interaction.reply({ content: 'Only the person who started the trivia or an admin can stop it.', flags: MessageFlags.Ephemeral });
  }

  session.stopped = true;
  await interaction.reply('Trivia game stopped!');

  // Show scoreboard if there were any answers
  if (Object.keys(session.scores).length > 0) {
    await showFinalScoreboard(interaction.channel, session, session.questionNum);
  }

  clearSession(channelId);
}

async function handleLeaderboard(interaction) {
  const lb = getLeaderboard();

  if (lb.length === 0) {
    return interaction.reply({ content: 'No trivia games have been played yet! Start one with `/trivia start`.', flags: MessageFlags.Ephemeral });
  }

  const top10 = lb.slice(0, 10);
  const lines = top10.map((p, i) => {
    const pct = p.questionsAnswered > 0 ? Math.round((p.correctAnswers / p.questionsAnswered) * 100) : 0;
    const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
    return `**${medal}** ${p.displayName} — ${p.correctAnswers} correct (${pct}%) | ${p.gamesWon} wins | Best streak: ${p.bestWinStreak}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('Trivia Leaderboard')
    .setDescription(lines.join('\n'))
    .setColor(0x9B59B6)
    .setFooter({ text: `${lb.length} player${lb.length !== 1 ? 's' : ''} total` });

  await interaction.reply({ embeds: [embed] });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

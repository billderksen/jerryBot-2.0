import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { fetchQuestions, updateLeaderboard } from '../utils/triviaGame.js';

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
const NUM_QUESTIONS = 5;

export default {
  data: new SlashCommandBuilder()
    .setName('challenge')
    .setDescription('Challenge someone to a 1v1 trivia duel')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('The user to challenge')
        .setRequired(true))
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
        )),

  async execute(interaction) {
    const target = interaction.options.getUser('user');
    const category = interaction.options.getString('category') || null;
    const difficulty = interaction.options.getString('difficulty') || 'mixed';

    // Validation
    if (target.id === interaction.user.id) {
      return interaction.reply({ content: "You can't challenge yourself!", flags: MessageFlags.Ephemeral });
    }
    if (target.bot) {
      return interaction.reply({ content: "You can't challenge a bot!", flags: MessageFlags.Ephemeral });
    }

    const categoryName = category ? CATEGORIES.find(c => c.value === category)?.name || 'Any' : 'Any Category';

    const challengeEmbed = new EmbedBuilder()
      .setTitle('Trivia Duel Challenge!')
      .setDescription(`**${interaction.user.displayName}** has challenged **${target.displayName}** to a 1v1 trivia duel!\n\n**Questions:** ${NUM_QUESTIONS}\n**Category:** ${categoryName}\n**Difficulty:** ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}\n\n${target}, do you accept?`)
      .setColor(0xFF6B35)
      .setFooter({ text: 'You have 30 seconds to respond' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('challenge_accept').setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('challenge_decline').setLabel('Decline').setStyle(ButtonStyle.Danger)
    );

    const msg = await interaction.reply({ content: `${target}`, embeds: [challengeEmbed], components: [row], fetchReply: true });

    const collector = msg.createMessageComponentCollector({ time: 30000 });
    let responded = false;

    collector.on('collect', async (btnInteraction) => {
      if (btnInteraction.user.id !== target.id) {
        return btnInteraction.reply({ content: "This challenge isn't for you!", flags: MessageFlags.Ephemeral });
      }

      responded = true;
      collector.stop();

      if (btnInteraction.customId === 'challenge_decline') {
        const declinedEmbed = EmbedBuilder.from(challengeEmbed)
          .setDescription(`**${target.displayName}** declined the challenge.`)
          .setColor(0x95A5A6)
          .setFooter({ text: 'Maybe next time!' });
        return btnInteraction.update({ content: null, embeds: [declinedEmbed], components: [] });
      }

      // Accepted — fetch questions and start
      const acceptedEmbed = EmbedBuilder.from(challengeEmbed)
        .setDescription(`**${target.displayName}** accepted! Fetching questions...`)
        .setColor(0x2ECC71)
        .setFooter({ text: 'Get ready!' });
      await btnInteraction.update({ content: null, embeds: [acceptedEmbed], components: [] });

      let questions;
      try {
        questions = await fetchQuestions(NUM_QUESTIONS, category, difficulty);
      } catch (e) {
        return interaction.channel.send(`Failed to fetch questions: ${e.message}`);
      }

      await sleep(2000);
      await runDuel(interaction.channel, interaction.user, target, questions, categoryName, difficulty);
    });

    collector.on('end', async () => {
      if (!responded) {
        const timeoutEmbed = EmbedBuilder.from(challengeEmbed)
          .setDescription(`**${target.displayName}** didn't respond in time.`)
          .setColor(0x95A5A6)
          .setFooter({ text: 'Challenge expired' });
        try {
          await msg.edit({ content: null, embeds: [timeoutEmbed], components: [] });
        } catch (e) { /* message may be deleted */ }
      }
    });
  }
};

async function runDuel(channel, challenger, opponent, questions, categoryName, difficulty) {
  const scores = {
    [challenger.id]: { correct: 0, answers: [] },
    [opponent.id]: { correct: 0, answers: [] }
  };

  for (let i = 0; i < questions.length; i++) {
    const result = await runDuelQuestion(channel, questions[i], challenger, opponent, i, questions.length);

    scores[challenger.id].answers.push(result[challenger.id]);
    scores[opponent.id].answers.push(result[opponent.id]);
    if (result[challenger.id]) scores[challenger.id].correct++;
    if (result[opponent.id]) scores[opponent.id].correct++;

    // Show head-to-head result for this question
    const q = questions[i];
    const challengerResult = result[challenger.id] ? '✅' : '❌';
    const opponentResult = result[opponent.id] ? '✅' : '❌';

    const resultEmbed = new EmbedBuilder()
      .setTitle(`Answer: ${q.correctLetter}. ${q.correctAnswer}`)
      .setDescription(
        `${challengerResult} **${challenger.displayName}** — ${scores[challenger.id].correct} pts\n` +
        `${opponentResult} **${opponent.displayName}** — ${scores[opponent.id].correct} pts`
      )
      .setColor(0x3498DB)
      .setFooter({ text: `Question ${i + 1}/${questions.length}` });

    await channel.send({ embeds: [resultEmbed] });

    if (i < questions.length - 1) {
      await sleep(3000);
    }
  }

  await sleep(1500);
  await showDuelResults(channel, challenger, opponent, scores, questions, categoryName, difficulty);
}

async function runDuelQuestion(channel, question, challenger, opponent, qIndex, totalQuestions) {
  const diffColor = DIFFICULTY_COLORS[question.difficulty] || 0xFF6B35;

  const embed = new EmbedBuilder()
    .setTitle(`Question ${qIndex + 1}/${totalQuestions}`)
    .setDescription(`**${question.question}**\n\n${question.answers.map((a, idx) => `**${LETTERS[idx]}.** ${a}`).join('\n')}`)
    .setFooter({ text: `${question.category} | ${question.difficulty.charAt(0).toUpperCase() + question.difficulty.slice(1)}` })
    .setColor(diffColor);

  const row = new ActionRowBuilder().addComponents(
    LETTERS.map(letter =>
      new ButtonBuilder()
        .setCustomId(`duel_${letter}`)
        .setLabel(letter)
        .setStyle(ButtonStyle.Primary)
    )
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });

  const result = {
    [challenger.id]: false,
    [opponent.id]: false
  };
  const answered = new Set();

  return new Promise(resolve => {
    const collector = msg.createMessageComponentCollector({ time: 15000 });

    collector.on('collect', async (btnInteraction) => {
      const userId = btnInteraction.user.id;

      // Only the two duelists can answer
      if (userId !== challenger.id && userId !== opponent.id) {
        return btnInteraction.reply({ content: "This duel isn't for you!", flags: MessageFlags.Ephemeral });
      }

      if (answered.has(userId)) {
        return btnInteraction.reply({ content: 'You already answered this question!', flags: MessageFlags.Ephemeral });
      }

      answered.add(userId);

      const chosenLetter = btnInteraction.customId.replace('duel_', '');
      const isCorrect = chosenLetter === question.correctLetter;
      result[userId] = isCorrect;

      await btnInteraction.reply({
        content: isCorrect ? 'Correct!' : `Wrong! The answer was **${question.correctLetter}. ${question.correctAnswer}**`,
        flags: MessageFlags.Ephemeral
      });

      // If both answered, end early
      if (answered.size === 2) {
        collector.stop('both_answered');
      }
    });

    collector.on('end', async () => {
      // Disable buttons
      const disabledRow = new ActionRowBuilder().addComponents(
        LETTERS.map((letter, idx) =>
          new ButtonBuilder()
            .setCustomId(`duel_${letter}`)
            .setLabel(`${letter}. ${question.answers[idx]}`)
            .setStyle(letter === question.correctLetter ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(true)
        )
      );

      try {
        await msg.edit({ embeds: [embed], components: [disabledRow] });
      } catch (e) { /* message may be deleted */ }

      resolve(result);
    });
  });
}

async function showDuelResults(channel, challenger, opponent, scores, questions, categoryName, difficulty) {
  const cScore = scores[challenger.id].correct;
  const oScore = scores[opponent.id].correct;

  let title, color;
  if (cScore > oScore) {
    title = `${challenger.displayName} wins!`;
    color = 0xFFD700;
  } else if (oScore > cScore) {
    title = `${opponent.displayName} wins!`;
    color = 0xFFD700;
  } else {
    title = "It's a tie!";
    color = 0x95A5A6;
  }

  // Build per-question breakdown
  const breakdown = questions.map((q, i) => {
    const cResult = scores[challenger.id].answers[i] ? '✅' : '❌';
    const oResult = scores[opponent.id].answers[i] ? '✅' : '❌';
    return `Q${i + 1}: ${cResult} vs ${oResult}`;
  }).join('\n');

  const cAccuracy = Math.round((cScore / questions.length) * 100);
  const oAccuracy = Math.round((oScore / questions.length) * 100);

  const embed = new EmbedBuilder()
    .setTitle(`Duel Over — ${title}`)
    .setDescription(
      `**${challenger.displayName}** ${cScore} - ${oScore} **${opponent.displayName}**\n\n` +
      `**${challenger.displayName}:** ${cScore}/${questions.length} correct (${cAccuracy}%)\n` +
      `**${opponent.displayName}:** ${oScore}/${questions.length} correct (${oAccuracy}%)\n\n` +
      `**Breakdown:**\n${breakdown}`
    )
    .setColor(color)
    .setFooter({ text: `${categoryName} | ${difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} | ${questions.length} questions` });

  await channel.send({ embeds: [embed] });

  // Update leaderboard for both players
  const challengerWon = cScore > oScore;
  const opponentWon = oScore > cScore;

  updateLeaderboard(challenger.id, challenger.displayName, {
    questionsAnswered: questions.length,
    correctAnswers: cScore,
    won: challengerWon
  });

  updateLeaderboard(opponent.id, opponent.displayName, {
    questionsAnswered: questions.length,
    correctAnswers: oScore,
    won: opponentWon
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

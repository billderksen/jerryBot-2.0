import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetch } from 'undici';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LEADERBOARD_FILE = join(__dirname, '..', '..', 'data', 'triviaLeaderboard.json');

// Local question bank files (category slug → filename)
const LOCAL_CATEGORIES = {
  'lord_of_the_rings': join(__dirname, '..', '..', 'data', 'lotrQuestions.json'),
  'osrs': join(__dirname, '..', '..', 'data', 'osrsQuestions.json'),
  'pokemon': join(__dirname, '..', '..', 'data', 'pokemonQuestions.json'),
  'world_of_warcraft': join(__dirname, '..', '..', 'data', 'wowQuestions.json'),
};

// Active trivia sessions per channel
const activeSessions = new Map();

// Category slug → display name mapping
const CATEGORY_NAMES = {
  'lord_of_the_rings': 'Lord of the Rings',
  'osrs': 'Old School RuneScape',
  'pokemon': 'Pokémon',
  'world_of_warcraft': 'World of Warcraft',
  'arts_and_literature': 'Arts & Literature',
  'film_and_tv': 'Film & TV',
  'food_and_drink': 'Food & Drink',
  'general_knowledge': 'General Knowledge',
  'geography': 'Geography',
  'history': 'History',
  'music': 'Music',
  'science': 'Science',
  'society_and_culture': 'Society & Culture',
  'sport_and_leisure': 'Sport & Leisure'
};

/**
 * Fetch trivia questions from The Trivia API (international, 12k+ vetted questions)
 * @param {number} amount - Number of questions (5-20)
 * @param {string|null} category - Category slug or null for any
 * @param {string} difficulty - 'easy', 'medium', 'hard', or 'mixed'
 * @returns {Promise<Array>} Questions with shuffled answers
 */
export async function fetchQuestions(amount, category, difficulty) {
  // Local question banks for custom categories
  if (LOCAL_CATEGORIES[category]) {
    return fetchLocalQuestions(category, amount, difficulty);
  }

  let url = `https://the-trivia-api.com/v2/questions?limit=${amount}&type=text_choice`;
  if (category) url += `&categories=${category}`;
  if (difficulty && difficulty !== 'mixed') url += `&difficulty=${difficulty}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`The Trivia API error: HTTP ${res.status}`);
  }
  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('No questions returned from The Trivia API');
  }

  return formatQuestions(data.map(q => ({
    question: q.question.text,
    correctAnswer: q.correctAnswer,
    incorrectAnswers: q.incorrectAnswers,
    difficulty: q.difficulty,
    category: q.category
  })));
}

function fetchLocalQuestions(category, amount, difficulty) {
  const file = LOCAL_CATEGORIES[category];
  const displayName = CATEGORY_NAMES[category] || category;
  let pool;
  try {
    pool = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to load ${displayName} questions`);
  }

  if (difficulty && difficulty !== 'mixed') {
    pool = pool.filter(q => q.difficulty === difficulty);
  }

  if (pool.length < amount) {
    throw new Error(`Not enough ${displayName} questions available (need ${amount}, have ${pool.length})`);
  }

  // Shuffle pool and pick the requested amount
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return formatQuestions(pool.slice(0, amount).map(q => ({
    question: q.question,
    correctAnswer: q.correctAnswer,
    incorrectAnswers: q.incorrectAnswers,
    difficulty: q.difficulty,
    category
  })));
}

function formatQuestions(questions) {
  return questions.map(q => {
    const correct = q.correctAnswer;
    const allAnswers = [...q.incorrectAnswers, correct];
    // Shuffle answers
    for (let i = allAnswers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allAnswers[i], allAnswers[j]] = [allAnswers[j], allAnswers[i]];
    }
    const correctIndex = allAnswers.indexOf(correct);

    return {
      question: q.question,
      category: CATEGORY_NAMES[q.category] || q.category,
      difficulty: q.difficulty,
      correctAnswer: correct,
      correctIndex,
      answers: allAnswers,
      correctLetter: String.fromCharCode(65 + correctIndex)
    };
  });
}

// --- Leaderboard ---

function loadLeaderboard() {
  return loadJsonSync(LEADERBOARD_FILE, { players: {} });
}

function saveLeaderboard(data) {
  saveJsonSync(LEADERBOARD_FILE, data);
}

/**
 * Get sorted leaderboard array
 */
export function getLeaderboard() {
  const data = loadLeaderboard();
  return Object.entries(data.players)
    .map(([userId, stats]) => ({ userId, ...stats }))
    .sort((a, b) => b.correctAnswers - a.correctAnswers);
}

/**
 * Update a player's leaderboard stats after a game
 * @param {string} userId
 * @param {string} displayName
 * @param {object} stats - { questionsAnswered, correctAnswers, won }
 */
export function updateLeaderboard(userId, displayName, stats) {
  const data = loadLeaderboard();
  const player = data.players[userId] || {
    displayName,
    gamesPlayed: 0,
    questionsAnswered: 0,
    correctAnswers: 0,
    gamesWon: 0,
    winStreak: 0,
    bestWinStreak: 0,
    lastPlayed: 0
  };

  player.displayName = displayName;
  player.gamesPlayed += 1;
  player.questionsAnswered += stats.questionsAnswered;
  player.correctAnswers += stats.correctAnswers;
  player.lastPlayed = Date.now();

  if (stats.won) {
    player.gamesWon += 1;
    player.winStreak += 1;
    if (player.winStreak > player.bestWinStreak) {
      player.bestWinStreak = player.winStreak;
    }
  } else {
    player.winStreak = 0;
  }

  data.players[userId] = player;
  saveLeaderboard(data);
}

// --- Session management ---

export function getActiveSession(channelId) {
  return activeSessions.get(channelId);
}

export function setActiveSession(channelId, session) {
  activeSessions.set(channelId, session);
}

export function clearSession(channelId) {
  activeSessions.delete(channelId);
}

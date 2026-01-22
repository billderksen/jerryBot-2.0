// Pictionary Game Manager
// Manages rooms, game state, scoring, and leaderboard persistence

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEADERBOARD_FILE = join(__dirname, '..', '..', 'data', 'pictionaryLeaderboard.json');
const WORDS_FILE = join(__dirname, '..', '..', 'data', 'pictionaryWords.json');

// Game constants
const ROUND_TIME = 80; // seconds per round
const MIN_PLAYERS = 1; // Set to 2 for production, 1 for testing
const MAX_PLAYERS = 8;
const ROUNDS_PER_GAME = 3;
const HINT_INTERVALS = [20, 40, 60]; // seconds at which to reveal hints

// Store active rooms
const rooms = new Map();

// Activity logger callback (will be set by server.js)
let activityLogger = null;

export function setActivityLogger(logger) {
  activityLogger = logger;
}

// Load words from file
function loadWords() {
  try {
    if (existsSync(WORDS_FILE)) {
      return JSON.parse(readFileSync(WORDS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading pictionary words:', error);
  }
  // Fallback with both languages
  return {
    en: { easy: ['cat', 'dog', 'house'], medium: ['bicycle', 'rainbow'], hard: ['philosophy'] },
    nl: { easy: ['kat', 'hond', 'huis'], medium: ['fiets', 'regenboog'], hard: ['filosofie'] }
  };
}

// Load leaderboard from file
function loadLeaderboard() {
  try {
    if (existsSync(LEADERBOARD_FILE)) {
      return JSON.parse(readFileSync(LEADERBOARD_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading pictionary leaderboard:', error);
  }
  return { players: {} };
}

// Save leaderboard with debouncing
let saveTimeout = null;
let leaderboard = loadLeaderboard();
const words = loadWords();

function saveLeaderboard() {
  try {
    const dataDir = dirname(LEADERBOARD_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
  } catch (error) {
    console.error('Error saving pictionary leaderboard:', error);
  }
}

function scheduleSaveLeaderboard() {
  if (!saveTimeout) {
    saveTimeout = setTimeout(() => {
      saveLeaderboard();
      saveTimeout = null;
    }, 5000);
  }
}

// Get a random word from difficulty category and language
function getRandomWord(difficulty = 'medium', language = 'en') {
  const langWords = words[language] || words.en;
  const wordList = langWords[difficulty] || langWords.medium;
  return wordList[Math.floor(Math.random() * wordList.length)];
}

// Generate hint from word (reveals some letters)
function generateHint(word, revealCount) {
  const letters = word.split('');
  const indices = [];

  // Get indices of non-space characters
  letters.forEach((char, i) => {
    if (char !== ' ') indices.push(i);
  });

  // Randomly select indices to reveal
  const revealIndices = new Set();
  while (revealIndices.size < Math.min(revealCount, indices.length)) {
    revealIndices.add(indices[Math.floor(Math.random() * indices.length)]);
  }

  return letters.map((char, i) => {
    if (char === ' ') return ' ';
    if (revealIndices.has(i)) return char;
    return '_';
  }).join('');
}

// Check if guess matches word (case-insensitive, with close match detection)
function checkGuess(guess, word) {
  const normalizedGuess = guess.toLowerCase().trim();
  const normalizedWord = word.toLowerCase().trim();

  if (normalizedGuess === normalizedWord) {
    return { correct: true, close: false };
  }

  // Check for close match (within 1-2 character difference)
  if (Math.abs(normalizedGuess.length - normalizedWord.length) <= 2) {
    let differences = 0;
    const maxLen = Math.max(normalizedGuess.length, normalizedWord.length);
    for (let i = 0; i < maxLen; i++) {
      if (normalizedGuess[i] !== normalizedWord[i]) differences++;
    }
    if (differences <= 2 && normalizedGuess.length >= 3) {
      return { correct: false, close: true };
    }
  }

  return { correct: false, close: false };
}

// Calculate score for guesser based on time
function calculateGuesserScore(timeElapsed, isFirst) {
  const baseScore = Math.max(100, 500 - (timeElapsed * 5));
  return isFirst ? baseScore + 50 : baseScore;
}

// Player class
class Player {
  constructor(id, displayName, avatar = null) {
    this.id = id;
    this.displayName = displayName;
    this.avatar = avatar;
    this.score = 0;
    this.hasGuessedThisRound = false;
    this.isConnected = true;
    this.isSpectator = false;
  }

  toJSON() {
    return {
      id: this.id,
      displayName: this.displayName,
      avatar: this.avatar,
      score: this.score,
      hasGuessedThisRound: this.hasGuessedThisRound,
      isConnected: this.isConnected,
      isSpectator: this.isSpectator
    };
  }
}

// Room class
export class Room {
  constructor(id, name, hostId, settings = {}) {
    this.id = id;
    this.name = name;
    this.hostId = hostId;
    this.players = new Map();
    this.spectators = new Map(); // Spectators who joined during an active game
    this.state = 'waiting'; // waiting, playing, between_rounds, ended
    this.currentRound = 0;
    this.totalRounds = settings.rounds || ROUNDS_PER_GAME;
    this.currentDrawerIndex = 0;
    this.currentWord = null;
    this.currentHint = null;
    this.hintsRevealed = 0;
    this.roundStartTime = null;
    this.roundTimer = null;
    this.hintTimer = null;
    this.drawHistory = []; // Stroke history for undo/redo
    this.redoHistory = [];
    this.correctGuessers = []; // Players who guessed correctly this round
    this.difficulty = settings.difficulty || 'medium';
    this.language = settings.language || 'en';
    this.maxPlayers = settings.maxPlayers || MAX_PLAYERS;
    this.customWords = settings.customWords || [];
    this.broadcastCallback = null;
    this.createdAt = Date.now();
    this.drawingStats = new Map(); // Track drawing stats per player
  }

  // Get a random word (includes custom words)
  getWord() {
    // 30% chance to use custom word if available
    if (this.customWords.length > 0 && Math.random() < 0.3) {
      return this.customWords[Math.floor(Math.random() * this.customWords.length)];
    }
    return getRandomWord(this.difficulty, this.language);
  }

  setBroadcastCallback(callback) {
    this.broadcastCallback = callback;
  }

  broadcast(type, data, excludeId = null) {
    if (this.broadcastCallback) {
      this.broadcastCallback(this.id, type, data, excludeId);
    }
  }

  addPlayer(player) {
    // Check if player already exists (reconnection)
    if (this.players.has(player.id)) {
      const existingPlayer = this.players.get(player.id);
      existingPlayer.connected = true;
      existingPlayer.displayName = player.displayName; // Update in case it changed
      existingPlayer.avatar = player.avatar;
      return { success: true, reconnected: true };
    }

    // Check if was a spectator reconnecting
    if (this.spectators.has(player.id)) {
      const spectator = this.spectators.get(player.id);
      spectator.connected = true;
      spectator.displayName = player.displayName;
      spectator.avatar = player.avatar;
      return { success: true, asSpectator: true, reconnected: true };
    }

    if (this.players.size >= this.maxPlayers) {
      return { success: false, error: 'Room is full' };
    }
    if (this.state === 'playing' || this.state === 'between_rounds') {
      // Game in progress - add as spectator instead
      return this.addSpectator(player);
    }

    this.players.set(player.id, player);
    this.broadcast('room:playerJoined', { player: player.toJSON() });
    return { success: true };
  }

  // Check if a player or spectator exists in the room (for reconnection)
  hasPlayer(playerId) {
    return this.players.has(playerId) || this.spectators.has(playerId);
  }

  addSpectator(player) {
    // Mark as spectator
    player.isSpectator = true;
    this.spectators.set(player.id, player);
    this.broadcast('room:spectatorJoined', { spectator: player.toJSON() });
    return { success: true, asSpectator: true };
  }

  removeSpectator(playerId) {
    const spectator = this.spectators.get(playerId);
    if (!spectator) return null;

    this.spectators.delete(playerId);
    this.broadcast('room:spectatorLeft', { playerId, displayName: spectator.displayName });
    return spectator;
  }

  promoteSpectatorToPlayer(playerId) {
    const spectator = this.spectators.get(playerId);
    if (!spectator) return false;
    if (this.players.size >= this.maxPlayers) return false;
    if (this.state !== 'waiting') return false;

    this.spectators.delete(playerId);
    spectator.isSpectator = false;
    spectator.score = 0;
    this.players.set(playerId, spectator);
    this.broadcast('room:spectatorPromoted', { player: spectator.toJSON() });
    return true;
  }

  getSpectatorList() {
    return Array.from(this.spectators.values()).map(s => s.toJSON());
  }

  removePlayer(playerId) {
    // Check if it's a spectator first
    if (this.spectators.has(playerId)) {
      return this.removeSpectator(playerId);
    }

    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.broadcast('room:playerLeft', { playerId, displayName: player.displayName });

    // If host leaves, assign new host
    if (playerId === this.hostId && this.players.size > 0) {
      this.hostId = this.players.keys().next().value;
      this.broadcast('room:newHost', { hostId: this.hostId });
    }

    // If game is playing and drawer leaves, end round
    if (this.state === 'playing' && this.getCurrentDrawer()?.id === playerId) {
      this.endRound(true);
    }

    // If not enough players, end game
    if (this.state === 'playing' && this.players.size < MIN_PLAYERS) {
      this.endGame('Not enough players');
    }

    return player;
  }

  getPlayerList() {
    return Array.from(this.players.values()).map(p => p.toJSON());
  }

  getCurrentDrawer() {
    const playerArray = Array.from(this.players.values());
    if (playerArray.length === 0) return null;
    return playerArray[this.currentDrawerIndex % playerArray.length];
  }

  canStart() {
    return this.players.size >= MIN_PLAYERS && this.state === 'waiting';
  }

  startGame() {
    if (!this.canStart()) {
      return { success: false, error: 'Cannot start game' };
    }

    this.state = 'playing';
    this.currentRound = 1;
    this.currentDrawerIndex = 0;

    // Reset all player scores
    this.players.forEach(p => {
      p.score = 0;
      p.hasGuessedThisRound = false;
    });

    // Log game start
    if (activityLogger && activityLogger.logPictionaryGameStart) {
      activityLogger.logPictionaryGameStart(this.name, this.players.size);
    }

    this.broadcast('game:started', {
      round: this.currentRound,
      totalRounds: this.totalRounds,
      players: this.getPlayerList()
    });

    this.startRound();
    return { success: true };
  }

  startRound() {
    // Generate 3 word choices for the drawer
    this.wordChoices = [
      this.getWord(),
      this.getWord(),
      this.getWord()
    ];
    // Ensure unique words
    while (this.wordChoices[1] === this.wordChoices[0]) {
      this.wordChoices[1] = this.getWord();
    }
    while (this.wordChoices[2] === this.wordChoices[0] || this.wordChoices[2] === this.wordChoices[1]) {
      this.wordChoices[2] = this.getWord();
    }

    this.currentWord = null; // Will be set when drawer picks
    this.currentHint = null;
    this.hintsRevealed = 0;
    this.drawHistory = [];
    this.redoHistory = [];
    this.correctGuessers = [];
    this.roundStartTime = null; // Will be set when drawer picks
    this.currentRoundHadCorrectGuess = false;
    this.state = 'choosing'; // New state for word selection

    // Reset player guess status
    this.players.forEach(p => {
      p.hasGuessedThisRound = false;
    });

    const drawer = this.getCurrentDrawer();

    // Track drawing stats
    if (drawer) {
      if (!this.drawingStats.has(drawer.id)) {
        this.drawingStats.set(drawer.id, { roundsDrawn: 0, successfulDrawings: 0 });
      }
      this.drawingStats.get(drawer.id).roundsDrawn++;
    }

    // Broadcast that drawer is choosing
    this.broadcast('game:choosing', {
      round: this.currentRound,
      drawerId: drawer.id,
      drawerName: drawer.displayName
    });

    // Send word choices only to drawer
    if (this.broadcastCallback) {
      this.broadcastCallback(this.id, 'game:chooseWord', {
        words: this.wordChoices
      }, null, drawer.id);
    }

    // Auto-select first word after 10 seconds if drawer doesn't pick
    this.wordChoiceTimer = setTimeout(() => {
      if (this.state === 'choosing') {
        this.selectWord(this.wordChoices[0]);
      }
    }, 10000);
  }

  selectWord(word) {
    if (this.state !== 'choosing') return false;
    if (!this.wordChoices.includes(word)) return false;

    // Clear the choice timer
    if (this.wordChoiceTimer) {
      clearTimeout(this.wordChoiceTimer);
      this.wordChoiceTimer = null;
    }

    this.currentWord = word;
    this.currentHint = this.currentWord.split('').map(c => c === ' ' ? ' ' : '_').join('');
    this.roundStartTime = Date.now();
    this.state = 'playing';
    this.wordChoices = null;

    const drawer = this.getCurrentDrawer();

    // Broadcast round start to all players
    this.broadcast('game:roundStart', {
      round: this.currentRound,
      drawerId: drawer.id,
      drawerName: drawer.displayName,
      hint: this.currentHint,
      wordLength: this.currentWord.length,
      timeLimit: ROUND_TIME
    });

    // Send confirmed word to drawer
    if (this.broadcastCallback) {
      this.broadcastCallback(this.id, 'game:yourTurn', {
        word: this.currentWord
      }, null, drawer.id);
    }

    // Start round timer
    this.roundTimer = setTimeout(() => this.endRound(false), ROUND_TIME * 1000);

    // Schedule hint reveals
    this.scheduleHints();

    return true;
  }

  scheduleHints() {
    const wordLength = this.currentWord.replace(/\s/g, '').length;

    HINT_INTERVALS.forEach((seconds, index) => {
      setTimeout(() => {
        if (this.state !== 'playing' || !this.currentWord) return;

        // Reveal more letters progressively
        const revealCount = Math.min(Math.ceil(wordLength * (index + 1) * 0.2), wordLength - 1);
        this.currentHint = generateHint(this.currentWord, revealCount);
        this.hintsRevealed = index + 1;

        this.broadcast('game:hint', {
          hint: this.currentHint,
          hintsRevealed: this.hintsRevealed
        });
      }, seconds * 1000);
    });
  }

  handleGuess(playerId, guess) {
    const player = this.players.get(playerId);
    if (!player) {
      // Check if it's a spectator
      if (this.spectators.has(playerId)) {
        return { success: false, error: 'Spectators cannot guess' };
      }
      return { success: false };
    }

    // Can't guess if you're the drawer
    if (this.getCurrentDrawer()?.id === playerId) {
      return { success: false, error: 'Drawer cannot guess' };
    }

    // Can't guess if already guessed correctly
    if (player.hasGuessedThisRound) {
      return { success: false, error: 'Already guessed correctly' };
    }

    const result = checkGuess(guess, this.currentWord);

    if (result.correct) {
      player.hasGuessedThisRound = true;
      const timeElapsed = (Date.now() - this.roundStartTime) / 1000;
      const isFirst = this.correctGuessers.length === 0;
      const score = calculateGuesserScore(timeElapsed, isFirst);

      player.score += score;
      this.correctGuessers.push({ playerId, displayName: player.displayName, score, timeElapsed });

      // Track successful drawing (first correct guess means the drawer succeeded)
      if (isFirst) {
        this.currentRoundHadCorrectGuess = true;
        const drawer = this.getCurrentDrawer();
        if (drawer && this.drawingStats.has(drawer.id)) {
          this.drawingStats.get(drawer.id).successfulDrawings++;
        }
      }

      // Award drawer points
      const drawer = this.getCurrentDrawer();
      if (drawer) {
        drawer.score += 25;
      }

      this.broadcast('game:correctGuess', {
        playerId,
        displayName: player.displayName,
        score,
        isFirst,
        players: this.getPlayerList()
      });

      // Log round win
      if (activityLogger && activityLogger.logPictionaryRoundWin) {
        activityLogger.logPictionaryRoundWin(player.displayName, this.currentWord, Math.round(timeElapsed));
      }

      // Check if everyone has guessed
      const nonDrawers = Array.from(this.players.values()).filter(p => p.id !== drawer?.id);
      const allGuessed = nonDrawers.every(p => p.hasGuessedThisRound);

      if (allGuessed) {
        this.endRound(false);
      }

      return { success: true, correct: true, score };
    }

    if (result.close) {
      return { success: true, correct: false, close: true };
    }

    return { success: true, correct: false, close: false };
  }

  endRound(drawerLeft = false) {
    // Clear timers
    if (this.roundTimer) {
      clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
    if (this.wordChoiceTimer) {
      clearTimeout(this.wordChoiceTimer);
      this.wordChoiceTimer = null;
    }

    const word = this.currentWord;
    this.currentWord = null;

    this.broadcast('game:roundEnd', {
      word,
      drawerLeft,
      correctGuessers: this.correctGuessers,
      players: this.getPlayerList()
    });

    // Move to next drawer
    this.currentDrawerIndex++;

    // Check if we've completed a full rotation (end of round)
    if (this.currentDrawerIndex >= this.players.size) {
      this.currentDrawerIndex = 0;
      this.currentRound++;

      if (this.currentRound > this.totalRounds) {
        // Game over
        setTimeout(() => this.endGame(), 3000);
        return;
      }
    }

    // Start next turn after a brief delay
    this.state = 'between_rounds';
    setTimeout(() => {
      if (this.players.size >= MIN_PLAYERS) {
        this.state = 'playing';
        this.startRound();
      } else {
        this.endGame('Not enough players');
      }
    }, 5000);
  }

  endGame(reason = null) {
    this.state = 'ended';

    // Clear any timers
    if (this.roundTimer) {
      clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }

    // Determine winner
    const sortedPlayers = Array.from(this.players.values()).sort((a, b) => b.score - a.score);
    const winner = sortedPlayers[0];

    // Update leaderboard
    this.players.forEach(player => {
      const drawStats = this.drawingStats.get(player.id) || { roundsDrawn: 0, successfulDrawings: 0 };
      updateLeaderboard(player.id, player.displayName, {
        gamesPlayed: 1,
        gamesWon: player.id === winner?.id ? 1 : 0,
        totalPoints: player.score,
        correctGuesses: this.correctGuessers.filter(g => g.playerId === player.id).length,
        roundsDrawn: drawStats.roundsDrawn,
        successfulDrawings: drawStats.successfulDrawings
      });
    });

    // Log game end
    if (activityLogger && activityLogger.logPictionaryGameEnd && winner) {
      activityLogger.logPictionaryGameEnd(winner.displayName, this.name);
    }

    this.broadcast('game:end', {
      reason,
      winner: winner ? winner.toJSON() : null,
      finalScores: sortedPlayers.map(p => p.toJSON())
    });

    // Reset room state after delay
    setTimeout(() => {
      this.state = 'waiting';
      this.currentRound = 0;
      this.currentDrawerIndex = 0;
      this.drawingStats.clear();
      this.players.forEach(p => {
        p.score = 0;
        p.hasGuessedThisRound = false;
      });

      // Promote spectators to players (up to max capacity)
      const spectatorArray = Array.from(this.spectators.values());
      for (const spectator of spectatorArray) {
        if (this.players.size >= this.maxPlayers) break;
        this.spectators.delete(spectator.id);
        spectator.isSpectator = false;
        spectator.score = 0;
        spectator.hasGuessedThisRound = false;
        this.players.set(spectator.id, spectator);
      }

      this.broadcast('room:reset', {
        players: this.getPlayerList(),
        spectators: this.getSpectatorList()
      });
    }, 10000);
  }

  // Drawing actions
  addStroke(stroke) {
    this.drawHistory.push(stroke);
    this.redoHistory = []; // Clear redo history on new stroke

    // Limit history size
    if (this.drawHistory.length > 50) {
      this.drawHistory.shift();
    }

    this.broadcast('draw:stroke', { stroke }, this.getCurrentDrawer()?.id);
  }

  undo() {
    if (this.drawHistory.length === 0) return null;
    const stroke = this.drawHistory.pop();
    this.redoHistory.push(stroke);
    // Just notify clients - they maintain their own undo stacks
    this.broadcast('draw:undo', {});
    return stroke;
  }

  redo() {
    if (this.redoHistory.length === 0) return null;
    const stroke = this.redoHistory.pop();
    this.drawHistory.push(stroke);
    // Just notify clients - they maintain their own undo stacks
    this.broadcast('draw:redo', {});
    return stroke;
  }

  clearCanvas() {
    this.drawHistory = [];
    this.redoHistory = [];
    this.broadcast('draw:clear', {});
  }

  getDrawState() {
    return {
      history: this.drawHistory
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      playerCount: this.players.size,
      spectatorCount: this.spectators.size,
      maxPlayers: this.maxPlayers,
      state: this.state,
      difficulty: this.difficulty,
      language: this.language,
      currentRound: this.currentRound,
      totalRounds: this.totalRounds,
      players: this.getPlayerList(),
      spectators: this.getSpectatorList()
    };
  }
}

// Update leaderboard for a player
function updateLeaderboard(playerId, displayName, stats) {
  if (!leaderboard.players[playerId]) {
    leaderboard.players[playerId] = {
      displayName,
      gamesPlayed: 0,
      gamesWon: 0,
      totalPoints: 0,
      correctGuesses: 0,
      roundsDrawn: 0,
      successfulDrawings: 0,
      winStreak: 0,
      bestWinStreak: 0,
      lastPlayed: null
    };
  }

  const player = leaderboard.players[playerId];
  player.displayName = displayName; // Always update display name
  player.gamesPlayed += stats.gamesPlayed || 0;
  player.gamesWon += stats.gamesWon || 0;
  player.totalPoints += stats.totalPoints || 0;
  player.correctGuesses += stats.correctGuesses || 0;
  player.roundsDrawn = (player.roundsDrawn || 0) + (stats.roundsDrawn || 0);
  player.successfulDrawings = (player.successfulDrawings || 0) + (stats.successfulDrawings || 0);
  player.lastPlayed = Date.now();

  // Update win streak
  if (stats.gamesWon > 0) {
    player.winStreak = (player.winStreak || 0) + 1;
    player.bestWinStreak = Math.max(player.bestWinStreak || 0, player.winStreak);
  } else {
    player.winStreak = 0;
  }

  scheduleSaveLeaderboard();
}

// Room management functions
export function createRoom(name, hostId, hostName, hostAvatar, settings = {}) {
  const id = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const room = new Room(id, name, hostId, settings);

  // Add host as first player
  const hostPlayer = new Player(hostId, hostName, hostAvatar);
  room.addPlayer(hostPlayer);

  rooms.set(id, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId);
}

export function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    // Clear any timers
    if (room.roundTimer) clearTimeout(room.roundTimer);
    rooms.delete(roomId);
  }
}

export function getRoomList() {
  return Array.from(rooms.values())
    .filter(room => room.state !== 'ended') // Show all rooms except ended
    .map(room => room.toJSON());
}

export function getLeaderboard() {
  return Object.entries(leaderboard.players)
    .map(([id, data]) => {
      const gamesPlayed = data.gamesPlayed || 0;
      const gamesWon = data.gamesWon || 0;
      const totalPoints = data.totalPoints || 0;
      const roundsDrawn = data.roundsDrawn || 0;
      const successfulDrawings = data.successfulDrawings || 0;

      // Calculate derived stats
      const winRate = gamesPlayed > 0 ? Math.round((gamesWon / gamesPlayed) * 100) : 0;
      const avgPoints = gamesPlayed > 0 ? Math.round(totalPoints / gamesPlayed) : 0;
      const drawSuccessRate = roundsDrawn > 0 ? Math.round((successfulDrawings / roundsDrawn) * 100) : 0;

      // Skill rating: weighted combination (avg points matters most, win rate adds bonus)
      // Minimum 3 games to get a proper rating
      const skillRating = gamesPlayed >= 3
        ? Math.round(avgPoints * 0.7 + winRate * 2 + drawSuccessRate * 0.5)
        : avgPoints;

      return {
        id,
        ...data,
        winRate,
        avgPoints,
        drawSuccessRate,
        skillRating
      };
    })
    .sort((a, b) => {
      // Sort by skill rating, then by games played as tiebreaker
      if (b.skillRating !== a.skillRating) return b.skillRating - a.skillRating;
      return b.gamesPlayed - a.gamesPlayed;
    })
    .slice(0, 20);
}

// Cleanup old/empty rooms periodically
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, id) => {
    // Remove empty rooms older than 5 minutes
    if (room.players.size === 0 && (now - room.createdAt) > 5 * 60 * 1000) {
      deleteRoom(id);
    }
    // Remove ended games older than 15 minutes
    if (room.state === 'ended' && (now - room.createdAt) > 15 * 60 * 1000) {
      deleteRoom(id);
    }
  });
}, 60000);

export { Player };

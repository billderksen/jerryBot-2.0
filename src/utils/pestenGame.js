import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEADERBOARD_PATH = join(__dirname, '../../data/pestenLeaderboard.json');

// Card suits and ranks
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Special card effects
const SPECIAL_CARDS = {
  '2': 'draw2',      // Next player draws 2 (stackable)
  '7': 'playAgain',  // Current player plays again
  '8': 'skip',       // Skip next player
  'J': 'wild',       // Choose new suit
  'A': 'reverse',    // Reverse direction
  'joker': 'draw5'   // Next player draws 5 (stackable)
};

// Room storage
const rooms = new Map();

// Leaderboard
let leaderboard = loadLeaderboard();

function loadLeaderboard() {
  try {
    if (existsSync(LEADERBOARD_PATH)) {
      const data = readFileSync(LEADERBOARD_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading Pesten leaderboard:', error);
  }
  return { players: {} };
}

function saveLeaderboard() {
  try {
    writeFileSync(LEADERBOARD_PATH, JSON.stringify(leaderboard, null, 2));
  } catch (error) {
    console.error('Error saving Pesten leaderboard:', error);
  }
}

function createDeck() {
  const deck = [];

  // Add regular cards
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, id: `${rank}_${suit}` });
    }
  }

  // Add 2 jokers
  deck.push({ suit: 'joker', rank: 'joker', id: 'joker_1' });
  deck.push({ suit: 'joker', rank: 'joker', id: 'joker_2' });

  return deck;
}

function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function canPlayCard(card, topCard, chosenSuit, pendingDraws) {
  // If there are pending draws, only matching draw cards can be played
  if (pendingDraws > 0) {
    if (topCard.rank === '2' || (topCard.suit === 'joker' && topCard.rank === 'joker')) {
      // Can stack 2s on 2s
      if (topCard.rank === '2' && card.rank === '2') return true;
      // Can stack jokers on jokers or on 2s
      if (card.suit === 'joker' && card.rank === 'joker') return true;
      // Can stack 2s on jokers
      if (topCard.suit === 'joker' && card.rank === '2') return true;
      return false;
    }
  }

  // Joker can always be played
  if (card.suit === 'joker' && card.rank === 'joker') return true;

  // Jack (wild) can always be played
  if (card.rank === 'J') return true;

  // If a suit was chosen (after Jack), must match that suit
  if (chosenSuit) {
    return card.suit === chosenSuit || card.rank === 'J';
  }

  // Match by suit or rank
  return card.suit === topCard.suit || card.rank === topCard.rank;
}

class PestenRoom {
  constructor(id, name, hostId, hostName, hostAvatar, maxPlayers = 4) {
    this.id = id;
    this.name = name;
    this.hostId = hostId;
    this.maxPlayers = Math.min(Math.max(maxPlayers, 2), 8);
    this.players = [{
      id: hostId,
      name: hostName,
      avatar: hostAvatar,
      hand: [],
      isBot: false,
      connected: true
    }];
    this.gameState = 'waiting'; // waiting, playing, finished
    this.deck = [];
    this.discardPile = [];
    this.currentPlayerIndex = 0;
    this.direction = 1; // 1 = clockwise, -1 = counter-clockwise
    this.chosenSuit = null; // Set when Jack is played
    this.pendingDraws = 0; // Stacked draw cards
    this.winner = null;
    this.gameLog = [];
    this.botIdCounter = 0;
  }

  addPlayer(playerId, playerName, playerAvatar, isBot = false) {
    // Check if player already exists (reconnection)
    const existingPlayer = this.players.find(p => p.id === playerId);
    if (existingPlayer) {
      existingPlayer.connected = true;
      existingPlayer.name = playerName; // Update name in case it changed
      existingPlayer.avatar = playerAvatar;
      return { success: true, message: 'Reconnected', reconnected: true };
    }

    // Can't add new players during a game
    if (this.gameState !== 'waiting') {
      return { success: false, error: 'Game already in progress' };
    }

    if (this.players.length >= this.maxPlayers) {
      return { success: false, error: 'Room is full' };
    }

    this.players.push({
      id: playerId,
      name: playerName,
      avatar: playerAvatar,
      hand: [],
      isBot,
      connected: true,
      // Game stats tracking
      gameStats: {
        cardsPlayed: 0,
        specialCardsPlayed: 0,
        drawsForced: 0,
        cardsDrawn: 0
      }
    });

    return { success: true };
  }

  // Check if a player exists in the room (for reconnection)
  hasPlayer(playerId) {
    return this.players.some(p => p.id === playerId);
  }

  addBot() {
    if (this.players.length >= this.maxPlayers) {
      return { success: false, error: 'Room is full' };
    }

    if (this.gameState !== 'waiting') {
      return { success: false, error: 'Game already in progress' };
    }

    this.botIdCounter++;
    const botNames = ['Bot Alex', 'Bot Sam', 'Bot Max', 'Bot Robin', 'Bot Charlie', 'Bot Jordan'];
    const botName = botNames[(this.botIdCounter - 1) % botNames.length];
    const botId = `bot_${this.id}_${this.botIdCounter}`;

    this.players.push({
      id: botId,
      name: botName,
      avatar: null,
      hand: [],
      isBot: true,
      connected: true
    });

    return { success: true, botId, botName };
  }

  removeBot(botId) {
    if (this.gameState !== 'waiting') {
      return { success: false, error: 'Cannot remove bot during game' };
    }

    const index = this.players.findIndex(p => p.id === botId && p.isBot);
    if (index === -1) {
      return { success: false, error: 'Bot not found' };
    }

    this.players.splice(index, 1);
    return { success: true };
  }

  removePlayer(playerId) {
    const index = this.players.findIndex(p => p.id === playerId);
    if (index === -1) return { success: false, error: 'Player not found' };

    // If game is in progress, mark as disconnected instead of removing
    if (this.gameState === 'playing') {
      this.players[index].connected = false;

      // If it's their turn, skip to next player
      if (this.currentPlayerIndex === index) {
        this.nextTurn();
      }

      // Check if all human players left
      const connectedHumans = this.players.filter(p => !p.isBot && p.connected);
      if (connectedHumans.length === 0) {
        this.gameState = 'finished';
        return { success: true, gameEnded: true };
      }

      return { success: true, disconnected: true };
    }

    // In waiting state, remove the player
    this.players.splice(index, 1);

    // If host left, assign new host
    if (playerId === this.hostId && this.players.length > 0) {
      const newHost = this.players.find(p => !p.isBot);
      if (newHost) {
        this.hostId = newHost.id;
      }
    }

    return { success: true };
  }

  startGame() {
    if (this.players.length < 2) {
      return { success: false, error: 'Need at least 2 players' };
    }

    if (this.gameState !== 'waiting') {
      return { success: false, error: 'Game already started' };
    }

    // Create and shuffle deck
    this.deck = shuffleDeck(createDeck());
    this.discardPile = [];
    this.direction = 1;
    this.chosenSuit = null;
    this.pendingDraws = 0;
    this.winner = null;
    this.gameLog = [];

    // Deal 7 cards to each player and reset game stats
    for (const player of this.players) {
      player.hand = [];
      player.gameStats = {
        cardsPlayed: 0,
        specialCardsPlayed: 0,
        drawsForced: 0,
        cardsDrawn: 0
      };
      for (let i = 0; i < 7; i++) {
        if (this.deck.length > 0) {
          player.hand.push(this.deck.pop());
        }
      }
    }

    // Place first card on discard pile (make sure it's not a special card)
    let firstCard;
    do {
      firstCard = this.deck.pop();
      if (SPECIAL_CARDS[firstCard.rank] || firstCard.suit === 'joker') {
        // Put special card back in deck and reshuffle
        this.deck.unshift(firstCard);
        this.deck = shuffleDeck(this.deck);
      } else {
        break;
      }
    } while (this.deck.length > 0);

    this.discardPile.push(firstCard);

    // Random starting player
    this.currentPlayerIndex = Math.floor(Math.random() * this.players.length);

    this.gameState = 'playing';
    this.addLog(`Game started! ${this.players[this.currentPlayerIndex].name}'s turn.`);

    return { success: true };
  }

  getTopCard() {
    return this.discardPile[this.discardPile.length - 1];
  }

  getCurrentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  playCard(playerId, cardId, chosenSuit = null) {
    if (this.gameState !== 'playing') {
      return { success: false, error: 'Game not in progress' };
    }

    const player = this.players[this.currentPlayerIndex];
    if (player.id !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    const cardIndex = player.hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) {
      return { success: false, error: 'Card not in hand' };
    }

    const card = player.hand[cardIndex];
    const topCard = this.getTopCard();

    if (!canPlayCard(card, topCard, this.chosenSuit, this.pendingDraws)) {
      return { success: false, error: 'Cannot play this card' };
    }

    // Remove card from hand and add to discard pile
    player.hand.splice(cardIndex, 1);
    this.discardPile.push(card);
    this.chosenSuit = null;

    // Track stats
    player.gameStats.cardsPlayed++;

    // Handle special cards
    let effect = null;
    const specialEffect = card.suit === 'joker' ? 'draw5' : SPECIAL_CARDS[card.rank];

    if (specialEffect) {
      player.gameStats.specialCardsPlayed++;
    }

    if (specialEffect === 'draw2') {
      this.pendingDraws += 2;
      player.gameStats.drawsForced += 2;
      effect = 'draw2';
      this.addLog(`${player.name} played 2 of ${card.suit}. Next player must draw ${this.pendingDraws} or stack!`);
    } else if (specialEffect === 'draw5') {
      this.pendingDraws += 5;
      player.gameStats.drawsForced += 5;
      effect = 'draw5';
      this.addLog(`${player.name} played Joker! Next player must draw ${this.pendingDraws} or stack!`);
    } else if (specialEffect === 'playAgain') {
      effect = 'playAgain';
      this.addLog(`${player.name} played 7 of ${card.suit} and plays again!`);
    } else if (specialEffect === 'skip') {
      effect = 'skip';
      this.addLog(`${player.name} played 8 of ${card.suit}. Next player is skipped!`);
    } else if (specialEffect === 'wild') {
      if (!chosenSuit || !SUITS.includes(chosenSuit)) {
        // Put card back if no suit chosen (undo stats tracking)
        player.hand.push(card);
        this.discardPile.pop();
        player.gameStats.cardsPlayed--;
        player.gameStats.specialCardsPlayed--;
        return { success: false, error: 'Must choose a suit', needsSuit: true };
      }
      this.chosenSuit = chosenSuit;
      effect = 'wild';
      this.addLog(`${player.name} played Jack and chose ${chosenSuit}!`);
    } else if (specialEffect === 'reverse') {
      this.direction *= -1;
      effect = 'reverse';
      const directionName = this.direction === 1 ? 'clockwise' : 'counter-clockwise';
      this.addLog(`${player.name} played Ace of ${card.suit}. Direction reversed to ${directionName}!`);
    } else {
      this.addLog(`${player.name} played ${card.rank} of ${card.suit}.`);
    }

    // Check for win
    if (player.hand.length === 0) {
      this.winner = player;
      this.gameState = 'finished';
      this.addLog(`${player.name} wins!`);
      this.updateLeaderboard(player.id, player.name, true, player.gameStats);

      // Update other players' stats
      for (const p of this.players) {
        if (p.id !== player.id && !p.isBot) {
          this.updateLeaderboard(p.id, p.name, false, p.gameStats);
        }
      }

      return { success: true, effect, gameOver: true, winner: player };
    }

    // Next turn (unless play again)
    if (specialEffect !== 'playAgain') {
      if (specialEffect === 'skip') {
        this.nextTurn(); // Skip one extra
      }
      this.nextTurn();
    }

    return { success: true, effect };
  }

  drawCard(playerId) {
    if (this.gameState !== 'playing') {
      return { success: false, error: 'Game not in progress' };
    }

    const player = this.players[this.currentPlayerIndex];
    if (player.id !== playerId) {
      return { success: false, error: 'Not your turn' };
    }

    // If there are pending draws, must draw that many
    const drawCount = this.pendingDraws > 0 ? this.pendingDraws : 1;
    const drawnCards = [];

    for (let i = 0; i < drawCount; i++) {
      // Reshuffle discard pile if deck is empty
      if (this.deck.length === 0) {
        if (this.discardPile.length <= 1) {
          return { success: false, error: 'No cards left to draw' };
        }
        const topCard = this.discardPile.pop();
        this.deck = shuffleDeck(this.discardPile);
        this.discardPile = [topCard];
        this.addLog('Deck reshuffled from discard pile.');
      }

      const card = this.deck.pop();
      player.hand.push(card);
      drawnCards.push(card);
    }

    // Track cards drawn
    player.gameStats.cardsDrawn += drawnCards.length;

    if (this.pendingDraws > 0) {
      this.addLog(`${player.name} drew ${this.pendingDraws} cards.`);
      this.pendingDraws = 0;
    } else {
      this.addLog(`${player.name} drew a card.`);
    }

    this.nextTurn();

    return { success: true, drawnCards };
  }

  nextTurn() {
    this.currentPlayerIndex = (this.currentPlayerIndex + this.direction + this.players.length) % this.players.length;

    // Skip disconnected players
    let attempts = 0;
    while (!this.players[this.currentPlayerIndex].connected && attempts < this.players.length) {
      this.currentPlayerIndex = (this.currentPlayerIndex + this.direction + this.players.length) % this.players.length;
      attempts++;
    }
  }

  addLog(message) {
    this.gameLog.push({
      time: Date.now(),
      message
    });
    // Keep only last 50 messages
    if (this.gameLog.length > 50) {
      this.gameLog.shift();
    }
  }

  updateLeaderboard(playerId, playerName, won, gameStats = {}) {
    if (playerId.startsWith('bot_')) return; // Don't track bot stats

    if (!leaderboard.players[playerId]) {
      leaderboard.players[playerId] = {
        oderId: playerId,
        displayName: playerName,
        gamesPlayed: 0,
        gamesWon: 0,
        cardsPlayed: 0,
        specialCardsPlayed: 0,
        drawsForced: 0,
        cardsDrawn: 0,
        winStreak: 0,
        bestWinStreak: 0,
        lastPlayed: null
      };
    }

    const stats = leaderboard.players[playerId];
    stats.displayName = playerName;
    stats.gamesPlayed++;
    stats.lastPlayed = Date.now();

    // Add game stats
    stats.cardsPlayed += gameStats.cardsPlayed || 0;
    stats.specialCardsPlayed += gameStats.specialCardsPlayed || 0;
    stats.drawsForced += gameStats.drawsForced || 0;
    stats.cardsDrawn += gameStats.cardsDrawn || 0;

    if (won) {
      stats.gamesWon++;
      stats.winStreak++;
      stats.bestWinStreak = Math.max(stats.bestWinStreak, stats.winStreak);
    } else {
      stats.winStreak = 0;
    }

    saveLeaderboard();
  }

  // Bot AI logic
  getBotMove(botId) {
    const player = this.players.find(p => p.id === botId);
    if (!player || !player.isBot) return null;

    const topCard = this.getTopCard();
    const playableCards = player.hand.filter(card =>
      canPlayCard(card, topCard, this.chosenSuit, this.pendingDraws)
    );

    if (playableCards.length === 0) {
      return { action: 'draw' };
    }

    // Bot strategy: prioritize special cards, then match suit, then match rank
    // If pending draws, try to stack
    if (this.pendingDraws > 0) {
      const stackableCards = playableCards.filter(c =>
        c.rank === '2' || c.suit === 'joker'
      );
      if (stackableCards.length > 0) {
        const card = stackableCards[Math.floor(Math.random() * stackableCards.length)];
        return { action: 'play', cardId: card.id };
      }
      return { action: 'draw' };
    }

    // Prioritize getting rid of special cards
    const specialCards = playableCards.filter(c => SPECIAL_CARDS[c.rank] || c.suit === 'joker');
    if (specialCards.length > 0 && Math.random() > 0.3) {
      const card = specialCards[Math.floor(Math.random() * specialCards.length)];
      let chosenSuit = null;
      if (card.rank === 'J') {
        // Choose most common suit in hand
        const suitCounts = {};
        for (const c of player.hand) {
          if (c.suit !== 'joker') {
            suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
          }
        }
        chosenSuit = Object.entries(suitCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || SUITS[0];
      }
      return { action: 'play', cardId: card.id, chosenSuit };
    }

    // Play random playable card
    const card = playableCards[Math.floor(Math.random() * playableCards.length)];
    let chosenSuit = null;
    if (card.rank === 'J') {
      const suitCounts = {};
      for (const c of player.hand) {
        if (c.suit !== 'joker') {
          suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
        }
      }
      chosenSuit = Object.entries(suitCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || SUITS[0];
    }
    return { action: 'play', cardId: card.id, chosenSuit };
  }

  getState(forPlayerId = null) {
    const state = {
      id: this.id,
      name: this.name,
      hostId: this.hostId,
      maxPlayers: this.maxPlayers,
      gameState: this.gameState,
      currentPlayerIndex: this.currentPlayerIndex,
      direction: this.direction,
      chosenSuit: this.chosenSuit,
      pendingDraws: this.pendingDraws,
      topCard: this.getTopCard(),
      deckCount: this.deck.length,
      gameLog: this.gameLog.slice(-10),
      winner: this.winner ? { id: this.winner.id, name: this.winner.name } : null,
      players: this.players.map((p, index) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        cardCount: p.hand.length,
        isBot: p.isBot,
        connected: p.connected,
        isCurrentTurn: index === this.currentPlayerIndex,
        // Only send hand to the player themselves
        hand: p.id === forPlayerId ? p.hand : undefined
      }))
    };

    return state;
  }
}

// Room management functions
export function createRoom(name, hostId, hostName, hostAvatar, maxPlayers) {
  const id = `pesten_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const room = new PestenRoom(id, name, hostId, hostName, hostAvatar, maxPlayers);
  rooms.set(id, room);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId);
}

export function deleteRoom(roomId) {
  rooms.delete(roomId);
}

export function getRoomList() {
  return Array.from(rooms.values())
    .filter(room => room.gameState === 'waiting')
    .map(room => ({
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      players: room.players.map(p => ({ name: p.name, avatar: p.avatar, isBot: p.isBot }))
    }));
}

export function getLeaderboard() {
  return Object.entries(leaderboard.players)
    .map(([id, data]) => {
      const gamesPlayed = data.gamesPlayed || 0;
      const gamesWon = data.gamesWon || 0;
      const cardsPlayed = data.cardsPlayed || 0;
      const specialCardsPlayed = data.specialCardsPlayed || 0;
      const drawsForced = data.drawsForced || 0;
      const cardsDrawn = data.cardsDrawn || 0;

      // Calculate derived stats
      const winRate = gamesPlayed > 0 ? Math.round((gamesWon / gamesPlayed) * 100) : 0;
      const avgCardsPlayed = gamesPlayed > 0 ? Math.round(cardsPlayed / gamesPlayed) : 0;
      const specialCardRate = cardsPlayed > 0 ? Math.round((specialCardsPlayed / cardsPlayed) * 100) : 0;
      const avgDrawsForced = gamesPlayed > 0 ? Math.round((drawsForced / gamesPlayed) * 10) / 10 : 0;

      // Skill rating: weighted combination
      // Win rate matters most, then aggression (draws forced), then efficiency (fewer cards drawn)
      const skillRating = gamesPlayed >= 3
        ? Math.round(
            winRate * 0.5 +
            Math.min(avgDrawsForced * 5, 25) +
            specialCardRate * 0.2 +
            Math.max(0, 20 - (cardsDrawn / Math.max(gamesPlayed, 1)))
          )
        : winRate;

      return {
        oderId: data.oderId || id,
        id,
        displayName: data.displayName,
        gamesPlayed,
        gamesWon,
        cardsPlayed,
        specialCardsPlayed,
        drawsForced,
        cardsDrawn,
        winRate,
        avgCardsPlayed,
        specialCardRate,
        avgDrawsForced,
        winStreak: data.winStreak || 0,
        bestWinStreak: data.bestWinStreak || 0,
        skillRating,
        lastPlayed: data.lastPlayed
      };
    })
    .sort((a, b) => b.skillRating - a.skillRating)
    .slice(0, 20);
}

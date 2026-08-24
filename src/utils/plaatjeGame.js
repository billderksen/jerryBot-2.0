// PLAATJE — regels en kamers. Dit deel is puur (geen IO); de Room-klasse en
// de room-manager (met jsonStore-leaderboard) staan eronder [Taak 4].

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { matchGuess } from './plaatjeText.js';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEADERBOARD_FILE = join(__dirname, '../../data/plaatjeLeaderboard.json');

const rooms = new Map();

export function placementIsCorrect(timelineYears, slotIndex, year) {
  if (slotIndex == null || slotIndex < 0 || slotIndex > timelineYears.length) return false;
  const left = slotIndex === 0 ? -Infinity : timelineYears[slotIndex - 1];
  const right = slotIndex === timelineYears.length ? Infinity : timelineYears[slotIndex];
  return left <= year && year <= right; // gelijke jaartallen tellen als goed
}

export function insertIndexForYear(timelineYears, year) {
  let i = 0;
  while (i < timelineYears.length && timelineYears[i] <= year) i++;
  return i;
}

export function resolveRound({ timelineYears, activeSlot, year, challenges }) {
  const activeCorrect = activeSlot != null && placementIsCorrect(timelineYears, activeSlot, year);
  let stealWinner = null;
  if (!activeCorrect) {
    const winner = [...challenges]
      .sort((a, b) => a.at - b.at)
      .find((c) => placementIsCorrect(timelineYears, c.slot, year));
    stealWinner = winner ? winner.userId : null;
  }
  return { activeCorrect, stealWinner };
}

export function startOffsetSeconds(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.round(Math.min(30, Math.max(0, durationSec - 60)));
}

export function clampCardsToWin(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 10;
  return Math.min(15, Math.max(5, Math.round(v)));
}

export function canHostSkipTurn({ disconnectedAtMs, nowMs }) {
  return Number.isFinite(disconnectedAtMs) && nowMs - disconnectedAtMs >= 60_000;
}

export function shouldDeleteRoom({ emptySinceMs, nowMs }) {
  return Number.isFinite(emptySinceMs) && nowMs - emptySinceMs >= 5 * 60_000;
}

export class PlaatjeRoom {
  constructor(roomId, hostUser, settings = {}) {
    this.roomId = roomId;
    this.hostId = hostUser.id;
    this.settings = {
      cardsToWin: clampCardsToWin(settings.cardsToWin),
      poolIds: Array.isArray(settings.poolIds) && settings.poolIds.length ? settings.poolIds : ['base'],
      audioMode: settings.audioMode === 'vc' ? 'vc' : 'browser',
      solo: settings.solo === true, // 1-speler-oefenpotje: start zonder tweede speler
    };
    this.phase = 'lobby';
    this.players = new Map(); // userId -> speler; insertion order = beurtvolgorde
    this.spectators = new Set();
    this.activeIdx = 0;
    this.round = null;
    this.lastReveal = null;
    this.usedSongIds = new Set();
    this.winnerId = null;
    this.emptySince = null;
    this.loadFailStreak = 0;
    this.rondeTeller = 0; // persistente ronde-teller — this.round wordt tussen rondes genuld,
    // dus die kan de nonce niet leveren (zie beginRound)
    this.addPlayer(hostUser);
  }

  addPlayer(user) {
    // Volgorde is belangrijk: een bestaande speler die mid-game herverbindt is
    // een speler, geen toeschouwer.
    if (this.players.has(user.id)) { this.markReconnected(user.id); return { isSpectator: false }; }
    if (this.phase !== 'lobby') { this.spectators.add(user.id); this.emptySince = null; return { isSpectator: true }; }
    this.players.set(user.id, {
      id: user.id, displayName: user.displayName, avatar: user.avatar ?? null,
      timeline: [], tokens: 2, tokensEarned: 0, connected: true, disconnectedAt: null,
    });
    this.emptySince = null;
    return { isSpectator: false };
  }

  addSpectator(userId) { this.spectators.add(userId); }

  markDisconnected(userId, nowMs) {
    const p = this.players.get(userId);
    if (p) { p.connected = false; p.disconnectedAt = nowMs; }
    this.spectators.delete(userId);
    // Mid-game migreert het hostschap naar een verbonden speler, anders is de kamer
    // stuurloos zodra de host wegvalt (niemand anders mag host-acties doen). In de
    // lobby juist niet: een host die even ververst moet zijn kamer terugkrijgen.
    if (this.phase !== 'lobby' && userId === this.hostId) {
      const vervanger = [...this.players.values()].find((x) => x.connected);
      if (vervanger) this.hostId = vervanger.id;
    }
    if (![...this.players.values()].some((x) => x.connected) && this.spectators.size === 0) {
      this.emptySince = nowMs;
    }
  }

  markReconnected(userId) {
    const p = this.players.get(userId);
    if (p) { p.connected = true; p.disconnectedAt = null; }
    this.emptySince = null;
  }

  removePlayer(userId) {
    this.spectators.delete(userId);
    if (this.phase === 'lobby') {
      this.players.delete(userId);
      if (this.hostId === userId && this.players.size) this.hostId = this.players.keys().next().value;
    } else {
      this.markDisconnected(userId, Date.now());
    }
  }

  get activeUserId() {
    const ids = [...this.players.keys()];
    return ids.length ? ids[this.activeIdx % ids.length] : null;
  }

  start(dealCard) {
    const minSpelers = this.settings.solo ? 1 : 2;
    if (this.phase !== 'lobby' || this.players.size < minSpelers) return { ok: false };
    for (const p of this.players.values()) {
      const card = dealCard();
      this.usedSongIds.add(card.youtubeId);
      p.timeline = [{ title: card.title, artist: card.artist, year: card.year }];
    }
    this.activeIdx = 0;
    this.phase = 'loading';
    return { ok: true };
  }

  beginRound(song, offsetSec) {
    if (this.phase !== 'loading') return { ok: false };
    this.usedSongIds.add(song.youtubeId);
    // this.round is al genuld door resolveReveal() tegen de tijd dat de volgende ronde begint,
    // dus (this.round?.nonce ?? 0) + 1 zou hier altijd op 1 uitkomen — vandaar de losstaande teller.
    this.rondeTeller += 1;
    this.round = {
      song, offsetSec, nonce: this.rondeTeller,
      placedSlot: null, guess: null, challenges: [],
    };
    this.lastReveal = null;
    this.phase = 'listening';
    return { ok: true };
  }

  place(userId, slot) {
    if (this.phase !== 'listening' || userId !== this.activeUserId || !this.round) return { ok: false };
    const tl = this.players.get(userId).timeline;
    if (!Number.isInteger(slot) || slot < 0 || slot > tl.length) return { ok: false };
    this.round.placedSlot = slot;
    this.phase = 'challenge';
    return { ok: true };
  }

  recordGuess(userId, artist, title) {
    if (!this.round || this.round.guess || userId !== this.activeUserId) return { ok: false };
    if (!['listening', 'challenge'].includes(this.phase)) return { ok: false };
    this.round.guess = { artist: String(artist ?? '').slice(0, 200), title: String(title ?? '').slice(0, 200) };
    return { ok: true };
  }

  paySwap(userId) {
    if (this.phase !== 'listening' || userId !== this.activeUserId) return { ok: false };
    if (this.round?.challenges.length) return { ok: false, reason: 'Er is al HITSTER geroepen — wisselen kan niet meer' };
    const p = this.players.get(userId);
    if (p.tokens < 1) return { ok: false, reason: 'Geen fiches meer' };
    p.tokens -= 1;
    return { ok: true };
  }

  challenge(userId, slot, atMs) {
    if (!['listening', 'challenge'].includes(this.phase) || !this.round) return { ok: false };
    if (userId === this.activeUserId) return { ok: false };
    const p = this.players.get(userId);
    if (!p) return { ok: false };
    if (p.tokens < 1) return { ok: false, reason: 'Geen fiches meer' };
    if (this.round.challenges.some((c) => c.userId === userId)) return { ok: false };
    const tl = this.players.get(this.activeUserId).timeline;
    if (!Number.isInteger(slot) || slot < 0 || slot > tl.length) return { ok: false };
    p.tokens -= 1; // HITSTER kost altijd je fiche
    this.round.challenges.push({ userId, slot, at: atMs });
    return { ok: true };
  }

  resolveReveal() {
    if (!this.round || !['listening', 'challenge'].includes(this.phase)) return null;
    const active = this.players.get(this.activeUserId);
    const { song } = this.round;
    const timelineYears = active.timeline.map((c) => c.year);
    const { activeCorrect, stealWinner } = resolveRound({
      timelineYears, activeSlot: this.round.placedSlot, year: song.year,
      challenges: this.round.challenges,
    });
    const card = { title: song.title, artist: song.artist, year: song.year };
    if (activeCorrect) {
      active.timeline.splice(insertIndexForYear(timelineYears, song.year), 0, card);
    } else if (stealWinner) {
      const w = this.players.get(stealWinner);
      w.timeline.splice(insertIndexForYear(w.timeline.map((c) => c.year), song.year), 0, card);
    }
    const guessCorrect = this.round.guess ? matchGuess(this.round.guess, song) : false;
    if (guessCorrect) { active.tokens += 1; active.tokensEarned += 1; }
    for (const p of this.players.values()) {
      if (p.timeline.length >= this.settings.cardsToWin) { this.phase = 'finished'; this.winnerId = p.id; }
    }
    if (this.phase !== 'finished') this.phase = 'reveal';
    this.lastReveal = {
      year: song.year, title: song.title, artist: song.artist,
      activeCorrect, stolenBy: stealWinner, guessCorrect, activeId: active.id,
    };
    this.round = null;
    return this.lastReveal;
  }

  nextTurn() {
    if (this.phase === 'finished' || this.round != null) return;
    // Disconnected spelers blijven in het spel staan (rejoin met tijdlijn intact) maar
    // krijgen geen beurt — anders wacht de ronde eeuwig op een kaart die nooit gelegd
    // wordt. Zodra iemand terug is, draait hij vanzelf weer mee.
    const ids = [...this.players.keys()];
    for (let stap = 1; stap <= ids.length; stap++) {
      const idx = (this.activeIdx + stap) % ids.length;
      if (this.players.get(ids[idx]).connected) {
        this.activeIdx = idx;
        this.phase = 'loading';
        return;
      }
    }
    // iedereen weg: gewoon één plek opschuiven; de empty-timer ruimt de kamer op
    this.activeIdx = (this.activeIdx + 1) % this.players.size;
    this.phase = 'loading';
  }

  publicState() {
    return {
      roomId: this.roomId,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      activeUserId: this.activeUserId,
      winnerId: this.winnerId,
      lastReveal: this.lastReveal,
      round: this.round ? {
        nonce: this.round.nonce,
        placedSlot: this.round.placedSlot,
        hasGuess: Boolean(this.round.guess),
        challengers: this.round.challenges.map((c) => c.userId),
      } : null,
      players: [...this.players.values()].map((p) => ({
        id: p.id, displayName: p.displayName, avatar: p.avatar,
        tokens: p.tokens, connected: p.connected, disconnectedAt: p.disconnectedAt,
        timeline: p.timeline,
      })),
      spectatorCount: this.spectators.size,
    };
  }
}

export function createPlaatjeRoom(roomId, hostUser, settings) {
  const room = new PlaatjeRoom(roomId, hostUser, settings);
  rooms.set(roomId, room);
  return room;
}
export function getPlaatjeRoom(roomId) { return rooms.get(roomId); }
export function deletePlaatjeRoom(roomId) { rooms.delete(roomId); }
export function getPlaatjeRoomList() {
  return [...rooms.values()].map((r) => ({
    roomId: r.roomId,
    hostName: r.players.get(r.hostId)?.displayName ?? '?',
    playerCount: r.players.size,
    phase: r.phase,
    cardsToWin: r.settings.cardsToWin,
  }));
}

export function recordGameResult(room) {
  const data = loadJsonSync(LEADERBOARD_FILE, { players: {} });
  for (const p of room.players.values()) {
    const entry = data.players[p.id] ?? { displayName: p.displayName, gamesPlayed: 0, gamesWon: 0, cardsWon: 0, tokensEarned: 0 };
    entry.displayName = p.displayName;
    entry.gamesPlayed += 1;
    if (p.id === room.winnerId) entry.gamesWon += 1;
    entry.cardsWon += Math.max(0, p.timeline.length - 1);
    entry.tokensEarned += p.tokensEarned;
    data.players[p.id] = entry;
  }
  saveJsonSync(LEADERBOARD_FILE, data);
}

export function getPlaatjeLeaderboard() {
  return loadJsonSync(LEADERBOARD_FILE, { players: {} });
}

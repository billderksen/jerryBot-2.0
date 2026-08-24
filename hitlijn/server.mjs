// hitlijn/server.mjs — HITLIJN: publieke, mobiele versie van het muziek-tijdlijnspel.
// Eigen proces naast de Discord-bot; deelt alleen de pure spelkern.
import '../src/loadEnv.js';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PlaatjeRoom, canHostSkipTurn, shouldDeleteRoom } from '../src/utils/plaatjeGame.js';
import { SHOUT, makeRoomCode, validateName, pickSong, audioSourceFor, magBeurtOverslaan, wachterMoetIngrijpen } from './game.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HITLIJN_PORT ?? 3002);
const ORIGINS = (process.env.HITLIJN_ORIGIN ?? `http://localhost:${PORT}`).split(',').map((s) => s.trim()).filter(Boolean);
const POOLS_FILE = join(__dirname, 'data/pools.json');

const app = express();
app.use(express.static(join(__dirname, 'public')));
app.get('/gezondheid', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? null, shout: SHOUT, soloBeschikbaar: true }));
// Spotify PKCE-redirect landt op de pagina zelf
app.get('/callback', (req, res) => res.sendFile(join(__dirname, 'public/index.html')));

function laadPools() {
  if (!existsSync(POOLS_FILE)) return [];
  try { return JSON.parse(readFileSync(POOLS_FILE, 'utf8')).pools ?? []; } catch { return []; }
}

// ── kamers ─────────────────────────────────────────────────────────────────
const rooms = new Map();       // code -> { room: PlaatjeRoom, poolId, usedIds:Set, timer, born, spotifyIdVoorRonde, previewVoorRonde }
const clients = new Map();     // code -> Set<ws>
const timers = new Map();      // code -> Timeout (fase-timer)
const emptyTimers = new Map(); // code -> Timeout
const skipTimers = new Map();  // code -> Timeout (auto-skip van een weggevallen actieve speler)
const rondeLatch = new Set();  // code -> startRonde in-flight (voorkomt dubbele Deezer-fetch)

// simpele sliding-window rate limiter per IP
const hits = new Map();
function rateLimit(ip, naam, max, vensterMs) {
  const key = `${naam}:${ip}`;
  const nu = Date.now();
  const lijst = (hits.get(key) ?? []).filter((t) => nu - t < vensterMs);
  if (lijst.length >= max) { hits.set(key, lijst); return false; }
  lijst.push(nu); hits.set(key, lijst); return true;
}

function broadcast(code, type, data = {}) {
  const set = clients.get(code); if (!set) return;
  const msg = JSON.stringify({ type, ...data });
  for (const c of set) if (c.readyState === 1) c.send(msg);
}
function broadcastState(code) {
  const k = rooms.get(code); if (k) broadcast(code, 'hl:state', { room: k.room.publicState() });
}
function clearTimer(code) { const t = timers.get(code); if (t) { clearTimeout(t); timers.delete(code); } }
function setTimer(code, ms, fn) { clearTimer(code); timers.set(code, setTimeout(() => { timers.delete(code); fn(); }, ms)); }

function destroyRoom(code) {
  broadcast(code, 'hl:error', { message: 'Deze tafel is gesloten.' });
  clearTimer(code);
  clearAutoSkip(code);
  const t = emptyTimers.get(code); if (t) { clearTimeout(t); emptyTimers.delete(code); }
  rooms.delete(code);
}

// ── auto-skip: een weggevallen actieve speler houdt het spel niet gijzeld ──
// De luisterfase wacht op een menselijke actie (kaart leggen); valt die speler weg, dan
// slaat de server zijn beurt na een respijt zelf over. Alle checks gebeuren pas op het
// moment van vuren — terugkomen, alsnog leggen of een doorgedraaide beurt maken de timer
// vanzelf een no-op. Eén timer per kamer volstaat: er is maar één actieve speler.
function clearAutoSkip(code) { const t = skipTimers.get(code); if (t) { clearTimeout(t); skipTimers.delete(code); } }
function armAutoSkip(code, playerId, wachtMs) {
  clearAutoSkip(code);
  skipTimers.set(code, setTimeout(() => probeerAutoSkip(code, playerId), wachtMs));
}
function probeerAutoSkip(code, playerId) {
  skipTimers.delete(code);
  const k = rooms.get(code); if (!k) return;
  if (k.room.phase === 'loading') {
    // startRonde is nog bezig (Deezer-fetch); zo dadelijk is het 'listening' — even opnieuw kijken
    skipTimers.set(code, setTimeout(() => probeerAutoSkip(code, playerId), 5000));
    return;
  }
  if (!magBeurtOverslaan(k.room, playerId)) return;
  const naam = k.room.players.get(playerId)?.displayName ?? '?';
  clearTimer(code);
  k.room.round = null;
  k.spotifyIdVoorRonde = null;
  k.previewVoorRonde = null;
  k.room.nextTurn();
  // reden weglaten: de eerdere melding (verlaten / verbinding verloren) zei al waarom
  broadcast(code, 'hl:notice', { message: `Beurt van ${naam} overgeslagen` });
  broadcastState(code);
  startRonde(code);
}

function armEmptyTimer(code) {
  const k = rooms.get(code);
  if (!k || k.room.emptySince == null || emptyTimers.has(code)) return;
  emptyTimers.set(code, setTimeout(() => {
    emptyTimers.delete(code);
    const kk = rooms.get(code);
    if (kk && shouldDeleteRoom({ emptySinceMs: kk.room.emptySince, nowMs: Date.now() })) destroyRoom(code);
  }, 5 * 60_000 + 1000));
}

// wachter (30s): een luisterronde die al liep voor een speler die wegviel heeft geen
// disconnect-event meer dat de auto-skip-timer zet — deze sweep vangt dat structureel.
// Respijt telt vanaf het echte disconnect-moment, met een kleine ondergrens.
setInterval(() => {
  for (const [code, k] of rooms) {
    if (skipTimers.has(code) || !wachterMoetIngrijpen(k.room)) continue;
    const actief = k.room.players.get(k.room.activeUserId);
    const alWegMs = Date.now() - (actief.disconnectedAt ?? Date.now());
    armAutoSkip(code, k.room.activeUserId, Math.max(5_000, 60_000 - alWegMs));
  }
}, 30_000);

// absolute levensduur: elke 30 min vegen (+ grove opruiming van de rate-limit-hits,
// anders groeit die Map onbegrensd met keys voor allang inactieve ip:actie-paren)
setInterval(() => {
  const nu = Date.now();
  for (const [code, k] of rooms) if (nu - k.born > 12 * 3600_000) destroyRoom(code);
  for (const [key, lijst] of hits) {
    const jongste = lijst[lijst.length - 1] ?? 0;
    if (nu - jongste > 10 * 60_000) hits.delete(key);
  }
}, 30 * 60_000);

// ── rondemotor: geen bestanden, alleen berichtjes ──────────────────────────
// Deezer-preview-URL's zijn gesigneerd en verlopen; pools.json bewaart daarom het
// deezerId en de server haalt per ronde een verse preview-link op (met de
// opgeslagen build-time-URL als fallback bij een API-hapering).
async function versePreview(song) {
  if (!song.deezerId) return song.previewUrl ?? null;
  try {
    const res = await fetch(`https://api.deezer.com/track/${song.deezerId}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return song.previewUrl ?? null;
    const data = await res.json();
    return data.preview || song.previewUrl || null;
  } catch { return song.previewUrl ?? null; }
}

async function startRonde(code) {
  if (rondeLatch.has(code)) return; // dubbele trigger (bv. host-skip 2x snel) niet opnieuw starten
  rondeLatch.add(code);
  try {
    const k = rooms.get(code);
    if (!k || k.room.phase !== 'loading') return;
    const pool = laadPools().find((p) => p.id === k.poolId);
    const song = pool ? pickSong(pool.songs, k.usedIds) : null;
    if (!song) {
      broadcast(code, 'hl:error', { message: 'De songpool is leeg — spel voorbij.' });
      k.room.phase = 'finished';
      broadcastState(code);
      return;
    }
    const previewUrl = await versePreview(song);
    const kNa = rooms.get(code);
    if (kNa !== k || k.room.phase !== 'loading') return; // kamer weg of ingehaald tijdens await
    song.previewUrl = previewUrl;
    k.usedIds.add(song.id);
    k.room.beginRound({ title: song.title, artist: song.artist, year: song.year, youtubeId: song.id.slice(0, 11).padEnd(11, 'x') }, 0);
    k.spotifyIdVoorRonde = song.spotifyId ?? null;
    k.previewVoorRonde = previewUrl;
    const nonce = k.room.round.nonce;
    broadcastState(code);
    const set = clients.get(code) ?? new Set();
    for (const c of set) {
      if (c.readyState !== 1) continue;
      const bron = audioSourceFor({ mode: c.audioMode ?? 'preview', spotifyOk: Boolean(song.spotifyId), previewUrl: song.previewUrl });
      const payload = { type: 'hl:round', nonce, previewUrl: song.previewUrl ?? null };
      if (bron === 'spotify') payload.spotifyId = song.spotifyId;
      c.send(JSON.stringify(payload));
    }
  } finally {
    rondeLatch.delete(code);
  }
}

function scheduleReveal(code) {
  const k = rooms.get(code);
  if (!k || k.room.phase !== 'challenge') return;
  const nonce = k.room.round?.nonce;
  // solo: niemand om uit te dagen, dus geen 7s-venster — korte adempauze en onthullen
  setTimer(code, k.room.settings.solo ? 1500 : 7000, () => {
    const kk = rooms.get(code);
    if (!kk || kk.room.phase !== 'challenge' || kk.room.round?.nonce !== nonce) return;
    doeReveal(code);
  });
}

function doeReveal(code) {
  const k = rooms.get(code); if (!k) return;
  const reveal = k.room.resolveReveal();
  if (!reveal) return;
  broadcast(code, 'hl:reveal', reveal);
  k.spotifyIdVoorRonde = null;
  k.previewVoorRonde = null;
  broadcastState(code);
  if (k.room.phase === 'finished') {
    broadcast(code, 'hl:game:over', { winnerId: k.room.winnerId, room: k.room.publicState() });
    return;
  }
  setTimer(code, 6000, () => {
    const kk = rooms.get(code);
    if (!kk || kk.room.phase !== 'reveal') return;
    kk.room.nextTurn();
    broadcastState(code);
    startRonde(code);
  });
}

// ── WS ─────────────────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

// Origin exact-match, geen prefix: 'http://localhost.evil.com' zou anders ook door een
// startsWith-check komen. Dit verdedigt alleen tegen browser-gemedieerd (CSRF-achtig)
// misbruik — niet-browser clients sturen vaak geen Origin en worden door de rate limits geremd.
const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

// XFF wordt alleen vertrouwd als de directe peer localhost is (nginx op dezelfde machine);
// nginx *append* het echte client-IP achteraan een eventuele door de aanvaller meegestuurde
// lijst, dus het rechtste element is altijd wat nginx zelf zag.
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '';
  const lokaal = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const xff = req.headers['x-forwarded-for'];
  if (lokaal && typeof xff === 'string' && xff.length) return xff.split(',').pop().trim();
  return peer;
}

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin ?? '';
  if (origin && !ORIGINS.includes(origin) && !LOCALHOST_ORIGIN.test(origin)) { ws.close(); return; }
  ws.ip = clientIp(req);

  const perIp = [...wss.clients].filter((c) => c.ip === ws.ip).length;
  if (perIp > 20 || wss.clients.size > 500) { ws.close(); return; }

  ws.on('message', (raw) => {
    let data; try { data = JSON.parse(raw); } catch { return; }
    try { afhandelen(ws, data); } catch (err) { console.error('[hitlijn] handler:', err); }
  });
  ws.on('close', () => {
    const code = ws.roomCode; if (!code) return;
    const set = clients.get(code);
    if (set) { set.delete(ws); if (!set.size) clients.delete(code); }
    const k = rooms.get(code); if (!k) return;
    const nogEen = set && [...set].some((c) => c.playerId === ws.playerId && c.readyState === 1);
    if (!nogEen) {
      k.room.markDisconnected(ws.playerId, Date.now());
      const speler = k.room.players.get(ws.playerId);
      if (speler && k.room.phase !== 'lobby' && k.room.phase !== 'finished') {
        broadcast(code, 'hl:notice', { message: `${speler.displayName} is de verbinding verloren` });
        if (k.room.activeUserId === ws.playerId) armAutoSkip(code, ws.playerId, 60_000);
      }
      broadcastState(code);
      armEmptyTimer(code);
    }
  });
});

function stuur(ws, type, data = {}) { ws.send(JSON.stringify({ type, ...data })); }
function fout(ws, message) { stuur(ws, 'hl:error', { message }); }

function afhandelen(ws, data) {
  switch (data.type) {
    // playerId is een client-gegenereerde, ongokbare uuid zonder token-binding: wie
    // andermans id kent kan die speler overnemen. Geaccepteerd voor een accountloos
    // feestspel (zelfde model als de kamercode zelf).
    case 'hl:hello': {
      const naam = validateName(data.name);
      if (!naam || typeof data.playerId !== 'string' || data.playerId.length < 8 || data.playerId.length > 64) return fout(ws, 'Vul een naam van 2-20 tekens in');
      ws.playerId = data.playerId; ws.naam = naam;
      stuur(ws, 'hl:hello:ok', { pools: laadPools().map((p) => ({ id: p.id, name: p.name, count: p.songs.length })) });
      break;
    }
    case 'hl:audio:mode': {
      ws.audioMode = data.mode === 'spotify' ? 'spotify' : 'preview';
      break;
    }
    case 'hl:room:create': {
      if (!ws.playerId) return fout(ws, 'Eerst je naam doorgeven');
      if (!rateLimit(ws.ip, 'create', 5, 60_000)) return fout(ws, 'Rustig aan — probeer het zo weer');
      const code = makeRoomCode(new Set(rooms.keys()));
      const room = new PlaatjeRoom(code, { id: ws.playerId, displayName: ws.naam, avatar: null }, { cardsToWin: data.cardsToWin, solo: data.solo === true });
      rooms.set(code, { room, poolId: null, usedIds: new Set(), born: Date.now(), spotifyIdVoorRonde: null, previewVoorRonde: null });
      ws.roomCode = code;
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(ws);
      stuur(ws, 'hl:room:joined', { room: room.publicState(), you: { id: ws.playerId, isSpectator: false } });
      break;
    }
    case 'hl:room:join': {
      if (!ws.playerId) return fout(ws, 'Eerst je naam doorgeven');
      if (!rateLimit(ws.ip, 'join', 20, 60_000)) return fout(ws, 'Rustig aan — probeer het zo weer');
      const code = String(data.code ?? '').toUpperCase().trim();
      const k = rooms.get(code);
      if (!k) return fout(ws, 'Kamer niet gevonden — check de code');
      // solo-potjes zijn privé: alleen de eigenaar zelf mag er (opnieuw) in
      if (k.room.settings.solo && !k.room.players.has(ws.playerId)) {
        return fout(ws, 'Dit is een solo-potje — maak zelf een kamer aan');
      }
      const wasWeg = k.room.players.get(ws.playerId)?.connected === false;
      const { isSpectator } = k.room.addPlayer({ id: ws.playerId, displayName: ws.naam, avatar: null });
      if (wasWeg && k.room.phase !== 'lobby') broadcast(code, 'hl:notice', { message: `${ws.naam} is terug!` });
      ws.roomCode = code;
      if (!clients.has(code)) clients.set(code, new Set());
      clients.get(code).add(ws);
      const t = emptyTimers.get(code); if (t) { clearTimeout(t); emptyTimers.delete(code); }
      stuur(ws, 'hl:room:joined', { room: k.room.publicState(), you: { id: ws.playerId, isSpectator } });
      broadcastState(code);
      // (Re)joiners tijdens listening/challenge misten anders de rondeaudio tot de volgende ronde:
      // hl:round werd alleen bij startRonde() gebroadcast, nooit ingehaald voor wie later binnenkomt.
      // ws.audioMode staat hier al vast — de client stuurt hl:audio:mode vlak na hl:hello, vóór
      // hl:room:join (zie bootstrap() in public/index.html), dus dat bericht is al verwerkt.
      if ((k.room.phase === 'listening' || k.room.phase === 'challenge') && k.room.round) {
        const bron = audioSourceFor({ mode: ws.audioMode ?? 'preview', spotifyOk: Boolean(k.spotifyIdVoorRonde), previewUrl: k.previewVoorRonde });
        const payload = { type: 'hl:round', nonce: k.room.round.nonce, previewUrl: k.previewVoorRonde ?? null };
        if (bron === 'spotify') payload.spotifyId = k.spotifyIdVoorRonde;
        ws.send(JSON.stringify(payload));
      }
      break;
    }
    case 'hl:room:leave': {
      const code = ws.roomCode; ws.roomCode = null;
      const k = rooms.get(code); if (!k) break;
      clients.get(code)?.delete(ws);
      const wasSpeler = k.room.players.has(ws.playerId);
      k.room.removePlayer(ws.playerId);
      if (k.room.phase === 'lobby' && !k.room.players.size) destroyRoom(code);
      else {
        if (wasSpeler && k.room.phase !== 'lobby' && k.room.phase !== 'finished') {
          broadcast(code, 'hl:notice', { message: `${ws.naam ?? '?'} heeft de tafel verlaten` });
          // bewust vertrokken: korter respijt dan de 60s voor een verbroken verbinding
          if (k.room.activeUserId === ws.playerId) armAutoSkip(code, ws.playerId, 10_000);
        }
        broadcastState(code);
        armEmptyTimer(code);
      }
      break;
    }
    case 'hl:game:start': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      if (ws.playerId !== k.room.hostId) return fout(ws, 'Alleen de host kan starten');
      const pool = laadPools().find((p) => p.id === data.poolId);
      if (!pool) return fout(ws, 'Kies een songpool');
      if (pool.songs.length < k.room.players.size + 1) return fout(ws, 'Songpool te klein voor dit aantal spelers');
      k.poolId = pool.id;
      let started;
      try {
        started = k.room.start(() => {
          const s = pickSong(pool.songs, k.usedIds);
          if (!s) throw new Error('pool leeg');
          k.usedIds.add(s.id);
          return { title: s.title, artist: s.artist, year: s.year, youtubeId: s.id.slice(0, 11).padEnd(11, 'x') };
        });
      } catch { return fout(ws, 'Starten mislukt — songpool te klein'); }
      if (!started.ok) return fout(ws, k.room.settings.solo ? 'Starten mislukt' : 'Minimaal 2 spelers nodig');
      startRonde(ws.roomCode);
      break;
    }
    case 'hl:turn:place': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      const r = k.room.place(ws.playerId, data.slot);
      if (!r.ok) return fout(ws, 'Leggen kan nu niet');
      broadcastState(ws.roomCode);
      scheduleReveal(ws.roomCode);
      break;
    }
    case 'hl:turn:guess': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      const r = k.room.recordGuess(ws.playerId, data.artist, data.title);
      if (!r.ok) return fout(ws, 'Gokken kan nu niet');
      broadcastState(ws.roomCode);
      break;
    }
    case 'hl:turn:swap': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      const r = k.room.paySwap(ws.playerId);
      if (!r.ok) return fout(ws, r.reason ?? 'Wisselen kan nu niet');
      k.room.phase = 'loading';
      broadcastState(ws.roomCode);
      startRonde(ws.roomCode);
      break;
    }
    case 'hl:challenge': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      const r = k.room.challenge(ws.playerId, data.slot, Date.now());
      if (!r.ok) return fout(ws, r.reason ?? 'Uitdagen kan nu niet');
      broadcastState(ws.roomCode);
      break;
    }
    case 'hl:host:skipTurn': {
      const k = rooms.get(ws.roomCode); if (!k) break;
      if (ws.playerId !== k.room.hostId) return fout(ws, 'Alleen de host kan dit');
      if (!rateLimit(ws.ip, 'skip', 10, 60_000)) return fout(ws, 'Rustig aan');
      const actief = k.room.players.get(k.room.activeUserId);
      if (!actief || actief.connected || !canHostSkipTurn({ disconnectedAtMs: actief.disconnectedAt, nowMs: Date.now() })) {
        return fout(ws, 'De actieve speler is (nog) niet 60s weg');
      }
      clearTimer(ws.roomCode);
      k.room.round = null;
      k.spotifyIdVoorRonde = null;
      k.previewVoorRonde = null;
      k.room.nextTurn();
      broadcastState(ws.roomCode);
      startRonde(ws.roomCode);
      break;
    }
    default: break;
  }
}

server.listen(PORT, () => console.log(`[hitlijn] draait op :${PORT} (origins: ${ORIGINS.join(', ')})`));

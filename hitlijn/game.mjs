// hitlijn/game.mjs — pure logica voor HITLIJN. Geen IO.
import { normalizeField, similarity } from '../src/utils/plaatjeText.js';

// De steelroep. Eén plek; hernoemen van de kreet = deze regel + UI-copy die hem toont.
export const SHOUT = 'HITLIJN!';

const CODE_ALFABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // geen I/O: verwarring met 1/0 voorkomen

export function makeRoomCode(bestaande) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_ALFABET[Math.floor(Math.random() * CODE_ALFABET.length)];
    if (!bestaande.has(code)) return code;
  }
}

export function validateName(raw) {
  if (typeof raw !== 'string') return null;
  const schoon = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (schoon.length < 2 || schoon.length > 20) return null;
  return schoon;
}

export function songKey(song) {
  return `${normalizeField(song.artist)}|${normalizeField(song.title)}`;
}

export function dedupeSongs(songs) {
  const gezien = new Set();
  const uit = [];
  for (const s of songs) {
    const key = songKey(s);
    if (gezien.has(key)) continue;
    gezien.add(key);
    uit.push(s);
  }
  return uit;
}

export function themeFor(song) {
  if (song.year < 1980) return 'tijdperk-60-70';
  if (song.year < 2000) return 'tijdperk-80-90';
  return 'tijdperk-00-nu';
}

export function pickSong(songs, usedIds) {
  const kandidaten = songs.filter((s) => !usedIds.has(s.id));
  if (!kandidaten.length) return null;
  return kandidaten[Math.floor(Math.random() * kandidaten.length)];
}

export function audioSourceFor({ mode, spotifyOk, previewUrl }) {
  if (mode === 'spotify' && spotifyOk) return 'spotify';
  if (previewUrl) return 'preview';
  return 'skip';
}

const MATCH = 0.7;

// Streaming titels dragen vaak een " - Remastered YYYY" / " - Live" / " - Single Version"
// staart die normalizeField niet wegknipt (die strip alleen haakjes-inhoud). Ook de kale
// titel vóór het streepje proberen voorkomt dat zulke titels de fuzzy-match missen.
function titelVarianten(titel) {
  const heel = normalizeField(titel);
  const kaal = normalizeField(String(titel ?? '').split(/\s+-\s+/)[0]);
  return heel === kaal ? [heel] : [heel, kaal];
}

function titelMatch(hitTitel, songTitel) {
  const doel = normalizeField(songTitel);
  return titelVarianten(hitTitel).some((variant) => similarity(variant, doel) >= MATCH);
}

export function beoordeelDeezerHit(hit, song) {
  if (!hit?.artist?.name || !hit?.title) return false;
  return similarity(normalizeField(hit.artist.name), normalizeField(song.artist)) >= MATCH
    && titelMatch(hit.title, song.title);
}

export function beoordeelSpotifyHit(item, song) {
  if (!item?.name || !item?.artists?.[0]?.name) return false;
  return similarity(normalizeField(item.artists[0].name), normalizeField(song.artist)) >= MATCH
    && titelMatch(item.name, song.title);
}

// Retry-beslissing voor resolve-pools.mjs: een ontbrekende waarde die nog niet definitief
// is vastgesteld (een API-fout, geen definitieve no-match) mag opnieuw geprobeerd worden;
// een definitieve no-match niet, om diezelfde miss niet elke hervatting te herhalen.
export function moetOpnieuwZoeken({ waarde, definitief }) {
  return waarde == null && !definitief;
}

// Beslist of de server de beurt van een weggevallen actieve speler mag overslaan.
// Alleen in de luisterfase: dat is de enige fase die op een menselijke actie (kaart
// leggen) wacht — challenge/reveal lopen op eigen timers door en halen zichzelf in.
export function magBeurtOverslaan(room, playerId) {
  const p = room.players.get(playerId);
  return Boolean(p) && !p.connected
    && room.activeUserId === playerId
    && room.phase === 'listening';
}

// Wachter-beslissing: loopt er een luisterronde voor een speler die weg is, terwijl er
// nog wél publiek wacht? Vangt de paden waar geen disconnect-event de skip-timer zette
// (bv. collectieve wifi-dip waarna één speler terugkeert — de ronde was toen al gestart).
export function wachterMoetIngrijpen(room) {
  const actief = room.players.get(room.activeUserId);
  if (!actief || actief.connected || room.phase !== 'listening') return false;
  return [...room.players.values()].some((p) => p.connected) || room.spectators.size > 0;
}

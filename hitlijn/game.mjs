// hitlijn/game.mjs — pure logica voor HITLIJN. Geen IO.
import { normalizeField } from '../src/utils/plaatjeText.js';

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

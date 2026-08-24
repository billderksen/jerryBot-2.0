// src/utils/plaatjeText.js
// Tekstlogica voor PLAATJE: gok-beoordeling (artiest+titel) en playlist-import-parsing.
// Puur — geen IO, geen imports.

export function normalizeField(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|de|het|een) /, '');
}

// Als normalizeField, maar de ínhoud van haakjes blijft staan — wie "(I Like It)"
// meegokt mag niet slechter af zijn dan wie het weglaat.
function normalizeMetHaakjesInhoud(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|de|het|een) /, '');
}

// Titelvarianten: mét en zonder catalogus-achtervoegsel (" - 2004 Remaster") — de
// beste match telt, dus een variant erbij kan nooit een goede gok afkeuren.
export function titelVarianten(raw) {
  const s = String(raw ?? '');
  const varianten = [s];
  const kaal = s.split(/\s+[-–—]\s+/)[0].trim();
  if (kaal && kaal !== s) varianten.push(kaal);
  return varianten;
}

// Artiestvarianten: de volledige naam plus elke afzonderlijke artiest — hoofdartiest
// (of een van de feat-artiesten) raden is goed, zoals in het officiële spel.
// Splitsers vereisen omliggende spaties, anders zou 'ft' binnen een woord splitsen.
export function artiestVarianten(raw) {
  const s = String(raw ?? '');
  const varianten = [s];
  for (const deel of s.split(/\s+(?:feat\.?|ft\.?|featuring|met|x)\s+|\s*[,&+]\s*/i)) {
    const d = deel.trim();
    if (d && d !== s) varianten.push(d);
  }
  return varianten;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

const MATCH_THRESHOLD = 0.8;

// Eén veld beoordelen tegen alle varianten, elk in beide normalisaties. Naast de
// procentuele drempel geldt een absolute coulance: één letterfout is altijd goed —
// de drempel is voor korte titels anders onhaalbaar streng (1 fout op 4 letters = 25%).
function veldMatch(gok, doelVarianten) {
  for (const norm of [normalizeField, normalizeMetHaakjesInhoud]) {
    const g = norm(gok);
    if (!g) continue;
    for (const variant of doelVarianten) {
      const d = norm(variant);
      if (!d) continue;
      if (similarity(g, d) >= MATCH_THRESHOLD) return true;
      if (g.length >= 3 && levenshtein(g, d) <= 1) return true;
    }
  }
  return false;
}

export function matchGuess({ artist, title }, song) {
  return veldMatch(artist, artiestVarianten(song.artist))
    && veldMatch(title, titelVarianten(song.title));
}

export function parseVideoTitle(raw) {
  const cleaned = String(raw ?? '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: cleaned };
}

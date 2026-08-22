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
    .replace(/^the /, '');
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

export function matchGuess({ artist, title }, song) {
  return similarity(normalizeField(artist), normalizeField(song.artist)) >= MATCH_THRESHOLD
    && similarity(normalizeField(title), normalizeField(song.title)) >= MATCH_THRESHOLD;
}

export function parseVideoTitle(raw) {
  const cleaned = String(raw ?? '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  return { artist: '', title: cleaned };
}

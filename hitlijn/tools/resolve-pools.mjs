// hitlijn/tools/resolve-pools.mjs
// Bouwt hitlijn/data/pools.json uit de bron-metadata: Deezer-preview (verplicht gezocht)
// + Spotify-track-id (alleen als SPOTIFY_CLIENT_ID/SECRET in .env staan). Hervatbaar:
// resolve-state per song in hitlijn/tools/resolve-state.json. Beleefd: ~1 verzoek/seconde.
// Draaien: node hitlijn/tools/resolve-pools.mjs [--limit N]
import '../../src/loadEnv.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dedupeSongs, themeFor, songKey, beoordeelDeezerHit, beoordeelSpotifyHit } from '../game.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../..');
const STATE_FILE = join(__dirname, 'resolve-state.json');
const OUT_FILE = join(REPO, 'hitlijn/data/pools.json');
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function laadBronnen() {
  const basis = JSON.parse(readFileSync(join(REPO, 'data/hitsterSongs.json'), 'utf8')).songs
    .map((s) => ({ artist: s.artist, title: s.title, year: s.year, bron: 'basis' }));
  const decks = ['hitster-original-nl', 'hitster-guilty-pleasures-nl', 'hitster-summer-party-nl'];
  const uitDecks = decks.flatMap((naam) => {
    const pad = join(__dirname, 'decks', `${naam}.json`);
    if (!existsSync(pad)) { console.log(`(deck ontbreekt: ${naam})`); return []; }
    return JSON.parse(readFileSync(pad, 'utf8')).songs.map((s) => ({ ...s, bron: naam }));
  });
  return dedupeSongs([...uitDecks, ...basis]); // decks eerst: hun (kaart)jaar wint bij dubbelen
}

async function spotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64') },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) { console.log(`Spotify-token mislukt (${res.status}) — ids overslaan`); return null; }
  return (await res.json()).access_token;
}

async function zoekDeezer(song) {
  const q = encodeURIComponent(`artist:"${song.artist}" track:"${song.title}"`);
  const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=5`);
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data.data ?? []).find((h) => beoordeelDeezerHit(h, song) && h.preview);
  return hit ? { previewUrl: hit.preview } : null;
}

async function zoekSpotify(song, token) {
  if (!token) return null;
  const q = encodeURIComponent(`artist:${song.artist} track:${song.title}`);
  const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=5&q=${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const hit = (data.tracks?.items ?? []).find((i) => beoordeelSpotifyHit(i, song));
  return hit ? { spotifyId: hit.id } : null;
}

const songs = laadBronnen();
console.log(`${songs.length} unieke songs uit alle bronnen`);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const token = await spotifyToken();
let n = 0, zonder = [];

for (const song of songs) {
  if (n >= LIMIT) break;
  const key = songKey(song);
  if (!state[key]) {
    n++;
    const deezer = await zoekDeezer(song); await sleep(1000);
    const spotify = await zoekSpotify(song, token); if (token) await sleep(300);
    state[key] = { ...song, id: key, previewUrl: deezer?.previewUrl ?? null, spotifyId: spotify?.spotifyId ?? null };
    writeFileSync(STATE_FILE, JSON.stringify(state));
    if (n % 25 === 0) console.log(`${n} songs geresolved…`);
  } else if (token && state[key].spotifyId == null) {
    // tweede run mét creds: alleen ontbrekende spotifyIds bijvullen
    n++;
    const spotify = await zoekSpotify(song, token); await sleep(300);
    if (spotify) { state[key].spotifyId = spotify.spotifyId; writeFileSync(STATE_FILE, JSON.stringify(state)); }
  }
}

const bruikbaar = Object.values(state).filter((s) => s.previewUrl || s.spotifyId);
zonder = Object.values(state).filter((s) => !s.previewUrl && !s.spotifyId).map((s) => `${s.artist} — ${s.title}`);
const pools = [
  { id: 'tijdperk-60-70', name: '60s & 70s', songs: [] },
  { id: 'tijdperk-80-90', name: '80s & 90s', songs: [] },
  { id: 'tijdperk-00-nu', name: '00s & nu', songs: [] },
  { id: 'feest-fout', name: 'Feest & Fout', songs: [] },
];
for (const s of bruikbaar) {
  const kaal = { id: s.id, artist: s.artist, title: s.title, year: s.year, previewUrl: s.previewUrl, spotifyId: s.spotifyId };
  pools.find((p) => p.id === themeFor(s)).songs.push(kaal);
  if (s.bron === 'hitster-guilty-pleasures-nl') pools.find((p) => p.id === 'feest-fout').songs.push(kaal);
}
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE + '.tmp', JSON.stringify({ pools }, null, 1));
renameSync(OUT_FILE + '.tmp', OUT_FILE);
console.log(`pools.json: ${pools.map((p) => `${p.id}=${p.songs.length}`).join(', ')}; zonder audio: ${zonder.length}`);
if (zonder.length) writeFileSync(join(__dirname, 'zonder-audio.txt'), zonder.join('\n'));

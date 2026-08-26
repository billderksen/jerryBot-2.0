// hitlijn/tools/resolve-pools.mjs
// Bouwt hitlijn/data/pools.json uit de bron-metadata: Deezer-preview (verplicht gezocht)
// + Spotify-track-id (alleen als SPOTIFY_CLIENT_ID/SECRET in .env staan). Hervatbaar:
// resolve-state per song in hitlijn/tools/resolve-state.json. Beleefd: ~1 verzoek/seconde.
// Draaien: node hitlijn/tools/resolve-pools.mjs [--limit N]
import '../../src/loadEnv.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  dedupeSongs, themeFor, songKey, beoordeelDeezerHit, beoordeelSpotifyHit, moetOpnieuwZoeken,
} from '../game.mjs';

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
  // Op de RUWE Guilty-Pleasures-lijst bijhouden, niet na dedupeSongs: een GP-song die ook in
  // het Original-deck zit verliest van dedupe (dat wint eerst), maar hoort toch in feest-fout.
  const gpKeys = new Set();
  const spKeys = new Set();   // Summer Party — eigen pool 'Zomerparty'
  const origKeys = new Set(); // basisspel-deck — eigen pool 'Origineel'
  const uitDecks = decks.flatMap((naam) => {
    const pad = join(__dirname, 'decks', `${naam}.json`);
    if (!existsSync(pad)) { console.log(`(deck ontbreekt: ${naam})`); return []; }
    const songs = JSON.parse(readFileSync(pad, 'utf8')).songs.map((s) => ({ ...s, bron: naam }));
    if (naam === 'hitster-guilty-pleasures-nl') songs.forEach((s) => gpKeys.add(songKey(s)));
    if (naam === 'hitster-summer-party-nl') songs.forEach((s) => spKeys.add(songKey(s)));
    if (naam === 'hitster-original-nl') songs.forEach((s) => origKeys.add(songKey(s)));
    return songs;
  });
  // Jaartal-correctielaag (maak-jaarcorrecties.mjs): gescrapete decks dragen soms het
  // heruitgavejaar. Vóór dedupe toegepast, zodat elke variant het juiste jaar krijgt.
  const corrPad = join(__dirname, 'jaar-correcties.json');
  const corr = existsSync(corrPad) ? JSON.parse(readFileSync(corrPad, 'utf8')).correcties ?? {} : {};
  const gecorrigeerd = [...uitDecks, ...basis].map((s) => {
    const c = corr[songKey(s)];
    return c && Number.isFinite(c.jaar) ? { ...s, year: c.jaar } : s;
  });
  if (Object.keys(corr).length) console.log(`(${Object.keys(corr).length} jaartal-correcties toegepast)`);
  return { songs: dedupeSongs(gecorrigeerd), gpKeys, spKeys, origKeys }; // decks eerst: hun (kaart)jaar wint bij dubbelen
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

// Beide zoekers geven drie uitkomsten: { previewUrl/spotifyId } bij een geslaagde hit,
// false bij een definitieve no-match (API antwoordde ok, niets voldeed), null bij een fout
// (netwerk/status) — alleen bij null mag een latere run het opnieuw proberen. Bij een fout
// alleen songKey + status/foutmelding loggen, nooit de response-body.
//
// deezerId (het track-id) wordt naast previewUrl bewaard: de dzcdn-previewUrl is een
// hmac/exp-signed link die binnen dagen verloopt, dus de gameserver haalt 'm per ronde
// vers op via GET /track/{id}. previewUrl blijft staan als build-time fallback.

async function zoekDeezer(song) {
  const q = encodeURIComponent(`artist:"${song.artist}" track:"${song.title}"`);
  try {
    const res = await fetch(`https://api.deezer.com/search?q=${q}&limit=5`);
    if (!res.ok) { console.log(`Deezer-fout (${res.status}) voor ${songKey(song)}`); return null; }
    const data = await res.json();
    const hit = (data.data ?? []).find((h) => beoordeelDeezerHit(h, song) && h.preview);
    return hit ? { previewUrl: hit.preview, deezerId: hit.id } : false;
  } catch (err) {
    console.log(`Deezer-fout (${err.message}) voor ${songKey(song)}`);
    return null;
  }
}

async function zoekSpotify(song, token) {
  if (!token) return null;
  const q = encodeURIComponent(`artist:${song.artist} track:${song.title}`);
  try {
    const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=5&q=${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) { console.log(`Spotify-fout (${res.status}) voor ${songKey(song)}`); return null; }
    const data = await res.json();
    const hit = (data.tracks?.items ?? []).find((i) => beoordeelSpotifyHit(i, song));
    return hit ? { spotifyId: hit.id } : false;
  } catch (err) {
    console.log(`Spotify-fout (${err.message}) voor ${songKey(song)}`);
    return null;
  }
}

const { songs, gpKeys, spKeys, origKeys } = laadBronnen();
console.log(`${songs.length} unieke songs uit alle bronnen`);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
// instelbaar tempo: de Spotify-app deelt zijn quotum met de muziekspeler van de bot —
// een rustiger herkansing (bv. RESOLVE_SLEEP_MS=650) voorkomt de 429-golf van de eerste run
const SPOTIFY_SLEEP_MS = Number(process.env.RESOLVE_SLEEP_MS ?? 300);
const token = await spotifyToken();
let n = 0, zonder = [];

for (const song of songs) {
  if (n >= LIMIT) break;
  const key = songKey(song);
  // metadata uit de bron (incl. jaartal-correcties) wint altijd van de cache: de cache
  // bewaart alleen de dure zoekresultaten, niet de waarheid over het nummer zelf
  if (state[key] && state[key].year !== song.year) state[key] = { ...state[key], year: song.year };
  if (!state[key]) {
    n++;
    const deezer = await zoekDeezer(song); await sleep(1000);
    const spotify = await zoekSpotify(song, token); if (token) await sleep(SPOTIFY_SLEEP_MS);
    state[key] = {
      ...song, id: key,
      previewUrl: deezer?.previewUrl ?? null, deezerId: deezer?.deezerId ?? null, deezerDefinitief: deezer !== null,
      spotifyId: spotify?.spotifyId ?? null, spotifyDefinitief: spotify !== null,
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
    if (n % 25 === 0) console.log(`${n} songs geresolved…`);
  } else if (moetOpnieuwZoeken({ waarde: state[key].previewUrl, definitief: state[key].deezerDefinitief })) {
    // eerdere poging was een fout (geen definitieve no-match): Deezer opnieuw proberen
    n++;
    const deezer = await zoekDeezer(song); await sleep(1000);
    state[key].previewUrl = deezer?.previewUrl ?? null;
    state[key].deezerId = deezer?.deezerId ?? null;
    state[key].deezerDefinitief = deezer !== null;
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } else if (token && moetOpnieuwZoeken({ waarde: state[key].spotifyId, definitief: state[key].spotifyDefinitief })) {
    // tweede run mét creds, of een eerdere Spotify-fout: opnieuw proberen
    n++;
    const spotify = await zoekSpotify(song, token); await sleep(SPOTIFY_SLEEP_MS);
    state[key].spotifyId = spotify?.spotifyId ?? null;
    state[key].spotifyDefinitief = spotify !== null;
    writeFileSync(STATE_FILE, JSON.stringify(state));
  }
}

const bruikbaar = Object.values(state).filter((s) => s.previewUrl || s.spotifyId);
zonder = Object.values(state).filter((s) => !s.previewUrl && !s.spotifyId).map((s) => `${s.artist} — ${s.title}`);
const pools = [
  { id: 'tijdperk-60-70', name: '60s & 70s', songs: [] },
  { id: 'tijdperk-80-90', name: '80s & 90s', songs: [] },
  { id: 'tijdperk-00-nu', name: '00s & nu', songs: [] },
  { id: 'feest-fout', name: 'Feest & Fout', songs: [] },
  { id: 'zomerparty', name: 'Zomerparty', songs: [] },
  { id: 'origineel', name: 'Origineel', songs: [] },
];
for (const s of bruikbaar) {
  const kaal = {
    id: s.id, artist: s.artist, title: s.title, year: s.year,
    previewUrl: s.previewUrl, deezerId: s.deezerId, spotifyId: s.spotifyId,
  };
  pools.find((p) => p.id === themeFor(s)).songs.push(kaal);
  if (gpKeys.has(s.id)) pools.find((p) => p.id === 'feest-fout').songs.push(kaal);
  if (spKeys.has(s.id)) pools.find((p) => p.id === 'zomerparty').songs.push(kaal);
  if (origKeys.has(s.id)) pools.find((p) => p.id === 'origineel').songs.push(kaal);
}
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE + '.tmp', JSON.stringify({ pools }, null, 1));
renameSync(OUT_FILE + '.tmp', OUT_FILE);
console.log(`pools.json: ${pools.map((p) => `${p.id}=${p.songs.length}`).join(', ')}; zonder audio: ${zonder.length}`);
if (zonder.length) writeFileSync(join(__dirname, 'zonder-audio.txt'), zonder.join('\n'));

// hitlijn/tools/check-jaren.mjs
// Controleert het kaartjaar van elk nummer tegen MusicBrainz (eerste uitgave van de
// opname) en schrijft een rapport van afwijkingen. Corrigeert zelf niets — het
// resultaat gaat naar jaar-rapport.json, waarna maak-jaarcorrecties.mjs er een
// correctielaag van maakt die resolve-pools.mjs toepast.
//
// Draaien: node hitlijn/tools/check-jaren.mjs [--limit N]
// Hervatbaar: tussenstand staat in jaar-state.json.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { songKey } from '../game.mjs';
import { normalizeField, similarity } from '../../src/utils/plaatjeText.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../..');
const POOLS = join(REPO, 'hitlijn/data/pools.json');
const STATE = join(__dirname, 'jaar-state.json');
const RAPPORT = join(__dirname, 'jaar-rapport.json');
const LIMIT = process.argv.includes('--limit') ? Number(process.argv[process.argv.indexOf('--limit') + 1]) : Infinity;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// MusicBrainz vraagt om 1 request/seconde en een herkenbare User-Agent.
const UA = 'HITLIJN-jaarcheck/1.0 ( https://hitlijn.nl )';
const PAUZE = 1100;

function unieke(songs) {
  const gezien = new Map();
  for (const s of songs) {
    const k = songKey(s);
    if (!gezien.has(k)) gezien.set(k, { key: k, artist: s.artist, title: s.title, year: s.year });
  }
  return [...gezien.values()];
}

// Eerste uitgavejaar van de opname volgens MusicBrainz. Alleen resultaten die qua
// artiest én titel echt matchen tellen mee; van die set wint het vroegste jaar,
// want dat is de oorspronkelijke uitgave (heropnames/compilaties zijn later).
async function mbJaar(song) {
  const q = `recording:"${song.title.replace(/"/g, '')}" AND artist:"${song.artist.replace(/"/g, '')}"`;
  const url = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(q)}&fmt=json&limit=25`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { fout: `HTTP ${res.status}` };
  const data = await res.json();
  const gWens = normalizeField(song.artist);
  const tWens = normalizeField(song.title);
  let besteJaar = null;
  let bewijs = null;
  for (const rec of data.recordings ?? []) {
    const tOk = similarity(normalizeField(rec.title ?? ''), tWens) >= 0.86;
    if (!tOk) continue;
    const artiesten = (rec['artist-credit'] ?? []).map((a) => normalizeField(a.name ?? a.artist?.name ?? ''));
    const aOk = artiesten.some((a) => a && (similarity(a, gWens) >= 0.8 || gWens.includes(a) || a.includes(gWens)));
    if (!aOk) continue;
    const datums = [rec['first-release-date'], ...(rec.releases ?? []).map((r) => r.date)].filter(Boolean);
    for (const d of datums) {
      const jaar = Number(String(d).slice(0, 4));
      if (!Number.isFinite(jaar) || jaar < 1900 || jaar > new Date().getFullYear()) continue;
      if (besteJaar == null || jaar < besteJaar) { besteJaar = jaar; bewijs = `${rec.title} — ${(rec['artist-credit'] ?? []).map((a) => a.name).join(', ')}`; }
    }
  }
  return besteJaar == null ? { geenTreffer: true } : { jaar: besteJaar, bewijs };
}

const pools = JSON.parse(readFileSync(POOLS, 'utf8')).pools;
const songs = unieke(pools.flatMap((p) => p.songs));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
console.log(`${songs.length} unieke nummers; ${Object.keys(state).length} al gecontroleerd`);

let gedaan = 0;
for (const song of songs) {
  if (state[song.key] || gedaan >= LIMIT) continue;
  try {
    const uitslag = await mbJaar(song);
    state[song.key] = { ...song, ...uitslag, op: new Date().toISOString().slice(0, 10) };
  } catch (e) {
    state[song.key] = { ...song, fout: String(e).slice(0, 120) };
  }
  gedaan++;
  if (gedaan % 25 === 0) {
    writeFileSync(STATE, JSON.stringify(state));
    console.log(`  ${gedaan} gecontroleerd…`);
  }
  await sleep(PAUZE);
}
writeFileSync(STATE, JSON.stringify(state));

const afwijkingen = Object.values(state)
  .filter((s) => Number.isFinite(s.jaar) && Math.abs(s.jaar - s.year) >= 2)
  .sort((a, b) => Math.abs(b.jaar - b.year) - Math.abs(a.jaar - a.year));
const geenTreffer = Object.values(state).filter((s) => s.geenTreffer).length;
const fouten = Object.values(state).filter((s) => s.fout).length;
writeFileSync(RAPPORT, JSON.stringify({ gemaakt: new Date().toISOString(), afwijkingen }, null, 1));
console.log(`\nklaar: ${Object.keys(state).length} gecontroleerd, ${afwijkingen.length} afwijkingen (>=2 jaar), ${geenTreffer} zonder treffer, ${fouten} fouten`);
for (const a of afwijkingen.slice(0, 25)) {
  console.log(`  ${a.year} -> ${a.jaar}  ${a.artist} — ${a.title}`);
}

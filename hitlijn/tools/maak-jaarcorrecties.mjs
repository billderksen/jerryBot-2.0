// hitlijn/tools/maak-jaarcorrecties.mjs
// Bouwt jaar-correcties.json uit onze eigen bronnen. Sommige gescrapete deck-lijsten
// dragen het heruitgave-/compilatiejaar in plaats van het origineel (La Bamba 2016,
// Una Paloma Blanca 2003, ...). Een heruitgave schuift een jaartal altijd naar later,
// nooit naar vroeger — daarom wint bij tegenspraak het vroegste jaar.
//
// Draaien: node hitlijn/tools/maak-jaarcorrecties.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { songKey } from '../game.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '../..');
const UIT = join(__dirname, 'jaar-correcties.json');
const MB_STATE = join(__dirname, 'jaar-state.json'); // optioneel, van check-jaren.mjs

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// losse groepeersleutel: eerste artiestwoord + titel zonder lidwoord, zodat
// 'Una Paloma Blanca' en 'Paloma Blanca' als hetzelfde nummer worden herkend
const groepSleutel = (s) => norm(s.artist).split(' ')[0] + '|' + norm(s.title).replace(/^(una|the|de|het|een|le|la|el)\s+/, '');

const bronnen = {};
for (const f of readdirSync(join(__dirname, 'decks'))) {
  bronnen[f] = JSON.parse(readFileSync(join(__dirname, 'decks', f), 'utf8')).songs;
}
bronnen['hitsterSongs.json'] = JSON.parse(readFileSync(join(REPO, 'data/hitsterSongs.json'), 'utf8')).songs;

const groepen = new Map();
for (const [bron, songs] of Object.entries(bronnen)) {
  for (const s of songs) {
    const g = groepSleutel(s);
    if (!groepen.has(g)) groepen.set(g, []);
    groepen.get(g).push({ ...s, bron, key: songKey(s) });
  }
}

const correcties = {};
let uitBronnen = 0;
for (const lijst of groepen.values()) {
  const jaren = lijst.map((x) => x.year).filter((j) => Number.isFinite(j));
  if (!jaren.length) continue;
  const vroegste = Math.min(...jaren);
  for (const item of lijst) {
    if (item.year > vroegste) {
      correcties[item.key] = { jaar: vroegste, was: item.year, artist: item.artist, title: item.title, reden: `bron-tegenspraak (${lijst.map((x) => x.year).join('/')}), vroegste wint` };
      uitBronnen++;
    }
  }
}

// MusicBrainz-vondsten (indien aanwezig) mogen een jaartal alleen naar VROEGER bijstellen:
// heruitgaven, remasters en bootlegs geven latere datums, dus 'later' is nooit bewijs.
let uitMb = 0;
if (existsSync(MB_STATE)) {
  const mb = JSON.parse(readFileSync(MB_STATE, 'utf8'));
  for (const s of Object.values(mb)) {
    if (!Number.isFinite(s.jaar) || !Number.isFinite(s.year)) continue;
    const doel = correcties[s.key]?.jaar ?? s.year;
    if (s.jaar <= doel - 2) {
      correcties[s.key] = { jaar: s.jaar, was: s.year, artist: s.artist, title: s.title, reden: `musicbrainz eerdere uitgave (${s.bewijs ?? ''})`.trim() };
      uitMb++;
    }
  }
}

writeFileSync(UIT, JSON.stringify({ gemaakt: new Date().toISOString(), correcties }, null, 1));
console.log(`${Object.keys(correcties).length} correcties (${uitBronnen} uit bron-tegenspraak, ${uitMb} uit musicbrainz) -> ${UIT}`);
for (const [k, c] of Object.entries(correcties).slice(0, 20)) {
  console.log(`  ${c.was} -> ${c.jaar}  ${c.artist} — ${c.title}`);
}

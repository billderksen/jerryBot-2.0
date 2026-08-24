import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOUT, makeRoomCode, validateName, dedupeSongs, themeFor, pickSong, audioSourceFor,
  beoordeelDeezerHit, beoordeelSpotifyHit, moetOpnieuwZoeken, magBeurtOverslaan,
} from '../hitlijn/game.mjs';

test('SHOUT is de hernoembare roep-constante', () => {
  assert.equal(SHOUT, 'HITLIJN!');
});

test('makeRoomCode: 5 tekens, veilig alfabet, botst niet met bestaande', () => {
  const bestaand = new Set();
  for (let i = 0; i < 200; i++) {
    const code = makeRoomCode(bestaand);
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
    assert.ok(!bestaand.has(code));
    bestaand.add(code);
  }
});

test('validateName: trim, lengte, control chars', () => {
  assert.equal(validateName('  Ben  '), 'Ben');
  assert.equal(validateName('X'), null);
  assert.equal(validateName('a'.repeat(21)), null);
  assert.equal(validateName('Be\x07n'), 'Ben');
  assert.equal(validateName(null), null);
  assert.equal(validateName('   '), null);
});

test('dedupeSongs: genormaliseerd op artiest+titel, eerste wint', () => {
  const uit = dedupeSongs([
    { artist: 'The Verve', title: 'Bitter Sweet Symphony', year: 1997 },
    { artist: 'Verve', title: 'Bitter Sweet Symphony!', year: 1998 },
    { artist: 'Queen', title: 'Bohemian Rhapsody', year: 1975 },
  ]);
  assert.equal(uit.length, 2);
  assert.equal(uit[0].year, 1997);
});

test('themeFor: tijdperkgrenzen', () => {
  assert.equal(themeFor({ year: 1979 }), 'tijdperk-60-70');
  assert.equal(themeFor({ year: 1980 }), 'tijdperk-80-90');
  assert.equal(themeFor({ year: 1999 }), 'tijdperk-80-90');
  assert.equal(themeFor({ year: 2000 }), 'tijdperk-00-nu');
});

test('pickSong: nooit een gebruikte, null bij leeg', () => {
  const songs = [{ id: 'a', year: 1990 }, { id: 'b', year: 2000 }];
  for (let i = 0; i < 20; i++) assert.equal(pickSong(songs, new Set(['a'])).id, 'b');
  assert.equal(pickSong(songs, new Set(['a', 'b'])), null);
  assert.equal(pickSong([], new Set()), null);
});

test('audioSourceFor: keuzeketen spotify → preview → skip', () => {
  assert.equal(audioSourceFor({ mode: 'spotify', spotifyOk: true, previewUrl: 'x' }), 'spotify');
  assert.equal(audioSourceFor({ mode: 'spotify', spotifyOk: false, previewUrl: 'x' }), 'preview');
  assert.equal(audioSourceFor({ mode: 'preview', spotifyOk: false, previewUrl: 'x' }), 'preview');
  assert.equal(audioSourceFor({ mode: 'preview', spotifyOk: false, previewUrl: null }), 'skip');
});

test('beoordeelDeezerHit: fuzzy op beide velden', () => {
  const song = { artist: 'Nirvana', title: 'Smells Like Teen Spirit' };
  assert.equal(beoordeelDeezerHit({ artist: { name: 'Nirvana' }, title: 'Smells Like Teen Spirit' }, song), true);
  assert.equal(beoordeelDeezerHit({ artist: { name: 'Nirvana' }, title: 'Smells Like Teen Spirit - Live at Reading' }, song), true);
  assert.equal(beoordeelDeezerHit({ artist: { name: 'Nirvana Tribute Band' }, title: 'Smells Like Teen Spirit (Karaoke)' }, song), false);
  assert.equal(beoordeelDeezerHit(null, song), false);
});

test('beoordeelSpotifyHit: eerste artiest, fuzzy beide velden', () => {
  const song = { artist: 'Queen', title: 'Bohemian Rhapsody' };
  assert.equal(beoordeelSpotifyHit({ name: 'Bohemian Rhapsody - Remastered 2011', artists: [{ name: 'Queen' }] }, song), true);
  assert.equal(beoordeelSpotifyHit({ name: 'Bohemian Rhapsody', artists: [{ name: 'Panic! At The Disco' }] }, song), false);
  assert.equal(beoordeelSpotifyHit(undefined, song), false);
});

test('moetOpnieuwZoeken: retry tenzij definitief', () => {
  assert.equal(moetOpnieuwZoeken({ waarde: null, definitief: false }), true);
  assert.equal(moetOpnieuwZoeken({ waarde: null, definitief: true }), false);
  assert.equal(moetOpnieuwZoeken({ waarde: 'x', definitief: true }), false);
});

test('magBeurtOverslaan: alleen in luisterfase, bij een weggevallen actieve speler', () => {
  const maak = (over) => ({
    players: new Map([
      ['u1', { id: 'u1', connected: false, ...over?.u1 }],
      ['u2', { id: 'u2', connected: true, ...over?.u2 }],
    ]),
    activeUserId: over?.activeUserId ?? 'u1',
    phase: over?.phase ?? 'listening',
  });
  assert.equal(magBeurtOverslaan(maak(), 'u1'), true);
  assert.equal(magBeurtOverslaan(maak({ u1: { connected: true } }), 'u1'), false); // terug
  assert.equal(magBeurtOverslaan(maak({ activeUserId: 'u2' }), 'u1'), false);      // niet meer aan de beurt
  assert.equal(magBeurtOverslaan(maak({ phase: 'challenge' }), 'u1'), false);      // fase loopt op timers door
  assert.equal(magBeurtOverslaan(maak({ phase: 'reveal' }), 'u1'), false);
  assert.equal(magBeurtOverslaan(maak(), 'onbekend'), false);                      // geen speler
});

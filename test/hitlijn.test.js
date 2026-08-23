import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOUT, makeRoomCode, validateName, dedupeSongs, themeFor, pickSong, audioSourceFor,
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

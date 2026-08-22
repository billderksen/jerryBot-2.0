// test/plaatjeText.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeField, similarity, matchGuess, parseVideoTitle } from '../src/utils/plaatjeText.js';

test('normalizeField: lowercase, diacritics, interpunctie, haakjes, voorloop-the', () => {
  assert.equal(normalizeField('  The Vérve! '), 'verve');
  assert.equal(normalizeField('Wannabe (Official Video)'), 'wannabe');
  assert.equal(normalizeField("...Baby One More Time"), 'baby one more time');
  assert.equal(normalizeField(''), '');
  assert.equal(normalizeField(null), '');
});

test('similarity: identiek 1, leeg vs niet-leeg 0, typo hoog', () => {
  assert.equal(similarity('queen', 'queen'), 1);
  assert.equal(similarity('', 'queen'), 0);
  assert.ok(similarity('nirvana', 'nirvanna') >= 0.8);
  assert.ok(similarity('abba', 'metallica') < 0.5);
});

test('matchGuess: beide velden ≥0.8 vereist, genormaliseerd', () => {
  const song = { artist: 'The Verve', title: 'Bitter Sweet Symphony' };
  assert.equal(matchGuess({ artist: 'verve', title: 'bittersweet symphony' }, song), true);
  assert.equal(matchGuess({ artist: 'The Verve', title: 'Lucky Man' }, song), false);
  assert.equal(matchGuess({ artist: '', title: 'Bitter Sweet Symphony' }, song), false);
  assert.equal(matchGuess({ artist: 'Queen ', title: 'Bohemian Rhapsody!' },
    { artist: 'Queen', title: 'Bohemian Rhapsody' }), true);
});

test('parseVideoTitle: "Artiest - Titel" met rommel', () => {
  assert.deepEqual(parseVideoTitle('Daft Punk - Get Lucky (Official Audio) [HD]'),
    { artist: 'Daft Punk', title: 'Get Lucky' });
  assert.deepEqual(parseVideoTitle('a-ha - Take On Me – Remastered'),
    { artist: 'a-ha', title: 'Take On Me - Remastered' });
  assert.deepEqual(parseVideoTitle('Bohemian Rhapsody'), { artist: '', title: 'Bohemian Rhapsody' });
});

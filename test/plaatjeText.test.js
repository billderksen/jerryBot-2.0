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

test('matchGuess: catalogus-suffix en haakjes-inhoud tellen niet tegen je', () => {
  const song = { artist: 'KC & The Sunshine Band', title: "That's the Way (I Like It) - 2004 Remaster" };
  // volledige titel mét het haakjes-deel geraden — moet goed zijn
  assert.equal(matchGuess({ artist: 'KC and the Sunshine Band', title: 'thats the way i like it' }, song), true);
  // titel zonder haakjes-deel ook
  assert.equal(matchGuess({ artist: 'kc & the sunshine band', title: "That's the Way" }, song), true);
  // maar een echt andere titel blijft fout
  assert.equal(matchGuess({ artist: 'kc & the sunshine band', title: 'get down tonight' }, song), false);
});

test('matchGuess: hoofdartiest of een van de artiesten is genoeg', () => {
  assert.equal(matchGuess({ artist: 'KC', title: 'x' }, { artist: 'KC & The Sunshine Band', title: 'x' }), true);
  assert.equal(matchGuess({ artist: 'BTS', title: 'Dynamite' }, { artist: 'BTS feat. Halsey', title: 'Dynamite' }), true);
  assert.equal(matchGuess({ artist: 'Halsey', title: 'Dynamite' }, { artist: 'BTS feat. Halsey', title: 'Dynamite' }), true);
  // 'ft' binnenin een woord mag géén splitsing veroorzaken
  assert.equal(matchGuess({ artist: 'Left', title: 'x' }, { artist: 'Left Boy', title: 'x' }), false);
  assert.equal(matchGuess({ artist: 'Left Boy', title: 'x' }, { artist: 'Left Boy', title: 'x' }), true);
});

test('matchGuess: één letterfout is altijd goed, ook bij korte titels', () => {
  assert.equal(matchGuess({ artist: 'Prince', title: 'Kis' }, { artist: 'Prince', title: 'Kiss' }), true);
  assert.equal(matchGuess({ artist: 'Princ', title: 'Kiss' }, { artist: 'Prince', title: 'Kiss' }), true);
  // maar twee fouten op een kort woord niet
  assert.equal(matchGuess({ artist: 'Prince', title: 'Ki' }, { artist: 'Prince', title: 'Kiss' }), false);
});

test('matchGuess: trema/accenten en lidwoorden blijven vergeven', () => {
  assert.equal(matchGuess({ artist: 'Beyonce', title: 'Halo' }, { artist: 'Beyoncé', title: 'Halo' }), true);
  assert.equal(matchGuess({ artist: 'Dijk', title: 'Mag het licht uit' }, { artist: 'De Dijk', title: 'Mag het licht uit' }), true);
});

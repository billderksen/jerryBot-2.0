import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastPathMatch, validateIntent } from '../src/utils/speech/intent.js';

const cases = [
  ['skip', 'skip'], ['volgende', 'skip'], ['volgend nummer', 'skip'],
  ['pauze', 'pause'], ['pauzeer', 'pause'], ['pauzeren', 'pause'],
  ['ga door', 'resume'], ['hervat', 'resume'], ['doorgaan', 'resume'], ['resume', 'resume'],
  ['stop', 'stop'], ['stoppen', 'stop'],
  ['wat speelt er', 'nowplaying'], ['wat speelt er nu', 'nowplaying'], ['welk nummer is dit', 'nowplaying'],
];
for (const [text, action] of cases) {
  test(`fast path: "${text}" -> ${action}`, () => {
    assert.equal(fastPathMatch(text)?.action, action);
  });
}

test('fast path: volume with number', () => {
  assert.deepEqual(fastPathMatch('volume 30'), { action: 'volume', volume: 30 });
  assert.deepEqual(fastPathMatch('zet het volume op 80'), { action: 'volume', volume: 80 });
  assert.equal(fastPathMatch('volume 150'), null); // out of range -> let LLM/unknown handle
});

test('fast path: punctuation/case/diacritics tolerant', () => {
  assert.equal(fastPathMatch('  Pauzeer!  ')?.action, 'pause');
  assert.equal(fastPathMatch('Volgende.')?.action, 'skip');
});

test('fast path: full sentences do NOT false-match', () => {
  assert.equal(fastPathMatch('speel beat it van michael jackson'), null);
  assert.equal(fastPathMatch('herinner me over tien minuten aan de pizza'), null);
  assert.equal(fastPathMatch('waarom stopt de muziek steeds'), null);
});

test('validateIntent: accepts good, rejects malformed', () => {
  assert.equal(validateIntent({ action: 'play', query: 'beat it' }).action, 'play');
  assert.equal(validateIntent({ action: 'volume', volume: 250 }).action, 'unknown');
  assert.equal(validateIntent({ action: 'evil' }).action, 'unknown');
  assert.equal(validateIntent(null).action, 'unknown');
  assert.equal(validateIntent({ action: 'remind', minutes: 20, message: 'pizza' }).action, 'remind');
});

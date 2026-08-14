import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastPathMatch, validateIntent, isLikelyHallucination } from '../src/utils/speech/intent.js';

const cases = [
  ['skip', 'skip'], ['volgende', 'skip'], ['volgend nummer', 'skip'],
  ['overslaan', 'skip'], ['sla over', 'skip'], ['sla dit over', 'skip'], ['volgend', 'skip'],
  ['pauze', 'pause'], ['pauzeer', 'pause'], ['pauzeren', 'pause'], ['wacht even', 'pause'],
  ['pause', 'pause'], // Whisper anglicizes the Dutch word often enough to matter
  ['ga door', 'resume'], ['hervat', 'resume'], ['doorgaan', 'resume'], ['resume', 'resume'],
  ['ga verder', 'resume'], ['verder', 'resume'], ['hervatten', 'resume'], ['speel verder', 'resume'],
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

test('fast path: short/spoken volume forms', () => {
  // Whisper regularly transcribes spoken volume commands in these shapes.
  assert.deepEqual(fastPathMatch('vol 10'), { action: 'volume', volume: 10 });
  assert.deepEqual(fastPathMatch('volume op 55'), { action: 'volume', volume: 55 });
  assert.deepEqual(fastPathMatch('zet volume op 20'), { action: 'volume', volume: 20 });
  assert.equal(fastPathMatch('vol 150'), null);
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

test('fast path: command words inside a sentence do NOT false-match', () => {
  // The whole-utterance anchor is what makes bare 'verder'/'overslaan' safe to
  // accept as commands - these sentences merely contain them.
  assert.equal(fastPathMatch('oversla die vraag'), null);
  assert.equal(fastPathMatch('verder weet ik het niet'), null);
  assert.equal(fastPathMatch('sla dit over en speel iets anders'), null);
});

test('hallucination guard: rejects empty, noise and music-tag transcripts', () => {
  // Every one of these came out of Whisper on a near-empty clip during live testing.
  assert.equal(isLikelyHallucination(''), true);
  assert.equal(isLikelyHallucination('   '), true);
  assert.equal(isLikelyHallucination('***'), true);
  assert.equal(isLikelyHallucination('. . .'), true);
  assert.equal(isLikelyHallucination('ZANG EN MUZIEK'), true);
  assert.equal(isLikelyHallucination('[Muziek]'), true);
  assert.equal(isLikelyHallucination(null), true);
  // Whisper's Dutch subtitle artifacts, both spellings of the credit.
  assert.equal(isLikelyHallucination('Bedankt voor het kijken!'), true);
  assert.equal(isLikelyHallucination('Ondertiteling door de Amara.org gemeenschap'), true);
  assert.equal(isLikelyHallucination('Ondertiteld door de Amara.org gemeenschap'), true);
});

test('hallucination guard: keeps real commands and questions', () => {
  assert.equal(isLikelyHallucination('skip'), false);
  assert.equal(isLikelyHallucination('vol 10'), false);
  assert.equal(isLikelyHallucination('speel muziek van queen'), false);
  assert.equal(isLikelyHallucination('hoe hoog is de eiffeltoren'), false);
});

test('validateIntent: accepts good, rejects malformed', () => {
  assert.equal(validateIntent({ action: 'play', query: 'beat it' }).action, 'play');
  assert.equal(validateIntent({ action: 'volume', volume: 250 }).action, 'unknown');
  assert.equal(validateIntent({ action: 'evil' }).action, 'unknown');
  assert.equal(validateIntent(null).action, 'unknown');
  assert.equal(validateIntent({ action: 'remind', minutes: 20, message: 'pizza' }).action, 'remind');
});

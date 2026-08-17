import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fastPathMatch, validateIntent, isLikelyHallucination, applyRelativeVolume, VOLUME_STEP, VOLUME_BIG_STEP } from '../src/utils/speech/intent.js';

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

// --- relative volume ---------------------------------------------------------
//
// Nobody shouting at a speaker has a number in mind. These are the two sizes and
// the direction comes from the word; the level itself is worked out at dispatch,
// where the current volume can actually be read.

const relativeCases = [
  ['harder', 15], ['luider', 15], ['wat harder', 15], ['iets harder', 15],
  ['doe harder', 15], ['zet harder', 15], ['harder graag', 15], ['volume omhoog', 15],
  ['zachter', -15], ['stiller', -15], ['wat zachter', -15], ['iets zachter', -15],
  ['doe zachter', -15], ['zet zachter', -15], ['zachter graag', -15], ['volume omlaag', -15],
  ['veel harder', 30], ['veel luider', 30],
  ['veel zachter', -30], ['veel stiller', -30],
];
for (const [text, relative] of relativeCases) {
  test(`fast path: "${text}" -> volume ${relative > 0 ? '+' : ''}${relative}`, () => {
    assert.deepEqual(fastPathMatch(text), { action: 'volume', relative });
  });
}

test('fast path: relative volume is punctuation/case tolerant like the rest', () => {
  assert.deepEqual(fastPathMatch('  Harder!  '), { action: 'volume', relative: 15 });
  assert.deepEqual(fastPathMatch('Veel zachter.'), { action: 'volume', relative: -30 });
});

test('fast path: sentences that merely contain harder/zachter do NOT match', () => {
  // The whole-utterance anchor is the entire safety story here: these are things
  // people say in a voice channel with a bot listening for a wake word.
  assert.equal(fastPathMatch('dat is harder dan ik dacht'), null);
  assert.equal(fastPathMatch('hij trapt harder dan jij'), null);
  assert.equal(fastPathMatch('het mag wel wat zachter met dat gepraat'), null);
  assert.equal(fastPathMatch('zachter gekookte eieren zijn lekkerder'), null);
  assert.equal(fastPathMatch('veel harder werken dan dit kan niet'), null);
});

test('fast path: an absolute volume is still absolute, not relative', () => {
  // The two shapes must never blur into each other
  assert.deepEqual(fastPathMatch('volume 30'), { action: 'volume', volume: 30 });
  assert.equal(fastPathMatch('volume 30').relative, undefined);
  assert.equal(fastPathMatch('harder').volume, undefined);
});

test('applyRelativeVolume: clamped into the slider, not rejected at its edges', () => {
  assert.equal(applyRelativeVolume(50, 15), 65);
  assert.equal(applyRelativeVolume(50, -15), 35);
  assert.equal(applyRelativeVolume(50, 30), 80);
  // Somebody at 95 saying "harder" means "as loud as it goes", not "nothing"
  assert.equal(applyRelativeVolume(95, 15), 100);
  assert.equal(applyRelativeVolume(10, -15), 0);
  assert.equal(applyRelativeVolume(100, 15), 100);
  assert.equal(applyRelativeVolume(0, -15), 0);
  // A level that arrives as a fraction of a percent still lands on a whole one
  assert.equal(applyRelativeVolume(64.4, 15), 79);
  // Nothing readable to work from: full volume is the honest default, not silence
  assert.equal(applyRelativeVolume(undefined, -15), 85);
  assert.equal(applyRelativeVolume(NaN, 15), 100);
  assert.equal(applyRelativeVolume(50, 'x'), 50);
});

test('validateIntent: a relative volume is accepted, strictly', () => {
  assert.deepEqual(validateIntent({ action: 'volume', relative: 15 }), { action: 'volume', relative: 15 });
  assert.deepEqual(validateIntent({ action: 'volume', relative: -30 }), { action: 'volume', relative: -30 });
  assert.deepEqual(validateIntent({ action: 'volume', relative: '15' }), { action: 'volume', relative: 15 });

  // Not a move at all
  assert.equal(validateIntent({ action: 'volume', relative: 0 }).action, 'unknown');
  // Beyond the whole range of the slider
  assert.equal(validateIntent({ action: 'volume', relative: 250 }).action, 'unknown');
  assert.equal(validateIntent({ action: 'volume', relative: -101 }).action, 'unknown');
  assert.equal(validateIntent({ action: 'volume', relative: 'harder' }).action, 'unknown');
  // "set it to 40 and also 15 louder" is not a request anybody made
  assert.equal(validateIntent({ action: 'volume', relative: 15, volume: 40 }).action, 'unknown');
  // An absolute one is untouched by any of this
  assert.deepEqual(validateIntent({ action: 'volume', volume: 40 }), { action: 'volume', volume: 40 });
});

test('fast path: the step sizes in the table are the exported ones', () => {
  // So a step that is tuned later cannot drift away from what the phrases mean
  assert.equal(fastPathMatch('harder').relative, VOLUME_STEP);
  assert.equal(fastPathMatch('zachter').relative, -VOLUME_STEP);
  assert.equal(fastPathMatch('veel harder').relative, VOLUME_BIG_STEP);
  assert.equal(fastPathMatch('veel zachter').relative, -VOLUME_BIG_STEP);
});

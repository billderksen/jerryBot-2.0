import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import {
  armGateAfterBeep,
  buildLogDescription,
  captureEndReason,
  downsample48kStereoTo16kMono,
  isOptedIn,
  setOptIn,
  getOptedInUserIds,
  reloadOptIns,
  setOptInStorePath,
} from '../src/utils/voiceAssistant.js';

test('downsampler: 6 stereo frames -> 2 mono samples, averaged', () => {
  // 48k stereo interleaved [L,R,...] -> 16k mono: avg channels, every 3rd frame
  const input = new Int16Array([100, 200, 0, 0, 0, 0, 300, 500, 0, 0, 0, 0]);
  const out = downsample48kStereoTo16kMono(input);
  assert.equal(out.length, 2);
  assert.equal(out[0], 150); // (100+200)/2
  assert.equal(out[1], 400); // (300+500)/2
});

test('downsampler: length = floor(frames/3)', () => {
  const out = downsample48kStereoTo16kMono(new Int16Array(2 * 32)); // 32 frames
  assert.equal(out.length, 10);
});

test('downsampler: handles negative samples without overflowing Int16', () => {
  const input = new Int16Array([-32768, -32768, 0, 0, 0, 0]);
  const out = downsample48kStereoTo16kMono(input);
  assert.equal(out.length, 1);
  assert.equal(out[0], -32768);
});

// --- capture state machine -------------------------------------------------
// Times are milliseconds from the wake event (T=0). The constants under test:
// WAKE_TAIL_MS 250, BEEP_ECHO_MARGIN_MS 250, ARM_GATE_MAX_MS 1200,
// CAPTURE_SILENCE_MS 1000, FIRST_SPEECH_GRACE_MS 3500, CAPTURE_MAX_MS 10000.

test('arm gate: a beep settling at T+250 covers its echo round-trip', () => {
  assert.equal(armGateAfterBeep(0, 250, 250), 500);
});

test('arm gate: an early or dropped beep never pulls the wake-tail gate in', () => {
  // tts.js resolves false immediately when it drops a clip; the gate must still
  // cover the tail of "hey jarvis".
  assert.equal(armGateAfterBeep(0, 250, 0), 250);
});

test('arm gate: a late beep is capped so it cannot eat the grace window', () => {
  // Queued behind a spoken reply, the beep can settle seconds after the wake.
  assert.equal(armGateAfterBeep(0, 250, 5000), 1200);
  assert.ok(armGateAfterBeep(0, 250, 5000) < 3500, 'gate must stay inside the grace window');
});

test('capture end: waits out the grace window while nothing has been said', () => {
  const waiting = { startedAt: 0, lastVoiceAt: 0, speechStarted: false };
  // The old bug: the silence rule firing at T+1000 on someone still listening
  // for the beep. It must not end here.
  assert.equal(captureEndReason(waiting, 1000), null);
  assert.equal(captureEndReason(waiting, 3499), null);
  assert.equal(captureEndReason(waiting, 3500), 'no-speech');
});

test('capture end: once armed, a second of silence ends the utterance', () => {
  const speaking = { startedAt: 0, lastVoiceAt: 600, speechStarted: true };
  assert.equal(captureEndReason(speaking, 1500), null);
  assert.equal(captureEndReason(speaking, 1600), 'silence');
});

test('capture end: a speaker armed late is not cut off by the grace window', () => {
  // Started talking at T+2500, still going at T+4000 - past FIRST_SPEECH_GRACE_MS.
  const lateStarter = { startedAt: 0, lastVoiceAt: 4000, speechStarted: true };
  assert.equal(captureEndReason(lateStarter, 4000), null);
});

test('capture end: someone who never stops still ends at the hard cap', () => {
  const endless = { startedAt: 0, lastVoiceAt: 9950, speechStarted: true };
  assert.equal(captureEndReason(endless, 10_000), 'max-duration');
});

// EmbedBuilder throws above 4096, from inside logInteraction's try - where the
// catch swallows it and the user gets no embed at all. Every field below is
// model-generated and effectively unbounded, so the clamp is what stands
// between a long answer and a silent failure.
test('log description: stays inside the embed limit for pathological input', () => {
  const description = buildLogDescription({
    displayName: 'x'.repeat(200),
    transcript: 'y'.repeat(2000),
    summary: 'vraag: ' + 'z'.repeat(2000),
    detail: 'a'.repeat(9000),
    ok: true,
  });
  assert.ok(description.length <= 4096, `description was ${description.length} chars`);
  assert.doesNotThrow(() => new EmbedBuilder().setDescription(description));
});

test('log description: a long heading still leaves room for the answer', () => {
  // The old code sliced the answer at a fixed 3800 regardless of the heading,
  // so a ~305-char heading pushed the total past 4096 and threw.
  const description = buildLogDescription({
    displayName: 'Gebruiker 918554414220972032',
    transcript: 'q'.repeat(400),
    summary: 'vraag: ' + 'q'.repeat(400),
    detail: 'A'.repeat(5000),
    ok: true,
  });
  assert.ok(description.length <= 4096);
  assert.doesNotThrow(() => new EmbedBuilder().setDescription(description));
  assert.ok(description.includes('AAAA'), 'the answer still made it into the description');
});

test('log description: short input is left alone', () => {
  const description = buildLogDescription({
    displayName: 'Bill', transcript: 'skip', summary: 'skip', detail: null, ok: true,
  });
  assert.equal(description, '🎤 **Bill**: "skip" → skip');
});

test('opt-in store: round-trips through disk', () => {
  const storePath = path.join(mkdtempSync(path.join(tmpdir(), 'jerrybot-va-')), 'voiceAssistant.json');
  setOptInStorePath(storePath);

  assert.equal(isOptedIn('user-1'), false);

  setOptIn('user-1', true);
  assert.equal(isOptedIn('user-1'), true);
  assert.deepEqual(getOptedInUserIds(), ['user-1']);

  // Persisted, not just in memory: drop the cache and read it back off disk.
  reloadOptIns();
  assert.equal(isOptedIn('user-1'), true);
  const onDisk = JSON.parse(readFileSync(storePath, 'utf8'));
  assert.ok(onDisk.optedIn['user-1'].since, 'stores an ISO opt-in timestamp');

  setOptIn('user-1', false);
  assert.equal(isOptedIn('user-1'), false);
  reloadOptIns();
  assert.equal(isOptedIn('user-1'), false);
  assert.deepEqual(getOptedInUserIds(), []);
});

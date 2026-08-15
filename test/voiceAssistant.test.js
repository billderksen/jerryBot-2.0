import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import {
  CaptureMachine,
  buildLogDescription,
  downsample48kStereoTo16kMono,
  isOptedIn,
  setOptIn,
  getOptedInUserIds,
  reloadOptIns,
  setOptInStorePath,
  shouldAssistantAutoLeave,
  voiceConnectionOwner,
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
// Times are milliseconds from the wake event (T=0). Constants under test:
// WAKE_TAIL_MS 250, BEEP_ECHO_MARGIN_MS 250, ARM_GATE_MAX_MS 1200,
// CAPTURE_SILENCE_MS 1000, FIRST_SPEECH_GRACE_MS 3500, CAPTURE_MAX_MS 10000,
// SPEECH_ENERGY_THRESHOLD 300.

const FRAME_MS = 20;                       // one Discord voice frame
const FRAME_BYTES = 48000 * 2 * 2 * 0.02;  // 3840 B of 48k stereo
const LOUD = 4000;                         // mean |sample| of speech (or beep echo)
const QUIET = 20;                          // a silence frame from a client that keeps transmitting
const FRICATIVE = 120;                     // an /s/: real audio, but under SPEECH_ENERGY_THRESHOLD
const OUT_BYTES_PER_MS = 32;               // 16k mono, 2 bytes/sample
const SOURCE_PER_OUT = 6;

/**
 * Runs a whole capture: 20ms frames, `voiced` intervals loud and the rest quiet
 * (or `energyAt(t)` for anything in between), beep in flight from T=0 until
 * `beepSettledAt` (null = never settles).
 */
function runCapture({ voiced = [], beepSettledAt, beep = true, energyAt = null }) {
  const machine = new CaptureMachine(0);
  if (beep) machine.beepStarted();
  let offered = 0, buffered = 0, armedAt = null, settled = false;

  for (let t = 0; t <= 12_000; t += FRAME_MS) {
    if (beep && !settled && beepSettledAt !== null && t >= beepSettledAt) {
      machine.beepSettled(beepSettledAt);
      settled = true;
    }
    const energy = energyAt ? energyAt(t) : (voiced.some(([a, b]) => t >= a && t < b) ? LOUD : QUIET);
    offered += FRAME_BYTES;
    if (machine.chunk(t, energy, FRAME_BYTES) === 'buffer') buffered += FRAME_BYTES;
    if (machine.speechStarted && armedAt === null) armedAt = t;

    const reason = machine.poll(t);
    if (reason) {
      const outBytes = Math.floor(buffered / SOURCE_PER_OUT);
      const voicedOut = Math.floor(machine.voicedBytes / SOURCE_PER_OUT);
      return {
        reason, armedAt, endedAt: t, outBytes, voicedOut,
        offeredOutBytes: Math.floor(offered / SOURCE_PER_OUT),
        voicedMs: Math.round(voicedOut / OUT_BYTES_PER_MS),
        transcribed: CaptureMachine.isWorthTranscribing(voicedOut),
      };
    }
  }
  throw new Error('capture never ended');
}

const WAKE_TAIL = [0, 140]; // the tail of "hey jarvis" still arriving after the wake

// The bug this round exists to kill: the gate used to be computed at wake time
// from an ESTIMATED beep length, leaving [WAKE_TAIL_MS, beepSettledAt) unguarded.
// A clip settling at T+400 let echo at T+260 arm permanently, and the capture
// died at ~T+1600 - before the user, who was waiting for that very beep, spoke.
test('capture (a): echo cannot arm while the beep is still in flight', () => {
  const r = runCapture({ voiced: [WAKE_TAIL, [180, 600], [2000, 3400]], beepSettledAt: 400 });
  assert.equal(r.armedAt, 2000, 'must arm on the user at T+2000, not on the echo');
  assert.equal(r.reason, 'silence');
  assert.ok(r.endedAt > 4000, `ended at T+${r.endedAt}, cutting the user off`);
  assert.ok(r.transcribed);
});

test('capture (a\'): a long-lagging echo is still suppressed', () => {
  // Echo still arriving 350ms after the clip finished - a bad connection. This
  // is what sized BEEP_ECHO_MARGIN_MS: at 250ms the gate opened at T+500 and the
  // echo's own tail armed the utterance.
  const r = runCapture({ voiced: [WAKE_TAIL, [100, 600], [2000, 3400]], beepSettledAt: 250 });
  assert.equal(r.armedAt, 2000);
  assert.ok(r.transcribed);
});

test('capture (b): a command finishing inside the gate is transcribed, not lost', () => {
  // "hey jarvis skip" said in one breath: over before the gate ever opens, so it
  // never arms and rides the grace window out - but it is a real word.
  const r = runCapture({ voiced: [[0, 280]], beepSettledAt: 250 });
  assert.equal(r.armedAt, null, 'nothing after the gate opened, so nothing armed');
  assert.equal(r.reason, 'no-speech');
  assert.equal(r.endedAt, 3500);
  assert.ok(r.transcribed, `${r.voicedMs}ms of speech must clear the voiced floor`);
});

test('capture (c): speech overlapping the beep is buffered and arms at gate-open', () => {
  // Headphones, so no echo - the user simply talks over the beep. None of it may
  // be dropped, and arming happens within a frame of the gate opening.
  const r = runCapture({ voiced: [[180, 1400]], beepSettledAt: 250 });
  const gateOpensAt = 250 + 400; // beepSettledAt + BEEP_ECHO_MARGIN_MS
  assert.ok(r.armedAt >= gateOpensAt && r.armedAt < gateOpensAt + FRAME_MS,
    `armed at T+${r.armedAt}, expected within one frame of the gate opening at T+${gateOpensAt}`);
  assert.equal(r.reason, 'silence');
  assert.ok(r.voicedMs >= 1200, `all ${r.voicedMs}ms of speech kept, including the part over the beep`);
});

test('capture (d): a beep that never settles opens the gate at the safety valve', () => {
  const r = runCapture({ voiced: [WAKE_TAIL, [1300, 2200]], beepSettledAt: null });
  assert.equal(r.armedAt, 1300, 'gate force-opens at ARM_GATE_MAX_MS, not never');
  assert.equal(r.reason, 'silence');
  assert.ok(r.transcribed);
});

test('capture (e): silence after the wake fails without a transcription call', () => {
  const r = runCapture({ voiced: [WAKE_TAIL], beepSettledAt: 250 });
  assert.equal(r.reason, 'no-speech');
  assert.equal(r.armedAt, null);
  assert.equal(r.transcribed, false, 'a wake-word tail alone is not worth an API call');
});

// The margin that makes (b) and (e) different verdicts. Both are short bursts of
// voiced audio; only the floor separates "a real command" from "the leftover of
// the wake word", so it has to sit clear of both with room to spare.
test('capture: the voiced floor clears the wake-word tail and admits a short command', () => {
  const floorMs = Math.round(
    [...Array(400).keys()].find((ms) => CaptureMachine.isWorthTranscribing(ms * OUT_BYTES_PER_MS))
  );
  assert.ok(floorMs - 140 >= 50, `floor ${floorMs}ms is only ${floorMs - 140}ms above a 140ms wake tail`);
  assert.ok(250 - floorMs >= 50, `floor ${floorMs}ms leaves only ${250 - floorMs}ms under a 250ms "skip"`);
});

test('capture: a user who never stops still ends at the hard cap', () => {
  const r = runCapture({ voiced: [[0, 12_000]], beepSettledAt: 250 });
  assert.ok(r.reason === 'max-duration' || r.reason === 'max-bytes', `ended by ${r.reason}`);
  assert.ok(r.endedAt <= 10_000);
});

test('capture: the pause before the command is buffered too, not dropped', () => {
  // The buffer used to start at the first voiced frame, which cost the soft
  // onset of the command itself (see the fricative test below). Now everything
  // from the wake onwards is kept: 2s of pause + 1s of speech + the 1s silence
  // that ends the utterance. Whisper's leading dead air is the price, and the
  // voiced floor - not the buffer size - is what decides whether to call it.
  const r = runCapture({ voiced: [[2000, 3000]], beepSettledAt: 250 });
  const bufferedMs = Math.round(r.outBytes / OUT_BYTES_PER_MS);
  assert.equal(r.endedAt, 3980); // last voiced frame at T+2980 + CAPTURE_SILENCE_MS
  assert.ok(bufferedMs >= 3900, `buffered only ${bufferedMs}ms of a ${r.endedAt}ms capture`);
  assert.equal(r.voicedMs, 1000);
  assert.equal(r.armedAt, 2000);
});

test('capture (f): a soft fricative onset is kept, not eaten by the energy gate', () => {
  // "hey jarvis, speel muziek af". The /s/ of "speel" carries a fraction of the
  // energy of the vowel behind it, so the classifier calls it unvoiced - and an
  // unvoiced frame before the utterance armed used to be dropped outright.
  // Whisper then heard "veel muziek af", which is what this test exists to stop.
  const onset = [2000, 2120];   // the /s/ - real speech, classified unvoiced
  const rest = [2120, 3200];    // "-peel muziek af"
  const r = runCapture({
    beepSettledAt: 250,
    energyAt: (t) => {
      if (t >= onset[0] && t < onset[1]) return FRICATIVE;
      if (t >= rest[0] && t < rest[1]) return LOUD;
      return QUIET;
    },
  });

  assert.equal(r.reason, 'silence');
  // Nothing at all was dropped: every byte offered after the wake is in the buffer.
  assert.equal(r.outBytes, r.offeredOutBytes,
    `buffered ${r.outBytes} of ${r.offeredOutBytes} post-wake bytes`);
  // ...and the onset really was classified unvoiced - it is retained despite
  // that, not because the classifier happened to like it.
  assert.equal(r.voicedMs, 1080, 'only the loud part counts as voiced');
  assert.equal(r.armedAt, 2120, 'the fricative does not arm the utterance');
  assert.ok(r.transcribed);
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

// --- connection ownership and auto-leave -----------------------------------
// The guild has one voice connection and three things that create one (/play,
// /record, /heyjerry join). These two functions are the whole guard against the
// assistant hanging up on a song or a recording, so they are tested directly.

const CONN = { id: 'the-live-connection' };
const OTHER_CONN = { id: 'a-connection-this-queue-moved-off' };

test('ownership: no connection at all', () => {
  assert.equal(voiceConnectionOwner({ connection: null, queueConnection: null, recording: false }), 'none');
});

test('ownership: the music queue holding this connection owns it', () => {
  assert.equal(
    voiceConnectionOwner({ connection: CONN, queueConnection: CONN, recording: false }),
    'music'
  );
});

test('ownership: music wins over a recording on the same connection', () => {
  // /play stops an active recording before it joins, but the two can overlap for
  // as long as that teardown takes - and the queue is the one that will hang up.
  assert.equal(
    voiceConnectionOwner({ connection: CONN, queueConnection: CONN, recording: true }),
    'music'
  );
});

test('ownership: an active recording owns a queueless connection', () => {
  assert.equal(
    voiceConnectionOwner({ connection: CONN, queueConnection: null, recording: true }),
    'recorder'
  );
});

test('ownership: a queue holding a DIFFERENT connection has no claim', () => {
  // A cleaned-up queue nulls its connection, and one that reconnected holds a
  // new object; neither may keep the assistant off the live connection. Identity,
  // not "is there a queue".
  assert.equal(
    voiceConnectionOwner({ connection: CONN, queueConnection: OTHER_CONN, recording: false }),
    'assistant'
  );
  assert.equal(
    voiceConnectionOwner({ connection: CONN, queueConnection: null, recording: false }),
    'assistant'
  );
});

test('auto-leave: an empty channel on a connection nobody else uses', () => {
  assert.equal(shouldAssistantAutoLeave({ owner: 'assistant', humanCount: 0 }), true);
});

test('auto-leave: never on a music- or recorder-owned connection, even when empty', () => {
  assert.equal(shouldAssistantAutoLeave({ owner: 'music', humanCount: 0 }), false);
  assert.equal(shouldAssistantAutoLeave({ owner: 'recorder', humanCount: 0 }), false);
  assert.equal(shouldAssistantAutoLeave({ owner: 'none', humanCount: 0 }), false);
});

test('auto-leave: not while anyone is still in the channel', () => {
  assert.equal(shouldAssistantAutoLeave({ owner: 'assistant', humanCount: 1 }), false);
});

test('auto-leave: not mid-interaction, even in an empty channel', () => {
  // Someone can wake Jerry and walk out; the reply still has to be spoken.
  assert.equal(shouldAssistantAutoLeave({ owner: 'assistant', humanCount: 0, busy: true }), false);
});

test('auto-leave: unknown inputs fail safe by staying', () => {
  // null = "couldn't tell" (channel not in cache, musicQueue import failed).
  // Idling costs nothing; a wrong hang-up cuts someone off.
  assert.equal(shouldAssistantAutoLeave({ owner: 'assistant', humanCount: null }), false);
  assert.equal(shouldAssistantAutoLeave({ owner: null, humanCount: 0 }), false);
});

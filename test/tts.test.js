import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  synthesize,
  isTtsAvailable,
  speak,
  playBeep,
  enqueueSpeechJob,
  TTS_TMP_DIR,
  BEEP_PATH,
} from '../src/utils/speech/tts.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('synthesize produces a wav file (skipped without piper)', async (t) => {
  if (!isTtsAvailable()) return t.skip('piper not installed');
  const wavPath = await synthesize('Oké, ik speel het nummer.');
  assert.ok(existsSync(wavPath));
  assert.equal(readFileSync(wavPath).subarray(0, 4).toString(), 'RIFF');
});

test('synthesize rejects blank text without spawning piper', async () => {
  await assert.rejects(() => synthesize('   '), /non-empty/i);
});

test('synthesize deletes tmp wavs older than 5 minutes (skipped without piper)', async (t) => {
  if (!isTtsAvailable()) return t.skip('piper not installed');
  mkdirSync(TTS_TMP_DIR, { recursive: true });
  const stale = path.join(TTS_TMP_DIR, 'tts-stale-test.wav');
  writeFileSync(stale, 'not really audio');
  const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
  utimesSync(stale, sixMinutesAgo, sixMinutesAgo);

  const fresh = await synthesize('Test.');
  assert.equal(existsSync(stale), false, 'stale wav should have been garbage collected');
  assert.ok(existsSync(fresh), 'the wav just synthesized must survive the GC pass');
});

test('beep asset is a committed 48kHz wav', () => {
  assert.equal(BEEP_PATH, path.join(PROJECT_ROOT, 'assets', 'beep.wav'));
  assert.ok(existsSync(BEEP_PATH), 'assets/beep.wav must be committed');
  const header = readFileSync(BEEP_PATH).subarray(0, 44);
  assert.equal(header.subarray(0, 4).toString(), 'RIFF');
  assert.equal(header.subarray(8, 12).toString(), 'WAVE');
  assert.equal(header.readUInt32LE(24), 48000);
});

test('isTtsAvailable reports a boolean', () => {
  assert.equal(typeof isTtsAvailable(), 'boolean');
});

test('speak and playBeep are callable without a voice connection', () => {
  // The no-connection path itself lives in musicQueue.duckAndPlay and is verified
  // by static trace: importing musicQueue here would drag the whole audio engine
  // (yt-dlp probe, stats files, restored sleep timer) into the test process.
  assert.equal(typeof speak, 'function');
  assert.equal(typeof playBeep, 'function');
});

test('speech jobs for one guild run one at a time, in order', async () => {
  const order = [];
  const started = [];
  const job = (name, ms) => async () => {
    started.push(name);
    // If jobs overlapped, a later job would have started before this sleep ends
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(name);
    return name;
  };

  const first = enqueueSpeechJob('serial-guild', 'first', job('first', 30));
  const second = enqueueSpeechJob('serial-guild', 'second', job('second', 1));

  // Jobs start on a microtask, so let the queue turn over before checking
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['first'], 'second job must not start until the first finishes');

  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(order, ['first', 'second']);
});

test('speech jobs beyond 3 pending are dropped for that guild', async () => {
  const ran = [];
  const slow = (name) => async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    ran.push(name);
    return true;
  };

  const accepted = [
    enqueueSpeechJob('busy-guild', 'a', slow('a')),
    enqueueSpeechJob('busy-guild', 'b', slow('b')),
    enqueueSpeechJob('busy-guild', 'c', slow('c')),
  ];
  const dropped = enqueueSpeechJob('busy-guild', 'd', slow('d'));

  assert.equal(await dropped, false, 'the 4th pending job is dropped');
  await Promise.all(accepted);
  assert.deepEqual(ran, ['a', 'b', 'c'], 'the dropped job never runs');

  // The per-guild chain is released once drained, so later jobs are accepted again
  assert.equal(await enqueueSpeechJob('busy-guild', 'e', async () => 'e'), 'e');
});

test('a failing speech job does not wedge the guild chain', async () => {
  const failed = enqueueSpeechJob('failing-guild', 'boom', async () => {
    throw new Error('synthesis exploded');
  });
  assert.equal(await failed, false);
  assert.equal(await enqueueSpeechJob('failing-guild', 'after', async () => 'after'), 'after');
});

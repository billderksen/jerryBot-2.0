import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWavHeader } from '../src/utils/voiceRecorder.js';
import { DEFAULT_TRANSCRIBE_PROMPT, padShortClip } from '../src/utils/speech/transcribe.js';

test('buildWavHeader options: 16k mono header fields', () => {
  const h = buildWavHeader(32000, { sampleRate: 16000, channels: 1 });
  assert.equal(h.length, 44);
  assert.equal(h.readUInt32LE(24), 16000);      // sample rate
  assert.equal(h.readUInt32LE(28), 32000);      // byteRate = 16000*1*2
  assert.equal(h.readUInt16LE(32), 2);          // blockAlign = 1*2
  assert.equal(h.readUInt32LE(40), 32000);      // data size
});

test('buildWavHeader default args unchanged (48k stereo)', () => {
  const h = buildWavHeader(384000);
  assert.equal(h.readUInt32LE(24), 48000);
  assert.equal(h.readUInt32LE(28), 192000);
  assert.equal(h.readUInt16LE(32), 4);
});

// --- short-clip padding ----------------------------------------------------
// 16k mono, 2 bytes/sample = 32 bytes/ms. Clips under 1.2s (38400 B) are padded
// with trailing silence to 1.5s (48000 B); Whisper decodes a lone word far more
// reliably that way than as a bare 300ms fragment.
const BYTES_PER_MS_16K = 32;

test('padShortClip: a 300ms "pauze" is padded out to 1.5s', () => {
  const clip = Buffer.alloc(300 * BYTES_PER_MS_16K, 0x7f);
  const padded = padShortClip(clip, 16000);
  assert.equal(padded.length, 48000);
  // The speech is untouched at the front, and everything added behind it is silence.
  assert.ok(padded.subarray(0, clip.length).equals(clip));
  assert.ok(padded.subarray(clip.length).every((b) => b === 0), 'padding is trailing silence');
});

test('padShortClip: a clip at or over the 1.2s threshold is returned as-is', () => {
  const atThreshold = Buffer.alloc(1200 * BYTES_PER_MS_16K);
  assert.equal(padShortClip(atThreshold, 16000), atThreshold, 'exactly 1.2s is not padded');

  const long = Buffer.alloc(5000 * BYTES_PER_MS_16K);
  assert.equal(padShortClip(long, 16000).length, long.length);
});

test('padShortClip: the byte math follows the sample rate', () => {
  // Same durations, half the bytes: 8k mono is 16 bytes/ms.
  assert.equal(padShortClip(Buffer.alloc(1000 * 16), 8000).length, 1500 * 16);
  assert.equal(padShortClip(Buffer.alloc(0), 16000).length, 48000);
});

test('transcription prompt: stays well inside Groq\'s 224-token cap', () => {
  // No tokenizer here, so bound it the conservative way: even at 2 chars/token
  // (worse than any real BPE on Dutch prose) the prompt must fit.
  assert.ok(DEFAULT_TRANSCRIBE_PROMPT.length / 2 < 224,
    `prompt is ${DEFAULT_TRANSCRIBE_PROMPT.length} chars`);
  assert.match(DEFAULT_TRANSCRIBE_PROMPT, /pauze/);
});

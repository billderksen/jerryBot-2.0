import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWavHeader } from '../src/utils/voiceRecorder.js';

test('buildWavHeader produces a valid 44-byte RIFF/WAVE header for 48kHz/16-bit/stereo PCM', () => {
  const dataSize = 123456;
  const header = buildWavHeader(dataSize);

  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.readUInt32LE(24), 48000); // sample rate
  assert.equal(header.readUInt32LE(28), 192000); // byte rate (48000 * 2ch * 2 bytes)
  assert.equal(header.readUInt16LE(32), 4); // block align (2ch * 2 bytes)
  assert.equal(header.readUInt16LE(34), 16); // bits per sample
  assert.equal(header.readUInt32LE(40), dataSize); // data chunk size
});

test('RIFF chunk size is 36 + dataSize', () => {
  const dataSize = 1000;
  const header = buildWavHeader(dataSize);
  assert.equal(header.readUInt32LE(4), dataSize + 36);
});

test('handles a zero-length recording without throwing', () => {
  const header = buildWavHeader(0);
  assert.equal(header.length, 44);
  assert.equal(header.readUInt32LE(4), 36);
  assert.equal(header.readUInt32LE(40), 0);
});

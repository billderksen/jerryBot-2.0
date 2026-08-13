import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWavHeader } from '../src/utils/voiceRecorder.js';

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

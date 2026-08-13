import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame } from '../src/utils/speech/wakeword.js';

test('encodeFrame layout: slot byte, LE sample count, LE samples', () => {
  const samples = new Int16Array([0, 1, -1, 32767, -32768]);
  const buf = encodeFrame(3, samples);
  assert.equal(buf.length, 1 + 2 + 10);
  assert.equal(buf.readUInt8(0), 3);
  assert.equal(buf.readUInt16LE(1), 5);
  assert.equal(buf.readInt16LE(3), 0);
  assert.equal(buf.readInt16LE(9), 32767);
  assert.equal(buf.readInt16LE(11), -32768);
});

test('encodeFrame rejects invalid slots', () => {
  assert.throws(() => encodeFrame(-1, new Int16Array(1)));
  assert.throws(() => encodeFrame(16, new Int16Array(1)));
});

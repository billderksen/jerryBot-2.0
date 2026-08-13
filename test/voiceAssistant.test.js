import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
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

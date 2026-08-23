import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildClipArgs, pickSongFrom, isStalePlaatjeFile, cachedClipPath } from '../src/utils/plaatjeAudio.js';

test('buildClipArgs: offset, 75s cap, mp3 128k, geen video, metadata strip', () => {
  const args = buildClipArgs('/tmp/in.opus', '/tmp/out.mp3', 30);
  assert.deepEqual(args, ['-y', '-ss', '30', '-t', '75', '-i', '/tmp/in.opus',
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-map_metadata', '-1', '-f', 'mp3', '/tmp/out.mp3']);
  assert.deepEqual(buildClipArgs('/a', '/b', 0).slice(1, 3), ['-ss', '0']);
});

test('pickSongFrom: nooit een gebruikte song, null bij lege pool', () => {
  const songs = [
    { title: 'A', artist: 'a', year: 1990, youtubeId: 'id_aaaaaaaa' },
    { title: 'B', artist: 'b', year: 2000, youtubeId: 'id_bbbbbbbb' },
  ];
  const used = new Set(['id_aaaaaaaa']);
  for (let i = 0; i < 20; i++) assert.equal(pickSongFrom(songs, used).youtubeId, 'id_bbbbbbbb');
  assert.equal(pickSongFrom(songs, new Set(['id_aaaaaaaa', 'id_bbbbbbbb'])), null);
  assert.equal(pickSongFrom([], new Set()), null);
});

test('isStalePlaatjeFile: stale plaatje file true, fresh false, non-plaatje false', () => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60_000 + 1_000);
  const fiveMinutesAgo = now - (5 * 60_000);
  assert.equal(isStalePlaatjeFile('plaatje_room1_12345', oneHourAgo, now), true);
  assert.equal(isStalePlaatjeFile('plaatje_room2_12345', fiveMinutesAgo, now), false);
  assert.equal(isStalePlaatjeFile('other_file_name', oneHourAgo, now), false);
});

test('cachedClipPath: returns null when cached file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plaatje-test-'));
  assert.equal(cachedClipPath('dQw4w9WgXcQ', dir), null);
});

test('cachedClipPath: returns path when cached file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plaatje-test-'));
  const youtubeId = 'dQw4w9WgXcQ';
  const filePath = join(dir, `${youtubeId}.mp3`);
  writeFileSync(filePath, 'dummy mp3 content');
  assert.equal(cachedClipPath(youtubeId, dir), filePath);
});

test('cachedClipPath: returns null for invalid id even with unspecified dir', () => {
  assert.equal(cachedClipPath('../../etc/passwd'), null);
  assert.equal(cachedClipPath('abc'), null);
  assert.equal(cachedClipPath(''), null);
  assert.equal(cachedClipPath(null), null);
});

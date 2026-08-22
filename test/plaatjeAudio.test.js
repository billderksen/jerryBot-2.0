import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipArgs, pickSongFrom } from '../src/utils/plaatjeAudio.js';

test('buildClipArgs: offset, 75s cap, mp3 128k, geen video', () => {
  const args = buildClipArgs('/tmp/in.opus', '/tmp/out.mp3', 30);
  assert.deepEqual(args, ['-y', '-ss', '30', '-t', '75', '-i', '/tmp/in.opus',
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', '/tmp/out.mp3']);
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

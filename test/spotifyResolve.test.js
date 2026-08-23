// test/spotifyResolve.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpotifyUrl,
  normalizeTrack,
  scoreYouTubeCandidate,
  resolveToYouTube,
  resolveAndQueueSpotifyTracks
} from '../src/utils/spotifyResolve.js';

test('parseSpotifyUrl: track/playlist/album links, with and without locale prefix', () => {
  assert.deepEqual(
    parseSpotifyUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'),
    { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }
  );
  assert.deepEqual(
    parseSpotifyUrl('https://open.spotify.com/intl-nl/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123'),
    { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }
  );
  assert.deepEqual(
    parseSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'),
    { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' }
  );
  assert.deepEqual(
    parseSpotifyUrl('https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX?si=xyz'),
    { type: 'album', id: '1ATL5GLyefJaxhQzSPVrLX' }
  );
});

test('parseSpotifyUrl: spotify: URIs', () => {
  assert.deepEqual(
    parseSpotifyUrl('spotify:track:4uLU6hMCjMI75M1A2tKUQC'),
    { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' }
  );
});

test('parseSpotifyUrl: non-Spotify or malformed input returns null', () => {
  assert.equal(parseSpotifyUrl('https://youtube.com/watch?v=abc'), null);
  assert.equal(parseSpotifyUrl('https://spotify.com/track/abc'), null); // not open.spotify.com
  assert.equal(parseSpotifyUrl('not a url'), null);
  assert.equal(parseSpotifyUrl('https://open.spotify.com/artist/abc'), null); // unsupported type
  assert.equal(parseSpotifyUrl('https://open.spotify.com/track/'), null); // missing id
  assert.equal(parseSpotifyUrl(''), null);
  assert.equal(parseSpotifyUrl(null), null);
  assert.equal(parseSpotifyUrl(undefined), null);
});

test('normalizeTrack: multiple artists joined, duration rounded, largest thumbnail chosen', () => {
  const apiTrack = {
    name: 'Song Title',
    artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    duration_ms: 200499,
    album: {
      images: [
        { url: 'https://img/small.jpg', width: 64 },
        { url: 'https://img/large.jpg', width: 640 },
        { url: 'https://img/medium.jpg', width: 300 }
      ]
    },
    external_urls: { spotify: 'https://open.spotify.com/track/abc' }
  };
  assert.deepEqual(normalizeTrack(apiTrack), {
    title: 'Song Title',
    artist: 'Artist A, Artist B',
    durationSec: 200,
    thumbnail: 'https://img/large.jpg',
    spotifyUrl: 'https://open.spotify.com/track/abc'
  });
});

test('normalizeTrack: single artist, missing images/url degrade to null/empty', () => {
  const apiTrack = {
    name: 'Solo Song',
    artists: [{ name: 'Solo Artist' }],
    duration_ms: 180000
  };
  const result = normalizeTrack(apiTrack);
  assert.equal(result.artist, 'Solo Artist');
  assert.equal(result.durationSec, 180);
  assert.equal(result.thumbnail, null);
  assert.equal(result.spotifyUrl, null);
});

test('normalizeTrack: handles a completely empty/undefined input without throwing', () => {
  assert.deepEqual(normalizeTrack(undefined), {
    title: '',
    artist: '',
    durationSec: 0,
    thumbnail: null,
    spotifyUrl: null
  });
});

test('scoreYouTubeCandidate: remaster variant by the right artist beats karaoke by the wrong channel', () => {
  const track = { title: 'Song', artist: 'Artist A', durationSec: 200 };
  const remaster = { title: 'Song - Remastered 2011', duration: 202, channel: 'Artist A - Topic' };
  const karaoke = { title: 'Song (Karaoke Version)', duration: 200, channel: 'Karaoke Superstar' };

  const remasterScore = scoreYouTubeCandidate(remaster, track);
  const karaokeScore = scoreYouTubeCandidate(karaoke, track);
  assert.ok(remasterScore > karaokeScore,
    `expected remaster (${remasterScore}) to beat karaoke (${karaokeScore})`);
});

test('scoreYouTubeCandidate: a candidate more than 10s off duration loses to an otherwise-equal close one', () => {
  const track = { title: 'Song', artist: 'Artist A', durationSec: 200 };
  const closeDuration = { title: 'Song', duration: 203, channel: 'Artist A' };
  const farDuration = { title: 'Song', duration: 245, channel: 'Artist A' };

  const closeScore = scoreYouTubeCandidate(closeDuration, track);
  const farScore = scoreYouTubeCandidate(farDuration, track);
  assert.ok(closeScore > farScore,
    `expected close-duration (${closeScore}) to beat far-duration (${farScore})`);
});

test('scoreYouTubeCandidate: an exact title+artist match with matching duration scores highly', () => {
  const track = { title: 'Bitter Sweet Symphony', artist: 'The Verve', durationSec: 299 };
  const candidate = { title: 'The Verve - Bitter Sweet Symphony (Official Video)', duration: 299, channel: 'The Verve' };
  assert.ok(scoreYouTubeCandidate(candidate, track) > 0.9);
});

test('resolveToYouTube: picks the highest-scoring ytsearch3 entry', async () => {
  const track = { title: 'Song', artist: 'Artist A', durationSec: 200 };
  const fakeYtDlpExec = async () => ({
    entries: [
      { id: 'karaoke1', title: 'Song (Karaoke Version)', duration: 200, channel: 'Karaoke Channel', url: 'https://www.youtube.com/watch?v=karaoke1' },
      { id: 'best1', title: 'Artist A - Song (Official Audio)', duration: 201, channel: 'Artist A', url: 'https://www.youtube.com/watch?v=best1' }
    ]
  });

  const result = await resolveToYouTube(track, fakeYtDlpExec);
  assert.equal(result.url, 'https://www.youtube.com/watch?v=best1');
  assert.ok(result.confidence > 0.6);
});

test('resolveToYouTube: builds a watch URL from id when the entry has no url field', async () => {
  const track = { title: 'Song', artist: 'Artist A', durationSec: 200 };
  const fakeYtDlpExec = async () => ({
    entries: [{ id: 'onlyid', title: 'Artist A - Song', duration: 200, channel: 'Artist A' }]
  });

  const result = await resolveToYouTube(track, fakeYtDlpExec);
  assert.equal(result.url, 'https://www.youtube.com/watch?v=onlyid');
});

test('resolveToYouTube: returns null only when the search itself returns zero entries', async () => {
  const track = { title: 'Song', artist: 'Artist A', durationSec: 200 };
  const fakeYtDlpExec = async () => ({ entries: [] });
  assert.equal(await resolveToYouTube(track, fakeYtDlpExec), null);
});

test('resolveToYouTube: queries ytsearch3 with artist and title', async () => {
  const track = { title: 'Song Title', artist: 'Artist Name', durationSec: 200 };
  let seenQuery = null;
  const fakeYtDlpExec = async (query) => {
    seenQuery = query;
    return { entries: [{ id: 'x', title: 'Artist Name - Song Title', duration: 200, channel: 'Artist Name' }] };
  };
  await resolveToYouTube(track, fakeYtDlpExec);
  assert.equal(seenQuery, 'ytsearch3:Artist Name Song Title');
});

test('resolveAndQueueSpotifyTracks: resolves each track and hands it to queueTrack, counting added vs. failed', async () => {
  const tracks = [
    { title: 'Found Song', artist: 'Artist A', durationSec: 200, thumbnail: 'https://img/a.jpg' },
    { title: 'Missing Song', artist: 'Artist B', durationSec: 180, thumbnail: null }
  ];
  // One search yields a match, the other yields zero entries (Artist B).
  const fakeYtDlpExec = async (query) => {
    if (query.includes('Artist A')) {
      return { entries: [{ id: 'found1', title: 'Artist A - Found Song', duration: 200, channel: 'Artist A' }] };
    }
    return { entries: [] };
  };
  const queued = [];
  const queueTrack = async (song) => {
    queued.push(song);
    return { success: true };
  };

  const result = await resolveAndQueueSpotifyTracks(tracks, queueTrack, fakeYtDlpExec);

  assert.deepEqual(result, { added: 1, failed: 1, total: 2 });
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0], {
    title: 'Artist A – Found Song',
    artist: 'Artist A',
    url: 'https://www.youtube.com/watch?v=found1',
    thumbnail: 'https://img/a.jpg',
    duration: 200,
    spotify: true
  });
});

test('resolveAndQueueSpotifyTracks: a queueTrack failure ({success: false}) counts as failed, not a thrown error', async () => {
  const tracks = [{ title: 'Song', artist: 'Artist A', durationSec: 200, thumbnail: null }];
  const fakeYtDlpExec = async () => ({
    entries: [{ id: 'x', title: 'Artist A - Song', duration: 200, channel: 'Artist A' }]
  });
  const queueTrack = async () => ({ success: false, error: 'no voice channel' });

  const result = await resolveAndQueueSpotifyTracks(tracks, queueTrack, fakeYtDlpExec);
  assert.deepEqual(result, { added: 0, failed: 1, total: 1 });
});

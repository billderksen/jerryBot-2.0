import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import {
  MusicQueue,
  createQueue,
  isPlayerPaused,
  waitForReadyConnection,
  setWebUpdateCallback,
  DownloadGate,
  DOWNLOAD_PRIORITY,
  DOWNLOAD_403_BACKOFF_MS,
  is403,
  downloadErrorText,
  planDownloadRetry,
  runGatedDownload,
  describeDownloadFailure,
  DownloadAbortedError,
  formatDownloadTiming,
  formatTransition,
  DOWNLOAD_TIMEOUT_MS,
} from '../src/utils/musicQueue.js';

// A voice connection is, as far as this module's lifecycle code is concerned, an EventEmitter
// with a `state.status` that emits the status name on every transition (see VoiceConnection's
// `this.emit(newState.status, ...)`). That is all entersState needs, so the recovery path can
// be driven end to end without Discord.
class FakeConnection extends EventEmitter {
  constructor(status = VoiceConnectionStatus.Ready) {
    super();
    this.state = { status };
    this.destroyCalls = 0;
  }

  to(status) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
    if (old.status !== status) this.emit(status, old, this.state);
  }

  destroy() {
    this.destroyCalls++;
    if (this.state.status === VoiceConnectionStatus.Destroyed) {
      throw new Error('Cannot destroy VoiceConnection - it has already been destroyed');
    }
    this.to(VoiceConnectionStatus.Destroyed);
  }
}

// Builds a queue wired to a fake connection, with listening-stat crediting recorded rather
// than performed - trackAndClearListening() writes through to the shared, on-disk stats.
function buildQueue(guildId, connectionStatus = VoiceConnectionStatus.Ready) {
  const queue = new MusicQueue(guildId);
  const connection = new FakeConnection(connectionStatus);
  queue.connection = connection;
  queue.listenerConnection = connection;
  queue.credited = 0;
  queue.trackAndClearListening = () => { queue.credited++; };
  return { queue, connection };
}

// --- paused mapping --------------------------------------------------------

test('isPlayerPaused: an explicit pause reads as paused', () => {
  assert.equal(isPlayerPaused(AudioPlayerStatus.Paused), true);
});

test('isPlayerPaused: AutoPaused reads as paused, not as playing', () => {
  // @discordjs/voice parks the player here the moment no subscribed connection is Ready.
  // Reporting it as playing is what showed a running progress bar over a dead voice link.
  assert.equal(isPlayerPaused(AudioPlayerStatus.AutoPaused), true);
});

test('isPlayerPaused: playing, buffering and idle are not paused', () => {
  assert.equal(isPlayerPaused(AudioPlayerStatus.Playing), false);
  assert.equal(isPlayerPaused(AudioPlayerStatus.Buffering), false);
  assert.equal(isPlayerPaused(AudioPlayerStatus.Idle), false);
});

// --- bounded wait for a usable connection ----------------------------------

test('waitForReadyConnection: a connection that is Ready and stays Ready recovers', async () => {
  const connection = new FakeConnection(VoiceConnectionStatus.Ready);
  assert.equal(await waitForReadyConnection(connection, 200, 20), true);
});

test('waitForReadyConnection: Ready at the instant of the error does not count if it drops', async () => {
  // The incident's shape: the 'error' arrives before the WebSocket close that caused it, so
  // the status still reads Ready. Judging on that instant would call a dead link recovered.
  const connection = new FakeConnection(VoiceConnectionStatus.Ready);
  setTimeout(() => connection.to(VoiceConnectionStatus.Signalling), 5);
  assert.equal(await waitForReadyConnection(connection, 150, 30), false);
});

test('waitForReadyConnection: a reconnect inside the window recovers', async () => {
  const connection = new FakeConnection(VoiceConnectionStatus.Signalling);
  setTimeout(() => connection.to(VoiceConnectionStatus.Ready), 40);
  assert.equal(await waitForReadyConnection(connection, 400, 20), true);
});

test('waitForReadyConnection: passing through Ready on the way back out does not count', async () => {
  const connection = new FakeConnection(VoiceConnectionStatus.Signalling);
  setTimeout(() => connection.to(VoiceConnectionStatus.Ready), 20);
  setTimeout(() => connection.to(VoiceConnectionStatus.Connecting), 30);
  assert.equal(await waitForReadyConnection(connection, 200, 40), false);
});

test('waitForReadyConnection: a connection that never comes back gives up inside the window', async () => {
  const connection = new FakeConnection(VoiceConnectionStatus.Signalling);
  const startedAt = Date.now();
  assert.equal(await waitForReadyConnection(connection, 150, 20), false);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 140, `gave up after ${elapsed}ms, expected to use the window`);
  assert.ok(elapsed < 1000, `took ${elapsed}ms, expected the window to bound it`);
});

test('waitForReadyConnection: a destroyed connection gives up without waiting out the window', async () => {
  const connection = new FakeConnection(VoiceConnectionStatus.Destroyed);
  const startedAt = Date.now();
  assert.equal(await waitForReadyConnection(connection, 5000, 20), false);
  assert.ok(Date.now() - startedAt < 500, 'should not sit out the full window');
});

// --- playback clock across a connection gap --------------------------------

test('closePlaybackGap: dead air is credited to paused time, not to playback', () => {
  const { queue } = buildQueue('gap-credit');
  queue.songStartTime = Date.now() - 10_000;

  const gapStartedAt = Date.now() - 3_000;
  queue.pausedAt = gapStartedAt;
  // Frozen while the connection is away, so the dashboard cannot run ahead of the audio
  assert.ok(Math.abs(queue.getPlaybackElapsedMs() - 7_000) < 50);

  queue.closePlaybackGap(gapStartedAt);
  assert.equal(queue.pausedAt, null);
  assert.ok(Math.abs(queue.totalPausedMs - 3_000) < 50);
  // Still 7s of real playback: the gap was not silently handed to the progress bar
  assert.ok(Math.abs(queue.getPlaybackElapsedMs() - 7_000) < 50);
});

test('closePlaybackGap: a user pause that landed during the gap keeps the clock stopped', () => {
  const { queue } = buildQueue('gap-user-pause');
  queue.songStartTime = Date.now() - 10_000;
  const gapStartedAt = Date.now() - 2_000;
  queue.pausedAt = gapStartedAt;
  queue.player = { state: { status: AudioPlayerStatus.Paused } };

  queue.closePlaybackGap(gapStartedAt);
  assert.notEqual(queue.pausedAt, null, 'the user is still paused, so the clock stays stopped');
  assert.ok(Math.abs(queue.totalPausedMs - 2_000) < 50);
});

test('closePlaybackGap: a clock another pause took over is left alone', () => {
  const { queue } = buildQueue('gap-taken-over');
  queue.songStartTime = Date.now() - 10_000;
  const gapStartedAt = Date.now() - 5_000;
  // A new song, a seek or a ducked clip moved the clock while the connection was away
  const otherPause = Date.now() - 1_000;
  queue.pausedAt = otherPause;

  queue.closePlaybackGap(gapStartedAt);
  assert.equal(queue.pausedAt, otherPause);
  assert.equal(queue.totalPausedMs, 0);
});

test('closePlaybackGap: no gap was claimed, nothing to close', () => {
  const { queue } = buildQueue('gap-none');
  queue.songStartTime = Date.now() - 10_000;
  queue.closePlaybackGap(null);
  assert.equal(queue.pausedAt, null);
  assert.equal(queue.totalPausedMs, 0);
});

// --- recovery from a connection error --------------------------------------

test('connection error: a connection that stays Ready keeps playing, with an honest position', async () => {
  const { queue, connection } = buildQueue('err-transient');
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };
  queue.songStartTime = Date.now() - 8_000;

  await queue.recoverFromConnectionError(connection);

  assert.equal(queue.isPlaying, true, 'playback was not torn down');
  assert.equal(queue.connection, connection, 'the connection was kept');
  assert.equal(connection.destroyCalls, 0);
  assert.equal(queue.credited, 0, 'nothing ended, so no listening time was booked');
  assert.equal(queue.pausedAt, null, 'the clock is running again');
  // The wait itself is dead air and is credited as paused, so the position does not jump
  assert.ok(queue.totalPausedMs > 0, 'the gap was credited');
  assert.ok(Math.abs(queue.getPlaybackElapsedMs() - 8_000) < 250);
});

test('connection error: a connection that is gone tears down to a stopped queue', async () => {
  const { queue, connection } = buildQueue('err-fatal');
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };
  queue.songStartTime = Date.now() - 8_000;
  queue.songs = [{ title: 'Next', url: 'https://example.com/y' }];

  connection.to(VoiceConnectionStatus.Destroyed);
  await queue.recoverFromConnectionError(connection);

  assert.equal(queue.isPlaying, false, 'the queue no longer claims to be playing');
  assert.equal(queue.currentSong, null);
  assert.equal(queue.connection, null);
  assert.deepEqual(queue.songs, []);
  assert.equal(queue.credited, 1, 'what was heard before the failure was booked exactly once');
  assert.equal(queue.destroying, false, 'the queue is usable again, not stuck mid-teardown');
});

test('connection error: the dashboard is told the queue stopped, not that it is paused', async () => {
  const guildId = 'err-broadcast';
  const queue = createQueue(guildId);
  const connection = new FakeConnection(VoiceConnectionStatus.Destroyed);
  queue.connection = connection;
  queue.listenerConnection = connection;
  queue.trackAndClearListening = () => {};
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };
  queue.songStartTime = Date.now() - 8_000;
  // What @discordjs/voice does to a player the moment no subscribed connection is Ready: it
  // parks the resource rather than consuming it. Standing in for it here because a real
  // player only reaches AutoPaused by being handed a resource and a live connection.
  queue.player = { state: { status: AudioPlayerStatus.AutoPaused }, stop() {} };

  const states = [];
  setWebUpdateCallback(state => states.push(state));
  try {
    await queue.recoverFromConnectionError(connection);
  } finally {
    setWebUpdateCallback(null);
  }

  // While the window is open the state is honest about the music not progressing...
  assert.ok(states.length >= 2, `expected a gap broadcast and a teardown broadcast, got ${states.length}`);
  assert.equal(states[0].isPlaying, true);
  assert.equal(states[0].isPaused, true);

  // ...and once it closes, the end state is stopped rather than the zombie playing-paused
  const final = states[states.length - 1];
  assert.equal(final.isPlaying, false);
  assert.equal(final.isPaused, false);
  assert.equal(final.currentSong, null);
});

test('connection error: a storm of errors runs one recovery and one teardown', async () => {
  const { queue, connection } = buildQueue('err-storm');
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };
  queue.songStartTime = Date.now() - 8_000;
  connection.to(VoiceConnectionStatus.Destroyed);

  // Five in a row, the first four before any of them have had a chance to settle
  const inFlight = [];
  for (let i = 0; i < 5; i++) inFlight.push(queue.recoverFromConnectionError(connection));
  await Promise.all(inFlight);

  assert.equal(queue.credited, 1, 'listening time booked once, not five times');
  assert.equal(queue.isPlaying, false);
  assert.equal(queue.connectionRecovery, null, 'the guard was released');
  // destroy() throws on an already-destroyed connection, so a second teardown would have
  // taken the process down rather than just double-counting
  assert.equal(connection.destroyCalls, 0, 'an already-destroyed connection is not destroyed again');
});

test('connection error: a later error starts a fresh recovery', async () => {
  const { queue, connection } = buildQueue('err-sequential');
  await queue.recoverFromConnectionError(connection);
  assert.equal(queue.connectionRecovery, null);

  // Still Ready, so the second error is judged on its own merits rather than being swallowed
  queue.songStartTime = Date.now() - 1_000;
  await queue.recoverFromConnectionError(connection);
  assert.equal(queue.connection, connection);
  assert.equal(connection.destroyCalls, 0);
});

test('connection error: an idle queue with nothing playing fails clean', async () => {
  const { queue, connection } = buildQueue('err-idle');
  connection.to(VoiceConnectionStatus.Destroyed);

  await queue.recoverFromConnectionError(connection);

  assert.equal(queue.isPlaying, false);
  assert.equal(queue.connection, null);
  assert.equal(queue.credited, 1, 'the teardown asks; the no-op is decided inside');
  assert.equal(queue.songStartTime, null);
});

test('connection error: a queue already tearing down is left to finish', async () => {
  const { queue, connection } = buildQueue('err-destroying');
  queue.destroying = true;

  await queue.recoverFromConnectionError(connection);

  assert.equal(connection.destroyCalls, 0);
  assert.equal(queue.credited, 0);
  assert.equal(queue.connectionRecovery, null);
});

test('connection error: a failure from a replaced connection does not stop the live one', async () => {
  const { queue, connection: stale } = buildQueue('err-stale');
  const live = new FakeConnection(VoiceConnectionStatus.Ready);
  queue.connection = live;
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x' };

  // The error handler is bound to the connection it was attached to, so this is what a late
  // event from a connection the queue has already moved off looks like
  await queue.recoverFromConnectionError(stale);
  queue.teardownConnection('error unrecoverable', stale);

  assert.equal(queue.isPlaying, true, 'the live connection kept playing');
  assert.equal(queue.connection, live);
  assert.equal(queue.credited, 0);
  assert.equal(stale.state.status, VoiceConnectionStatus.Destroyed, 'the stale connection went');
});

// --- teardown ordering -----------------------------------------------------

test('teardownConnection: a queue that already tore down is not cleaned up twice', () => {
  // The Disconnected race can still be running when an error teardown completes, and expires
  // a few seconds later against a connection the queue has since let go of. cleanup() fires
  // the presence and now-playing-log callbacks, which are global - a second run would clear
  // the presence and re-log whatever a newer queue had started playing by then.
  const { queue, connection } = buildQueue('teardown-twice');
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x' };
  queue.songStartTime = Date.now() - 4_000;

  let cleanups = 0;
  const runCleanup = queue.cleanup.bind(queue);
  queue.cleanup = () => { cleanups++; runCleanup(); };

  queue.teardownConnection('error unrecoverable', connection);
  assert.equal(cleanups, 1);
  assert.equal(queue.connection, null);

  // The Disconnected race expires afterwards, on the same (now destroyed) connection
  queue.teardownConnection('disconnected', connection);
  assert.equal(cleanups, 1, 'the late failure did not run a second cleanup');
  assert.equal(queue.credited, 1, 'nor booked listening time a second time');
  assert.equal(connection.destroyCalls, 1, 'nor destroyed an already-destroyed connection');
});

test('the player parking itself tells the dashboard, rather than going quiet', () => {
  // Without this the last thing the browser hears is "playing", and it runs its own progress
  // bar on from there - the position interval stops on its next tick without a final update.
  const guildId = 'autopause-broadcast';
  const queue = createQueue(guildId);
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };
  queue.songStartTime = Date.now() - 8_000;

  const states = [];
  setWebUpdateCallback(state => states.push(state));
  try {
    // Driven through the real player's state setter, which is what emits the status event
    queue.player.state = { status: AudioPlayerStatus.AutoPaused };
  } finally {
    setWebUpdateCallback(null);
    queue.cleanup();
  }

  assert.equal(states.length, 1, 'parking the player broadcast exactly once');
  assert.equal(states[0].isPlaying, true);
  assert.equal(states[0].isPaused, true, 'reported as paused, not as playing');
});

test('teardownConnection: credits listening before cleanup clears the clock', () => {
  const { queue, connection } = buildQueue('teardown-order');
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x' };
  queue.songStartTime = Date.now() - 4_000;

  let songStartTimeWhenCredited = 'never credited';
  queue.trackAndClearListening = () => { songStartTimeWhenCredited = queue.songStartTime; };

  queue.teardownConnection('disconnected', connection);

  assert.notEqual(songStartTimeWhenCredited, 'never credited');
  assert.notEqual(songStartTimeWhenCredited, null, 'the clock was still readable when credited');
  assert.equal(queue.songStartTime, null, 'and cleared afterwards');
  assert.equal(connection.destroyCalls, 1);
  assert.equal(queue.isPlaying, false);
});

// --- serialized, 403-tolerant downloads -------------------------------------

// Lets every pending microtask settle, so "did this job get the slot?" can be asked
// without racing the promise plumbing
const tick = () => new Promise(resolve => setImmediate(resolve));

// What a rate-limited fetch actually looks like coming out of yt-dlp-exec: an execa error
// whose message is about the exit code and whose stderr carries the reason
const forbidden = () => Object.assign(
  new Error('Command failed with exit code 1: yt-dlp https://www.youtube.com/watch?v=qrCRgIu2QtU'),
  { stderr: 'ERROR: unable to download video data: HTTP Error 403: Forbidden' }
);

test('is403: recognises the rate-limit yt-dlp reports on video data', () => {
  assert.equal(is403('ERROR: unable to download video data: HTTP Error 403: Forbidden'), true);
  assert.equal(is403('HTTP Error 403: Forbidden'), true);
  assert.equal(is403('urlopen error 403 Forbidden'), true);
});

test('is403: a bare 403 in an id or a title is not a rate-limit', () => {
  // The retry is three attempts and ten seconds of waiting - spending it on a dead video
  // because its id happens to contain three digits is exactly what this guards
  assert.equal(is403('ERROR: [youtube] a403bcdefgh: Video unavailable'), false);
  assert.equal(is403('ERROR: HTTP Error 429: Too Many Requests'), false);
  assert.equal(is403(''), false);
  assert.equal(is403(null), false);
});

test('downloadErrorText: reads the reason wherever execa left it', () => {
  assert.match(downloadErrorText(forbidden()), /403/);
  assert.match(downloadErrorText(new Error('HTTP Error 403: Forbidden')), /403/);
  assert.equal(downloadErrorText(null), '');
});

test('planDownloadRetry: three attempts on a 403, waiting 500ms then 3s', () => {
  // The first hop is near-immediate because a retry re-resolves a fresh googlevideo URL,
  // which is what actually clears these 403s - the old 3s wait bought nothing and was paid
  // on roughly half of all downloads. Three attempts still, and the second wait stays long.
  const text = 'HTTP Error 403: Forbidden';
  assert.deepEqual(DOWNLOAD_403_BACKOFF_MS, [500, 3000]);
  assert.deepEqual(planDownloadRetry(1, text), { retry: true, delayMs: 500 });
  assert.deepEqual(planDownloadRetry(2, text), { retry: true, delayMs: 3000 });
  assert.deepEqual(planDownloadRetry(3, text), { retry: false, delayMs: 0 }, 'the schedule is exhausted');
});

test('planDownloadRetry: the fast first hop cannot silently become the whole schedule', () => {
  // A 403 that survives a re-resolution is a different animal, and hammering it three times
  // in 1.5s would be the burst behaviour the gate was built to stop
  assert.equal(DOWNLOAD_403_BACKOFF_MS.length, 2, 'still three attempts in all');
  assert.ok(DOWNLOAD_403_BACKOFF_MS[0] <= 1000, 'the first retry is near-immediate');
  assert.ok(DOWNLOAD_403_BACKOFF_MS[1] >= 3000, 'the second still waits');
});

test('planDownloadRetry: anything that is not a 403 keeps the single-attempt behaviour', () => {
  assert.deepEqual(planDownloadRetry(1, 'ERROR: Video unavailable'), { retry: false, delayMs: 0 });
});

test('DownloadGate: a second job waits for the first to let go', async () => {
  const gate = new DownloadGate(1);
  const releaseFirst = await gate.acquire();

  let secondRan = false;
  const second = gate.acquire().then(release => { secondRan = true; release(); });

  await tick();
  assert.equal(secondRan, false, 'the one slot is taken');
  releaseFirst();
  await second;
  assert.equal(secondRan, true);
  assert.equal(gate.active, 0);
});

test('DownloadGate: starting a song jumps the queued cache jobs, which keep their order', async () => {
  const gate = new DownloadGate(1);
  const order = [];
  const release = await gate.acquire(DOWNLOAD_PRIORITY.CACHE);

  const jobs = [
    gate.acquire(DOWNLOAD_PRIORITY.CACHE).then(r => { order.push('cache-1'); r(); }),
    gate.acquire(DOWNLOAD_PRIORITY.CACHE).then(r => { order.push('cache-2'); r(); }),
    gate.acquire(DOWNLOAD_PRIORITY.PLAY).then(r => { order.push('play'); r(); }),
  ];

  release();
  await Promise.all(jobs);
  assert.deepEqual(order, ['play', 'cache-1', 'cache-2']);
  assert.equal(gate.active, 0);
});

test('DownloadGate: a job that throws still frees the slot', async () => {
  const gate = new DownloadGate(1);
  await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(gate.active, 0, 'a failed download does not wedge every later one');
  assert.equal(await gate.run(async () => 'ran'), 'ran');
});

test('DownloadGate: releasing twice hands the slot over once', async () => {
  const gate = new DownloadGate(1);
  const releaseFirst = await gate.acquire();
  const second = gate.acquire();

  releaseFirst();
  releaseFirst();

  const releaseSecond = await second;
  assert.equal(gate.active, 1, 'the slot was handed over, not duplicated');
  releaseSecond();
  assert.equal(gate.active, 0);
});

test('runGatedDownload: a 403 is retried on the schedule, then reported as rate-limited', async () => {
  const gate = new DownloadGate(1);
  const attemptsSeen = [];
  const startedAt = Date.now();

  await assert.rejects(
    runGatedDownload(attempt => { attemptsSeen.push(attempt); throw forbidden(); },
      { gate, schedule: [20, 40], label: 'test fetch' }),
    error => {
      assert.equal(error.rateLimited, true, 'tagged, so the skip can say why');
      assert.equal(error.attempts, 3);
      return true;
    }
  );

  assert.deepEqual(attemptsSeen, [1, 2, 3], 'three attempts, and only three');
  assert.ok(Date.now() - startedAt >= 50, 'it actually waited between them');
  assert.equal(gate.active, 0);
});

test('runGatedDownload: a dead video fails on the first attempt, as before', async () => {
  const gate = new DownloadGate(1);
  let calls = 0;

  await assert.rejects(
    runGatedDownload(() => { calls++; throw new Error('ERROR: Video unavailable'); },
      { gate, schedule: [5, 5] }),
    error => {
      assert.equal(error.rateLimited, undefined, 'not a rate-limit, so not reported as one');
      return /Video unavailable/.test(error.message);
    }
  );
  assert.equal(calls, 1);
});

test('runGatedDownload: the backoff waits outside the gate, so the slot stays useful', async () => {
  const gate = new DownloadGate(1);
  let attempts = 0;
  const flaky = runGatedDownload(() => {
    attempts++;
    if (attempts === 1) throw forbidden();
    return 'audio';
  }, { gate, schedule: [60, 60] });

  await tick(); // the first attempt has failed and is now backing off
  let attemptsWhenProbeRan = null;
  await gate.run(async () => { attemptsWhenProbeRan = attempts; });

  assert.equal(attemptsWhenProbeRan, 1, 'the probe got the slot while the retry was still waiting');
  assert.equal(await flaky, 'audio');
});

test('runGatedDownload: a job whose song is already gone never fetches anything', async () => {
  const gate = new DownloadGate(1);
  let calls = 0;

  await assert.rejects(
    runGatedDownload(() => { calls++; }, { gate, abortReason: () => 'the song changed' }),
    error => error.aborted === true
  );
  assert.equal(calls, 0);
  assert.equal(gate.active, 0, 'and it did not take the slot to find that out');
});

test('runGatedDownload: a cache job queued behind a download drops itself if its song is skipped', async () => {
  const gate = new DownloadGate(1);
  const held = await gate.acquire(DOWNLOAD_PRIORITY.PLAY);
  let songChanged = false;
  let calls = 0;

  const cacheJob = runGatedDownload(() => { calls++; return 'audio'; }, {
    gate,
    priority: DOWNLOAD_PRIORITY.CACHE,
    abortReason: () => (songChanged ? 'the song changed' : null)
  });

  await tick();
  assert.equal(calls, 0, 'it is queued behind the play-path download');

  // The song it was caching gets skipped while it waits - without the re-check after
  // acquiring, this would spend a serialized slot downloading a file to delete
  songChanged = true;
  held();

  await assert.rejects(cacheJob, error => error.aborted === true);
  assert.equal(calls, 0, 'the slot came free and nothing was downloaded');
  assert.equal(gate.active, 0);
});

test('runGatedDownload: a teardown during the backoff stops the retries there', async () => {
  const gate = new DownloadGate(1);
  let tornDown = false;
  let calls = 0;

  await assert.rejects(
    runGatedDownload(() => { calls++; tornDown = true; throw forbidden(); }, {
      gate,
      schedule: [10, 10],
      abortReason: () => (tornDown ? 'the queue is being torn down' : null)
    }),
    error => error.aborted === true && /torn down/.test(error.message)
  );
  assert.equal(calls, 1, 'no second attempt once nobody is waiting for the audio');
  assert.equal(gate.active, 0);
});

test('describeDownloadFailure: a rate-limited skip says so, in one line', () => {
  const rateLimited = Object.assign(new Error('Command failed with exit code 1'), { rateLimited: true, attempts: 3 });
  assert.equal(describeDownloadFailure(rateLimited), 'YouTube rate-limited this download (3 attempts)');
  assert.equal(describeDownloadFailure(new Error('Video unavailable')), 'Video unavailable');
});

test('describeDownloadFailure: a download that hung says so too', () => {
  const timedOut = Object.assign(new Error('Command timed out after 60000 milliseconds'), { timedOut: true });
  assert.equal(describeDownloadFailure(timedOut), `the download did not finish within ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
});

test('downloadAbortReason: a fetch is dropped once the song it belongs to has moved on', () => {
  const queue = new MusicQueue('download-abort-reason');
  const gen = queue.cacheGeneration;
  assert.equal(queue.downloadAbortReason(gen), null);

  // The one thing play(), playNext() and cleanup() all go through
  queue.cleanupCachedAudio();
  assert.match(queue.downloadAbortReason(gen), /song changed/);

  const current = queue.cacheGeneration;
  assert.equal(queue.downloadAbortReason(current), null);
  queue.destroying = true;
  assert.match(queue.downloadAbortReason(current), /torn down/);
});

test('an invalidated download is stopped, not just ignored', () => {
  // Its file is thrown away either way - but the audio is downloaded before it is played
  // now, so leaving a doomed download running holds the slot the next song needs to start
  const queue = new MusicQueue('download-abort-kill');
  let kills = 0;
  queue.downloadProcess = { kill: () => { kills++; } };

  queue.cleanupCachedAudio();

  assert.equal(kills, 1);
  assert.equal(queue.downloadProcess, null);
  assert.equal(queue.abortDownload(), false, 'nothing left to stop');
});

// --- download-then-play ------------------------------------------------------

// Drives play() without the network or ffmpeg. The download becomes a controllable stub and
// playback is recorded rather than performed.
//
// playNext is stubbed to the part of its contract these tests care about: the real one
// writes to the shared recently-played file and, on an empty queue, reaches for the radio
// (a live yt-dlp call). It is covered by its own tests elsewhere.
function buildDownloadQueue(guildId) {
  const queue = new MusicQueue(guildId);
  // Keeps play() off the shared recently-played and listening-stats files. Pinned rather
  // than assigned: play() clears the flag as it consumes it, so a plain `= true` only ever
  // protected the first song, and a test that played a second one wrote fictional play
  // counts into data/listeningStats.json - and armed the 30s debounced save that writes it.
  Object.defineProperty(queue, 'playingFromHistory', { get: () => true, set: () => {} });
  queue.played = [];
  queue.playNextCalls = 0;
  queue.playFromCache = function (seconds) { this.played.push({ path: this.cachedAudioPath, seconds }); };
  queue.playNext = async function () {
    this.playNextCalls++;
    this.currentSong = null;
    this.isPlaying = false;
  };
  return queue;
}

// Records what the module logs, so a test can assert on the line a human reads in `pm2 logs`
function captureConsole() {
  const lines = [];
  const real = { error: console.error, log: console.log, warn: console.warn };
  const record = (...args) => lines.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(' '));
  console.error = record;
  console.log = record;
  console.warn = record;
  return {
    find: (pattern) => lines.some(line => pattern.test(line)),
    dump: () => `logged:\n${lines.join('\n')}`,
    restore: () => Object.assign(console, real)
  };
}

const aSong = (title = 'Gragas - Gangsta Paradise (AI Cover)', url = 'https://www.youtube.com/watch?v=qrCRgIu2QtU') => ({
  title,
  url,
  duration: 180,
  requestedBy: 'test'
});

test('(g) the play path hands ffmpeg a local file, never a YouTube URL', async () => {
  // The bug this whole change is about: ffmpeg pulling a googlevideo URL that 403s produces
  // a song with no audio, which the player reports as Idle and the queue skips silently.
  const queue = buildDownloadQueue('play-from-file');
  queue.downloadSongToCache = async () => '/tmp/godcord_test.opus';
  queue.songs = [aSong()];

  await queue.play();

  assert.equal(queue.played.length, 1, 'playback started');
  assert.equal(queue.played[0].path, '/tmp/godcord_test.opus');
  assert.equal(queue.played[0].seconds, 0);
  assert.ok(!/^https?:/.test(queue.played[0].path), 'what ffmpeg opens is a file, not a URL');
  assert.equal(queue.cachedAudioPath, '/tmp/godcord_test.opus', 'and it doubles as the seek cache');
});

test('(a) one media fetch per song - nothing downloads alongside playback', () => {
  // The colliding pair was ffmpeg's stream pull and a second, concurrent yt-dlp download of
  // the same audio. There is no second fetch to collide with any more.
  const queue = new MusicQueue('single-fetch');
  assert.equal(queue.cacheAudioInBackground, undefined, 'the concurrent cache download is gone');
  assert.equal(queue.playFromUrl, undefined, 'and so is the path that streamed from a URL');
});

test('(f) a skip during the download cancels it and moves the queue on at once', async () => {
  const queue = buildDownloadQueue('skip-mid-download');
  let released;
  let kills = 0;
  const downloadStarted = { done: false };
  queue.downloadSongToCache = () => new Promise(resolve => {
    downloadStarted.done = true;
    // The real method parks the yt-dlp child here for the cancellation to find
    queue.downloadProcess = { kill: () => { kills++; } };
    released = () => resolve('/tmp/godcord_skipped.opus');
  });
  queue.songs = [aSong(), aSong('next up')];

  const starting = queue.play();
  await tick();
  assert.equal(downloadStarted.done, true, 'the download is in flight');
  assert.equal(queue.player.state.status, AudioPlayerStatus.Idle, 'with no audio yet');

  const acted = queue.skip();

  assert.equal(kills, 1, 'the yt-dlp child was killed rather than left running');
  assert.equal(queue.playNextCalls, 1, 'the queue advanced immediately, not after the download');
  assert.equal(queue.skipRequested, true, 'and loop mode will not re-queue the skipped song');

  // The download lands afterwards, as it always will - it must not resurrect the song
  released();
  await starting;
  assert.equal(queue.played.length, 0, 'no zombie playback from the cancelled start');
  assert.equal(queue.playNextCalls, 1, 'and the queue was not advanced twice');
});

test('(f) stop() during the download cannot be resurrected by the download landing', async () => {
  const queue = buildDownloadQueue('stop-mid-download');
  let released;
  queue.downloadSongToCache = () => new Promise(resolve => { released = () => resolve('/tmp/godcord_stopped.opus'); });
  queue.songs = [aSong()];

  const starting = queue.play();
  await tick();
  queue.stop();

  assert.equal(queue.songs.length, 0, 'the queue was emptied');
  released();
  await starting;
  assert.equal(queue.played.length, 0, 'the song that was stopped never started playing');
});

test('(b) a genuinely dead video fails once and skips, as before', async () => {
  const queue = buildDownloadQueue('dead-video');
  queue.downloadSongToCache = async () => { throw new Error('ERROR: Video unavailable'); };
  queue.songs = [aSong('a dead one')];

  const logged = captureConsole();
  try {
    await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(queue.consecutiveFailures, 1, 'one failure against the breaker');
  assert.equal(queue.playNextCalls, 1, 'and the queue moved on');
  assert.equal(queue.played.length, 0);
  assert.ok(logged.find(/Skipping "a dead one": ERROR: Video unavailable/), logged.dump());
});

test('(c) a 403 storm skips the song once, saying why', async () => {
  const queue = buildDownloadQueue('rate-limited');
  queue.downloadSongToCache = async () => {
    // What runGatedDownload throws after exhausting the schedule
    throw Object.assign(new Error('Command failed with exit code 1'), { rateLimited: true, attempts: 3 });
  };
  queue.songs = [aSong('a rate-limited one')];

  const logged = captureConsole();
  try {
    await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(queue.consecutiveFailures, 1, 'three attempts, one failure - retries are internal');
  assert.equal(queue.playNextCalls, 1);
  assert.ok(
    logged.find(/Skipping "a rate-limited one": YouTube rate-limited this download \(3 attempts\)/),
    logged.dump()
  );
});

// --- next-song prefetch ------------------------------------------------------

const URL_A = 'https://www.youtube.com/watch?v=qrCRgIu2QtU';
const URL_B = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const URL_C = 'https://www.youtube.com/watch?v=9bZkp7q19f0';
const URL_D = 'https://www.youtube.com/watch?v=kJQP7kiw5Fk';

// Every /tmp file this guild's queue is responsible for. Guild ids are unique per test, so
// this is an exact answer to "did anything get left behind?"
const cacheFilesFor = (guildId) =>
  readdirSync(tmpdir()).filter(f => f.startsWith('godcord') && f.includes(guildId));

// A queue whose playNext() does what the real one does to the state the prefetch cares
// about - end this song, drop its file, start the next - without the recently-played file,
// the listening stats, the 500ms settle, or the radio's live yt-dlp call.
//
// The advancing promise is exposed because the real playNext() is fired and forgotten from
// stopForUserAction(), so a test that skips has no other way to wait for the transition.
function buildTransitionQueue(guildId) {
  const queue = buildDownloadQueue(guildId);
  queue.credited = 0;
  queue.trackAndClearListening = () => { queue.credited++; };
  queue.advancing = Promise.resolve();
  queue.playNext = function () {
    this.playNextCalls++;
    this.skipRequested = false;
    this.advancing = (async () => {
      this.cleanupCachedAudio();
      this.currentSong = null;
      this.isPlaying = false;
      if (this.songs.length > 0) await this.play();
    })();
    return this.advancing;
  };
  return queue;
}

// Replaces yt-dlp, and only yt-dlp. The gate's callers, the abort checks, the real /tmp
// paths and the real unlinking all stay, so these tests watch actual files appear and go.
//
// Each call is a handle: finish() writes the file the download would have produced, fail()
// makes it fail, and kill() (through the child the queue parks) does what cancelling does.
function stubFetches(queue) {
  const calls = [];
  queue.fetchAudioTo = (cachePath, url, title, opts) => {
    // What runGatedDownload checks before it spends an attempt
    const reason = opts.abortReason();
    if (reason) return Promise.reject(new DownloadAbortedError(reason));

    const call = { cachePath, url, title, priority: opts.priority, label: opts.label, settled: false, killed: false };
    call.promise = new Promise((resolve, reject) => {
      const settle = (act) => {
        if (call.settled) return;
        call.settled = true;
        if (queue[opts.childSlot] === call.child) queue[opts.childSlot] = null;
        act();
      };
      call.finish = () => settle(() => { writeFileSync(cachePath, 'audio'); resolve({ attempts: 1, ms: 7 }); });
      call.fail = (error = new Error('ERROR: Video unavailable')) => settle(() => reject(error));
    });
    call.child = { kill: () => { call.killed = true; call.fail(new Error('Command failed with exit code 255')); } };
    queue[opts.childSlot] = call.child;
    calls.push(call);
    return call.promise;
  };
  return calls;
}

// Start the first song and get it playing, so there is something for a prefetch to run under
async function startFirstSong(queue, calls) {
  const starting = queue.play();
  await tick();
  calls[0].finish();
  await starting;
}

test('prefetch: the next song starts downloading as soon as this one is playing', async () => {
  const queue = buildTransitionQueue('prefetch-starts');
  const calls = stubFetches(queue);
  queue.songs = [aSong('now playing', URL_A), aSong('up next', URL_B)];

  await startFirstSong(queue, calls);

  assert.equal(calls.length, 2, 'the song that started, and the one after it');
  assert.equal(calls[1].url, URL_B);
  assert.equal(calls[1].priority, DOWNLOAD_PRIORITY.CACHE, 'behind anything a listener is waiting on');
  assert.equal(calls[0].priority, DOWNLOAD_PRIORITY.PLAY);
  assert.equal(queue.prefetch.url, URL_B);

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-starts'), []);
});

test('prefetch: nothing is prefetched when nothing is playing, or when nothing is queued', async () => {
  const queue = buildTransitionQueue('prefetch-idle');
  const calls = stubFetches(queue);

  // An idle queue's songs[0] is the song play() is about to start for itself, at play
  // priority - prefetching it would be the second concurrent fetch the gate exists to stop
  queue.songs = [aSong('the only one', URL_A)];
  queue.maintainPrefetch();
  assert.equal(calls.length, 0);
  assert.equal(queue.prefetch, null);

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 1, 'and with the queue now empty, there is no next song to fetch');
  assert.equal(queue.prefetch, null);

  queue.cleanup();
});

test('prefetch: a transition that finds the song already downloaded plays it without a download', async () => {
  const queue = buildTransitionQueue('prefetch-hit');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].finish();
  await tick();

  const readyPath = calls[1].cachePath;
  assert.ok(existsSync(readyPath), 'the next song is on disk before anybody needs it');

  await queue.playNext();

  assert.equal(calls.length, 2, 'the transition downloaded nothing at all');
  assert.equal(queue.played.length, 2);
  assert.equal(queue.played[1].path, readyPath, 'it played the file that was already waiting');
  assert.equal(queue.cachedAudioPath, readyPath, 'which is the seek cache from the first second');
  assert.equal(queue.prefetch, null, 'and the entry was consumed, not left attached');
  assert.equal(queue.prefetchHits, 1);
  assert.equal(queue.prefetchMisses, 1, 'the first song had nothing prefetched, as the first never can');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-hit'), []);
});

test('prefetch: a next song that stops being next has its file thrown away, not played', async () => {
  const queue = buildTransitionQueue('prefetch-stale');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].finish();
  await tick();
  const stalePath = calls[1].cachePath;
  assert.ok(existsSync(stalePath));

  // The user drops the song that was next; a different one takes its place
  queue.songs.push(aSong('third', URL_C));
  assert.equal(queue.removeFromQueue(1), true);

  assert.equal(existsSync(stalePath), false, 'the file for a song that is no longer next is gone');
  assert.equal(calls.length, 3, 'and the song that is next now is downloading');
  assert.equal(calls[2].url, URL_C);

  calls[2].finish();
  await tick();
  await queue.playNext();

  assert.equal(queue.played[1].path, calls[2].cachePath, 'the third song played its own audio');
  assert.notEqual(queue.played[1].path, stalePath, 'and never the file fetched for the song it replaced');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-stale'), []);
});

test('prefetch: a replacement never reuses the dropped fetch\'s filename', async () => {
  // Dropping a prefetch and starting its replacement happen in the same millisecond, and the
  // dropped one deletes its file as it unwinds - on a shared name, that delete lands on the
  // new download's output and the song plays half a file or none at all.
  const queue = buildTransitionQueue('prefetch-unique-names');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  queue.songs[0] = aSong('third', URL_C);
  queue.maintainPrefetch();

  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].cachePath, calls[1].cachePath, 'the replacement got a name of its own');
  assert.notEqual(calls[1].cachePath, calls[0].cachePath, 'and a prefetch never shares one with a play download');

  calls[2].finish();
  await tick();
  assert.ok(existsSync(calls[2].cachePath), 'the dropped fetch did not delete the new one\'s file');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-unique-names'), []);
});

test('prefetch: a reorder that changes what plays next re-points it', async () => {
  const queue = buildTransitionQueue('prefetch-reorder');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B), aSong('third', URL_C)];

  await startFirstSong(queue, calls);
  assert.equal(calls[1].url, URL_B);

  // Move the third song to the front of the queue
  assert.equal(queue.reorder(2, 1), true);

  assert.equal(calls[1].killed, true, 'the fetch for the song that was next was stopped');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, URL_C, 'and the song that is next now took its place');
  assert.equal(queue.prefetch.url, URL_C);

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-reorder'), []);
});

test('prefetch: never two in flight, however much the queue is stirred', async () => {
  const queue = buildTransitionQueue('prefetch-single');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B), aSong('third', URL_C)];

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 2, 'one prefetch, of the second song, still running');

  queue.maintainPrefetch();
  queue.maintainPrefetch();
  queue.addSong(aSong('fourth', URL_D));
  queue.reorder(2, 3);   // shuffles the tail, leaves the next song alone

  assert.equal(calls.length, 2, 'the next song never changed, so the running fetch is still the right one');
  assert.equal(calls.filter(c => !c.settled).length, 1, 'and exactly one download is in flight');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-single'), []);
});

test('prefetch: one that fails is silent - it costs the song neither a retry nor a life', async () => {
  const queue = buildTransitionQueue('prefetch-fails');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].fail(Object.assign(new Error('Command failed with exit code 1'), { rateLimited: true, attempts: 3 }));
  await tick();

  assert.equal(queue.consecutiveFailures, 0, 'a background fetch does not spend the song\'s failures');
  assert.deepEqual(queue.songs.map(s => s.url), [URL_B], 'nor drop it from the queue');
  assert.equal(queue.playNextCalls, 0, 'nor move the queue on');

  // ...and the song still plays: the start downloads it properly, exactly as it did before
  const advancing = queue.playNext();
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, URL_B);
  assert.equal(calls[2].priority, DOWNLOAD_PRIORITY.PLAY, 'at play priority, with the play path\'s retries');
  calls[2].finish();
  await advancing;

  assert.equal(queue.played[1].path, calls[2].cachePath);
  assert.equal(queue.prefetchHits, 0);
  assert.equal(queue.prefetchMisses, 2);

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-fails'), []);
});

test('prefetch: a failed one is not started again on the next queue mutation', async () => {
  // Otherwise a song YouTube is refusing turns every reorder into another doomed download
  const queue = buildTransitionQueue('prefetch-no-respin');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].fail();
  await tick();

  queue.maintainPrefetch();
  queue.addSong(aSong('third', URL_C));
  assert.equal(calls.length, 2, 'the song that is next has had its go');

  queue.cleanup();
});

test('prefetch: stopping mid-prefetch stops the fetch and leaves no file behind', async () => {
  const queue = buildTransitionQueue('prefetch-stop');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 2, 'the prefetch is in flight');

  queue.stop();
  await tick();

  assert.equal(calls[1].killed, true, 'the yt-dlp fetching a song nobody will hear was stopped');
  assert.equal(queue.prefetch, null);
  assert.equal(queue.prefetchProcess, null, 'no zombie left parked in the slot');
  assert.deepEqual(queue.songs, []);
  assert.deepEqual(cacheFilesFor('prefetch-stop'), [], 'and /tmp is clean');

  queue.cleanup();
});

test('prefetch: a teardown mid-prefetch takes the file with it', async () => {
  const queue = buildTransitionQueue('prefetch-teardown');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].finish();
  await tick();
  assert.ok(existsSync(calls[1].cachePath));

  queue.cleanup();
  await tick();

  assert.equal(queue.prefetch, null);
  assert.deepEqual(cacheFilesFor('prefetch-teardown'), [], 'both the playing song\'s file and the next one\'s');
});

test('prefetch: a skip takes over the running fetch rather than restarting it', async () => {
  const queue = buildTransitionQueue('prefetch-takeover');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 2, 'the second song is still downloading');

  queue.skip();
  await tick();

  assert.equal(calls.length, 2, 'the seconds already spent on it were not thrown away');
  assert.equal(calls[1].killed, false);
  assert.equal(queue.prefetch.consumedGen, queue.cacheGeneration, 'the start owns that fetch now');

  calls[1].finish();
  await queue.advancing;
  assert.equal(queue.played[1].path, calls[1].cachePath);
  assert.equal(queue.prefetchHits, 1, 'and it still counts as a hit');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-takeover'), []);
});

test('prefetch: cancelling a start that took over a running fetch stops that fetch too', async () => {
  // A consumed prefetch is this song's download, but it is parked in the other slot. Without
  // this it runs on unwatched, holding the one slot the song the user actually wants needs.
  const queue = buildTransitionQueue('prefetch-consumed-kill');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B), aSong('third', URL_C)];

  await startFirstSong(queue, calls);
  queue.skip();
  await tick();
  assert.notEqual(queue.prefetchProcess, null, 'its yt-dlp is running, for the song that is starting');

  queue.skip();  // ...and the user changes their mind again

  assert.equal(calls[1].killed, true, 'the fetch the abandoned start had taken over was stopped');
  assert.equal(queue.prefetchProcess, null);

  await tick();
  assert.equal(calls.length, 3, 'and the third song is being fetched for its own start');
  assert.equal(calls[2].url, URL_C);
  calls[2].finish();
  await queue.advancing;
  assert.equal(queue.played[1].path, calls[2].cachePath, 'no file was played for the wrong song');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-consumed-kill'), []);
});

test('prefetch: two skips in a row leave one fetch in flight and nothing orphaned', async () => {
  const queue = buildTransitionQueue('prefetch-double-skip');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B), aSong('third', URL_C)];

  await startFirstSong(queue, calls);
  calls[1].finish();
  await tick();

  queue.skip();
  await queue.advancing;
  assert.equal(queue.played[1].path, calls[1].cachePath, 'the second song played its prefetched file');
  assert.equal(calls.length, 3, 'and the third started prefetching');

  queue.skip();
  await tick();

  assert.equal(calls.length, 3, 'the running fetch was taken over, not restarted');
  assert.equal(calls.filter(c => !c.settled).length, 1, 'still exactly one download in flight');
  assert.equal(cacheFilesFor('prefetch-double-skip').length, 0, 'the two finished songs took their files with them');

  calls[2].finish();
  await queue.advancing;
  assert.equal(queue.played[2].path, calls[2].cachePath);
  assert.equal(queue.prefetchHits, 2);
  assert.equal(queue.prefetchMisses, 1);
  assert.equal(cacheFilesFor('prefetch-double-skip').length, 1, 'only the song that is playing');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-double-skip'), []);
});

test('prefetch: a user song replacing the radio fill that was next re-points it', async () => {
  const queue = buildTransitionQueue('prefetch-radio');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A)];

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 1, 'nothing queued after it, so nothing to prefetch');

  // The server-side radio tops the queue up while the song plays
  queue.addSong({ ...aSong('radio pick', URL_B), requestedBy: '📻 Radio' });
  assert.equal(calls.length, 2, 'which starts downloading straight away, rather than at the gap');
  calls[1].finish();
  await tick();
  const radioPath = calls[1].cachePath;

  // ...and then a human queues something, which drops the radio picks
  queue.addSong(aSong('a real request', URL_C));

  assert.deepEqual(queue.songs.map(s => s.url), [URL_C]);
  assert.equal(existsSync(radioPath), false, 'the dropped radio pick took its file with it');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, URL_C);

  calls[2].finish();
  await tick();
  await queue.playNext();
  assert.equal(queue.played[1].path, calls[2].cachePath, 'the request played, not the radio pick');
  assert.equal(queue.prefetchHits, 1);

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-radio'), []);
});

test('prefetch: a whole playlist leaves exactly one file on disk at a time', async () => {
  const queue = buildTransitionQueue('prefetch-playlist');
  const calls = stubFetches(queue);
  queue.songs = [
    aSong('one', URL_A), aSong('two', URL_B), aSong('three', URL_C), aSong('four', URL_D)
  ];

  await startFirstSong(queue, calls);
  for (let song = 1; song < 4; song++) {
    calls[calls.length - 1].finish();   // the prefetch lands while the song plays
    await tick();
    assert.equal(cacheFilesFor('prefetch-playlist').length, 2, 'the song playing, and the one after it');
    await queue.playNext();
  }

  assert.equal(queue.played.length, 4, 'all four played');
  assert.equal(queue.prefetchHits, 3, 'and only the first cost a wait');
  assert.equal(queue.prefetchMisses, 1);
  assert.deepEqual(cacheFilesFor('prefetch-playlist').length, 1, 'no orphans piled up along the way');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('prefetch-playlist'), []);
});

// --- timing instrumentation --------------------------------------------------

test('formatDownloadTiming: one line, with the numbers that say whether this is working', () => {
  assert.equal(
    formatDownloadTiming('Gragas - Gangsta Paradise (AI Cover)', 4210, 1),
    '[MusicQueue] downloaded "Gragas - Gangsta Paradise (AI Cover)" in 4210ms (1 attempt)'
  );
  assert.equal(
    formatDownloadTiming('Summertime Sadness', 9800, 2, true),
    '[MusicQueue] downloaded "Summertime Sadness" in 9800ms (2 attempts, prefetched)'
  );
});

test('formatTransition: the hit rate reads straight out of the log', () => {
  assert.equal(formatTransition(true, 'Second', 12, 3), '[MusicQueue] transition: prefetch HIT for "Second" (12 hit / 3 miss)');
  assert.equal(formatTransition(false, 'Second', 12, 4), '[MusicQueue] transition: prefetch MISS for "Second" (12 hit / 4 miss)');
});

test('instrumentation: a transition logs the timing and whether it was a hit', async () => {
  const queue = buildTransitionQueue('prefetch-logging');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('Gragas Cover', URL_B)];

  const logged = captureConsole();
  try {
    await startFirstSong(queue, calls);
    calls[1].finish();
    await tick();
    await queue.playNext();
  } finally {
    logged.restore();
  }

  assert.ok(logged.find(/downloaded "first" in \d+ms \(1 attempt\)$/), logged.dump());
  assert.ok(logged.find(/downloaded "Gragas Cover" in \d+ms \(1 attempt, prefetched\)$/), logged.dump());
  assert.ok(logged.find(/transition: prefetch MISS for "first" \(0 hit \/ 1 miss\)/), logged.dump());
  assert.ok(logged.find(/transition: prefetch HIT for "Gragas Cover" \(1 hit \/ 1 miss\)/), logged.dump());

  queue.cleanup();
  await tick();
});

test('instrumentation: a skip says how long the listener waited for the song that never played', async () => {
  const queue = buildDownloadQueue('skip-reason-timing');
  queue.downloadSongToCache = async () => {
    throw Object.assign(new Error('Command failed with exit code 1'), {
      rateLimited: true, attempts: 3, downloadMs: 4123
    });
  };
  queue.songs = [aSong('a rate-limited one')];

  const logged = captureConsole();
  try {
    await queue.play();
  } finally {
    logged.restore();
  }

  assert.ok(
    logged.find(/Skipping "a rate-limited one": YouTube rate-limited this download \(3 attempts\) after 4123ms/),
    logged.dump()
  );
});

test('a download killed by the cancellation is not reported as a broken song', async () => {
  // Killing the child surfaces as an ordinary subprocess failure, so the error alone cannot
  // tell it apart from a dead video - the generation is what says the queue moved on
  const queue = buildDownloadQueue('killed-not-failed');
  queue.downloadSongToCache = async (url, title, gen) => {
    queue.cacheGeneration++; // the skip that killed it
    throw new Error('Command failed with exit code 255');
  };
  queue.songs = [aSong()];

  const logged = captureConsole();
  try {
    await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(queue.consecutiveFailures, 0, 'not counted against the breaker');
  assert.equal(queue.playNextCalls, 0, 'and not advanced twice - whoever cancelled owns that');
  assert.ok(logged.find(/Gave up starting/), logged.dump());
});

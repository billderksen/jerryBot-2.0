import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { existsSync, readdirSync, writeFileSync, statSync, utimesSync, unlinkSync } from 'fs';
import { execFileSync, execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
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
  getQueue,
  safeTimer,
  positionTick,
  setWebPositionCallback,
  setWebClientCountCallback,
  filterEligibleRadioTracks,
  chooseRadioSeed,
  RADIO_MEMORY_SIZE,
  flushQueueState,
  saveQueueStateNow,
  scheduleQueueStateSave,
  forgetQueueState,
  restoreQueueState,
  describeRestoreHold,
  getRecentlyPlayed,
  planRejoinDelay,
  rejoinAbortReason,
  scheduleRejoin,
  cancelRejoin,
  cancelAllRejoins,
  isRejoinPending,
  setDiscordClient,
  REJOIN_BACKOFF_MS,
  REJOIN_INTERVAL_MS,
  REJOIN_GIVE_UP_MS,
  parseLoudnormJson,
  buildLoudnormFilter,
  measureLoudness,
  loudnessFor,
  rememberLoudness,
  clampCrossfadeSec,
  getMusicSettings,
  DEFAULT_CROSSFADE_SEC,
  MAX_CROSSFADE_SEC,
} from '../src/utils/musicQueue.js';
import {
  setQueueStatePath,
  getQueueStatePath,
  loadQueueState,
  planQueueRestore,
  clampResumePosition,
  QUEUE_STATE_MAX_AGE_MS,
} from '../src/utils/queueState.js';

// Everything below writes queue snapshots to a disposable file rather than to the live bot's
// data/queueState.json - which the restore path would then read on the next real startup.
setQueueStatePath(join(tmpdir(), `jerrybot-test-queueState-${process.pid}.json`));

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

// --- what play() tells its callers -------------------------------------------
//
// play() self-heals: a song it cannot fetch is dropped and the queue moves on. Callers used
// to read "the await resolved" as "the song is playing", so an age-gated or rate-limited song
// was announced as now playing on Discord, toasted as added on the dashboard and confirmed
// out loud by Jerry, with nothing ever correcting any of them.

test('play() outcome: a song that actually started says so, with the song it started', async () => {
  const queue = buildDownloadQueue('outcome-started');
  queue.downloadSongToCache = async () => '/tmp/godcord_outcome.opus';
  queue.songs = [aSong('the one that plays')];

  const outcome = await queue.play();

  assert.equal(outcome.started, true);
  assert.equal(outcome.song.title, 'the one that plays');
});

test('play() outcome: a song that could not be fetched is reported as failed, with the reason', async () => {
  const queue = buildDownloadQueue('outcome-failed');
  queue.downloadSongToCache = async () => { throw new Error('ERROR: Video unavailable'); };
  queue.songs = [aSong('a dead one')];

  const logged = captureConsole();
  let outcome;
  try {
    outcome = await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'failed');
  assert.equal(outcome.detail, 'ERROR: Video unavailable');
  assert.equal(outcome.song.title, 'a dead one', 'the caller can name the song it lost');
  // The self-heal is untouched: the queue still advanced by itself
  assert.equal(queue.playNextCalls, 1);
});

test('play() outcome: a rate-limited song reports the one-line reason, not a stack', async () => {
  const queue = buildDownloadQueue('outcome-ratelimited');
  queue.downloadSongToCache = async () => {
    throw Object.assign(new Error('Command failed with exit code 1'), { rateLimited: true, attempts: 3 });
  };
  queue.songs = [aSong('a throttled one')];

  const logged = captureConsole();
  let outcome;
  try {
    outcome = await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(outcome.reason, 'failed');
  assert.equal(outcome.detail, 'YouTube rate-limited this download (3 attempts)');
});

test('play() outcome: a start the user overtook is superseded, not a failure', async () => {
  // A skip mid-download must not make the reply say the song broke - nothing broke, and
  // whoever cancelled owns the queue's state now
  const queue = buildDownloadQueue('outcome-superseded');
  let released;
  queue.downloadSongToCache = () => new Promise(resolve => {
    queue.downloadProcess = { kill: () => {} };
    released = () => resolve('/tmp/godcord_superseded.opus');
  });
  queue.songs = [aSong('overtaken'), aSong('next up')];

  const starting = queue.play();
  await tick();
  queue.skip();
  released();

  const logged = captureConsole();
  let outcome;
  try {
    outcome = await starting;
  } finally {
    logged.restore();
  }

  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'superseded');
  assert.equal(queue.consecutiveFailures, 0, 'and it cost the breaker nothing');
});

test('play() outcome: nothing to start is said plainly, not as a failure', async () => {
  const queue = buildDownloadQueue('outcome-nothing');

  assert.deepEqual(await queue.play(), { started: false, reason: 'empty-queue' });

  queue.isPlaying = true;
  queue.songs = [aSong()];
  assert.deepEqual(await queue.play(), { started: false, reason: 'already-playing' });
});

// --- pause honesty ----------------------------------------------------------

test('pause(): a player with no audio yet says it is loading rather than claiming a pause', () => {
  const { queue } = buildQueue('pause-loading');
  // isPlaying goes up the moment a song starts downloading, seconds before any audio exists
  queue.isPlaying = true;

  const result = queue.pause();

  assert.equal(result.paused, false);
  assert.equal(result.reason, 'loading');
  assert.equal(queue.pausedAt, null, 'and the playback clock was not stopped for a pause that never happened');
});

test('pause(): with nothing playing at all, it says so', () => {
  const { queue } = buildQueue('pause-idle');
  assert.deepEqual(queue.pause(), { paused: false, reason: 'nothing-playing' });
});

test('resume(): a queue that exists but is idle is not reported as resumed', () => {
  const { queue } = buildQueue('resume-idle');
  assert.deepEqual(queue.resume(), { resumed: false, reason: 'nothing-playing' });
});

// A music player that behaves the way @discordjs/voice does for the two calls the duck path
// makes: pause() only pauses a Playing player, unpause() only un-pauses a Paused one, and
// both emit their status synchronously from the state setter.
class FakePlayer extends EventEmitter {
  constructor(status = AudioPlayerStatus.Playing) {
    super();
    this.state = { status };
    this.unpauseCalls = 0;
  }

  pause() {
    if (this.state.status !== AudioPlayerStatus.Playing) return false;
    this.state = { status: AudioPlayerStatus.Paused };
    this.emit(AudioPlayerStatus.Paused);
    return true;
  }

  unpause() {
    if (this.state.status !== AudioPlayerStatus.Paused) return false;
    this.unpauseCalls++;
    this.state = { status: AudioPlayerStatus.Playing };
    this.emit(AudioPlayerStatus.Playing);
    return true;
  }

  stop() { return true; }
}

// Drives one ducked clip over playing music. The clip's player and resource are fakes, since
// awaitClipEnd only ever reads the player's status and listens for Idle/error.
function buildDuckedQueue(guildId) {
  const { queue, connection } = buildQueue(guildId);
  connection.subscribe = () => ({ unsubscribe() {} });

  queue.player = new FakePlayer(AudioPlayerStatus.Playing);
  queue.songStartTime = Date.now() - 5_000;
  queue.isPlaying = true;
  queue.currentSong = { title: 'Summertime Sadness', url: 'https://example.com/x', duration: 200 };

  const clipPlayer = new EventEmitter();
  clipPlayer.state = { status: AudioPlayerStatus.Playing, playbackDuration: 5 };
  clipPlayer.play = () => {};
  clipPlayer.stop = () => {};
  queue.ttsPlayer = clipPlayer;

  const resource = { playStream: new EventEmitter(), playbackDuration: 42 };
  return { queue, clipPlayer, resource };
}

test('duck: an ordinary clip puts the music back when it finishes', async () => {
  const { queue, clipPlayer, resource } = buildDuckedQueue('duck-plain');

  const ducking = queue.duckAndPlay(() => resource);
  await tick();
  assert.equal(queue.player.state.status, AudioPlayerStatus.Paused, 'the clip holds the music down');

  clipPlayer.emit(AudioPlayerStatus.Idle);
  assert.equal(await ducking, true);
  assert.equal(queue.player.unpauseCalls, 1);
  assert.equal(queue.player.state.status, AudioPlayerStatus.Playing);
});

test('duck: a /pause during the clip is held, then honoured - the music stays paused', async () => {
  // player.pause() is Playing-only and the music is already Paused by the clip, so the pause
  // used to be a silent no-op that the clip's own resume then undid, while /pause answered
  // "Paused the music."
  const { queue, clipPlayer, resource } = buildDuckedQueue('duck-pause');

  const ducking = queue.duckAndPlay(() => resource);
  await tick();

  const result = queue.pause();
  assert.deepEqual(result, { paused: true, reason: 'held-until-clip-ends' });
  assert.equal(queue.pendingUserPause, true);

  clipPlayer.emit(AudioPlayerStatus.Idle);
  await ducking;

  assert.equal(queue.player.unpauseCalls, 0, 'the clip did not put the music back');
  assert.equal(queue.player.state.status, AudioPlayerStatus.Paused, 'the pause the user asked for holds');
  assert.equal(queue.pendingUserPause, false, 'and the request was consumed, not left to affect the next clip');
});

test('duck: a resume during the clip takes the held pause back', async () => {
  const { queue, clipPlayer, resource } = buildDuckedQueue('duck-pause-undone');

  const ducking = queue.duckAndPlay(() => resource);
  await tick();

  queue.pause();
  queue.resume(); // changed their mind while Jerry was still talking
  assert.equal(queue.pendingUserPause, false);

  clipPlayer.emit(AudioPlayerStatus.Idle);
  await ducking;

  assert.equal(queue.player.state.status, AudioPlayerStatus.Playing, 'the music came back as usual');
});

// --- the playback clock across an ordinary voice reconnect -------------------

test('AutoPaused: the dead air of a reconnect is claimed as paused time, not as playback', () => {
  // @discordjs/voice parks the player whenever no subscribed connection is Ready, which is
  // every Disconnected -> Signalling -> Ready reconnect and needs no 'error' at all. The
  // resource is held rather than consumed, so the audio resumes where it stopped - but
  // songStartTime runs through the whole outage.
  const { queue } = buildQueue('autopause-clock');
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 10_000;

  queue.player.emit(AudioPlayerStatus.AutoPaused);

  assert.notEqual(queue.pausedAt, null, 'the clock stopped with the audio');
  const frozen = queue.getPlaybackElapsedMs();
  assert.ok(Math.abs(frozen - 10_000) < 100, `froze at ${frozen}ms`);
});

test('AutoPaused: a user pause already in effect keeps the gap it owns', () => {
  const { queue } = buildQueue('autopause-user-pause');
  queue.songStartTime = Date.now() - 10_000;
  const userPause = Date.now() - 4_000;
  queue.pausedAt = userPause;

  queue.player.emit(AudioPlayerStatus.AutoPaused);

  assert.equal(queue.pausedAt, userPause, 'the pause in effect was not overwritten');
});

test('AutoPaused: the reconnect closes the gap exactly once, resume() included', () => {
  // The ordering that makes this safe: player.unpause() emits Playing *synchronously*, so the
  // Playing handler closes the gap first and resume()'s own bookkeeping then finds it closed.
  const { queue } = buildQueue('autopause-resume');
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 10_000;

  queue.player.emit(AudioPlayerStatus.AutoPaused);
  assert.notEqual(queue.pausedAt, null);
  queue.pausedAt = Date.now() - 3_000; // as if the outage had lasted three seconds

  queue.player.unpause = () => { queue.player.emit(AudioPlayerStatus.Playing); return true; };
  const result = queue.resume();

  assert.equal(result.resumed, true);
  assert.equal(queue.pausedAt, null, 'the clock is running again');
  assert.ok(Math.abs(queue.totalPausedMs - 3_000) < 100, `credited ${queue.totalPausedMs}ms, once`);
  assert.ok(Math.abs(queue.getPlaybackElapsedMs() - 7_000) < 100, 'and the position is what was heard');
});

// --- one queue per guild ------------------------------------------------------

test('createQueue: a second creation for the same guild hands back the live queue', () => {
  // A duplicate instance is not cosmetic: the loser keeps its voice connection, downloads
  // through the same single-slot gate and broadcasts over the winner, and nothing in the map
  // can reach it again - so no /stop or /skip ever stops it.
  const guildId = 'one-instance-per-guild';
  const first = createQueue(guildId);
  first.songs = [aSong('already queued')];

  const second = createQueue(guildId);

  assert.equal(second, first, 'the same instance, not a replacement');
  assert.equal(second.songs.length, 1, 'and its queue was not wiped by the second caller');
  first.cleanup();
});

test('createQueue: concurrent first-play callers all end up on one queue', async () => {
  const guildId = 'one-instance-race';
  // What the three "start playing from nothing" callers do: read, find nothing, create
  const start = async (title) => {
    const queue = getQueue(guildId) || createQueue(guildId);
    await tick();
    queue.songs.push(aSong(title));
    return queue;
  };

  const [a, b, c] = await Promise.all([start('first'), start('second'), start('third')]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(getQueue(guildId), a, 'and it is the one the map hands out');
  assert.equal(a.songs.length, 3, 'every caller added to the same queue');
  a.cleanup();
});

test('createQueue: a fresh queue is created once the last one has been torn down', () => {
  const guildId = 'one-instance-after-cleanup';
  const first = createQueue(guildId);
  first.cleanup();

  const second = createQueue(guildId);
  assert.notEqual(second, first, 'a torn-down queue is not handed out again');
  second.cleanup();
});

// --- throw safety -------------------------------------------------------------

test('a dashboard callback that throws does not wedge the queue mid-start', async () => {
  // The prologue used to run outside play()'s try. A throw from it left isPlaying true and
  // currentSong set with no resource, no ffmpeg, no download and no auto-leave timer - and
  // nothing that would ever advance the queue again.
  const queue = buildDownloadQueue('prologue-throws');
  queue.downloadSongToCache = async () => '/tmp/godcord_prologue.opus';
  queue.songs = [aSong('the one nobody hears')];

  setWebUpdateCallback(() => { throw new Error('the dashboard fell over'); });
  const logged = captureConsole();
  let outcome;
  try {
    outcome = await queue.play();
  } finally {
    logged.restore();
    setWebUpdateCallback(null);
  }

  // A broadcast that fails is logged and the song still plays - the dashboard is downstream
  assert.equal(outcome.started, true, 'the song still started');
  assert.equal(queue.played.length, 1);
  assert.ok(logged.find(/Broadcasting state to the dashboard failed/), logged.dump());
});

test('a start that throws before it claims a generation still cleans up and advances', async () => {
  const queue = buildDownloadQueue('prologue-fatal');
  queue.songs = [aSong('doomed'), aSong('next up')];
  // The first statement of the prologue, so this throws before the generation this start
  // belongs to has been claimed - the case where reading the generation would answer "the song
  // changed" and skip the cleanup
  queue.clearAutoLeaveTimer = () => { throw new Error('ENOSPC: no space left on device'); };

  const logged = captureConsole();
  let outcome;
  try {
    outcome = await queue.play();
  } finally {
    logged.restore();
  }

  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'failed', 'not mistaken for "the song changed", which would skip the cleanup');
  assert.equal(queue.isPlaying, false, 'the queue does not claim to be playing');
  assert.equal(queue.currentSong, null);
  assert.equal(queue.playNextCalls, 1, 'and it moved on instead of stopping dead');
});

test('a timer body that throws is logged, not left to end the process', () => {
  // index.js's uncaughtException handler calls process.exit(1), so an unguarded throw from a
  // timer is the bot dying mid-song rather than a warning in the log
  const logged = captureConsole();
  try {
    // The wrapper every timer in this module is built with
    safeTimer('a test timer', () => { throw new Error('disk full'); })();
  } finally {
    logged.restore();
  }
  assert.ok(logged.find(/a test timer failed: disk full/), logged.dump());
});

// --- loop mode replays the file it already has --------------------------------

// buildTransitionQueue() replaces playNext() wholesale, which is exactly the method under test
// here - so the real one is put back. Everything it reaches that would leave the process is
// still stubbed: the download, the ffmpeg spawn, the listening-stat write, and the radio's live
// yt-dlp lookup on an empty queue.
function buildLoopQueue(guildId) {
  const queue = buildTransitionQueue(guildId);
  delete queue.playNext;
  queue.tryRadioFill = async () => false;
  return queue;
}

test('loop song: the repeat plays the file already on disk, downloading nothing', async () => {
  // playNext() re-queued the finished song and then, three lines later, deleted the very file
  // that song had just been played from - so every repeat paid a full play-priority download:
  // seconds of silence between repeats plus one more media fetch at YouTube, on the loop most
  // likely to be left running for an hour.
  const queue = buildLoopQueue('loop-reuse');
  const calls = stubFetches(queue);
  queue.songs = [aSong('on repeat', URL_A)];

  await startFirstSong(queue, calls);
  assert.equal(calls.length, 1);
  const filePath = queue.cachedAudioPath;
  assert.ok(existsSync(filePath));

  queue.currentLoopMode = () => 'song';
  await queue.playNext();

  assert.equal(calls.length, 1, 'the repeat downloaded nothing at all');
  assert.equal(queue.played.length, 2, 'and it did start playing again');
  assert.equal(queue.played[1].path, filePath, 'from the same file');
  assert.equal(queue.cachedAudioPath, filePath, 'which is still the seek cache');
  assert.ok(existsSync(filePath), 'the file was handed over, not deleted');
  assert.equal(queue.prefetchHits, 1, 'and it counts as a hit, so the log tells the truth');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('loop-reuse'), [], 'and the last repeat took its file with it');
});

test('loop song: a skip is not a repeat, so the file goes as it always did', async () => {
  const queue = buildLoopQueue('loop-skip');
  const calls = stubFetches(queue);
  queue.songs = [aSong('on repeat', URL_A)];

  await startFirstSong(queue, calls);
  const filePath = queue.cachedAudioPath;

  queue.currentLoopMode = () => 'song';
  queue.skipRequested = true; // what stopForUserAction sets
  await queue.playNext();

  assert.equal(existsSync(filePath), false, 'the skipped song\'s file was cleaned up');
  assert.equal(queue.prefetch, null, 'and nothing was adopted for a repeat that is not happening');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('loop-skip'), []);
});

test('loop queue: a queue with another song next keeps its own prefetch', async () => {
  const queue = buildLoopQueue('loop-queue-untouched');
  const calls = stubFetches(queue);
  queue.songs = [aSong('first', URL_A), aSong('second', URL_B)];

  await startFirstSong(queue, calls);
  calls[1].finish();
  await tick();
  const prefetchedForB = calls[1].cachePath;
  const fileForA = queue.cachedAudioPath;

  queue.currentLoopMode = () => 'queue';
  await queue.playNext();

  // The finished song went to the back, so the next song is still B and its prefetch stands
  assert.equal(queue.played[1].path, prefetchedForB, 'B played from its own prefetch');
  assert.equal(existsSync(fileForA), false, "A's file was cleaned up as usual");
  assert.deepEqual(queue.songs.map(s => s.url), [URL_A], 'and A is queued behind it, to be fetched then');

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('loop-queue-untouched'), []);
});

// --- the broadcast diet -------------------------------------------------------

test('broadcast gating: with nobody watching, no per-second update is built or sent', async () => {
  const queue = buildTransitionQueue('broadcast-gated');
  const calls = stubFetches(queue);
  queue.songs = [aSong('playing to an empty room', URL_A)];

  const positions = [];
  const states = [];
  setWebUpdateCallback(state => states.push(state));
  setWebPositionCallback(tick => positions.push(tick));
  setWebClientCountCallback(() => 0);
  try {
    await startFirstSong(queue, calls);
    const statesAfterStart = states.length;
    assert.ok(statesAfterStart > 0, 'a song starting is a real change, so it still broadcasts');

    // Drive the position tick the way the interval does
    queue.player = { state: { status: AudioPlayerStatus.Playing }, stop: () => {} };
    queue.songStartTime = Date.now() - 1000;
    positionTick(queue);

    assert.deepEqual(positions, [], 'nothing was sent to nobody');
    assert.equal(states.length, statesAfterStart, 'and no full state either');
  } finally {
    setWebUpdateCallback(null);
    setWebPositionCallback(null);
    setWebClientCountCallback(null);
    queue.cleanup();
  }
});

test('broadcast gating: with a dashboard open, the tick is the position, not the whole state', async () => {
  const queue = buildTransitionQueue('broadcast-position');
  const calls = stubFetches(queue);
  queue.songs = [aSong('watched', URL_A)];

  const positions = [];
  const states = [];
  setWebUpdateCallback(state => states.push(state));
  setWebPositionCallback(t => positions.push(t));
  setWebClientCountCallback(() => 2);
  try {
    await startFirstSong(queue, calls);
    const statesAfterStart = states.length;

    queue.player = { state: { status: AudioPlayerStatus.Playing }, stop: () => {} };
    queue.songStartTime = Date.now() - 2000;
    positionTick(queue);

    assert.equal(positions.length, 1, 'one small message per tick');
    assert.equal(states.length, statesAfterStart, 'and no 25KB state object with it');
    assert.deepEqual(Object.keys(positions[0]).sort(), ['isPaused', 'position', 'songStartTime']);
    assert.ok(Math.abs(positions[0].position - 2) < 0.3, `position was ${positions[0].position}s`);
    assert.equal(positions[0].isPaused, false);
  } finally {
    setWebUpdateCallback(null);
    setWebPositionCallback(null);
    setWebClientCountCallback(null);
    queue.cleanup();
  }
});

test('loop song: the reused file is touched, so the /tmp sweep reads it as in use', async () => {
  // Nothing rewrites a file the loop keeps replaying, so its mtime stays at the download - and
  // after an hour of repeats it is indistinguishable from a crash orphan to the startup sweep,
  // which any second instance of this module runs (npm test included).
  const queue = buildLoopQueue('loop-touch');
  const calls = stubFetches(queue);
  queue.songs = [aSong('on repeat', URL_A)];

  await startFirstSong(queue, calls);
  const filePath = queue.cachedAudioPath;
  const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  utimesSync(filePath, longAgo, longAgo);

  queue.currentLoopMode = () => 'song';
  await queue.playNext();

  assert.equal(queue.cachedAudioPath, filePath, 'the same file is playing again');
  const age = Date.now() - statSync(filePath).mtimeMs;
  assert.ok(age < 60_000, `mtime is ${Math.round(age / 1000)}s old, so the sweep would take it`);

  queue.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('loop-touch'), []);
});

// --- radio pick brain: filterEligibleRadioTracks / chooseRadioSeed -----------
//
// These are the pure pieces pulled out of the old tryRadioFill/dashboard split so the
// tiering and seed choice are testable without a live yt-dlp call. pickRadioTrack() itself
// (the async wrapper that fetches the mix and calls filterEligibleRadioTracks) is exercised
// against real YouTube by a scratch script instead - see the radio report.

const radioTrack = (n) => ({ title: `Track ${n}`, url: `https://www.youtube.com/watch?v=trk${n}` });

test('filterEligibleRadioTracks: a niche mix with most of it recently played leaves only the fresh tracks, at tier 0', () => {
  const tracks = Array.from({ length: 8 }, (_, i) => radioTrack(i));
  const historyUrls = tracks.slice(0, 6).map(t => t.url); // 6 of the 8 already played

  const { eligible, tier } = filterEligibleRadioTracks(tracks, { historyUrls });

  assert.equal(tier, 0, 'nothing needed relaxing');
  assert.deepEqual(eligible.map(t => t.url), [tracks[6].url, tracks[7].url]);
});

test('filterEligibleRadioTracks: a fresh mix with no history, memory or queue is eligible in full at tier 0', () => {
  const tracks = [radioTrack(0), radioTrack(1), radioTrack(2)];

  const { eligible, tier } = filterEligibleRadioTracks(tracks, {});

  assert.equal(tier, 0);
  assert.equal(eligible.length, 3);
});

test('filterEligibleRadioTracks: everything played and everything in session memory still returns something, never silence', () => {
  const tracks = Array.from({ length: 5 }, (_, i) => radioTrack(i));
  const urls = tracks.map(t => t.url);

  const { eligible, tier } = filterEligibleRadioTracks(tracks, {
    historyUrls: urls,       // all 5 "actually played"
    recentRadioUrls: urls    // and all 5 in this session's memory too
  });

  // Tier 0 (history+memory) and tier 1 (history only) both exclude everything; tier 2's
  // shrunk window still covers all 5 (they're the first 5 history entries); only tier 3,
  // which drops the history filter altogether, has anything left to offer.
  assert.equal(tier, 3);
  assert.equal(eligible.length, 5, 'degraded to "some repetition", not to nothing');
});

test('filterEligibleRadioTracks: the currently-queued/now-playing exclusion never relaxes, even once every soft filter has', () => {
  const tracks = [radioTrack(0), radioTrack(1)];

  const { eligible, tier } = filterEligibleRadioTracks(tracks, {
    queueUrls: [tracks[0].url],
    currentUrl: tracks[1].url
  });

  // Every soft filter (history, memory) was already vacuous here - there was nothing to
  // relax - so this exhausts all four tiers and comes back empty. A tiny mix that's already
  // entirely in the queue has nothing left to offer, and that's the one case where null is
  // the right answer, not a repeat.
  assert.equal(eligible.length, 0);
  assert.equal(tier, 4, 'ran out of tiers rather than reusing a queued/playing track');
});

test('filterEligibleRadioTracks: dropping session memory first (tier 1) recovers a track that was never actually played', () => {
  const track = radioTrack(0);

  const { eligible, tier } = filterEligibleRadioTracks([track], {
    historyUrls: [],               // never actually played...
    recentRadioUrls: [track.url]   // ...just picked earlier this session
  });

  assert.equal(tier, 1);
  assert.deepEqual(eligible.map(t => t.url), [track.url]);
});

test('filterEligibleRadioTracks: shrinking the history window (tier 2) recovers a track that is only stale by the wide window', () => {
  const track = radioTrack('target');
  // 16 history entries, newest first, with the target sitting at index 15 - inside the
  // default 30-entry window, but outside the relaxed 10-entry one.
  const historyUrls = Array.from({ length: 15 }, (_, i) => `https://www.youtube.com/watch?v=filler${i}`);
  historyUrls.push(track.url);

  const { eligible, tier } = filterEligibleRadioTracks([track], { historyUrls });

  assert.equal(tier, 2);
  assert.deepEqual(eligible.map(t => t.url), [track.url]);
});

test('RADIO_MEMORY_SIZE: grown from 5 to 25, so the session memory outlasts a single fetched mix', () => {
  assert.equal(RADIO_MEMORY_SIZE, 25);
});

test('chooseRadioSeed: no history at all falls back to the song that just ended', () => {
  const fallback = { url: 'https://www.youtube.com/watch?v=ended', title: 'Ended Song' };
  assert.equal(chooseRadioSeed([], fallback), fallback);
  assert.equal(chooseRadioSeed(null, fallback), fallback);
});

test('chooseRadioSeed: history entries missing a url are ignored, so an all-invalid history also falls back', () => {
  const fallback = { url: 'https://www.youtube.com/watch?v=ended', title: 'Ended Song' };
  assert.equal(chooseRadioSeed([{ title: 'no url here' }, {}], fallback), fallback);
});

test('chooseRadioSeed: prefers a real user request over past radio auto-adds', () => {
  const radioPick = { url: 'https://www.youtube.com/watch?v=radio', title: 'Radio Pick', requestedBy: '📻 Radio' };
  const userPick = { url: 'https://www.youtube.com/watch?v=user', title: 'User Pick', requestedBy: 'billy' };

  // Radio pick listed first, to prove it's filtered out rather than just not being index 0
  const result = chooseRadioSeed([radioPick, userPick], null, () => 0);
  assert.equal(result, userPick);
});

test('chooseRadioSeed: falls back to the whole pool, radio picks included, when nothing was user-requested', () => {
  const radioA = { url: 'https://www.youtube.com/watch?v=radioA', title: 'A', requestedBy: '📻 Radio' };
  const radioB = { url: 'https://www.youtube.com/watch?v=radioB', title: 'B', requestedBy: '📻 Radio' };

  assert.equal(chooseRadioSeed([radioA, radioB], null, () => 0), radioA);
  assert.equal(chooseRadioSeed([radioA, radioB], null, () => 0.9999), radioB);
});

test('chooseRadioSeed: only the last 8 plays are considered, even with a longer history', () => {
  // The first 8 are radio auto-adds (so they stay in the candidate pool); a genuine user
  // request sits at index 8 - one past the window - and must never be reachable.
  const radioEntries = Array.from({ length: 8 }, (_, i) => ({
    url: `https://www.youtube.com/watch?v=r${i}`,
    title: `Radio ${i}`,
    requestedBy: '📻 Radio'
  }));
  const laterUserEntry = { url: 'https://www.youtube.com/watch?v=toofar', title: 'Too Far', requestedBy: 'billy' };
  const history = [...radioEntries, laterUserEntry, laterUserEntry];

  // randomFn near 1 selects the last candidate in the pool - if the window were not
  // enforced, that would be the user entry outside it
  const result = chooseRadioSeed(history, null, () => 0.9999);
  assert.equal(result, radioEntries[7], 'the 9th history entry was never in the candidate pool');
});

test('chooseRadioSeed: a single-entry history is chosen regardless of randomFn', () => {
  const onlyEntry = { url: 'https://www.youtube.com/watch?v=only', title: 'Only' };
  assert.equal(chooseRadioSeed([onlyEntry], null, () => 0), onlyEntry);
  assert.equal(chooseRadioSeed([onlyEntry], null, () => 0.9999), onlyEntry);
});

// --- surviving a restart ------------------------------------------------------

// A voice channel, as far as the restore path is concerned: an id, a name, and members it can
// count the humans in. The members collection filters for real, so countHumans is exercised
// rather than mocked out.
class FakeMembers extends Map {
  filter(fn) {
    const out = new FakeMembers();
    for (const [key, value] of this) if (fn(value)) out.set(key, value);
    return out;
  }
}

function fakeVoiceChannel(id, { humans = 1, bots = 1, name = 'Muziek' } = {}) {
  const members = new FakeMembers();
  for (let i = 0; i < humans; i++) members.set(`human-${i}`, { user: { id: `human-${i}`, bot: false } });
  for (let i = 0; i < bots; i++) members.set(`bot-${i}`, { user: { id: `bot-${i}`, bot: true } });
  return { id, name, members, isVoiceBased: () => true };
}

const fakeClient = (...channels) => ({
  channels: {
    cache: new Map(channels.map(channel => [channel.id, channel])),
    fetch: async () => { throw new Error('not found'); }
  }
});

// A queue that knows which channel it is in, which is what a snapshot has to write down
function buildSnapshotQueue(guildId, { channelId = 'voice-1', channelName = 'Muziek' } = {}) {
  const queue = new MusicQueue(guildId);
  queue.voiceChannel = { id: channelId, name: channelName };
  queue.voiceChannelName = channelName;
  return queue;
}

// Force the player's reported status without playing a resource: `state` is an accessor on
// AudioPlayer, so an own property shadows it and the bookkeeping behind the setter is skipped.
function pinPlayerStatus(queue, status) {
  Object.defineProperty(queue.player, 'state', { value: { status }, configurable: true });
}

test('snapshot: what gets written down is where the listener actually is, not how long ago the song started', () => {
  const queue = buildSnapshotQueue('snapshot-position');
  queue.currentSong = { title: 'Playing now', url: URL_A, duration: 300 };
  queue.songs = [{ title: 'Next up', url: URL_B, duration: 200 }];
  queue.isPlaying = true;
  queue.volume = 0.35;
  // A minute since it started, twenty seconds of which nobody heard (a pause, a reconnect, a
  // ducked "Hey Jerry" answer). The listener is forty seconds in.
  queue.songStartTime = Date.now() - 60_000;
  queue.totalPausedMs = 20_000;

  const snapshot = queue.snapshot();

  assert.ok(Math.abs(snapshot.positionSec - 40) < 1, `position was ${snapshot.positionSec}`);
  assert.equal(snapshot.currentSong.title, 'Playing now');
  assert.deepEqual(snapshot.songs.map(s => s.url), [URL_B]);
  assert.equal(snapshot.voiceChannelId, 'voice-1');
  assert.equal(snapshot.volume, 0.35);
  assert.equal(snapshot.wasPaused, false);
  assert.ok(snapshot.savedAt > 0, 'and it is timestamped, so a restart can tell if it is stale');
});

test('snapshot: an idle, empty queue has nothing worth coming back to', () => {
  const queue = buildSnapshotQueue('snapshot-empty');
  assert.equal(queue.snapshot(), null);
  // ...unless the caller is the 24/7 rejoin, whose job is the channel rather than the song
  const forced = queue.snapshot({ includeEmpty: true });
  assert.equal(forced.voiceChannelId, 'voice-1');
  assert.equal(forced.currentSong, null);
  assert.deepEqual(forced.songs, []);
});

test('snapshot: a song with no URL is not worth restoring, so it is not written down', () => {
  const queue = buildSnapshotQueue('snapshot-unplayable');
  queue.songs = [{ title: 'no url at all' }, { title: 'fine', url: URL_A, duration: 10 }];
  assert.deepEqual(queue.snapshot().songs.map(s => s.title), ['fine']);
});

test('snapshot: an explicit pause is recorded, the player parking itself is not', () => {
  const paused = buildSnapshotQueue('snapshot-paused');
  paused.currentSong = { title: 'held', url: URL_A, duration: 100 };
  pinPlayerStatus(paused, AudioPlayerStatus.Paused);
  assert.equal(paused.snapshot().wasPaused, true, 'the user asked for silence');

  const parked = buildSnapshotQueue('snapshot-autopaused');
  parked.currentSong = { title: 'held by a dead link', url: URL_A, duration: 100 };
  pinPlayerStatus(parked, AudioPlayerStatus.AutoPaused);
  // AutoPaused is exactly what a dying voice connection leaves behind. Reading it as a pause
  // would mean a 24/7 rejoin came back to a queue that refused to play.
  assert.equal(parked.snapshot().wasPaused, false);
});

test('restore math: the round trip puts the queue back in order, with the current song at the front', () => {
  const queue = buildSnapshotQueue('roundtrip-order');
  queue.currentSong = { title: 'was playing', url: URL_A, duration: 300 };
  queue.songs = [{ title: 'second', url: URL_B, duration: 100 }, { title: 'third', url: URL_C, duration: 100 }];
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 30_000;
  queue.volume = 0.6;

  const plan = planQueueRestore(queue.snapshot(), { humansPresent: 2 });

  assert.equal(plan.restore, true);
  assert.equal(plan.join, true);
  assert.equal(plan.reason, 'resume');
  assert.deepEqual(plan.songs.map(s => s.url), [URL_A, URL_B, URL_C], 'the song that was playing goes back at the front, where play() will shift it off');
  assert.equal(plan.currentSong.url, URL_A);
  assert.ok(Math.abs(plan.resumeAt - 30) < 1, `resumeAt was ${plan.resumeAt}`);
  assert.equal(plan.volume, 0.6);
});

test('restore math: a position past the end of the song is clamped into it', () => {
  // -ss past the end produces a stream that ends immediately, which the queue would skip for
  // no visible reason. The same clamp seek() applies, for the same reason.
  assert.equal(clampResumePosition(300, 180), 179);
  assert.equal(clampResumePosition(179.5, 180), 179);
  assert.equal(clampResumePosition(60, 180), 60);
  // An unknown length (a live stream, a lookup with no duration) is no reason to refuse an offset
  assert.equal(clampResumePosition(60, 0), 60);
  assert.equal(clampResumePosition(60, undefined), 60);
  // Nonsense, and a song that had not started, both come back from the beginning
  assert.equal(clampResumePosition(-5, 180), 0);
  assert.equal(clampResumePosition('nonsense', 180), 0);
  assert.equal(clampResumePosition(0, 180), 0);
});

test('restore math: a snapshot the position clamp lands at the very end still comes back inside the song', () => {
  const state = {
    savedAt: Date.now(),
    currentSong: { title: 'nearly over', url: URL_A, duration: 200 },
    songs: [],
    positionSec: 9999
  };
  const plan = planQueueRestore(state, { humansPresent: 1 });
  assert.equal(plan.resumeAt, 199);
});

test('restore math: a snapshot older than the window is discarded rather than acted on', () => {
  const state = {
    savedAt: Date.now() - (31 * 60 * 1000),
    currentSong: { title: 'last night', url: URL_A, duration: 300 },
    songs: [],
    positionSec: 30
  };

  const stale = planQueueRestore(state, { humansPresent: 3 });
  assert.equal(stale.restore, false);
  assert.equal(stale.reason, 'stale');
  assert.ok(stale.ageMs > QUEUE_STATE_MAX_AGE_MS);

  // ...and one from inside the window is not
  const fresh = planQueueRestore({ ...state, savedAt: Date.now() - (29 * 60 * 1000) }, { humansPresent: 3 });
  assert.equal(fresh.restore, true);
  assert.equal(fresh.join, true);
});

test('restore math: a snapshot with no timestamp cannot be judged, so it is not trusted', () => {
  const plan = planQueueRestore({ currentSong: { title: 'x', url: URL_A, duration: 10 }, songs: [] }, {});
  assert.equal(plan.restore, false);
  assert.equal(plan.reason, 'stale');
});

test('restore math: an empty channel gets the queue back but no bot in it', () => {
  const state = {
    savedAt: Date.now(),
    voiceChannelId: 'voice-1',
    currentSong: { title: 'was playing', url: URL_A, duration: 300 },
    songs: [{ title: 'second', url: URL_B, duration: 100 }],
    positionSec: 42
  };

  const plan = planQueueRestore(state, { humansPresent: 0 });

  assert.equal(plan.restore, true);
  assert.equal(plan.join, false, 'nobody is there to hear it');
  assert.equal(plan.reason, 'channel-empty');
  assert.deepEqual(plan.songs.map(s => s.url), [URL_A, URL_B], 'nothing is lost - the song that was playing is queued again');
  assert.equal(plan.currentSong, null, 'and nothing is started');
  assert.equal(plan.resumeAt, 0);
});

test('restore math: a channel that has gone, and a pause, are both held the same way', () => {
  const base = {
    savedAt: Date.now(),
    currentSong: { title: 'was playing', url: URL_A, duration: 300 },
    songs: [],
    positionSec: 42
  };

  const gone = planQueueRestore(base, { channelFound: false, humansPresent: 0 });
  assert.equal(gone.reason, 'channel-gone');
  assert.equal(gone.join, false);
  assert.deepEqual(gone.songs.map(s => s.url), [URL_A]);

  // A pause is an instruction, and a restart is not a reason to overrule it
  const held = planQueueRestore({ ...base, wasPaused: true }, { humansPresent: 4 });
  assert.equal(held.reason, 'was-paused');
  assert.equal(held.join, false);
  assert.deepEqual(held.songs.map(s => s.url), [URL_A]);

  // Songs queued but nothing playing: there is nothing to join a channel for
  const queueOnly = planQueueRestore({ ...base, currentSong: null, songs: [{ title: 'waiting', url: URL_B, duration: 5 }] }, { humansPresent: 4 });
  assert.equal(queueOnly.reason, 'queue-only');
  assert.equal(queueOnly.join, false);
});

test('restore math: nothing saved is not a restore', () => {
  assert.equal(planQueueRestore(null, {}).restore, false);
  assert.equal(planQueueRestore({ savedAt: Date.now(), songs: [], currentSong: null }, {}).reason, 'nothing-saved');
});

test('restore: every reason a restored queue is sitting there says so in words', () => {
  assert.match(describeRestoreHold('channel-empty', 'Muziek'), /nobody in "Muziek"/);
  assert.match(describeRestoreHold('channel-gone'), /no longer exists/);
  assert.match(describeRestoreHold('was-paused'), /paused/);
  assert.match(describeRestoreHold('queue-only'), /nothing was playing/);
});

test('play(): a start that is really a continuation opens the file at the saved position', async () => {
  const queue = buildDownloadQueue('play-from-offset');
  queue.downloadSongToCache = async () => '/tmp/godcord_offset.opus';
  queue.songs = [{ title: 'resumed', url: URL_A, duration: 300 }];

  await queue.play({ startAtSeconds: 96.4 });

  assert.equal(queue.played.length, 1);
  assert.equal(queue.played[0].seconds, 96.4, 'handed straight to the same -ss machinery a seek uses');

  // ...and a start past the end of the song is clamped, not left to end instantly
  const clamped = buildDownloadQueue('play-from-offset-clamped');
  clamped.downloadSongToCache = async () => '/tmp/godcord_offset2.opus';
  clamped.songs = [{ title: 'nearly over', url: URL_A, duration: 120 }];
  await clamped.play({ startAtSeconds: 500 });
  assert.equal(clamped.played[0].seconds, 119);
});

test('play(): an ordinary start is unchanged - no offset, from the beginning', async () => {
  const queue = buildDownloadQueue('play-no-offset');
  queue.downloadSongToCache = async () => '/tmp/godcord_plain.opus';
  queue.songs = [{ title: 'from the top', url: URL_A, duration: 300 }];
  await queue.play();
  assert.equal(queue.played[0].seconds, 0);
});

test('play(): a start that never happened does not take the next song out of the history', async () => {
  // History navigation and the restore both raise playingFromHistory immediately before calling
  // play(), to keep a song that is already in the history from being counted twice. Left
  // standing by a start that was refused, it would silently keep the *next* song - an ordinary
  // one somebody asked for - out of recentlyPlayed and out of the listening stats.
  const busy = new MusicQueue('history-flag-busy');
  busy.songs = [{ title: 'queued', url: URL_A, duration: 60 }];
  busy.isPlaying = true;
  busy.playingFromHistory = true;

  const refused = await busy.play();

  assert.equal(refused.reason, 'already-playing');
  assert.equal(busy.playingFromHistory, false, 'the flag went with the start it was set for');

  const empty = new MusicQueue('history-flag-empty');
  empty.playingFromHistory = true;
  assert.equal((await empty.play()).reason, 'empty-queue');
  assert.equal(empty.playingFromHistory, false);
});

test('previous: with the bot in no channel, it declines instead of playing to nobody', () => {
  // The one start path with no channel to join with - and a restored queue that stayed out of an
  // empty channel is exactly a queue with no connection. Downloading and playing anyway hands
  // the audio to a player with nothing subscribed, which parks it AutoPaused: a running progress
  // bar with the bot in no channel at all.
  const queue = new MusicQueue('previous-no-connection');
  queue.songs = [{ title: 'restored, waiting', url: URL_A, duration: 60 }];
  let started = 0;
  queue.play = async () => { started++; return { started: true }; };

  const logged = captureConsole();
  let acted;
  try {
    acted = queue.playPrevious();
  } finally {
    logged.restore();
  }

  assert.equal(acted, false);
  assert.equal(started, 0, 'nothing was downloaded or played');
  assert.deepEqual(queue.songs.map(s => s.title), ['restored, waiting'], 'and the restored queue is untouched');
  assert.equal(queue.historyIndex, -1);
  assert.equal(queue.playingFromHistory, false);
  assert.ok(logged.find(/previous: not in a voice channel/), logged.dump());
});

test('previous: in a channel, it still queues the last song and starts it', () => {
  // The guard above is the only thing that changed: with a connection, previous works as before
  const history = getRecentlyPlayed();
  history.unshift({ url: URL_D, title: 'played before', duration: 60, requestedBy: 'billy', playedAt: Date.now() });
  try {
    const { queue } = buildQueue('previous-with-connection');
    let started = 0;
    queue.play = async () => { started++; return { started: true }; };

    assert.equal(queue.playPrevious(), true);
    assert.equal(queue.songs[0].title, 'played before');
    assert.equal(started, 1);
    assert.equal(queue.playingFromHistory, true, 'and the song is not re-counted in the history');
  } finally {
    history.shift();
  }
});

// The restore path looks the guild's queue up in the module's own map, so the stubs go on the
// instance that is already in it rather than on a queue built beside it.
function stubQueueForRestore(queue) {
  const joined = [];
  queue.joined = joined;
  queue.join = async (channel) => {
    joined.push(channel.id);
    const connection = new FakeConnection(VoiceConnectionStatus.Ready);
    queue.connection = connection;
    queue.listenerConnection = connection;
    queue.voiceChannel = channel;
    queue.voiceChannelName = channel.name;
    return connection;
  };
  queue.played = [];
  queue.playFromCache = function (seconds) { this.played.push({ path: this.cachedAudioPath, seconds }); };
  queue.trackAndClearListening = () => {};
  queue.tryRadioFill = async () => false;
  return stubFetches(queue);
}

// Waits for the resumed song's download to be asked for, without sitting out real time
async function waitForCall(calls, index = 0) {
  for (let i = 0; i < 50 && calls.length <= index; i++) await tick();
  assert.ok(calls.length > index, `download ${index} was never asked for`);
  return calls[index];
}

test('restore: a restart mid-song comes back to the same channel, at the same position, with the queue behind it', async () => {
  const channel = fakeVoiceChannel('voice-restore', { humans: 1 });
  const client = fakeClient(channel);
  const historyBefore = getRecentlyPlayed().length;

  // --- the process that is about to be restarted
  const before = createQueue('restore-roundtrip');
  before.voiceChannel = { id: channel.id, name: channel.name };
  before.voiceChannelName = channel.name;
  before.volume = 0.35;
  before.currentSong = { title: 'Interrupted', url: URL_A, duration: 300 };
  before.songs = [{ title: 'Next up', url: URL_B, duration: 200 }];
  before.isPlaying = true;
  before.songStartTime = Date.now() - 75_000;

  assert.equal(flushQueueState(), true, 'the shutdown flush wrote the queue out');
  before.cleanup(); // the process ends: nothing live is left behind

  // --- the process that comes back
  const after = createQueue('restore-roundtrip');
  const calls = stubQueueForRestore(after);

  const restoring = restoreQueueState({ client });
  const download = await waitForCall(calls);
  assert.equal(download.url, URL_A, 'the song that was interrupted is the one being fetched');
  download.finish();
  const [plan] = await restoring;

  assert.equal(plan.restore, true);
  assert.equal(plan.started, true);
  assert.deepEqual(after.joined, ['voice-restore']);
  assert.equal(after.currentSong.title, 'Interrupted');
  assert.deepEqual(after.songs.map(s => s.title), ['Next up'], 'and what was queued behind it is still queued');
  assert.equal(after.volume, 0.35);
  assert.equal(after.played.length, 1);
  assert.ok(Math.abs(after.played[0].seconds - 75) <= 1, `resumed at ${after.played[0].seconds}s`);
  assert.equal(getRecentlyPlayed().length, historyBefore, 'a resumed song is the same play continuing, not a new one in the history');
  assert.equal(existsSync(getQueueStatePath()), false, 'and the file is gone, so a second restart cannot restore it again');

  after.cleanup();
  await tick();
  assert.deepEqual(cacheFilesFor('restore-roundtrip'), [], 'nothing left in /tmp');
});

test('restore: a channel with nobody in it gets its queue back and no bot in the channel', async () => {
  const channel = fakeVoiceChannel('voice-empty', { humans: 0, bots: 1 });
  const client = fakeClient(channel);

  const before = createQueue('restore-empty-channel');
  before.voiceChannel = { id: channel.id, name: channel.name };
  before.voiceChannelName = channel.name;
  before.currentSong = { title: 'Was playing', url: URL_A, duration: 300 };
  before.songs = [{ title: 'Next up', url: URL_B, duration: 200 }];
  before.isPlaying = true;
  before.songStartTime = Date.now() - 10_000;
  flushQueueState();
  before.cleanup();

  const after = createQueue('restore-empty-channel');
  const calls = stubQueueForRestore(after);

  const logged = captureConsole();
  let plans;
  try {
    plans = await restoreQueueState({ client });
  } finally {
    logged.restore();
  }

  assert.equal(plans[0].reason, 'channel-empty');
  assert.deepEqual(after.joined, [], 'the bot stayed out of the empty channel');
  assert.deepEqual(after.songs.map(s => s.title), ['Was playing', 'Next up'], 'but the queue is all there, ready for the next /play');
  assert.equal(after.isPlaying, false);
  assert.equal(calls.length, 0, 'and nothing was downloaded for a room with nobody in it');
  assert.ok(logged.find(/nobody in "Muziek"/), logged.dump());

  // The file was cleared before the restore acted on it and a held restore starts nothing, so
  // the queue would exist only in memory until somebody touched it - one crash from being gone
  assert.equal(scheduleQueueStateSave(), false, 'a save is already pending for the restored queue');
  assert.equal(saveQueueStateNow(), true);
  assert.deepEqual(
    loadQueueState().guilds['restore-empty-channel'].songs.map(s => s.title),
    ['Was playing', 'Next up'],
    'a crash right now would find the queue back on disk'
  );

  after.cleanup();
  forgetQueueState();
});

test('restore: a snapshot from last night is discarded, and never joins anything', async () => {
  const channel = fakeVoiceChannel('voice-stale', { humans: 2 });
  const client = fakeClient(channel);

  const before = createQueue('restore-stale');
  before.voiceChannel = { id: channel.id, name: channel.name };
  before.currentSong = { title: 'Last night', url: URL_A, duration: 300 };
  before.isPlaying = true;
  before.songStartTime = Date.now() - 5_000;
  flushQueueState();
  before.cleanup();

  const after = createQueue('restore-stale');
  const calls = stubQueueForRestore(after);

  const logged = captureConsole();
  let plans;
  try {
    // Two hours later, by the clock the restore is given
    plans = await restoreQueueState({ client, now: Date.now() + (2 * 60 * 60 * 1000) });
  } finally {
    logged.restore();
  }

  assert.equal(plans[0].restore, false);
  assert.equal(plans[0].reason, 'stale');
  assert.deepEqual(after.joined, []);
  assert.deepEqual(after.songs, []);
  assert.equal(calls.length, 0);
  assert.ok(logged.find(/120 min old - discarded/), logged.dump());
  assert.equal(existsSync(getQueueStatePath()), false, 'a discarded snapshot is not left to be reconsidered');

  after.cleanup();
});

test('restore: a queue somebody has already started is not overwritten by the saved one', async () => {
  const channel = fakeVoiceChannel('voice-race', { humans: 1 });
  const client = fakeClient(channel);

  const before = createQueue('restore-race');
  before.voiceChannel = { id: channel.id, name: channel.name };
  before.currentSong = { title: 'From the snapshot', url: URL_A, duration: 300 };
  before.isPlaying = true;
  before.songStartTime = Date.now() - 5_000;
  flushQueueState();
  before.cleanup();

  // Somebody's /play got there first
  const live = createQueue('restore-race');
  const calls = stubQueueForRestore(live);
  live.songs = [{ title: 'What the user asked for', url: URL_C, duration: 100 }];

  const plans = await restoreQueueState({ client });

  assert.equal(plans[0].restore, false);
  assert.equal(plans[0].reason, 'already-playing');
  assert.deepEqual(live.songs.map(s => s.title), ['What the user asked for'], 'their song is untouched');
  assert.deepEqual(live.joined, []);
  assert.equal(calls.length, 0);

  live.cleanup();
});

test('persistence: stopping the music on purpose is not something a restart undoes', () => {
  const queue = createQueue('persist-stop');
  queue.voiceChannel = { id: 'voice-stop', name: 'Muziek' };
  queue.songs = [{ title: 'playing', url: URL_A, duration: 100 }];
  assert.equal(saveQueueStateNow(), true);
  assert.ok(existsSync(getQueueStatePath()));

  queue.stop();

  assert.equal(existsSync(getQueueStatePath()), false, 'a /stop takes the saved queue with it');
  queue.cleanup();
});

test('persistence: a queue that has run dry drops its own entry instead of leaving a finished song there', () => {
  const queue = createQueue('persist-dry');
  queue.voiceChannel = { id: 'voice-dry', name: 'Muziek' };
  queue.currentSong = { title: 'the last song', url: URL_A, duration: 100 };
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 1000;
  assert.equal(saveQueueStateNow(), true);
  assert.ok(loadQueueState().guilds['persist-dry'], 'it was saved while it played');

  // 24/7 mode keeps an empty queue alive rather than leaving; without this, a restart would
  // replay the song that had already finished
  queue.currentSong = null;
  queue.isPlaying = false;
  queue.songs = [];
  saveQueueStateNow();

  assert.equal(existsSync(getQueueStatePath()), false, 'nothing left worth restoring, so nothing left on disk');
  queue.cleanup();
  forgetQueueState();
});

test('persistence: a teardown leaves the saved queue alone, so a restart can still put it back', () => {
  // The one path that loses the connection without anybody asking for it. The queue is gone
  // from memory, but what it was playing is exactly what a restart wants.
  const queue = createQueue('persist-teardown');
  const connection = new FakeConnection(VoiceConnectionStatus.Ready);
  queue.connection = connection;
  queue.listenerConnection = connection;
  queue.trackAndClearListening = () => {};
  queue.voiceChannel = { id: 'voice-teardown', name: 'Muziek' };
  queue.currentSong = { title: 'interrupted', url: URL_A, duration: 100 };
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 2000;
  queue.current24_7 = () => false; // the 24/7 rejoin is its own story, below
  saveQueueStateNow();

  queue.teardownConnection('error unrecoverable', connection);

  assert.equal(loadQueueState().guilds['persist-teardown'].currentSong.title, 'interrupted');
  // ...and a later write does not overwrite it with emptiness: there is no live queue for this
  // guild any more, and "no queue" is not the same fact as "a queue with nothing in it"
  saveQueueStateNow();
  assert.equal(loadQueueState().guilds['persist-teardown'].currentSong.title, 'interrupted');
  forgetQueueState();
});

// --- 24/7: getting back in after a connection dies ----------------------------

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Waits for something the rejoin does on a timer, without sitting out real backoff time
async function waitUntil(fn, what) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await sleep(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

// The snapshot a teardown hands the rejoin, taken from a real queue so the shape is the one the
// code actually produces rather than one a test made up
function snapshotOf({ guildId = 'rejoin', channelId = 'voice-247', positionSec = 42, songs = [], current = { title: 'Interrupted', url: URL_A, duration: 300 } } = {}) {
  const queue = new MusicQueue(guildId);
  queue.voiceChannel = { id: channelId, name: 'Muziek' };
  queue.voiceChannelName = 'Muziek';
  queue.currentSong = current;
  queue.songs = songs;
  queue.volume = 0.5;
  if (current) {
    queue.isPlaying = true;
    queue.songStartTime = Date.now() - (positionSec * 1000);
  }
  return queue.snapshot({ includeEmpty: true });
}

test('24/7 rejoin: the backoff starts quickly, then waits out a real outage, then gives up', () => {
  assert.deepEqual(REJOIN_BACKOFF_MS, [10_000, 30_000, 60_000]);
  assert.equal(REJOIN_INTERVAL_MS, 5 * 60_000);
  assert.equal(REJOIN_GIVE_UP_MS, 30 * 60_000);

  // Walk the whole schedule the way armRejoin does, and read off when each attempt lands
  const landsAtSeconds = [];
  let elapsedMs = 0;
  for (let attempt = 1; attempt < 100; attempt++) {
    const plan = planRejoinDelay(attempt, elapsedMs);
    if (!plan.retry) break;
    elapsedMs += plan.delayMs;
    landsAtSeconds.push(elapsedMs / 1000);
  }

  assert.deepEqual(landsAtSeconds, [10, 40, 100, 400, 700, 1000, 1300, 1600]);
  assert.ok(elapsedMs <= REJOIN_GIVE_UP_MS, 'every attempt lands inside the half hour');
  // The one after the last would land past it, which is what stopped the walk
  assert.equal(planRejoinDelay(9, elapsedMs).retry, false);
});

test('24/7 rejoin: an attempt that would land past the give-up point is not scheduled at all', () => {
  assert.deepEqual(planRejoinDelay(4, 29 * 60_000), { retry: false, delayMs: 0 });
  // ...and nonsense is not a reason to schedule anything either
  assert.equal(planRejoinDelay(0, 0).retry, false);
  assert.equal(planRejoinDelay(NaN, 0).retry, false);
});

test('24/7 rejoin: every reason to stop trying is checked, in the order that matters', () => {
  assert.equal(rejoinAbortReason({}), null, 'nothing wrong: carry on');
  assert.match(rejoinAbortReason({ cancelled: true }), /cancelled/);
  assert.match(rejoinAbortReason({ shuttingDown: true }), /shutting down/);
  assert.match(rejoinAbortReason({ is24_7: false }), /24\/7 mode was turned off/);
  assert.match(rejoinAbortReason({ claimed: true }), /music was started/);
  // A cancelled effort says so even when everything else is also true - the first answer is the
  // one that happened first
  assert.match(rejoinAbortReason({ cancelled: true, is24_7: false, claimed: true }), /cancelled/);
});

test('24/7 rejoin: the plan the rejoin asks for is the restore plan with the checks that do not apply turned off', () => {
  // An hour-old snapshot, and nobody in the channel: both of which stop the startup restore
  // dead. 24/7 has already decided to be in that channel, and an outage is exactly the reason
  // the snapshot is old.
  const snapshot = { ...snapshotOf({ guildId: 'rejoin-plan' }), savedAt: Date.now() - (60 * 60 * 1000) };

  const atStartup = planQueueRestore(snapshot, { humansPresent: 0 });
  assert.equal(atStartup.restore, false);
  assert.equal(atStartup.reason, 'stale');

  const forTheRejoin = planQueueRestore(snapshot, { maxAgeMs: Infinity, channelFound: true, requireHumans: false });
  assert.equal(forTheRejoin.join, true);
  assert.equal(forTheRejoin.reason, 'resume');
  assert.ok(Math.abs(forTheRejoin.resumeAt - 42) < 1);
});

test('24/7 rejoin: a connection that dies keeps the interrupted song and schedules a way back', () => {
  const queue = createQueue('rejoin-teardown');
  queue.current24_7 = () => true;
  queue.trackAndClearListening = () => {};
  const connection = new FakeConnection(VoiceConnectionStatus.Ready);
  queue.connection = connection;
  queue.listenerConnection = connection;
  queue.voiceChannel = { id: 'voice-teardown-247', name: 'Muziek' };
  queue.voiceChannelName = 'Muziek';
  queue.currentSong = { title: 'Interrupted', url: URL_A, duration: 300 };
  queue.songs = [{ title: 'Next up', url: URL_B, duration: 200 }];
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 40_000;

  queue.teardownConnection('error unrecoverable', connection);

  // The teardown itself is unchanged: the queue stopped and the connection is gone
  assert.equal(queue.isPlaying, false);
  assert.equal(connection.destroyCalls, 1);
  assert.equal(isRejoinPending('rejoin-teardown'), true, 'but 24/7 means it is coming back');

  // ...and the interrupted state is on disk, so a pm2 restart during the retry window (which
  // can be half an hour long) finds the song rather than nothing
  const saved = loadQueueState().guilds['rejoin-teardown'];
  assert.equal(saved.currentSong.title, 'Interrupted');
  assert.deepEqual(saved.songs.map(s => s.title), ['Next up']);
  assert.ok(Math.abs(saved.positionSec - 40) < 1, `saved position was ${saved.positionSec}`);
  assert.equal(saved.voiceChannelId, 'voice-teardown-247');

  cancelRejoin('rejoin-teardown', 'end of test');
  forgetQueueState();
});

test('24/7 rejoin: normal mode is untouched - a dead connection still just stops', () => {
  const queue = createQueue('rejoin-normal-mode');
  queue.current24_7 = () => false;
  queue.trackAndClearListening = () => {};
  const connection = new FakeConnection(VoiceConnectionStatus.Ready);
  queue.connection = connection;
  queue.listenerConnection = connection;
  queue.voiceChannel = { id: 'voice-normal', name: 'Muziek' };
  queue.currentSong = { title: 'Interrupted', url: URL_A, duration: 300 };
  queue.isPlaying = true;
  queue.songStartTime = Date.now() - 5_000;

  queue.teardownConnection('error unrecoverable', connection);

  assert.equal(isRejoinPending('rejoin-normal-mode'), false, 'nothing is scheduled, nothing is retried');
  assert.equal(existsSync(getQueueStatePath()), false, 'and the teardown wrote nothing of its own');
});

test('24/7 rejoin: without 24/7, or without a channel to go back to, nothing is scheduled', () => {
  const snapshot = snapshotOf({ guildId: 'rejoin-refused' });
  assert.equal(scheduleRejoin('rejoin-refused', snapshot, 'error unrecoverable', { is24_7: () => false }), null);
  assert.equal(isRejoinPending('rejoin-refused'), false);

  const logged = captureConsole();
  try {
    assert.equal(scheduleRejoin('rejoin-nowhere', { ...snapshot, voiceChannelId: null }, 'error unrecoverable', { is24_7: () => true }), null);
  } finally {
    logged.restore();
  }
  assert.equal(isRejoinPending('rejoin-nowhere'), false);
  assert.ok(logged.find(/channel it was in is not known/), logged.dump());
});

test('24/7 rejoin: an error storm is one effort, not five', () => {
  const snapshot = snapshotOf({ guildId: 'rejoin-storm' });
  const first = scheduleRejoin('rejoin-storm', snapshot, 'error unrecoverable', { is24_7: () => true, schedule: [60_000] });
  const second = scheduleRejoin('rejoin-storm', snapshot, 'error unrecoverable', { is24_7: () => true, schedule: [60_000] });
  assert.equal(second, first, 'the effort already running owns this guild');
  assert.equal(first.attempt, 1, 'and it did not restart its own schedule');
  cancelRejoin('rejoin-storm', 'end of test');
});

test('24/7 rejoin: a /play that gets there first calls the whole thing off, at once', async () => {
  const snapshot = snapshotOf({ guildId: 'rejoin-raced' });
  // A backoff long enough that the attempt has definitely not fired yet
  scheduleRejoin('rejoin-raced', snapshot, 'error unrecoverable', { is24_7: () => true, schedule: [50] });
  assert.equal(isRejoinPending('rejoin-raced'), true);

  // ...which is exactly the window a user's /play lands in
  const userQueue = createQueue('rejoin-raced');

  assert.equal(isRejoinPending('rejoin-raced'), false, 'cancelled the moment music was started, not five minutes later');
  await sleep(80);
  assert.equal(userQueue.connection, null, 'and the attempt never ran, so nothing joined anything');
  userQueue.cleanup();
});

test('24/7 rejoin: a shutdown ends the effort - the next process reads the snapshot instead', async () => {
  const snapshot = snapshotOf({ guildId: 'rejoin-shutdown' });
  scheduleRejoin('rejoin-shutdown', snapshot, 'error unrecoverable', { is24_7: () => true, schedule: [50] });
  assert.equal(isRejoinPending('rejoin-shutdown'), true);

  flushQueueState();

  assert.equal(isRejoinPending('rejoin-shutdown'), false);
  // The shutdown flush latches persistence off for the process it belongs to, so nothing new is
  // scheduled either
  assert.equal(scheduleRejoin('rejoin-shutdown', snapshot, 'error unrecoverable', { is24_7: () => true }), null);

  // Put the module back the way a fresh process starts, for whatever runs after this
  await restoreQueueState({ client: fakeClient() });
  forgetQueueState();
});

test('24/7 rejoin: an attempt that lands goes back into the channel and picks the song up where it stopped', async () => {
  const channel = fakeVoiceChannel('voice-247-live', { humans: 0, bots: 0 });
  // Nobody in the channel on purpose: 24/7 is about being there, whether or not anybody is
  // listening at the moment the connection comes back
  setDiscordClient(fakeClient(channel));
  const queue = createQueue('rejoin-live');
  const calls = stubQueueForRestore(queue);

  try {
    const snapshot = snapshotOf({ guildId: 'rejoin-live', channelId: channel.id, positionSec: 42, songs: [{ title: 'Next up', url: URL_B, duration: 200 }] });
    scheduleRejoin('rejoin-live', snapshot, 'error unrecoverable', { is24_7: () => true, schedule: [0] });

    await waitUntil(() => calls.length > 0, 'the interrupted song to start downloading again');
    assert.equal(calls[0].url, URL_A);
    calls[0].finish();
    await waitUntil(() => queue.played.length > 0, 'playback to start');

    assert.deepEqual(queue.joined, ['voice-247-live']);
    assert.ok(Math.abs(queue.played[0].seconds - 42) <= 1, `resumed at ${queue.played[0].seconds}s`);
    assert.equal(queue.currentSong.title, 'Interrupted');
    assert.deepEqual(queue.songs.map(s => s.title), ['Next up']);
    assert.equal(queue.volume, 0.5);
    assert.equal(isRejoinPending('rejoin-live'), false, 'the effort is over: it worked');
  } finally {
    setDiscordClient(null);
    queue.cleanup();
    await tick();
  }
  assert.deepEqual(cacheFilesFor('rejoin-live'), []);
});

test('24/7 rejoin: an attempt that cannot join tries again, and leaves no half-joined queue behind', async () => {
  const channel = fakeVoiceChannel('voice-247-outage', { humans: 1 });
  setDiscordClient(fakeClient(channel));
  const queue = createQueue('rejoin-outage');
  const calls = stubQueueForRestore(queue);
  const connection = new FakeConnection(VoiceConnectionStatus.Signalling);
  // What a Discord outage looks like from here: the join hands back a connection that never
  // becomes Ready
  queue.join = async () => {
    queue.joined.push(channel.id);
    queue.connection = connection;
    return connection;
  };

  const logged = captureConsole();
  try {
    // The first attempt now, the second far enough out that this test does not have to wait
    // for it - what matters is that it is scheduled at all
    scheduleRejoin('rejoin-outage', snapshotOf({ guildId: 'rejoin-outage', channelId: channel.id }), 'error unrecoverable', {
      is24_7: () => true,
      schedule: [0, 60_000],
      readyMs: 30,
      giveUpMs: 10 * 60_000
    });

    await waitUntil(() => logged.find(/got no usable voice connection/), 'the attempt to fail');

    assert.deepEqual(queue.joined, ['voice-247-outage'], 'it did try');
    assert.equal(calls.length, 0, 'and downloaded nothing for a connection that never came up');
    assert.equal(getQueue('rejoin-outage'), undefined, 'no queue is left holding a dead connection');
    assert.equal(connection.destroyCalls, 1, 'and the half-open connection was closed');
    assert.equal(isRejoinPending('rejoin-outage'), true, 'the effort continues');
    assert.ok(logged.find(/rejoin attempt 2 for guild rejoin-outage in 60s/), logged.dump());
  } finally {
    logged.restore();
    setDiscordClient(null);
    cancelRejoin('rejoin-outage', 'end of test');
  }
});

// --- loudness normalization --------------------------------------------------
//
// The fixtures are real ffmpeg output, captured from `ffmpeg -i <file> -af
// loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -` on this box, log lines and all.
// Nothing about the parser is worth testing against a hand-written approximation of it: the
// whole risk is what ffmpeg actually prints around the JSON, and what happens when a value in
// it is one ffmpeg would then refuse to accept back.

const REAL_LOUDNORM_STDERR = `Input #0, ogg, from 'b.opus':
  Duration: 00:00:10.01, start: 0.000000, bitrate: 125 kb/s
  Stream #0:0: Audio: opus, 48000 Hz, mono, fltp
Stream mapping:
  Stream #0:0 -> #0:0 (opus (native) -> pcm_s16le (native))
[out#0/null @ 0x5e05caba4cc0] video:0kB audio:3750kB subtitle:0kB other streams:0kB
size=N/A time=00:00:07.10 bitrate=N/A speed=35.5x
[Parsed_loudnorm_0 @ 0x5e05cabef680]
{
	"input_i" : "-39.35",
	"input_tp" : "-35.88",
	"input_lra" : "0.00",
	"input_thresh" : "-49.35",
	"output_i" : "-15.97",
	"output_tp" : "-12.54",
	"output_lra" : "0.00",
	"output_thresh" : "-25.97",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.03"
}`;

// The same pass over a real 4-minute AI cover - a track mastered right into the ceiling, which
// is the case this whole feature exists for
const LOUD_TRACK_LOUDNORM_STDERR = `[Parsed_loudnorm_0 @ 0x6287538a1000]
{
	"input_i" : "-14.74",
	"input_tp" : "-0.74",
	"input_lra" : "8.10",
	"input_thresh" : "-25.27",
	"output_i" : "-15.67",
	"output_tp" : "-1.61",
	"output_lra" : "6.90",
	"output_thresh" : "-25.96",
	"normalization_type" : "dynamic",
	"target_offset" : "-0.33"
}`;

test('parseLoudnormJson: reads the measured values out of real ffmpeg output', () => {
  assert.deepEqual(parseLoudnormJson(REAL_LOUDNORM_STDERR), {
    input_i: -39.35,
    input_tp: -35.88,
    input_lra: 0,
    input_thresh: -49.35,
    target_offset: -0.03
  });
  assert.deepEqual(parseLoudnormJson(LOUD_TRACK_LOUDNORM_STDERR), {
    input_i: -14.74,
    input_tp: -0.74,
    input_lra: 8.1,
    input_thresh: -25.27,
    target_offset: -0.33
  });
});

test('parseLoudnormJson: nothing to read is null, not a half-filled measurement', () => {
  assert.equal(parseLoudnormJson(''), null);
  assert.equal(parseLoudnormJson(null), null);
  assert.equal(parseLoudnormJson('Input #0, ogg, from a.opus:\n  Duration: 00:00:10.01'), null);
  // ffmpeg died part-way through printing it
  assert.equal(parseLoudnormJson('{\n\t"input_i" : "-14.74",\n\t"input_tp" :'), null);
});

test('parseLoudnormJson: a silent file measures as -inf, which is not a measurement', () => {
  // Real output for a file with no audio in it at all. Number('-inf') is NaN, and handing NaN
  // to ffmpeg as measured_I is a song that produces nothing.
  const silent = REAL_LOUDNORM_STDERR.replace('"-39.35"', '"-inf"');
  assert.equal(parseLoudnormJson(silent), null);
});

test('parseLoudnormJson: values ffmpeg would refuse are treated as unmeasured', () => {
  // measured_thresh's accepted range is -99..0. A value outside it does not make the song
  // quiet, it makes the filter fail to initialise - which is a silent song.
  assert.equal(parseLoudnormJson(REAL_LOUDNORM_STDERR.replace('"-49.35"', '"-120.4"')), null);
  assert.equal(parseLoudnormJson(REAL_LOUDNORM_STDERR.replace('"0.00"', '"140.0"')), null);
});

test('parseLoudnormJson: the last block wins', () => {
  const twice = `${REAL_LOUDNORM_STDERR}\n${LOUD_TRACK_LOUDNORM_STDERR}`;
  assert.equal(parseLoudnormJson(twice).input_i, -14.74);
});

test('buildLoudnormFilter: the measured values become a single-pass filter at the target', () => {
  const filter = buildLoudnormFilter(parseLoudnormJson(LOUD_TRACK_LOUDNORM_STDERR));
  // The streaming-standard target, and the measurement that turns loudnorm's guessing single
  // pass into the second pass of a two-pass run
  assert.match(filter, /^loudnorm=I=-16:TP=-1\.5:LRA=11:/);
  assert.match(filter, /measured_I=-14\.74/);
  assert.match(filter, /measured_TP=-0\.74/);
  assert.match(filter, /measured_LRA=8\.1/);
  assert.match(filter, /measured_thresh=-25\.27/);
  assert.match(filter, /offset=-0\.33/);
  // A static gain rather than a compressor riding the track. loudnorm drops to dynamic by
  // itself when a linear gain would clip the ceiling.
  assert.match(filter, /linear=true/);
});

test('buildLoudnormFilter: an unmeasured file gets no filter at all', () => {
  assert.equal(buildLoudnormFilter(null), null);
  assert.equal(buildLoudnormFilter(undefined), null);
  // A measurement missing a field is not a measurement
  assert.equal(buildLoudnormFilter({ input_i: -14, input_tp: -1 }), null);
});

test('measureLoudness: a file that is not there answers null rather than throwing', async () => {
  assert.equal(await measureLoudness(join(tmpdir(), `godcord_nope_${process.pid}.opus`)), null);
  assert.equal(await measureLoudness(null), null);
});

test('measureLoudness: a file with no audio in it answers null, and the song still plays', async () => {
  // The failure that must never block a song: ffmpeg exits non-zero, nothing is measured, and
  // the caller carries on with no filter.
  const path = join(tmpdir(), `godcord_notaudio_${process.pid}.opus`);
  writeFileSync(path, 'this is not an opus file');
  try {
    const logged = captureConsole();
    try {
      assert.equal(await measureLoudness(path), null);
    } finally {
      logged.restore();
    }
    assert.equal(buildLoudnormFilter(loudnessFor(path)), null, 'nothing was remembered for it');
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

// ffmpeg is a hard runtime dependency of this module, but a checkout without it should report
// that rather than failing a loudness assertion for the wrong reason.
const FFMPEG = (() => {
  try {
    return execSync('which ffmpeg', { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();

test('measureLoudness: real ffmpeg, real file - a known tone measures as a usable number', { skip: FFMPEG ? false : 'no system ffmpeg' }, async () => {
  // The one test that proves the whole first pass end to end: a synthetic tone at a known
  // level, measured by the same code the download path calls.
  const path = join(tmpdir(), `godcord_tone_${process.pid}.opus`);
  execFileSync(FFMPEG, [
    '-y', '-loglevel', '0',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6:sample_rate=48000',
    '-filter:a', 'volume=-12dB', '-c:a', 'libopus', '-b:a', '96k', path
  ]);
  try {
    const measured = await measureLoudness(path);
    assert.ok(measured, 'a real file measures');
    // A -12dBFS sine sits around -15 LUFS; the point is that it is a plausible, finite number
    // in the range ffmpeg will take back, not a magic constant
    assert.ok(measured.input_i < 0 && measured.input_i > -40, `input_i was ${measured.input_i}`);
    assert.ok(measured.input_tp < 0, `input_tp was ${measured.input_tp}`);
    assert.ok(Number.isFinite(measured.target_offset));
    assert.match(buildLoudnormFilter(measured), /measured_I=/);
  } finally {
    if (existsSync(path)) unlinkSync(path);
  }
});

test('a deleted cache file takes its measurement with it', () => {
  const path = join(tmpdir(), `godcord_forget_${process.pid}.opus`);
  writeFileSync(path, 'audio');
  const queue = new MusicQueue('loudness-forget');
  queue.cachedAudioPath = path;
  rememberLoudness(path, parseLoudnormJson(REAL_LOUDNORM_STDERR));
  assert.ok(loudnessFor(path), 'measured');

  queue.cleanupCachedAudio();

  assert.equal(loudnessFor(path), null, 'and forgotten with the file, so the map cannot grow');
  assert.equal(existsSync(path), false);
});

test('the settings home: normalization and crossfade default on, nonsense reads as the default', () => {
  // playerSettings.json is hand-edited (there is no UI yet), so a typo must not silently
  // remove a feature - only an explicit 0 turns the crossfade off.
  assert.equal(clampCrossfadeSec(undefined), DEFAULT_CROSSFADE_SEC);
  assert.equal(clampCrossfadeSec(null), DEFAULT_CROSSFADE_SEC);
  assert.equal(clampCrossfadeSec('nonsense'), DEFAULT_CROSSFADE_SEC);
  assert.equal(clampCrossfadeSec(0), 0, 'an explicit zero is off');
  assert.equal(clampCrossfadeSec('0'), 0);
  assert.equal(clampCrossfadeSec(4), 4);
  assert.equal(clampCrossfadeSec(-3), 0);
  assert.equal(clampCrossfadeSec(99), MAX_CROSSFADE_SEC);

  const settings = getMusicSettings();
  assert.equal(typeof settings.normalizeAudio, 'boolean');
  assert.equal(typeof settings.crossfadeSec, 'number');
});

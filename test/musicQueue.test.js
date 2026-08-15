import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { AudioPlayerStatus, VoiceConnectionStatus } from '@discordjs/voice';
import {
  MusicQueue,
  createQueue,
  isPlayerPaused,
  waitForReadyConnection,
  setWebUpdateCallback,
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

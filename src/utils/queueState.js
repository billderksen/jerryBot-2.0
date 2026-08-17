// What the music queue needs written down to survive the process ending, and the arithmetic
// that turns it back into a queue.
//
// The bot is restarted for every deploy, and a restart used to be the end of the evening: the
// queue lived only in memory, so a pm2 restart mid-song left the room silent with nothing to
// put back. The queue is now snapshotted to disk while it plays and read back at startup.
//
// Everything in here is either file IO or pure arithmetic - it knows nothing about Discord,
// @discordjs/voice or the MusicQueue class - so the decisions that matter (is this snapshot
// too old to use, where in the song do we come back, is there anybody there to hear it) are
// directly testable without a voice connection.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync } from 'fs';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bumped only if the shape below changes incompatibly. A file from an older shape is discarded
// rather than half-read: a restore that puts back a queue it does not fully understand is
// worse than a restore that does not happen.
export const QUEUE_STATE_VERSION = 1;

// How old a snapshot may be and still be worth acting on. Past this, whatever the room was
// listening to is not what the room is doing now, and starting it again would be the bot
// talking over a conversation rather than picking up where it left off.
export const QUEUE_STATE_MAX_AGE_MS = 30 * 60 * 1000;

let stateFile = join(__dirname, '..', '..', 'data', 'queueState.json');

// Tests point the store somewhere disposable rather than writing to the live bot's data
// directory (the same seam as voiceAssistant's setOptInStorePath).
export function setQueueStatePath(filePath) {
  stateFile = filePath;
}

export function getQueueStatePath() {
  return stateFile;
}

// The fields of a song that are worth keeping. A whitelist rather than the whole object: a
// song picked up from history carries a playedAt, a radio pick carries channel metadata, and
// none of it survives a restart as anything but noise in a file a human may have to read.
const SONG_FIELDS = ['title', 'url', 'duration', 'thumbnail', 'requestedBy', 'requestedById', 'source'];

// @returns {object|null} the storable form of a song, or null when there is nothing playable
//   in it - a song with no URL cannot be fetched again, so it is not worth restoring.
export function serializeSong(song) {
  if (!song || typeof song !== 'object' || typeof song.url !== 'string' || song.url === '') return null;
  const out = {};
  for (const field of SONG_FIELDS) {
    if (song[field] !== undefined) out[field] = song[field];
  }
  return out;
}

export function serializeSongs(songs) {
  return (Array.isArray(songs) ? songs : []).map(serializeSong).filter(Boolean);
}

// One guild's worth of "here is where we were". Assembled here rather than inline at the call
// site so the file on disk has exactly one shape, whichever path wrote it - the periodic save
// while playing, the shutdown flush, and the snapshot a connection teardown takes on its way
// out all produce the same record.
export function buildGuildSnapshot({
  guildId,
  guildName = null,
  guildIcon = null,
  voiceChannelId = null,
  voiceChannelName = null,
  currentSong = null,
  songs = [],
  positionSec = 0,
  volume = 1.0,
  wasPaused = false,
  loopMode = 'off',
  is24_7 = false,
  radioEnabled = false,
  savedAt = Date.now()
} = {}) {
  return {
    guildId,
    guildName,
    guildIcon,
    voiceChannelId,
    voiceChannelName,
    currentSong,
    songs,
    // Seconds of audio, not milliseconds of wall clock: this is the number ffmpeg's -ss takes
    // and the number the dashboard shows, and it already has the mixer's speed folded in.
    positionSec: Number.isFinite(positionSec) && positionSec > 0 ? positionSec : 0,
    volume: Number.isFinite(volume) ? volume : 1.0,
    wasPaused: !!wasPaused,
    // The global settings are persisted in playerSettings.json in their own right; these are
    // copies, kept so a snapshot read by a human says what the player was doing at the time.
    loopMode,
    is24_7,
    radioEnabled,
    savedAt
  };
}

export function loadQueueState() {
  const state = loadJsonSync(stateFile, { version: QUEUE_STATE_VERSION, savedAt: 0, guilds: {} });
  if (!state || typeof state !== 'object' || !state.guilds || typeof state.guilds !== 'object') {
    return { version: QUEUE_STATE_VERSION, savedAt: 0, guilds: {} };
  }
  return state;
}

export function saveQueueState(guilds) {
  saveJsonSync(stateFile, { version: QUEUE_STATE_VERSION, savedAt: Date.now(), guilds });
}

// Drop the file entirely. Called once a saved state has been acted on (restored or discarded),
// and whenever the user stops the music themselves - an explicit stop is not something a
// restart should undo.
export function clearQueueState() {
  try {
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
      return true;
    }
  } catch (err) {
    console.error(`[queueState] Could not remove ${stateFile}:`, err.message);
  }
  return false;
}

// Where in the song to come back, given where we left off.
//
// The clamp is the same one seek() applies, for the same reason: -ss past the end of the audio
// produces a stream that ends immediately, and a song that ends the instant it starts is a
// song the queue skips for no visible reason. A duration of 0 means "unknown" (a live stream,
// a lookup that came back without one), and an unknown length is not a reason to refuse the
// offset - ffmpeg simply plays from there.
export function clampResumePosition(positionSec, duration) {
  const position = Number(positionSec);
  if (!Number.isFinite(position) || position <= 0) return 0;
  const length = Number(duration);
  if (Number.isFinite(length) && length > 0) return Math.min(position, Math.max(0, length - 1));
  return position;
}

// What to do with one guild's saved state, decided from the state and the room as it is now.
//
// Pure, and the whole decision: whether the snapshot is worth acting on at all, what goes back
// into the queue, whether to join the channel, and where in the song to start. The two callers
// (startup restore, 24/7 rejoin) differ only in the options they pass - the rejoin has already
// decided it is going into that channel, so it turns the age and audience checks off.
//
// @param humansPresent - people (not bots) in the saved voice channel right now
// @param requireHumans - whether an empty channel means "restore, but don't join"
// @returns {{restore: boolean, reason: string, join?: boolean, songs?: object[],
//   currentSong?: object|null, resumeAt?: number, volume?: number}}
//   `songs` is exactly what queue.songs should become, current song included at the front -
//   so a caller that starts playback lets the ordinary start path shift it off. `currentSong`
//   is non-null only when playback should actually be started, and `resumeAt` is where.
export function planQueueRestore(guildState, {
  now = Date.now(),
  maxAgeMs = QUEUE_STATE_MAX_AGE_MS,
  channelFound = true,
  humansPresent = 0,
  requireHumans = true
} = {}) {
  if (!guildState || typeof guildState !== 'object') return { restore: false, reason: 'nothing-saved' };

  const current = serializeSong(guildState.currentSong);
  const upcoming = serializeSongs(guildState.songs);
  if (!current && upcoming.length === 0) return { restore: false, reason: 'nothing-saved' };

  const savedAt = Number(guildState.savedAt);
  // A snapshot with no timestamp cannot be judged, so it is treated as too old to trust. A
  // clock that stepped backwards over the restart reads as age zero rather than as a reason to
  // throw the queue away.
  if (!Number.isFinite(savedAt)) return { restore: false, reason: 'stale', ageMs: Infinity };
  const ageMs = Math.max(0, now - savedAt);
  if (ageMs > maxAgeMs) return { restore: false, reason: 'stale', ageMs };

  // Everything that was in the queue, in the order it was in. The song that was playing goes
  // back at the front whether or not playback is about to start, so nothing is lost in the
  // cases where it is not.
  const songs = current ? [current, ...upcoming] : upcoming;
  const volume = Number.isFinite(guildState.volume) ? guildState.volume : 1.0;
  const held = (reason) => ({ restore: true, reason, join: false, songs, currentSong: null, resumeAt: 0, volume });

  if (!channelFound) return held('channel-gone');
  if (requireHumans && humansPresent <= 0) return held('channel-empty');
  // A pause is an instruction, and a restart is not a reason to overrule it. The queue comes
  // back, the music does not start itself.
  if (guildState.wasPaused) return held('was-paused');
  // Songs queued but nothing playing. The bot is only ever put into a channel here in order to
  // resume something, so there is nothing to join for - the queue is simply waiting.
  if (!current) return held('queue-only');

  return {
    restore: true,
    reason: 'resume',
    join: true,
    songs,
    currentSong: current,
    resumeAt: clampResumePosition(guildState.positionSec, current.duration),
    volume
  };
}

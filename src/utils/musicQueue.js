import { createAudioPlayer, createAudioResource, joinVoiceChannel, getVoiceConnection, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import ytDlpPkg from 'yt-dlp-exec';
import { platform } from 'os';
import { spawn, execSync } from 'child_process';
// Exported so other modules (play.js search/autocomplete, server.js radio route) can reuse
// this same system-binary-aware, cookie-aware instance instead of keeping their own copy.
export let ytDlpExec;

// Use system yt-dlp(.exe) if available, otherwise fallback to yt-dlp-exec default
let systemYtDlpPath = null;
try {
  if (platform() === 'win32') {
    // On Windows, look for yt-dlp.exe
    systemYtDlpPath = execSync('where yt-dlp.exe', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } else {
    // On Linux/macOS, look for yt-dlp
    systemYtDlpPath = execSync('which yt-dlp', { encoding: 'utf8' }).trim();
  }
} catch (e) {
  console.log('System yt-dlp not found in PATH, checking common locations...');
  // Try common locations
  const commonPaths = platform() === 'win32' 
    ? ['C:\\yt-dlp\\yt-dlp.exe', 'C:\\Program Files\\yt-dlp\\yt-dlp.exe']
    : ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', '/home/jerryBot/yt-dlp'];
  
  for (const p of commonPaths) {
    try {
      if (platform() === 'win32') {
        execSync(`if exist "${p}" echo found`, { encoding: 'utf8' });
      } else {
        execSync(`test -f "${p}"`, { encoding: 'utf8' });
      }
      systemYtDlpPath = p;
      break;
    } catch (e2) {
      // Not found, try next
    }
  }
}

if (systemYtDlpPath) {
  console.log('Using system yt-dlp:', systemYtDlpPath);
  // Use .create() to specify a custom binary path
  ytDlpExec = ytDlpPkg.create(systemYtDlpPath);
} else {
  console.log('WARNING: System yt-dlp not found! Music playback will likely fail on Linux.');
  console.log('Install yt-dlp with: sudo apt install yt-dlp');
  console.log('Or: sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod a+rx /usr/local/bin/yt-dlp');
  ytDlpExec = ytDlpPkg;
}
// YouTube cookies for authenticated access (improves radio variety, age-gated content, etc.)
// YOUTUBE_COOKIES_BROWSER=firefox  → extracts cookies from browser at runtime (simplest)
// YOUTUBE_COOKIES=path/to/file.txt → uses a Netscape-format cookies file
export const ytCookieOpts = process.env.YOUTUBE_COOKIES_BROWSER
  ? { cookiesFromBrowser: process.env.YOUTUBE_COOKIES_BROWSER }
  : process.env.YOUTUBE_COOKIES && existsSync(process.env.YOUTUBE_COOKIES)
    ? { cookies: process.env.YOUTUBE_COOKIES }
    : {};

// (moved up)
import ffmpegStatic from 'ffmpeg-static';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';
import { isAllowedMediaUrl } from './urlValidation.js';
import { isRecording, stopRecording } from './voiceRecorder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// How long the bot stays in the channel after the queue runs dry
const AUTO_LEAVE_MS = 60_000;

// Determine FFmpeg path - try ffmpeg-static first, fall back to system ffmpeg
let ffmpegPath = ffmpegStatic;

// On Linux, ffmpeg-static might not work, so try system ffmpeg as fallback
if (!ffmpegPath || process.platform === 'linux') {
  try {
    // Check if system ffmpeg is available
    const systemFfmpeg = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (systemFfmpeg) {
      ffmpegPath = systemFfmpeg;
      console.log('Using system FFmpeg:', ffmpegPath);
    }
  } catch (e) {
    // System ffmpeg not found, use ffmpeg-static
    ffmpegPath = ffmpegStatic;
    console.log('Using ffmpeg-static:', ffmpegPath);
  }
}

// Set FFmpeg path
process.env.FFMPEG_PATH = ffmpegPath;

// Recently played persistence
const RECENTLY_PLAYED_FILE = join(__dirname, '..', '..', 'data', 'recentlyPlayed.json');
const SETTINGS_FILE = join(__dirname, '..', '..', 'data', 'playerSettings.json');
const STATS_FILE = join(__dirname, '..', '..', 'data', 'listeningStats.json');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// How long a seek/filter restart may stay pending before we assume the Playing
// transition is never coming and unstick the player
const SEEK_WATCHDOG_MS = 10000;
// A ducked clip (wake beep, spoken reply) holds the music down while it plays, so
// it is abandoned once it stops making playback progress for this long...
const DUCK_STALL_MS = 10000;
// ...or overruns this total, however healthy it looks
const DUCK_MAX_MS = 120000;
// How long a voice connection that raised an 'error' gets to come back to Ready before the
// queue gives up on it. The same 5s the Disconnected handler allows, but a materially stricter
// bar: Disconnected forgives as soon as a reconnect has *started* (Signalling or Connecting)
// and leaves the rest to the library, while an error is only forgiven by a connection that is
// actually Ready again - there is no transition on the way that would tell us any different.
const CONNECTION_RECOVERY_MS = 5000;
// A connection 'error' usually arrives a beat before the WebSocket close that explains it, so
// the connection's status is never read until it has had this long to settle.
const CONNECTION_SETTLE_MS = 250;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Wrap a timer body so a throw inside it is logged instead of ending the process.
//
// A throwing timer is not a logged warning here: index.js's uncaughtException handler ends in
// process.exit(1), so it is the bot dying mid-song, pm2 restarting it, and the /tmp file for
// that song orphaned. Every timer in this module reaches at least one thing that can throw for
// reasons outside it - a full disk (saveJsonSync) or the web dashboard's updateState ->
// client.send() - so none of them run bare. The recovery path was given a .catch for exactly
// this reason; this is the same reasoning applied to the class rather than to one site.
export function safeTimer(what, fn) {
  return () => {
    try {
      fn();
    } catch (err) {
      console.error(`[MusicQueue] ${what} failed:`, err?.message || err);
    }
  };
}

// Start async work that nothing is going to await, and make sure a failure says where it came
// from. All of these are queue advances fired from an event or timer body: left bare, a
// rejection reaches the process-wide handler that logs it without a clue which path it was, and
// whatever half-mutated state it died in simply stays.
function unattended(promise, what) {
  if (promise && typeof promise.catch === 'function') {
    promise.catch(err => console.error(`[MusicQueue] ${what} failed:`, err?.message || err));
  }
  return promise;
}

// --- Serialized, 403-tolerant media downloads --------------------------------
//
// YouTube answers "HTTP Error 403: Forbidden" to media fetches it sees as a burst from one
// IP. This module used to make two per song at once: ffmpeg pulling the googlevideo stream
// URL for playback, and yt-dlp downloading the same audio again to cache it for seeking.
// The production logs show exactly what that cost - 24 cache downloads 403'd, 0 metadata
// lookups did, and 23 songs died as "FFmpeg process closed with code 8", which is ffmpeg's
// exit code for a 403 (verified). A song whose stream 403s produces no audio at all, so the
// player goes Idle and the queue skips it silently, with nothing to retry and nothing
// logged that says why.
//
// So there is now one media fetch per song: play() downloads the audio to a local file
// through this gate and plays ffmpeg off that file. Nothing else fetches media, ffmpeg
// never touches a googlevideo URL, and the one fetch that remains fails somewhere a retry
// can reach. The cheap listing calls (radio mixes, search autocomplete) stay ungated - they
// are not what YouTube is counting.
//
// That fixed the skips (about 7 dead songs in 15 became 1) and left one cost behind: the
// download now happens in the gap between songs, where it is audible silence. Roughly half
// of them 403 on the first attempt, so the gap was the download plus a backoff - up to 13
// seconds of nothing. Since a song's audio is a file that exists before playback starts,
// the same fetch can just as well happen a song early, and that is what the prefetch below
// does: while song N plays, queue[0] is downloaded in the background at CACHE priority, so
// when N ends its successor is already on disk and the transition costs nothing. A prefetch
// is never authoritative - if it is missing, stale or failed, the start downloads the song
// itself exactly as it did before, with the same retries and the same say over the breaker.

// Waits before the 2nd and 3rd attempt, so three attempts in all. Passed around as a
// parameter so the retry loop can be tested without sitting out ten real seconds.
//
// The first hop is near-immediate on purpose. Each attempt runs a fresh yt-dlp, which
// re-resolves a new googlevideo URL, and the 403s in the logs are the pattern kind that a
// re-resolution clears rather than a cooldown that has to be waited out - so the old 3s
// first wait bought nothing and cost 3s on about half of all downloads. The second wait
// stays long, because a 403 that survives a re-resolution is the kind worth waiting on.
export const DOWNLOAD_403_BACKOFF_MS = [500, 3000];

// Starting a song outranks any background fetch, which is what keeps the next-song prefetch
// from ever standing between a listener and the song they are waiting for: a prefetch that
// is merely queued is jumped, and one that is already running is killed outright when the
// song it was for stops being next (see invalidatePrefetch).
export const DOWNLOAD_PRIORITY = { CACHE: 0, PLAY: 1 };

// A download that stops making progress must not hold the gate for the rest of the evening.
// execa kills the child on timeout (SIGTERM, error.timedOut) rather than just abandoning the
// promise, so the slot is genuinely released and no yt-dlp is left running.
export const DOWNLOAD_TIMEOUT_MS = 60_000;

// One slot, handed out highest-priority-first and FIFO within a priority. Ownership of the
// slot passes straight from a releasing holder to the next waiter, so the count can never
// drift; a release is idempotent because the retry loop releases in a `finally` that a
// thrown abort also runs through.
export class DownloadGate {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
  }

  // @returns {Promise<function>} resolves with the release function once the slot is held
  acquire(priority = DOWNLOAD_PRIORITY.CACHE) {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve(this.grant());
    }
    return new Promise(resolve => {
      // Inserted ahead of everything of lower priority and behind everything of equal or
      // higher, which is what keeps arrivals of one priority in their own order: a
      // play-path job jumps the queued cache jobs without reshuffling them
      let i = this.waiting.length;
      while (i > 0 && this.waiting[i - 1].priority < priority) i--;
      this.waiting.splice(i, 0, { priority, resolve });
    });
  }

  grant() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot is not freed and re-taken, it is handed over: `active` stays put
      if (next) next.resolve(this.grant());
      else this.active--;
    };
  }

  async run(fn, priority = DOWNLOAD_PRIORITY.CACHE) {
    const release = await this.acquire(priority);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const downloadGate = new DownloadGate(1);

// yt-dlp reports the rate-limit as an HTTP 403 on the video data, e.g.
// "ERROR: unable to download video data: HTTP Error 403: Forbidden". Matched on the
// phrasing rather than on a bare "403" so a video id or a title containing those three
// digits cannot turn a genuinely dead video into three attempts at nothing.
export function is403(text) {
  if (!text) return false;
  const s = String(text);
  if (/HTTP\s*Error\s*403\b/i.test(s)) return true;
  return /\b403\b/.test(s) && /forbidden/i.test(s);
}

// execa keeps the child's stderr off the message on some failures and folds it in on
// others, so the verdict is taken over everything it carries.
export function downloadErrorText(error) {
  if (!error) return '';
  return [error.stderr, error.shortMessage, error.message].filter(Boolean).join('\n');
}

// Pure: what to do after attempt `attempt` (1-based) failed with `errorText`.
export function planDownloadRetry(attempt, errorText, schedule = DOWNLOAD_403_BACKOFF_MS) {
  if (!is403(errorText)) return { retry: false, delayMs: 0 };
  const delayMs = schedule[attempt - 1];
  if (delayMs === undefined) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs };
}

// Thrown when the reason for a fetch disappeared while it was queued or backing off. It is
// not a failure: whatever moved the queue on owns its state now, and callers must leave it
// alone rather than counting a failure or advancing the queue a second time.
export class DownloadAbortedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'DownloadAbortedError';
    this.aborted = true;
  }
}

// The single phrasing for a failed fetch, so a rate-limited skip is obvious in `pm2 logs`
// instead of being one more "Error playing song" among the dead videos.
export function describeDownloadFailure(error) {
  if (error?.rateLimited) return `YouTube rate-limited this download (${error.attempts} attempts)`;
  if (error?.timedOut) return `the download did not finish within ${DOWNLOAD_TIMEOUT_MS / 1000}s`;
  return error?.message || 'unknown error';
}

// One line per finished fetch. The whole point of the prefetch is time the listener does not
// spend in silence, and there was no way to read that off the logs at all: how long a
// download took, how many attempts it cost, and whether it happened early enough to matter
// are exactly the three numbers that say whether it is working.
export function formatDownloadTiming(title, ms, attempts, prefetched = false) {
  const plural = attempts === 1 ? 'attempt' : 'attempts';
  return `[MusicQueue] downloaded "${title}" in ${ms}ms (${attempts} ${plural}${prefetched ? ', prefetched' : ''})`;
}

// Whether the song that just started was already on disk, logged at every transition so the
// hit rate reads straight out of `pm2 logs` without a counter to poll or an endpoint to add.
export function formatTransition(hit, title, hits, misses) {
  return `[MusicQueue] transition: prefetch ${hit ? 'HIT' : 'MISS'} for "${title}" (${hits} hit / ${misses} miss)`;
}

// Where one song's audio goes while it is being fetched.
//
// The timestamp alone is not unique, and two downloads sharing a name is not a cosmetic
// problem: dropping a prefetch and starting its replacement happen in the same tick, and the
// dropped one deletes its file on the way out - which would be the file the new one is
// writing. The counter is what actually keeps them apart.
let cacheFileSeq = 0;
function cacheFilePath(prefix, guildId) {
  cacheFileSeq += 1;
  return join(tmpdir(), `${prefix}${guildId}_${Date.now()}_${cacheFileSeq}.opus`);
}

// Delete a cache file and the part-file yt-dlp may have left beside it. Quiet about a file
// that is not there: for a download that was killed before it wrote anything, that is the
// normal case, and every caller is on a path where something has already gone away.
function removeCacheFile(path) {
  if (!path) return;
  for (const candidate of [path, `${path}.part`]) {
    try {
      if (existsSync(candidate)) unlinkSync(candidate);
    } catch (err) {
      console.error(`[MusicQueue] Could not remove ${candidate}:`, err.message);
    }
  }
}

// kill(), guarded. A child that has already exited can throw, and every caller here is a
// cancellation path - a skip, a stop, a teardown - which is no place to take the bot down.
function killChild(child, what) {
  if (!child) return false;
  try {
    child.kill();
  } catch (err) {
    console.error(`[MusicQueue] Failed to stop the ${what}:`, err.message);
  }
  return true;
}

// Run one yt-dlp fetch through the gate, retrying a 403 on the backoff schedule.
//
// All the attempts happen in here and exactly one error comes back out, so a 403 storm
// still counts as a single failure against the caller's breaker - retries are internal.
//
// @param run - performs the fetch; called with the 1-based attempt number
// @param abortReason - returns why this fetch is no longer wanted, or null to carry on.
//   Checked before each attempt and again with the slot in hand, since a job can sit in
//   the queue for the length of a whole download.
export async function runGatedDownload(run, {
  priority = DOWNLOAD_PRIORITY.CACHE,
  label = 'download',
  abortReason = () => null,
  gate = downloadGate,
  schedule = DOWNLOAD_403_BACKOFF_MS
} = {}) {
  for (let attempt = 1; ; attempt++) {
    const reason = abortReason();
    if (reason) throw new DownloadAbortedError(reason);

    let plan = null;
    const release = await gate.acquire(priority);
    try {
      const reasonNow = abortReason();
      if (reasonNow) throw new DownloadAbortedError(reasonNow);
      return await run(attempt);
    } catch (error) {
      if (error?.aborted) throw error;

      const text = downloadErrorText(error);
      plan = planDownloadRetry(attempt, text, schedule);
      if (!plan.retry) {
        // Tagged on the way out so the caller can say why it is skipping the song
        if (is403(text)) {
          error.rateLimited = true;
          error.attempts = attempt;
        }
        throw error;
      }
    } finally {
      release();
    }

    // Backing off inside the gate would idle the one thing the gate exists to keep busy
    console.warn(`[MusicQueue] ${label}: HTTP 403 from YouTube on attempt ${attempt}/${schedule.length + 1}, retrying in ${plan.delayMs}ms`);
    await delay(plan.delayMs);
  }
}

// Load recently played from file
function loadRecentlyPlayed() {
  const data = loadJsonSync(RECENTLY_PLAYED_FILE, []);
  // Filter out entries older than 7 days
  const now = Date.now();
  return data.filter(song => (now - song.playedAt) < SEVEN_DAYS_MS);
}

// Save recently played to file
function saveRecentlyPlayed(recentlyPlayed) {
  // Filter out entries older than 7 days before saving
  const now = Date.now();
  const filtered = recentlyPlayed.filter(song => (now - song.playedAt) < SEVEN_DAYS_MS);
  saveJsonSync(RECENTLY_PLAYED_FILE, filtered);
}

// Global recently played list (shared across all guilds for persistence)
let globalRecentlyPlayed = loadRecentlyPlayed();
console.log(`Loaded ${globalRecentlyPlayed.length} recently played songs from storage`);

// Listening stats persistence
function loadStats() {
  return loadJsonSync(STATS_FILE, { users: {}, songs: {}, totalSongsPlayed: 0, totalListeningTime: 0 });
}

function saveStats() {
  saveJsonSync(STATS_FILE, listeningStats);
}

// Track when a song starts playing (increment play count for requester)
async function trackSongStarted(song) {
  if (!song || !song.requestedBy) return;
  
  const songKey = song.url || song.title;
  
  // Skip tracking for radio auto-adds
  const requestedBy = song.requestedBy || '';
  if (requestedBy.toLowerCase().includes('radio')) return;
  
  // Get requester's user ID
  const userId = song.requestedById;
  
  // Only track if we have a user ID
  if (userId) {
    // Try to get the current displayName from voice channel members
    const voiceMembers = await getVoiceChannelMembers();
    const voiceMember = voiceMembers.find(m => m.id === userId);
    const displayName = voiceMember?.displayName || voiceMember?.username || song.requestedBy;
    
    // Initialize user stats if needed (for the requester - songs played count)
    if (!listeningStats.users[userId]) {
      listeningStats.users[userId] = {
        displayName: displayName,
        songsPlayed: 0,
        totalListeningTime: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now()
      };
    }
    // Always update display name to latest
    listeningStats.users[userId].displayName = displayName;
    listeningStats.users[userId].songsPlayed++;
    listeningStats.users[userId].lastSeen = Date.now();
  }
  
  // Initialize song stats if needed
  if (!listeningStats.songs[songKey]) {
    listeningStats.songs[songKey] = {
      title: song.title,
      url: song.url,
      thumbnail: song.thumbnail,
      playCount: 0,
      totalListeningTime: 0,
      duration: song.duration || 0,
      requestedBy: {} // Track request counts per user
    };
  }
  listeningStats.songs[songKey].playCount++;
  
  // Track who requested this song
  if (userId) {
    const voiceMembers = await getVoiceChannelMembers();
    const voiceMember = voiceMembers.find(m => m.id === userId);
    const displayName = voiceMember?.displayName || voiceMember?.username || song.requestedBy;
    
    if (!listeningStats.songs[songKey].requestedBy) {
      listeningStats.songs[songKey].requestedBy = {};
    }
    if (!listeningStats.songs[songKey].requestedBy[userId]) {
      listeningStats.songs[songKey].requestedBy[userId] = { displayName, count: 0 };
    }
    listeningStats.songs[songKey].requestedBy[userId].displayName = displayName;
    listeningStats.songs[songKey].requestedBy[userId].count++;
  }
  
  // Update global song count
  listeningStats.totalSongsPlayed++;
  
  scheduleSaveStats();
}

// Track actual listening time when song ends - for ALL voice channel members
async function trackListeningTime(song, actualSecondsListened) {
  if (!song || actualSecondsListened <= 0) return;
  
  const songKey = song.url || song.title;
  
  // Cap at song duration to avoid over-counting
  const maxDuration = song.duration || actualSecondsListened;
  const timeToAdd = Math.min(actualSecondsListened, maxDuration);
  
  // Get all members in the voice channel
  const voiceMembers = await getVoiceChannelMembers();
  
  // Track time for each voice channel member
  for (const member of voiceMembers) {
    const userId = member.id;
    const displayName = member.displayName || member.username;
    
    // Initialize user stats if needed
    if (!listeningStats.users[userId]) {
      listeningStats.users[userId] = {
        displayName: displayName,
        songsPlayed: 0,
        totalListeningTime: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now()
      };
    }
    // Always update display name to latest
    listeningStats.users[userId].displayName = displayName;
    listeningStats.users[userId].totalListeningTime += timeToAdd;
    listeningStats.users[userId].lastSeen = Date.now();
  }
  
  // Update song listening time (once per song, not per user)
  if (listeningStats.songs[songKey]) {
    listeningStats.songs[songKey].totalListeningTime += timeToAdd;
  }
  
  // Update global total (once per song)
  listeningStats.totalListeningTime += timeToAdd;
  
  const memberNames = voiceMembers.map(m => m.displayName || m.username).join(', ');
  console.log(`Tracked ${Math.round(timeToAdd)}s listening time for ${voiceMembers.length} members (${memberNames}) on "${song.title}"`);
  
  scheduleSaveStats();
}

// Debounced save - at most once per 30s while stats keep changing during playback
function scheduleSaveStats() {
  if (!saveStatsTimeout) {
    saveStatsTimeout = setTimeout(() => {
      // Cleared before the write, not after: saveJsonSync throws on a full or read-only disk,
      // and a throw that left the handle set would stop every later save from being scheduled
      // (as well as ending the process - see safeTimer)
      saveStatsTimeout = null;
      try {
        saveStats();
      } catch (err) {
        console.error('[MusicQueue] Could not save listening stats:', err.message);
      }
    }, 30000);
  }
}

// Force an immediate synchronous write of any pending listening-stats changes.
// Called from index.js's shutdown flush so stats aren't lost to the debounce window.
export function flushStats() {
  if (saveStatsTimeout) {
    clearTimeout(saveStatsTimeout);
    saveStatsTimeout = null;
    saveStats();
  }
}

let listeningStats = loadStats();
let saveStatsTimeout = null;
console.log(`Loaded listening stats: ${listeningStats.totalSongsPlayed} total songs played`);

// Export getter for listening stats
export function getListeningStats() {
  return listeningStats;
}

// Export getter for 24/7 mode status
export function is24_7Enabled() {
  return globalSettings.is24_7;
}

// Export getter for radio mode status
export function isRadioEnabled() {
  return globalSettings.radioEnabled;
}

// Export getter for music settings
export function getMusicSettings() {
  return {
    loopMode: globalSettings.loopMode,
    is24_7: globalSettings.is24_7,
    radioEnabled: globalSettings.radioEnabled
  };
}

// Player settings persistence
const defaultMixerFilters = {
  bass: 0, mid: 0, treble: 0, speed: 1.0,
  karaoke: false,
  eightD: false, eightDRate: 0.15,
  reverb: 0,
  compressor: false,
  flanger: false
};

function loadSettings() {
  const data = loadJsonSync(SETTINGS_FILE, { loopMode: 'off', is24_7: false, sleepEndTime: null, radioEnabled: false, mixerFilters: { ...defaultMixerFilters } });
  // Check if sleep timer has expired
  if (data.sleepEndTime && data.sleepEndTime < Date.now()) {
    data.sleepEndTime = null;
  }
  return {
    loopMode: data.loopMode || 'off',
    is24_7: data.is24_7 || false,
    sleepEndTime: data.sleepEndTime || null,
    radioEnabled: data.radioEnabled || false,
    mixerFilters: { ...defaultMixerFilters, ...(data.mixerFilters || {}) }
  };
}

function saveSettings() {
  saveJsonSync(SETTINGS_FILE, globalSettings);
}

function buildFilterChain() {
  const filters = ['aresample=resampler=soxr'];
  const m = globalSettings.mixerFilters;

  if (m.bass !== 0) filters.push(`bass=g=${m.bass}`);
  if (m.mid !== 0) filters.push(`equalizer=f=1000:width_type=o:width=1:g=${m.mid}`);
  if (m.treble !== 0) filters.push(`treble=g=${m.treble}`);
  if (m.compressor) filters.push('acompressor=threshold=0.089:ratio=8:attack=5:release=50:makeup=2');
  if (m.karaoke) filters.push('pan=stereo|c0=c0-c1|c1=c1-c0');
  if (m.flanger) filters.push('flanger=delay=3:depth=4:speed=0.5:shape=sinusoidal');
  if (m.reverb > 0) {
    const d = m.reverb / 100;
    filters.push(`aecho=0.8:0.88:60|120|180:${(d * 0.4).toFixed(2)}|${(d * 0.3).toFixed(2)}|${(d * 0.2).toFixed(2)}`);
  }
  if (m.eightD) filters.push(`apulsator=mode=sine:hz=${m.eightDRate || 0.15}:amount=1`);

  if (m.speed !== 1.0) {
    filters.push(`asetrate=48000*${m.speed}`);
    filters.push('aresample=48000');
  }

  return filters.join(',');
}

// Global settings (shared across all clients)
let globalSettings = loadSettings();
let sleepTimer = null;
console.log(`Loaded player settings: loopMode=${globalSettings.loopMode}, is24_7=${globalSettings.is24_7}, sleepEndTime=${globalSettings.sleepEndTime}, radioEnabled=${globalSettings.radioEnabled}`);

// Setup sleep timer if one was persisted
function setupSleepTimer() {
  if (globalSettings.sleepEndTime) {
    const remaining = globalSettings.sleepEndTime - Date.now();
    if (remaining > 0) {
      console.log(`Restoring sleep timer with ${Math.round(remaining / 1000)}s remaining`);
      sleepTimer = setTimeout(safeTimer('the restored sleep timer', () => {
        // Stop playback when timer expires
        sleepTimer = null;
        const firstQueue = queues.values().next().value;
        if (firstQueue) {
          firstQueue.stop();
          firstQueue.leave();
        }
        globalSettings.sleepEndTime = null;
        saveSettings();
        broadcastState();
        console.log('Sleep timer expired - playback stopped');
      }), remaining);
    } else {
      globalSettings.sleepEndTime = null;
      saveSettings();
    }
  }
}

// Call after queues Map is defined
setTimeout(safeTimer('restoring the sleep timer', setupSleepTimer), 100);

// Sleep timer control functions (called from web server)
export function setSleepTimer(minutes) {
  // Clear existing timer if any
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }

  globalSettings.sleepEndTime = Date.now() + (minutes * 60 * 1000);
  saveSettings();

  sleepTimer = setTimeout(safeTimer('the sleep timer', () => {
    // Stop playback when timer expires
    sleepTimer = null;
    const firstQueue = queues.values().next().value;
    if (firstQueue) {
      firstQueue.stop();
      firstQueue.leave();
    }
    globalSettings.sleepEndTime = null;
    saveSettings();
    broadcastState();
    console.log('Sleep timer expired - playback stopped');
  }), minutes * 60 * 1000);

  console.log(`Sleep timer set for ${minutes} minutes`);
  broadcastState();
  return globalSettings.sleepEndTime;
}

export function cancelSleepTimer() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  globalSettings.sleepEndTime = null;
  saveSettings();
  console.log('Sleep timer cancelled');
  broadcastState();
}

export function applyMixerFilters(newFilters) {
  const firstQueue = queues.values().next().value;
  if (firstQueue) {
    return firstQueue.applyFilters(newFilters);
  }
  // No active queue — save settings so they apply to next song
  clampMixerFilters(newFilters);
  saveSettings();
  broadcastState();
  return true;
}

function clampMixerFilters(newFilters) {
  if (newFilters.bass !== undefined) {
    globalSettings.mixerFilters.bass = Math.max(-20, Math.min(20, Math.round(newFilters.bass)));
  }
  if (newFilters.mid !== undefined) {
    globalSettings.mixerFilters.mid = Math.max(-20, Math.min(20, Math.round(newFilters.mid)));
  }
  if (newFilters.treble !== undefined) {
    globalSettings.mixerFilters.treble = Math.max(-20, Math.min(20, Math.round(newFilters.treble)));
  }
  if (newFilters.speed !== undefined) {
    globalSettings.mixerFilters.speed = Math.max(0.5, Math.min(2.0, newFilters.speed));
  }
  if (newFilters.karaoke !== undefined) {
    globalSettings.mixerFilters.karaoke = !!newFilters.karaoke;
  }
  if (newFilters.eightD !== undefined) {
    globalSettings.mixerFilters.eightD = !!newFilters.eightD;
  }
  if (newFilters.eightDRate !== undefined) {
    globalSettings.mixerFilters.eightDRate = Math.max(0.05, Math.min(0.5, newFilters.eightDRate));
  }
  if (newFilters.reverb !== undefined) {
    globalSettings.mixerFilters.reverb = Math.max(0, Math.min(100, Math.round(newFilters.reverb)));
  }
  if (newFilters.compressor !== undefined) {
    globalSettings.mixerFilters.compressor = !!newFilters.compressor;
  }
  if (newFilters.flanger !== undefined) {
    globalSettings.mixerFilters.flanger = !!newFilters.flanger;
  }
}

// Export getter for recently played (used by web server for initial state)
export function getRecentlyPlayed() {
  return globalRecentlyPlayed;
}

// Look up related "YouTube Mix" tracks for a video - shared by server-side radio
// auto-fill in playNext() and the /api/youtube/radio route (which delegates here
// instead of keeping its own copy). Reuses this module's already-configured,
// cookie-aware yt-dlp instance. Returns [] on any failure or unrecognized URL -
// never throws, so callers can fall through to their normal behavior.
export async function getRadioTracks(seedUrl, limit = 20) {
  const videoIdMatch = typeof seedUrl === 'string' && seedUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) return [];
  const videoId = videoIdMatch[1];

  // YouTube Mix playlist URL format: list=RD<videoId>
  const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;

  try {
    const results = await ytDlpExec(mixUrl, {
      ...ytCookieOpts,
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      flatPlaylist: true,
      skipDownload: true,
      playlistEnd: 25
    });

    if (!results.entries || results.entries.length === 0) return [];

    return results.entries
      .filter(video => video.id !== videoId)
      .slice(0, limit)
      .map(video => ({
        title: video.title || 'Unknown Title',
        url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration || 0,
        thumbnail: video.id ? `https://img.youtube.com/vi/${video.id}/hqdefault.jpg` : null,
        channel: video.channel || video.uploader || 'Unknown'
      }));
  } catch (error) {
    console.error('[MusicQueue] Radio lookup failed:', error.message);
    return [];
  }
}

// Store queue per guild
const queues = new Map();

// Web dashboard update function (will be set by index.js)
let webUpdateCallback = null;

// Discord client reference (will be set by index.js)
let discordClient = null;

// Activity logger callbacks (will be set by index.js)
let logNowPlayingCallback = null;
let resetLastLoggedSongCallback = null;

// Presence update callback (will be set by index.js)
let updatePresenceCallback = null;

export function setWebUpdateCallback(callback) {
  webUpdateCallback = callback;
}

export function setDiscordClient(client) {
  discordClient = client;
}

export function setActivityLoggerCallback(logNowPlaying, resetLastLoggedSong) {
  logNowPlayingCallback = logNowPlaying;
  resetLastLoggedSongCallback = resetLastLoggedSong;
}

export function setPresenceCallback(callback) {
  updatePresenceCallback = callback;
}

// Fetch a member's display name from Discord by user ID
export async function getMemberDisplayName(userId) {
  if (!discordClient) return null;
  
  const firstQueue = queues.values().next().value;
  if (!firstQueue || !firstQueue.voiceChannel) return null;
  
  try {
    const guild = firstQueue.voiceChannel.guild;
    const member = await guild.members.fetch(userId);
    return {
      displayName: member.displayName,
      username: member.user.username,
      avatar: member.user.avatar
    };
  } catch (e) {
    return null;
  }
}

// Get members in the bot's current voice channel
export async function getVoiceChannelMembers() {
  if (!discordClient) return [];
  
  const firstQueue = queues.values().next().value;
  if (!firstQueue || !firstQueue.connection) return [];
  
  const voiceChannel = firstQueue.voiceChannel;
  if (!voiceChannel) return [];
  
  // Fetch fresh channel data to get updated nicknames
  const freshChannel = discordClient.channels.cache.get(voiceChannel.id);
  if (!freshChannel) return [];
  
  const members = [];
  
  // Iterate over voice channel members and fetch fresh guild member data
  for (const [memberId, member] of freshChannel.members) {
    // Exclude bots
    if (member.user.bot) continue;
    
    try {
      // Fetch fresh member data from Discord API to get updated nickname
      const freshMember = await freshChannel.guild.members.fetch(memberId);
      members.push({
        id: freshMember.user.id,
        username: freshMember.user.username,
        displayName: freshMember.displayName,
        avatar: freshMember.user.avatar
      });
    } catch (e) {
      // Fallback to cached data if fetch fails
      members.push({
        id: member.user.id,
        username: member.user.username,
        displayName: member.displayName,
        avatar: member.user.avatar
      });
    }
  }
  
  return members;
}

// Broadcast state to web dashboard
export function triggerStateBroadcast() {
  broadcastState();
}

// Periodic state broadcast for Watch Together sync
let positionBroadcastInterval = null;

function startPositionBroadcast() {
  if (positionBroadcastInterval) return;
  positionBroadcastInterval = setInterval(safeTimer('the position broadcast', () => {
    const firstQueue = queues.values().next().value;
    if (firstQueue && firstQueue.isPlaying && firstQueue.songStartTime &&
        !isPlayerPaused(firstQueue.player.state.status)) {
      broadcastState();
    } else {
      stopPositionBroadcast();
    }
  }), 1000);
}

function stopPositionBroadcast() {
  if (positionBroadcastInterval) {
    clearInterval(positionBroadcastInterval);
    positionBroadcastInterval = null;
  }
}

// The dashboard has one "paused" indicator and the player has two ways of holding a resource
// without playing it: Paused, which somebody asked for, and AutoPaused, which @discordjs/voice
// enters on its own as soon as no subscribed connection is Ready. Reporting AutoPaused as
// playing is what let a dead voice link render as a progress bar running over silence.
export function isPlayerPaused(status) {
  return status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused;
}

// Tell the dashboard where things stand. Guarded, because everything downstream of here is
// somebody else's code: webUpdateCallback reaches the web server's updateState() ->
// JSON.stringify -> ws.send(), none of which this module can vouch for. An unguarded throw
// from there has two ways to hurt, and both were live: from a timer body it ends the process
// (index.js's uncaughtException handler exits, so the bot dies mid-song), and from play()'s
// prologue it left the queue marked playing with no resource and no download - a state nothing
// would ever advance again. There is no caller for which a failed broadcast is worth either.
function broadcastState(seekPosition = null) {
  try {
    sendStateToDashboard(seekPosition);
  } catch (err) {
    console.error('[MusicQueue] Broadcasting state to the dashboard failed:', err?.message || err);
  }
}

function sendStateToDashboard(seekPosition = null) {
  if (!webUpdateCallback) return;

  // Get first active queue (for now, support single guild)
  const firstQueue = queues.values().next().value;

  if (firstQueue) {
    // Calculate current playback position in seconds (paused time excluded)
    const isPaused = isPlayerPaused(firstQueue.player.state.status);
    const speed = globalSettings.mixerFilters?.speed || 1.0;
    const position = firstQueue.getPlaybackElapsedMs() / 1000 * speed;
    webUpdateCallback({
      currentSong: firstQueue.currentSong,
      queue: firstQueue.songs,
      recentlyPlayed: globalRecentlyPlayed,
      isPlaying: firstQueue.isPlaying,
      isPaused: isPaused,
      volume: firstQueue.volume,
      guildId: firstQueue.guildId,
      guildName: firstQueue.guildName,
      guildIcon: firstQueue.guildIcon,
      voiceChannelName: firstQueue.voiceChannelName,
      seekPosition: seekPosition,
      position: position,
      isCached: !!(firstQueue.cachedAudioPath && existsSync(firstQueue.cachedAudioPath)),
      // Pause-corrected, since the client computes its own progress as (now - songStartTime)
      songStartTime: firstQueue.getEffectiveSongStartTime(),
      loopMode: globalSettings.loopMode,
      is24_7: globalSettings.is24_7,
      sleepEndTime: globalSettings.sleepEndTime,
      radioEnabled: globalSettings.radioEnabled,
      mixerFilters: globalSettings.mixerFilters
    });

    // Start periodic broadcast when playing
    if (firstQueue.isPlaying && !isPaused) {
      startPositionBroadcast();
    } else {
      stopPositionBroadcast();
    }
  } else {
    stopPositionBroadcast();
    webUpdateCallback({
      currentSong: null,
      queue: [],
      recentlyPlayed: globalRecentlyPlayed,
      isPlaying: false,
      isPaused: false,
      volume: 1.0,
      guildId: null,
      position: 0,
      loopMode: globalSettings.loopMode,
      is24_7: globalSettings.is24_7,
      sleepEndTime: globalSettings.sleepEndTime,
      radioEnabled: globalSettings.radioEnabled,
      mixerFilters: globalSettings.mixerFilters
    });
  }
}

// Wait for a ducked clip to finish playing. Resolves with why it ended: the music
// is paused for as long as this takes, so a clip that errors, never starts, or runs
// away must end the wait just as reliably as a clean finish does. Progress is read
// from the player rather than timed from the start, so a 30-second spoken answer is
// not cut off while a wedged one still gives up after DUCK_STALL_MS.
function awaitClipEnd(player, resource) {
  return new Promise(resolve => {
    let settled = false;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off('error', onError);
      resource.playStream.off('error', onStreamError);
      resolve(reason);
    };

    const onIdle = () => finish('finished');
    const onError = (error) => {
      console.error('[MusicQueue] Clip player error:', error.message);
      finish('error');
    };
    const onStreamError = (error) => {
      console.error('[MusicQueue] Clip stream error:', error.message);
      finish('error');
    };

    const startedAt = Date.now();
    let lastProgress = -1;
    let lastProgressAt = startedAt;
    const progressTimer = setInterval(safeTimer('the clip stall watchdog', () => {
      // Buffering carries no playbackDuration, and a clip stuck there is stalled too
      const state = player.state;
      const progress = state.status === AudioPlayerStatus.Idle ? -1 : (state.playbackDuration ?? -1);
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastProgressAt = Date.now();
      }

      if (Date.now() - lastProgressAt >= DUCK_STALL_MS) {
        console.warn(`[MusicQueue] Clip made no progress for ${DUCK_STALL_MS}ms, giving up on it`);
        finish('stalled');
      } else if (Date.now() - startedAt >= DUCK_MAX_MS) {
        console.warn(`[MusicQueue] Clip exceeded ${DUCK_MAX_MS}ms, cutting it off`);
        finish('overran');
      }
    }), 1000);
    if (progressTimer.unref) progressTimer.unref();

    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    resource.playStream.on('error', onStreamError);
  });
}

// Wait, for at most `timeoutMs`, for a voice connection to be usable again.
//
// The verdict is taken at the end of the window rather than the moment Ready is first seen,
// because a Ready sighting is not the same as a healthy connection: a connection 'error'
// typically arrives just before the WebSocket close that caused it, so the status at the
// instant of the error can still read Ready, and a reconnect can pass through Ready on its
// way back out again. So every Ready has to survive a settle before it counts.
export async function waitForReadyConnection(connection, timeoutMs = CONNECTION_RECOVERY_MS, settleMs = CONNECTION_SETTLE_MS) {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    await delay(Math.max(0, Math.min(settleMs, deadline - Date.now())));

    if (connection.state.status === VoiceConnectionStatus.Ready) return true;
    // Nothing is coming back from here, so don't sit out the rest of the window
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return false;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, remaining);
    } catch {
      return false;
    }
    // Reached Ready - loop back round to confirm it holds
  }
}

export class MusicQueue {
  constructor(guildId, guildInfo = null) {
    this.guildId = guildId;
    this.guildName = guildInfo?.name || null;
    this.guildIcon = guildInfo?.icon || null;
    this.voiceChannel = null; // Reference to the voice channel
    this.voiceChannelName = null;
    this.songs = [];
    this.isPlaying = false;
    this.isSeeking = false;
    this.skipRequested = false; // A user ended this song on purpose, so loop must not re-queue it
    this.connection = null;
    this.player = createAudioPlayer();
    this.currentSong = null;
    this.volume = 1.0;
    this.currentResource = null;
    this.currentFFmpeg = null;
    this.cachedAudioPath = null; // Path to the downloaded audio file being played
    this.isCaching = false; // Whether a download is in flight
    this.songStartTime = null; // Timestamp when current song started playing
    this.pausedAt = null; // Timestamp of the pause currently in effect (null = not paused)
    this.totalPausedMs = 0; // Paused milliseconds already accumulated for this song
    this.seekWatchdog = null; // Handle for the timer that unsticks a seek that never resumed
    this.seekOffset = 0; // Offset in seconds for when song started (for seeking)
    this.historyIndex = -1; // Current position in recently played history (-1 = not navigating history)
    this.playingFromHistory = false; // Flag to prevent re-adding history songs
    this.cacheGeneration = 0; // Bumped whenever the current song changes - stale downloads are discarded
    this.downloadProcess = null; // yt-dlp child of the in-flight download, so it can be stopped
    // The one background download of the song that plays next, or null. Deliberately not
    // keyed to cacheGeneration: a prefetch has to survive the song change that consumes it,
    // which is the one event that always bumps that counter. See maintainPrefetch().
    this.prefetch = null;
    this.prefetchToken = 0; // Bumped whenever a prefetch stops being wanted - stale ones abort
    this.prefetchProcess = null; // yt-dlp child of the in-flight prefetch, so it can be stopped
    this.prefetchHits = 0; // Transitions that found the song already downloaded...
    this.prefetchMisses = 0; // ...and those that had to fetch it in the gap, as before
    this.autoLeaveTimer = null; // Handle for the empty-queue auto-disconnect timer
    this.consecutiveFailures = 0; // Consecutive play() failures - trips a breaker at 3
    this.destroying = false; // True while cleanup() runs, so player events don't restart anything
    this.listenerConnection = null; // Connection object we already attached lifecycle listeners to
    this.connectionRecovery = null; // In-flight recovery from a connection 'error' (null = none)
    this.recentRadioUrls = []; // Last 5 server-side radio auto-adds, to avoid looping on the same tracks
    this.ttsPlayer = null; // Dedicated player for ducked clips, created on first use (see duckAndPlay)
    this.duckActive = false; // True while a ducked clip is playing over the music
    this.pendingUserPause = false; // A /pause asked for during a clip, honoured when it ends
    // Note: loopMode, is24_7, and sleepEndTime are now in globalSettings for persistence

    // Handle player state changes - use arrow function to preserve 'this'
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Don't trigger playNext if we're seeking
      if (this.isSeeking) {
        console.log('Player went idle during seek, ignoring...');
        return;
      }
      if (this.destroying) {
        console.log('Player went idle during cleanup, ignoring...');
        return;
      }
      console.log('Player went idle, playing next...');
      unattended(this.playNext(), 'advancing the queue after the player went idle');
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log('Player is now playing');
      this.isSeeking = false; // Clear seeking flag when playing resumes
      this.clearSeekWatchdog();
      this.consecutiveFailures = 0; // Audio actually started - reset the failure breaker

      // Set song start time when actually playing (accounting for seek offset)
      // Note: this also fires on unpause, where songStartTime is already set and must stay put
      if (!this.songStartTime) {
        const speed = globalSettings.mixerFilters?.speed || 1.0;
        this.pausedAt = null;
        this.totalPausedMs = 0;
        this.songStartTime = Date.now() - (this.seekOffset / speed * 1000);
        console.log('Song start time set:', new Date(this.songStartTime), 'with offset:', this.seekOffset, 'at speed:', speed);
      } else if (this.pausedAt !== null) {
        // The other half of the AutoPaused claim below: audio is flowing again, so whatever
        // stopped the clock is over and the stretch of silence belongs to paused time. This
        // is also the path a resume() takes - player.unpause() emits Playing *synchronously*,
        // so the gap is closed here and resume()'s own bookkeeping then finds pausedAt
        // already null and no-ops. Counted once, either way.
        this.totalPausedMs += Date.now() - this.pausedAt;
        this.pausedAt = null;
      }

      broadcastState();
    });

    this.player.on(AudioPlayerStatus.Paused, () => {
      console.log('Player paused');
      broadcastState();
    });

    // @discordjs/voice parks the player here by itself as soon as no subscribed connection is
    // Ready. Nothing else announces it: the position interval notices on its next tick and
    // just stops, without a final broadcast, so the dashboard's last word on the song stays
    // "playing" and every browser keeps running its progress bar over silence.
    // ...and it is dead air, so it is paused time. The resource is held rather than consumed
    // while the player is parked, so when the connection comes back the audio carries on
    // exactly where it stopped - but songStartTime runs through the whole outage. Left
    // unclaimed, every ordinary voice reconnect (Disconnected -> Signalling -> Ready, which
    // needs no 'error' at all) leaves the progress bar permanently ahead of the sound and
    // over-credits listeningStats.json by the length of the gap. Closed by the Playing
    // handler above. Skipped when the clock is already stopped: a user pause, a ducked clip
    // or a connection-error recovery owns that pause and closes it itself.
    this.player.on(AudioPlayerStatus.AutoPaused, () => {
      console.log('Player auto-paused - no voice connection ready to receive audio');
      if (this.songStartTime && this.pausedAt === null) this.pausedAt = Date.now();
      broadcastState();
    });

    this.player.on('error', error => {
      console.error(`Error in audio player for guild ${guildId}:`, error);
      this.isSeeking = false;
      this.clearSeekWatchdog();
      if (this.destroying) return;
      unattended(this.playNext(), 'advancing the queue after a player error');
    });
  }

  async join(voiceChannel) {
    this.voiceChannel = voiceChannel; // Store reference to voice channel
    this.voiceChannelName = voiceChannel.name;

    // Joining (re)deafens the bot by default, which would silently kill an active recording
    // (the receiver can't hear anything while self-deafened). Stop it gracefully first so the
    // WAV gets saved and the channel gets a visible announcement, instead of recording just
    // going dead with no explanation.
    try {
      if (isRecording(voiceChannel.guild.id)) {
        await stopRecording(voiceChannel.guild.id, 'music playback started');
      }
    } catch (err) {
      console.error(`[MusicQueue] Failed to stop recording before join in guild ${voiceChannel.guild.id}:`, err.message);
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    this.connection.subscribe(this.player);

    // joinVoiceChannel can hand back an existing connection for this guild, so only
    // attach the lifecycle listeners once per connection object
    if (this.listenerConnection !== this.connection) {
      this.listenerConnection = this.connection;
      // Captured rather than read off `this` inside the handlers: an event that arrives late,
      // from a connection this queue has already moved off, must be judged against the
      // connection it came from
      const conn = this.connection;

      // Handle connection state
      conn.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(conn, VoiceConnectionStatus.Signalling, CONNECTION_RECOVERY_MS),
            entersState(conn, VoiceConnectionStatus.Connecting, CONNECTION_RECOVERY_MS),
          ]);
        } catch {
          this.teardownConnection('disconnected', conn);
        }
      });

      conn.on('error', err => {
        console.error('[MusicQueue] connection error:', err.message);
        this.recoverFromConnectionError(conn);
      });
    }

    return this.connection;
  }

  // Give up on a voice connection that is not coming back. Both connection failure paths -
  // a Disconnected whose reconnect never started, and an 'error' that never recovered - end
  // here, so there is exactly one way for the queue to lose its connection.
  //
  // destroy() emits the Destroyed transition the voice assistant's stateChange handler
  // watches for, so its receive monitors stop with the connection rather than outliving it.
  teardownConnection(reason, connection) {
    // destroy() throws on an already-destroyed connection, and this runs from event and timer
    // callbacks where that would take down the process
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }

    // A failure from a connection this queue no longer holds takes that connection with it and
    // stops there. It must not stop the playback running on a replacement, and it must not run
    // a second cleanup() behind an earlier teardown: cleanup() fires the presence and
    // now-playing-log callbacks, which are global, so a late one would clear the presence and
    // re-log whatever a newer queue is playing. `this.connection` is only ever nulled by
    // cleanup(), so null here means the teardown has already happened.
    if (this.connection !== connection) {
      console.warn(`[MusicQueue] Ignoring voice connection ${reason} from a connection this queue no longer holds`);
      return;
    }

    console.warn(`[MusicQueue] Voice connection ${reason} - stopping playback`);
    // cleanup() raises `destroying` before it stops the player, so the Idle that follows never
    // reaches playNext(); this is the last chance to credit what was actually heard
    this.trackAndClearListening();
    this.cleanup();
  }

  // A connection-level 'error' is not a state transition. @discordjs/voice re-emits it and
  // leaves the connection exactly where it was, so no other handler in this class will ever
  // hear about it. A transient one (Discord answering the voice gateway with a 521) is
  // followed by the library re-signalling its way back to Ready; a fatal one just sits there
  // forever. Wait out a bounded window to tell the two apart, then either let the music carry
  // on or stop cleanly. The one thing this must never do is leave the queue marked playing on
  // a connection that is never going to carry audio again.
  async recoverFromConnectionError(connection) {
    if (this.destroying) return;
    // An error storm is one failure, not five: the first handler owns the recovery and every
    // later one rides its result instead of starting a second teardown
    if (this.connectionRecovery) return this.connectionRecovery;
    // An error from a connection this queue has already moved off is that connection's
    // problem. An already-destroyed one that this queue is still holding is not - that is the
    // wedge itself, and it falls through to the teardown below.
    if (!connection || this.connection !== connection) return;

    this.connectionRecovery = (async () => {
      // The player parks itself (AutoPaused) as soon as no subscribed connection is Ready, so
      // it holds the resource rather than consuming it while we wait - but songStartTime keeps
      // running regardless. Stop the clock for the gap so the position the dashboard shows
      // stays the position the listener actually heard. Skipped when the clock is already
      // stopped: a user pause, or a ducked clip, owns that pause and will close it itself.
      const gapStartedAt = this.songStartTime && this.pausedAt === null ? Date.now() : null;
      if (gapStartedAt !== null) this.pausedAt = gapStartedAt;
      broadcastState();

      let ready = false;
      try {
        ready = await waitForReadyConnection(connection, CONNECTION_RECOVERY_MS, CONNECTION_SETTLE_MS);
      } catch (error) {
        console.error('[MusicQueue] Voice connection recovery check failed:', error.message);
      }

      // A rejoin, a stop, or a full cleanup may all have happened while we waited
      if (this.destroying || this.connection !== connection) {
        this.closePlaybackGap(gapStartedAt);
        return;
      }

      if (ready) {
        // Nothing to restart: the player un-parks itself the moment a subscribed connection is
        // Ready again, and it still holds the resource it was playing
        console.log('[MusicQueue] Voice connection recovered after error');
        this.closePlaybackGap(gapStartedAt);
        broadcastState();
        return;
      }

      this.teardownConnection('error unrecoverable', connection);
    })().catch(error => {
      // Nothing awaits this on the event-handler path, so a throw here - broadcastState()
      // reaches the web dashboard, and a callback out there can throw - would go unhandled
      // and take the process with it
      console.error('[MusicQueue] Voice connection recovery failed:', error.message);
    }).finally(() => {
      this.connectionRecovery = null;
    });

    return this.connectionRecovery;
  }

  // Credit a stretch of dead air back to the playback clock. Identity-checked the same way the
  // auto-leave timer is: if a new song, a seek or a user pause moved the clock while the
  // connection was away, that owns it now and this gap is no longer the pause in effect.
  closePlaybackGap(gapStartedAt) {
    if (gapStartedAt === null || this.pausedAt !== gapStartedAt) return;
    this.totalPausedMs += Date.now() - gapStartedAt;
    // A user pause that landed during the gap keeps the clock stopped, just from here on
    this.pausedAt = this.player.state.status === AudioPlayerStatus.Paused ? Date.now() : null;
  }

  addSong(song) {
    // Check if this is a radio song
    const isRadioSong = song.requestedBy && song.requestedBy.toLowerCase().includes('radio');

    // If this is NOT a radio song, remove any radio songs from the queue
    if (!isRadioSong) {
      const radioSongsRemoved = this.songs.filter(s => s.requestedBy && s.requestedBy.toLowerCase().includes('radio')).length;
      if (radioSongsRemoved > 0) {
        this.songs = this.songs.filter(s => !(s.requestedBy && s.requestedBy.toLowerCase().includes('radio')));
        console.log(`Removed ${radioSongsRemoved} radio song(s) from queue (user added a song)`);
      }
    }

    this.songs.push(song);
    console.log(`Song added: ${song.title}, Queue length now: ${this.songs.length}`);
    broadcastState();
    // Adding to an empty queue makes this the next song; adding a user song to a queue of
    // radio fills replaces the next song outright. Both are handled by asking.
    this.maintainPrefetch();
  }

  playPrevious() {
    // Start from current position or beginning
    let startIndex = this.historyIndex >= 0 ? this.historyIndex + 1 : 0;
    
    // Find the next song in history (skip duplicates of current song)
    let previousSong = null;
    let foundIndex = -1;
    
    for (let i = startIndex; i < globalRecentlyPlayed.length; i++) {
      const song = globalRecentlyPlayed[i];
      // Skip if this is the currently playing song
      if (this.currentSong && song.url === this.currentSong.url) continue;
      previousSong = song;
      foundIndex = i;
      break;
    }
    
    if (!previousSong) {
      console.log('No previous song available');
      return false;
    }
    
    // Update history index
    this.historyIndex = foundIndex;
    this.playingFromHistory = true;
    
    // Create a clean copy of the song (without playedAt)
    const songToPlay = {
      url: previousSong.url,
      title: previousSong.title,
      duration: previousSong.duration,
      thumbnail: previousSong.thumbnail,
      requestedBy: previousSong.requestedBy || 'Previous',
      requestedById: previousSong.requestedById || null,
      source: previousSong.source || 'youtube'
    };
    
    // Add to front of queue
    this.songs.unshift(songToPlay);
    console.log(`Previous song queued (history index ${foundIndex}): ${songToPlay.title}`);
    
    // If currently playing, skip to it; otherwise start playing
    if (this.isPlaying) {
      this.skip();
    } else {
      unattended(this.play(), 'starting the previous song');
    }
    
    return true;
  }

  // Start the next song, and say what happened to it.
  //
  // play() self-heals: a song that cannot be fetched is dropped and the queue moves on by
  // itself. So "the promise resolved" has never meant "this song is playing", and every
  // caller that read it that way told the user it was. The outcome describes *this* song's
  // fate only - the self-heal is untouched, and the start it triggers reports its own.
  //
  // @returns {Promise<{started: true, song} | {started: false, reason, song?, detail?}>}
  //   reason is one of:
  //     'already-playing'  a song was already running; this call started nothing
  //     'empty-queue'      there was nothing to start
  //     'superseded'       a skip, stop or teardown took over while this song downloaded
  //     'failed'           the song could not be fetched (`detail` says why); queue moved on
  async play() {
    console.log(`play() called - isPlaying: ${this.isPlaying}, songs in queue: ${this.songs.length}`);
    if (this.isPlaying || this.songs.length === 0) {
      console.log('Skipping play() - already playing or no songs');
      return { started: false, reason: this.isPlaying ? 'already-playing' : 'empty-queue' };
    }

    // Everything from here on runs inside the try, prologue included. It used to start
    // outside it, and four of the things it does can throw for reasons that have nothing to do
    // with this module: saveRecentlyPlayed() (a full or read-only disk), broadcastState()
    // (now guarded itself), and the now-playing-log and presence callbacks. A throw there left
    // isPlaying true, currentSong set, and no resource, no ffmpeg, no download and no
    // auto-leave timer - a state nothing would ever advance again, because the player was Idle
    // (so no Idle transition was coming), play() early-returns on isPlaying, and armAutoLeave
    // needs !isPlaying. The music stopped dead and only /stop could recover it, with the
    // rejection logged and swallowed so nothing pointed at the cause. The catch below already
    // does the right thing for all of it.
    //
    // `gen` stays null until the generation is claimed, so a throw before that is never
    // mistaken for "the song changed" - which would skip the cleanup this needs.
    let gen = null;
    let songTitle = 'unknown';

    try {
      // A song is starting, so the empty-queue disconnect no longer applies
      this.clearAutoLeaveTimer();

      // Clean up previous FFmpeg process and cached audio
      if (this.currentFFmpeg) {
        killChild(this.currentFFmpeg, 'previous encoder');
        this.currentFFmpeg = null;
      }
      this.cleanupCachedAudio();

      this.isPlaying = true;
      this.currentSong = this.songs.shift();
      this.cacheGeneration++; // New song - any download still in flight is now stale
      // The generation this start belongs to. The download is a multi-second subprocess and a
      // 403 adds ten more seconds of backoff on top, so a stop, a skip or a teardown can
      // easily land while it runs - and whichever of those it was has already moved the queue
      // on. Claimed here, immediately after the bump, so it can never read as stale.
      gen = this.cacheGeneration;
      const songUrl = this.currentSong.url;
      songTitle = this.currentSong.title;

      // Only add to recently played if not playing from history navigation
      if (!this.playingFromHistory) {
        // Reset history index when playing new songs normally
        this.historyIndex = -1;

        // Add to global recently played (at the beginning, max 150)
        globalRecentlyPlayed.unshift({
          ...this.currentSong,
          playedAt: Date.now()
        });
        if (globalRecentlyPlayed.length > 150) {
          globalRecentlyPlayed.pop();
        }
        // Save to file for persistence
        saveRecentlyPlayed(globalRecentlyPlayed);

        // Track song started in listening stats (play count only, time tracked when song ends)
        trackSongStarted(this.currentSong)
          .catch(err => console.error('[MusicQueue] Could not record the song start:', err.message));
      }
      // Clear the flag for next song
      this.playingFromHistory = false;

      // Broadcast state immediately when song changes
      broadcastState();

      // Log the now playing song
      if (logNowPlayingCallback && this.currentSong) {
        logNowPlayingCallback(this.currentSong);
      }

      // Update Discord presence with now playing
      if (updatePresenceCallback && this.currentSong) {
        updatePresenceCallback(this.currentSong.title);
      }

      // A prefetch that finished while the last song played makes this instant, which is the
      // whole point of it. Every kind of miss - no prefetch, one for a song the queue has
      // since moved off, one that failed - falls through to the download below and behaves
      // exactly as it did before the prefetch existed.
      const prefetched = await this.takePrefetched(songUrl, gen);

      // Download first, then play the file. The audio is fetched exactly once, by the one
      // component that can retry a 403 - ffmpeg is never pointed at a googlevideo URL,
      // where a 403 arrives as an instantly-silent song and an unexplained skip.
      const cachePath = prefetched ? prefetched.path : await this.downloadSongToCache(songUrl, songTitle, gen);

      // The queue can have moved on while yt-dlp ran; playing this now would hijack
      // whatever song took its place
      const movedOn = this.downloadAbortReason(gen);
      if (movedOn) {
        removeCacheFile(cachePath);
        throw new DownloadAbortedError(movedOn);
      }

      // The downloaded file *is* the cache, so seeking is instant from the first second
      this.cachedAudioPath = cachePath;
      this.playFromCache(0);

      // Counted here rather than at the consume, so a start that was abandoned partway does
      // not report a transition the listener never had
      if (prefetched) this.prefetchHits++; else this.prefetchMisses++;
      console.log(formatTransition(!!prefetched, songTitle, this.prefetchHits, this.prefetchMisses));

      broadcastState(); // the dashboard's cached indicator is true from the start now

      // ...and now that the slot is free again, start on the one after this
      this.maintainPrefetch();

      return { started: true, song: this.currentSong };

    } catch (error) {
      // Not a failure: a stop, a skip or a teardown got here first and owns the queue's
      // state now, so this call touches nothing and advances nothing. Read from the
      // generation as well as the error, since cancelling kills the yt-dlp child and that
      // arrives here as an ordinary subprocess failure.
      const movedOn = gen === null ? null : this.downloadAbortReason(gen);
      if (error?.aborted || movedOn) {
        const why = error?.aborted ? error.message : movedOn;
        console.log(`[MusicQueue] Gave up starting "${songTitle}" - ${why}`);
        return { started: false, reason: 'superseded', detail: why };
      }

      // All the retries happened inside runGatedDownload, so a 403 storm arrives here once
      // and counts as one failure against the breaker below
      const reason = describeDownloadFailure(error);
      // How long the listener spent in silence for a song that never played - the number
      // that says what a backoff schedule actually costs when it does not pay off
      const spent = error?.downloadMs === undefined ? '' : ` after ${error.downloadMs}ms`;
      console.error(`[MusicQueue] Skipping "${songTitle}": ${reason}${spent}`);
      if (!error?.rateLimited) console.error('Error playing song:', error);
      // Drop the failed song BEFORE playNext() - otherwise loop mode 'song' re-queues it
      // and we spin on the same broken URL forever
      const failedSong = this.currentSong;
      this.currentSong = null;
      this.isPlaying = false;
      this.cleanupCachedAudio();

      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        console.error(`[MusicQueue] Skipping repeatedly failing song: ${failedSong?.title || 'unknown'} (${reason})`);
        // Purge any remaining copies (loop re-queues, duplicate adds) of the failing song
        if (failedSong?.url) {
          this.songs = this.songs.filter(s => s.url !== failedSong.url);
        }
        this.consecutiveFailures = 0;
      }

      unattended(this.playNext(), 'advancing the queue past a song that could not be played');
      return { started: false, reason: 'failed', song: failedSong, detail: reason };
    }
  }

  // Fetch one song's audio to `cachePath`, through the download gate, retrying a YouTube
  // 403. Deletes the part-file on any failure and tags the error with what the attempt cost.
  //
  // Shared by the play path and the next-song prefetch, which are the same yt-dlp call and
  // differ only in three things: what they queue at, what makes them stale, and where their
  // child process is parked so the right cancellation can find it.
  //
  // @param childSlot - property name to park the running child on ('downloadProcess' or
  //   'prefetchProcess'). Two slots rather than one because the two cancellations are not
  //   the same: a song change cancels the play download and must leave the prefetch alone.
  // @returns {Promise<{attempts: number, ms: number}>} what the fetch cost, for the timing line
  async fetchAudioTo(cachePath, songUrl, songTitle, { priority, label, abortReason, childSlot }) {
    if (!isAllowedMediaUrl(songUrl)) {
      throw new Error(`Refusing to pass unsupported URL to yt-dlp: ${songUrl}`);
    }

    const startedAt = Date.now();
    let attempts = 0;

    try {
      // Highest quality opus (quality 0 = best, ~256kbps VBR)
      await runGatedDownload((attempt) => {
        attempts = attempt;
        // .exec() hands back the child process rather than its parsed output, so a
        // cancelled or timed-out download can actually be stopped instead of running on
        // unwatched, holding the one slot the next song needs before it can make a sound
        const child = ytDlpExec.exec(songUrl, {
          ...ytCookieOpts,
          output: cachePath,
          extractAudio: true,
          audioFormat: 'opus',
          audioQuality: 0, // Best quality (VBR ~256kbps for opus)
          noCheckCertificates: true,
          noWarnings: true,
          ffmpegLocation: ffmpegPath,
          format: 'bestaudio[acodec=opus]/bestaudio[acodec=aac]/bestaudio[abr>=160]/bestaudio/best',
          postprocessorArgs: 'ffmpeg:-b:a 256k' // Ensure high bitrate on transcode
        }, { timeout: DOWNLOAD_TIMEOUT_MS });
        this[childSlot] = child;
        return child.finally(() => {
          if (this[childSlot] === child) this[childSlot] = null;
        });
      }, { priority, label, abortReason });

      // yt-dlp exiting 0 without leaving the file where we asked for it would otherwise
      // reach playFromCache(), which logs and returns - and the queue would sit forever on
      // a song that never plays and so never ends. Fail it into the skip path instead.
      if (!existsSync(cachePath)) {
        throw new Error(`yt-dlp reported success but left no file at ${cachePath}`);
      }

      return { attempts, ms: Date.now() - startedAt };
    } catch (error) {
      // So the skip line can say how much of the gap this song spent failing, which is the
      // number that says whether a backoff schedule is worth what it costs
      if (error && typeof error === 'object') {
        error.downloadMs = Date.now() - startedAt;
        error.downloadAttempts = attempts;
      }
      // Whatever went wrong, yt-dlp may have left a part-file behind
      removeCacheFile(cachePath);
      throw error;
    }
  }

  // Download the song that is starting now, at play priority. Returns the path to the
  // finished file.
  //
  // A method rather than a free function so tests can drive play() end to end without the
  // network, and so the whole download sits behind one seam.
  async downloadSongToCache(songUrl, songTitle, gen) {
    const cachePath = cacheFilePath('godcord_', this.guildId);
    console.log(`Downloading audio to: ${cachePath}`);
    this.isCaching = true;

    try {
      const cost = await this.fetchAudioTo(cachePath, songUrl, songTitle, {
        priority: DOWNLOAD_PRIORITY.PLAY,
        label: `download of "${songTitle}"`,
        abortReason: () => this.downloadAbortReason(gen),
        childSlot: 'downloadProcess'
      });
      console.log(formatDownloadTiming(songTitle, cost.ms, cost.attempts));
      return cachePath;
    } finally {
      this.isCaching = false;
    }
  }

  // --- next-song prefetch ----------------------------------------------------
  //
  // The song a prefetch should be for right now, or null when there is nothing to prefetch.
  // Only while something is actually playing: with the queue idle, songs[0] is the song
  // play() is about to shift and start for itself, at play priority, and racing it with a
  // second download of the same audio is the collision this whole gate exists to prevent.
  prefetchTarget() {
    if (this.destroying || !this.isPlaying) return null;
    return this.songs[0] || null;
  }

  // Keep exactly one background download lined up on the song that plays next, and nothing
  // lined up on a song that no longer does.
  //
  // Idempotent, cheap and self-checking, so every queue mutation can just call it and let it
  // work out whether anything changed; it never throws, so no caller needs to guard it.
  maintainPrefetch() {
    try {
      const target = this.prefetchTarget();
      const entry = this.prefetch;

      // A prefetch of a song that is no longer next is dead weight twice over: its file will
      // never be played, and while it runs it holds the one download slot. A consumed one is
      // not ours to judge - the play path owns it now and cancels it on its own terms.
      if (entry && entry.consumedGen === null && entry.url !== target?.url) {
        this.invalidatePrefetch(target ? `"${target.title}" is next now` : 'nothing is queued after this one');
      }

      // Either there is nothing to prefetch, or the one we have is already the right one -
      // or a consumed one is still finishing, and one download in flight is the whole rule
      if (!target || this.prefetch) return;

      this.startPrefetch(target);
    } catch (err) {
      // Lining up the next song is an optimisation on top of a path that works without it,
      // so a problem here must never reach the caller - some of them are Discord commands
      console.error('[MusicQueue] Prefetch bookkeeping failed:', err.message);
    }
  }

  startPrefetch(song) {
    const entry = {
      url: song.url,
      title: song.title,
      // A name of its own, so the current song's cleanup can never unlink the next song's file
      path: cacheFilePath('godcord_pre_', this.guildId),
      token: this.prefetchToken,
      consumedGen: null, // set to the play generation that took this file over
      startedAt: Date.now(),
      attempts: 0,
      ms: null
    };
    this.prefetch = entry;
    entry.promise = this.runPrefetch(entry);
    console.log(`[MusicQueue] prefetching next song "${song.title}"`);
  }

  // Never rejects and never resolves to a file that is not there: a prefetch that fails is
  // simply a miss, and a miss is exactly the behaviour that shipped. The play path downloads
  // the song for real when it starts - with its own retries, and with the only say over the
  // failure breaker - so nothing in here may count a failure or move the queue on.
  //
  // @returns {Promise<string|null>} the finished file, or null
  async runPrefetch(entry) {
    try {
      const cost = await this.fetchAudioTo(entry.path, entry.url, entry.title, {
        priority: DOWNLOAD_PRIORITY.CACHE,
        label: `prefetch of "${entry.title}"`,
        abortReason: () => this.prefetchAbortReason(entry),
        childSlot: 'prefetchProcess'
      });
      entry.attempts = cost.attempts;
      entry.ms = cost.ms;
      console.log(formatDownloadTiming(entry.title, cost.ms, cost.attempts, true));
      return entry.path;
    } catch (error) {
      entry.attempts = error?.downloadAttempts || entry.attempts;
      const why = error?.aborted ? error.message : describeDownloadFailure(error);
      console.log(`[MusicQueue] prefetch of "${entry.title}" did not finish (${why}) - it will download when the song starts`);
      // Left attached, and failed: that stops the next queue mutation from starting the
      // same doomed fetch again. It goes when the song it was for stops being next.
      return null;
    }
  }

  // Why a prefetch should stop - null means carry on. Checked before every attempt and again
  // with the gate slot in hand, so a prefetch cannot outlive the reason it was started.
  prefetchAbortReason(entry) {
    if (this.destroying) return 'the queue is being torn down';
    // Once the play path has taken the file over, the fetch lives and dies with that start:
    // it is this song's download now, and must survive the song change that consumed it
    if (entry.consumedGen !== null) return this.downloadAbortReason(entry.consumedGen);
    if (entry.token !== this.prefetchToken) return 'the next song changed';
    return null;
  }

  // Drop the prefetch: stop it, delete its file, and leave nothing that could be played for
  // the wrong song. The token bump is what an in-flight fetch reads at its next checkpoint;
  // the kill is what stops it holding the slot until then.
  invalidatePrefetch(reason) {
    const entry = this.prefetch;
    if (!entry) return false;
    this.prefetch = null;
    this.prefetchToken++;
    const child = this.prefetchProcess;
    this.prefetchProcess = null;
    killChild(child, 'prefetch');
    removeCacheFile(entry.path);
    console.log(`[MusicQueue] dropped the prefetch of "${entry.title}" - ${reason}`);
    return true;
  }

  // Hand the starting song its already-downloaded file, if the prefetch was for that song.
  //
  // Identity is the URL, not a position or a token: the queue can be reordered, added to and
  // cut down arbitrarily between the prefetch starting and the song starting, and the only
  // question that matters at the end of all that is whether this file is this song's audio.
  //
  // A prefetch that is still running for the right song is awaited rather than restarted -
  // that is the rapid-skip case, where throwing away a download that is seconds from done to
  // start the identical one again would be slower than having no prefetch at all.
  //
  // @returns {Promise<{path, ms, attempts}|null>} null on any kind of miss
  async takePrefetched(songUrl, gen) {
    const entry = this.prefetch;
    if (!entry || entry.url !== songUrl) {
      // Whatever it was fetching is not what is starting, so from here it is only holding
      // the slot the song that *is* starting needs
      if (entry) this.invalidatePrefetch(`"${entry.title}" is not the song that started`);
      return null;
    }

    entry.consumedGen = gen;
    const path = await entry.promise;
    if (this.prefetch === entry) this.prefetch = null;

    if (path && existsSync(path)) {
      return { path, ms: entry.ms ?? Date.now() - entry.startedAt, attempts: entry.attempts || 1 };
    }
    // It failed, or its file went while we waited. Either way nothing usable came of it and
    // it must not be left behind as an orphan.
    removeCacheFile(entry.path);
    return null;
  }

  // Play from the downloaded audio file at a specific position
  playFromCache(seekSeconds = 0) {
    if (!this.cachedAudioPath || !existsSync(this.cachedAudioPath)) {
      console.error('Cached audio file not found');
      return;
    }

    // Store the seek offset - songStartTime will be set when player actually starts
    this.seekOffset = seekSeconds;

    // Build FFmpeg args
    const ffmpegArgs = [];
    
    // Add seek position if not starting from beginning
    if (seekSeconds > 0) {
      ffmpegArgs.push('-ss', String(Math.floor(seekSeconds)));
    }
    
    ffmpegArgs.push(
      '-i', this.cachedAudioPath,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-af', buildFilterChain(),
      '-f', 's16le',
      '-ar', '48000', // Discord's native sample rate
      '-ac', '2',     // Stereo
      'pipe:1'
    );
    
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    this.currentFFmpeg = ffmpeg;
    
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg process closed with code ${code}`);
    });
    
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg error:', err);
    });
    
    ffmpeg.stderr.on('data', () => {});
    
    const resource = createAudioResource(ffmpeg.stdout, { 
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    
    if (resource.volume) {
      // Apply logarithmic volume curve for natural perception
      const actualVolume = Math.pow(this.volume, 2);
      resource.volume.setVolume(actualVolume);
    }
    this.currentResource = resource;
    
    this.player.play(resource);
    console.log(`Now playing: ${this.currentSong.title}${seekSeconds > 0 ? ` from ${seekSeconds}s` : ''}`);
  }

  // Clean up cached audio file
  cleanupCachedAudio() {
    if (this.cachedAudioPath && existsSync(this.cachedAudioPath)) {
      try {
        unlinkSync(this.cachedAudioPath);
        console.log('Cleaned up cached audio file');
      } catch (err) {
        console.error('Error cleaning up cached audio:', err);
      }
    }
    this.cachedAudioPath = null;
    this.isCaching = false;
    this.resetPlaybackClock();
    this.cacheGeneration++; // Invalidate any download still in flight
    // ...and stop it for real. Its file is discarded from here on either way, and with the
    // audio now downloaded before it is played, a doomed download left running would hold
    // the one slot the next song needs before it can make a sound.
    this.abortDownload();
  }

  // Why a fetch taken out for generation `gen` should not proceed - null means carry on.
  // Both answers mean somebody else (a stop, the next song, a teardown) is driving the
  // queue now: `destroying` covers a cleanup in progress, and the generation covers one
  // that already finished, since cleanup() puts the flag back down when it is done.
  downloadAbortReason(gen) {
    if (this.destroying) return 'the queue is being torn down';
    if (gen !== this.cacheGeneration) return 'the song changed';
    return null;
  }

  // Stop the in-flight download, if there is one.
  abortDownload() {
    const child = this.downloadProcess;
    this.downloadProcess = null;
    let stopped = killChild(child, 'download');

    // A prefetch the play path has taken over is this song's download too, and it is parked
    // in the other slot. Without this, cancelling a start that consumed a still-running
    // prefetch would leave its yt-dlp holding the one slot the next song needs.
    if (this.prefetch && this.prefetch.consumedGen !== null) {
      const prefetchChild = this.prefetchProcess;
      this.prefetchProcess = null;
      stopped = killChild(prefetchChild, 'prefetch') || stopped;
    }
    return stopped;
  }

  // Clear the empty-queue auto-disconnect timer (if one is pending)
  clearAutoLeaveTimer() {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
  }

  // (Re)start the empty-queue auto-disconnect clock.
  armAutoLeave(ms = AUTO_LEAVE_MS) {
    this.clearAutoLeaveTimer();
    this.autoLeaveTimer = setTimeout(safeTimer('the auto-leave timer', () => {
      this.autoLeaveTimer = null;
      // A timer left over from a discarded queue must never touch the live one
      if (queues.get(this.guildId) !== this) {
        console.log('[MusicQueue] Stale auto-leave timer fired for a replaced queue, ignoring');
        return;
      }
      if (this.songs.length === 0 && !this.isPlaying && !globalSettings.is24_7) {
        this.leave();
      }
    }), ms);
  }

  // Push the pending auto-disconnect back. The "Hey Jerry" voice assistant calls
  // this while an interaction is in flight so the 60s timer can't hang up on
  // Jerry mid-sentence. Only re-arms a timer that was already pending — it never
  // starts one on a queue that is still playing.
  deferAutoLeave(ms = AUTO_LEAVE_MS) {
    if (!this.autoLeaveTimer) return false;
    this.armAutoLeave(ms);
    return true;
  }

  // Milliseconds of real playback since the current song started, with paused time removed.
  // Single source of truth: position broadcasts, filter restarts and listening stats all use it.
  getPlaybackElapsedMs() {
    if (!this.songStartTime) return 0;
    const pausedNow = this.pausedAt ? Date.now() - this.pausedAt : 0;
    return Math.max(0, Date.now() - this.songStartTime - this.totalPausedMs - pausedNow);
  }

  // The start timestamp the song would have had if it had never been paused. The web client
  // derives its progress bar from (Date.now() - songStartTime), so it gets this instead.
  getEffectiveSongStartTime() {
    if (!this.songStartTime) return null;
    return Date.now() - this.getPlaybackElapsedMs();
  }

  // Drop the playback clock - pause bookkeeping is meaningless without a start time
  resetPlaybackClock() {
    this.songStartTime = null;
    this.pausedAt = null;
    this.totalPausedMs = 0;
  }

  // Credit listening time for the current song exactly once. stop()/leave() each trigger an
  // Idle that runs playNext(), so whichever call arrives second finds songStartTime null.
  trackAndClearListening() {
    if (!this.currentSong || !this.songStartTime) return;
    const listenedSeconds = Math.floor(this.getPlaybackElapsedMs() / 1000);
    const song = this.currentSong;
    this.resetPlaybackClock();
    trackListeningTime(song, listenedSeconds);
  }

  // A seek/filter restart is only finished once Playing fires. If it never does (dead stream,
  // seek past the end) isSeeking would stay true and swallow every later Idle event.
  armSeekWatchdog() {
    this.clearSeekWatchdog();
    this.seekWatchdog = setTimeout(safeTimer('the seek watchdog', () => {
      this.seekWatchdog = null;
      if (!this.isSeeking) return;
      console.warn('[MusicQueue] Seek watchdog fired - no Playing transition, clearing seek state');
      this.isSeeking = false;
      // The Idle that ended the old stream was swallowed, so nothing else will advance the queue
      if (!this.destroying && this.player.state.status === AudioPlayerStatus.Idle) {
        unattended(this.playNext(), 'advancing the queue after the seek watchdog fired');
      }
    }), SEEK_WATCHDOG_MS);
  }

  clearSeekWatchdog() {
    if (this.seekWatchdog) {
      clearTimeout(this.seekWatchdog);
      this.seekWatchdog = null;
    }
  }

  // Stop playback for an explicit user action (skip / jump / stop) so loop mode does not
  // re-queue the song. The flag has to be set before stop(), which can emit Idle - and only
  // when a song is actually ending, or it would leak onto the next song's natural end.
  stopForUserAction() {
    const status = this.player.state.status;
    if (status === AudioPlayerStatus.Idle) {
      // An Idle player used to mean there was nothing to stop. Now a song can be seconds
      // into its download with no audio yet, and the user means that one - so cancel it
      // here. Nothing else would: no audio ever started, so no Idle transition is coming
      // to run playNext(), and the queue would otherwise sit on a song it had already
      // been told to abandon until the download finished.
      if (!this.isPlaying) return false;

      this.skipRequested = true;
      this.cacheGeneration++; // play() drops the download when it lands
      this.abortDownload();   // ...and it lands now rather than in a minute
      unattended(this.playNext(), 'advancing the queue after a user action');
      return true;
    }

    this.skipRequested = true;
    // Only a Playing player drains its silence padding frames; from any other state a plain
    // stop() would leave it sitting there, so force the transition to Idle
    this.player.stop(status !== AudioPlayerStatus.Playing);
    return true;
  }

  // Try to auto-queue one related track when radio mode is on and the queue just ran
  // dry. Returns true (and has already started playback) on success, false if no
  // suitable track was found - callers fall back to their normal empty-queue behavior.
  async tryRadioFill(seedUrl) {
    try {
      const tracks = await getRadioTracks(seedUrl);

      // getRadioTracks() is a multi-second yt-dlp subprocess - this queue may have been
      // stopped, replaced (a stale instance left over from a discarded queue, same as the
      // auto-leave timer's check), or had a song added to it while we were waiting. Only
      // proceed if it's still the live, genuinely-empty, idle queue for this guild.
      if (queues.get(this.guildId) !== this || this.destroying || this.isPlaying || this.songs.length > 0) {
        return false;
      }

      const track = tracks.find(t => !this.recentRadioUrls.includes(t.url));
      if (!track) return false;

      this.recentRadioUrls.push(track.url);
      if (this.recentRadioUrls.length > 5) this.recentRadioUrls.shift();

      this.addSong({
        title: track.title,
        url: track.url,
        duration: track.duration,
        thumbnail: track.thumbnail,
        requestedBy: '📻 Radio',
        requestedById: null,
        source: 'youtube'
      });
      await this.play();
      return true;
    } catch (error) {
      console.error('[MusicQueue] Radio auto-fill failed:', error.message);
      return false;
    }
  }

  async playNext() {
    console.log('playNext called, songs in queue:', this.songs.length);

    // Capture the song that just ended before it's cleared below - the radio auto-fill
    // seeds its lookup from it once we know the queue is actually empty
    const endedSong = this.currentSong;

    // Consume the skip flag: it only ever suppresses the loop re-queue for the song that
    // the user just ended, never for the one after it
    const wasSkipped = this.skipRequested;
    this.skipRequested = false;

    // Track actual listening time for the song that just ended
    this.trackAndClearListening();

    // Handle loop modes before cleanup
    if (this.currentSong && !wasSkipped && globalSettings.loopMode !== 'off') {
      const songToLoop = { ...this.currentSong };
      delete songToLoop.playedAt; // Remove playedAt if present

      if (globalSettings.loopMode === 'song') {
        // Loop single: add to front of queue
        this.songs.unshift(songToLoop);
        console.log('Loop mode (song): Re-queued current song');
      } else if (globalSettings.loopMode === 'queue') {
        // Loop queue: add to end of queue
        this.songs.push(songToLoop);
        console.log('Loop mode (queue): Added current song to end of queue');
      }
    }

    // Clean up previous FFmpeg process and cached audio
    if (this.currentFFmpeg) {
      this.currentFFmpeg.kill();
      this.currentFFmpeg = null;
    }
    this.cleanupCachedAudio();

    this.currentSong = null;
    this.currentResource = null;
    this.isPlaying = false;
    broadcastState();

    if (this.songs.length > 0) {
      console.log('Playing next song...');
      // Small delay to ensure cleanup before playing next
      await new Promise(resolve => setTimeout(resolve, 500));
      await this.play();
    } else {
      // Server-side radio auto-fill: the existing radio flow only runs client-side
      // (browser fetches /api/youtube/radio), so with no dashboard open the queue
      // just used to end here. Never throws into this path - any failure falls
      // through to the normal empty-queue behavior below.
      if (globalSettings.radioEnabled && !this.destroying && endedSong?.url) {
        const filled = await this.tryRadioFill(endedSong.url);
        if (filled) return;
      }

      // Clear Discord presence when queue is empty
      if (updatePresenceCallback) {
        updatePresenceCallback(null);
      }
      // Handle 24/7 mode - don't disconnect
      if (globalSettings.is24_7) {
        console.log('Queue empty, but 24/7 mode is active - staying connected');
      } else {
        console.log('Queue empty, will disconnect in 60 seconds if no new songs');
        // Queue finished, disconnect after a delay
        this.armAutoLeave();
      }
    }
  }

  // Pause the audio and stop the playback clock, with no interpretation of why. Used by the
  // ducking path, which pauses the music for its own reasons and must not be mistaken for a
  // user asking for a pause (see pause() below).
  pauseAudio() {
    const paused = this.player.pause();
    // Only start the clock on a real transition, so a double /pause cannot lose time
    if (paused && this.pausedAt === null) {
      this.pausedAt = Date.now();
    }
    return paused;
  }

  // A user asked for the music to be paused. Says what actually happened, because "asked for
  // a pause" and "the music is now paused" are not the same event: @discordjs/voice only
  // pauses a player that is exactly Playing, so during the download gap there is no audio to
  // pause yet, and during a ducked clip the music is already paused by the clip. Both of
  // those used to answer "paused" and change nothing.
  //
  // @returns {{paused: boolean, reason: string}} reason is one of 'paused',
  //   'held-until-clip-ends', 'already-paused', 'no-voice', 'loading', 'nothing-playing'
  pause() {
    // A clip holds the music down and its finally() puts it back. Pausing here would be a
    // no-op the clip then undoes, so the request is recorded and consumed at the unduck:
    // the music stays paused, which is what was asked for, just a few seconds later.
    if (this.duckActive) {
      this.pendingUserPause = true;
      return { paused: true, reason: 'held-until-clip-ends' };
    }

    const statusBefore = this.player.state.status;
    if (this.pauseAudio()) return { paused: true, reason: 'paused' };

    if (statusBefore === AudioPlayerStatus.AutoPaused) return { paused: false, reason: 'no-voice' };
    if (statusBefore === AudioPlayerStatus.Paused) return { paused: false, reason: 'already-paused' };
    // isPlaying is set the moment a song starts downloading, seconds before any audio exists
    if (this.isPlaying) return { paused: false, reason: 'loading' };
    return { paused: false, reason: 'nothing-playing' };
  }

  // @returns {{resumed: boolean, reason: string}} reason is one of 'resumed', 'not-paused',
  //   'no-voice', 'loading', 'nothing-playing'
  resume() {
    // Asking for a resume takes back a pause that was still waiting for a clip to end
    this.pendingUserPause = false;

    const statusBefore = this.player.state.status;
    const resumed = this.player.unpause();
    if (resumed && this.pausedAt !== null) {
      this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    if (resumed) return { resumed: true, reason: 'resumed' };

    // Un-parking is the library's job and only a Ready connection does it
    if (statusBefore === AudioPlayerStatus.AutoPaused) return { resumed: false, reason: 'no-voice' };
    if (this.isPlaying) return { resumed: false, reason: this.songStartTime ? 'not-paused' : 'loading' };
    return { resumed: false, reason: 'nothing-playing' };
  }

  // Play a short clip (wake beep, spoken reply) over the music, then put the music
  // back exactly as it was.
  //
  // The clip must never be played on this.player: its Idle handler would fire when
  // the clip ended and advance the queue. So the clip gets its own AudioPlayer and
  // the connection's subscription is swapped for the duration. The music player is
  // paused rather than stopped, which keeps its resource intact and, being paused
  // rather than idle, keeps it from emitting Idle at all.
  //
  // @param resourceFactory - builds the clip's AudioResource. A factory rather than
  //   a resource because a resource can only ever be played once, and this call may
  //   have waited behind another clip.
  // @returns {Promise<boolean>} whether the clip was actually audible - false when
  //   it was refused, could not be built, produced no audio, or had to be cut off.
  async duckAndPlay(resourceFactory) {
    if (this.destroying) {
      console.log('[MusicQueue] duckAndPlay: queue is being torn down, skipping clip');
      return false;
    }
    if (!this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
      console.log(`[MusicQueue] duckAndPlay: voice connection is ${this.connection?.state.status ?? 'missing'}, skipping clip`);
      return false;
    }
    if (this.duckActive) {
      console.warn('[MusicQueue] duckAndPlay: a clip is already playing, skipping this one');
      return false;
    }

    // Claimed before anything can yield, so two callers can never both get past the
    // guard above. Everything from here on runs inside the try: pause() reaches the
    // web dashboard through broadcastState(), and a callback throwing out there would
    // otherwise strand this flag set and refuse every later clip.
    this.duckActive = true;
    // A /pause that arrives while the clip is talking is recorded here rather than acted on,
    // and consumed in the finally below. Cleared on entry so a request from a previous clip
    // cannot keep the music down through this one.
    this.pendingUserPause = false;
    let duckPaused = false;
    let onMusicPlaying = null;
    let swapped = false;

    try {
      let resource;
      try {
        resource = resourceFactory();
      } catch (error) {
        console.error('[MusicQueue] duckAndPlay: could not build the clip resource:', error.message);
        return false;
      }

      if (!this.ttsPlayer) {
        this.ttsPlayer = createAudioPlayer();
        // Nothing else listens to this player - each clip awaits it individually - but
        // an 'error' with no listener at all throws process-wide
        this.ttsPlayer.on('error', error => {
          console.error(`[MusicQueue] Clip player error in guild ${this.guildId}:`, error.message);
        });
      }

      // We owe a resume only if the clip is what stopped the music, so music the user
      // paused themselves stays paused afterwards. Decided from the player's status
      // rather than pause()'s return value because pause() reaches the dashboard through
      // broadcastState(): a callback throwing there would leave the player paused with
      // nothing recording that we did it, and the music would never come back.
      const wasPaused = this.player.state.status === AudioPlayerStatus.Paused;
      try {
        this.pauseAudio();
      } finally {
        duckPaused = !wasPaused && this.player.state.status === AudioPlayerStatus.Paused;
      }

      // A song that starts mid-clip - a /play whose yt-dlp lookup resolved while Jerry
      // was still talking, or a manual resume - would otherwise be playing to a
      // connection subscribed to the clip player. @discordjs/voice would auto-pause it
      // (silently, holding the audio) while songStartTime kept running, leaving the
      // position ahead of the sound. Pausing it properly instead keeps the playback
      // clock honest, and the resume in the finally covers it - which, as above, we
      // owe whenever this handler leaves the player paused.
      onMusicPlaying = () => {
        try {
          this.pauseAudio();
        } finally {
          if (this.player.state.status === AudioPlayerStatus.Paused) duckPaused = true;
        }
      };
      this.player.on(AudioPlayerStatus.Playing, onMusicPlaying);

      // Set before the swap, so a subscribe() that throws part-way still gets undone
      swapped = true;
      this.connection.subscribe(this.ttsPlayer);
      this.ttsPlayer.play(resource);
      const reason = await awaitClipEnd(this.ttsPlayer, resource);
      // A clip that stalled or overran is still holding its resource open
      if (reason !== 'finished') this.ttsPlayer.stop(true);
      // A clip whose ffmpeg died goes idle without ever yielding a packet, which
      // otherwise looks exactly like a clean finish
      if (reason === 'finished' && resource.playbackDuration === 0) {
        console.warn('[MusicQueue] Clip ended without producing any audio');
        return false;
      }
      return reason === 'finished';
    } catch (error) {
      console.error('[MusicQueue] duckAndPlay: clip playback failed:', error.message);
      this.ttsPlayer?.stop(true);
      return false;
    } finally {
      // Putting the music back is the one step that must not fail silently, and
      // resume() can throw the same way pause() can - so it neither escapes (it would
      // replace the return value with a rejection) nor skips clearing the flag
      try {
        // Before resume(), or resuming the music would trip the handler that pauses it
        if (onMusicPlaying) this.player.off(AudioPlayerStatus.Playing, onMusicPlaying);
        // cleanup() can have run while the clip was playing
        if (swapped && this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
          this.connection.subscribe(this.player);
        }
        // Read (and cleared) before resume(), which would otherwise take the request back on
        // the user's behalf: a pause asked for during the clip is honoured by simply not
        // putting the music back, which leaves the player paused with the clock already
        // stopped by the duck's own pause.
        const userAskedForPause = this.pendingUserPause;
        this.pendingUserPause = false;
        if (userAskedForPause) {
          console.log('[MusicQueue] Leaving the music paused after the clip - a pause was asked for during it');
        } else if (duckPaused) {
          this.resume();
        }
      } catch (error) {
        console.error('[MusicQueue] duckAndPlay: restoring the music after the clip failed:', error.message);
      } finally {
        this.duckActive = false;
      }
    }
  }

  setVolume(volume) {
    // Store the linear volume for UI display
    this.volume = volume;
    
    // Apply logarithmic curve for more natural volume perception
    // Human hearing is logarithmic, so linear sliders feel wrong
    // Using a power curve: actual = linear^2 gives a nice feel
    // At 0.5 (50%), actual volume will be 0.25 (25%)
    // At 0.1 (10%), actual volume will be 0.01 (1%)
    const actualVolume = Math.pow(volume, 2);
    
    if (this.currentResource && this.currentResource.volume) {
      this.currentResource.volume.setVolume(actualVolume);
    }
    broadcastState();
  }

  skip() {
    this.stopForUserAction();
  }

  // Cycle through loop modes: off -> song -> queue -> off
  cycleLoopMode() {
    const modes = ['off', 'song', 'queue'];
    const currentIndex = modes.indexOf(globalSettings.loopMode);
    globalSettings.loopMode = modes[(currentIndex + 1) % 3];
    saveSettings();
    console.log('Loop mode changed to:', globalSettings.loopMode);
    broadcastState();
    return globalSettings.loopMode;
  }

  // Toggle 24/7 mode (prevents auto-disconnect)
  toggle24_7() {
    globalSettings.is24_7 = !globalSettings.is24_7;
    saveSettings();
    console.log('24/7 mode:', globalSettings.is24_7 ? 'enabled' : 'disabled');
    broadcastState();
    return globalSettings.is24_7;
  }

  // Toggle radio mode (auto-play similar songs)
  toggleRadio() {
    globalSettings.radioEnabled = !globalSettings.radioEnabled;
    saveSettings();
    console.log('Radio mode:', globalSettings.radioEnabled ? 'enabled' : 'disabled');
    broadcastState();
    return globalSettings.radioEnabled;
  }

  // Seek to a specific position in the current song (in seconds)
  async seek(seconds) {
    if (!this.currentSong || !this.connection) return false;

    const requested = Number(seconds);
    if (!Number.isFinite(requested)) return false;

    // Clamp into the song: seeking past the end produces a stream that ends immediately,
    // and that Idle is swallowed by isSeeking
    let target = Math.max(0, requested);
    if (this.currentSong.duration > 0) {
      target = Math.min(target, Math.max(0, this.currentSong.duration - 1));
    }

    console.log(`Seeking to ${target} seconds in ${this.currentSong.title}`);

    // Set seeking flag to prevent playNext from being triggered
    this.isSeeking = true;
    this.armSeekWatchdog();

    // Reset songStartTime so it gets recalculated when playback resumes. Playing again from a
    // paused player also resumes it, so the pause bookkeeping goes with it.
    this.resetPlaybackClock();

    // Store old FFmpeg reference
    const oldFFmpeg = this.currentFFmpeg;

    // The song is played from a local file, so seeking is always instant - and there is
    // nothing to fall back to if that file has gone
    if (this.cachedAudioPath && existsSync(this.cachedAudioPath)) {
      this.playFromCache(target);
    } else {
      console.log('No audio source available for seek');
      this.isSeeking = false;
      this.clearSeekWatchdog();
      return false;
    }

    // Clean up old FFmpeg process AFTER starting new one
    if (oldFFmpeg) {
      oldFFmpeg.kill();
    }

    // Broadcast state with seek position
    broadcastState(target);
    return true;
  }

  // Apply mixer filter changes and re-spawn FFmpeg at current position
  async applyFilters(newFilters) {
    // Calculate current position BEFORE updating speed
    // songStartTime is encoded as: start - seekOffset / speed * 1000
    // So: (now - songStartTime) / 1000 * speed = audio position
    const oldSpeed = globalSettings.mixerFilters.speed || 1.0;
    const currentPosition = this.getPlaybackElapsedMs() / 1000 * oldSpeed;

    clampMixerFilters(newFilters);

    saveSettings();

    if (!this.currentSong || !this.connection) {
      broadcastState();
      return true;
    }

    console.log(`[Mixer] Applying filters at position ${currentPosition.toFixed(1)}s:`, globalSettings.mixerFilters);

    this.isSeeking = true;
    this.armSeekWatchdog();
    this.resetPlaybackClock();
    const oldFFmpeg = this.currentFFmpeg;

    if (this.cachedAudioPath && existsSync(this.cachedAudioPath)) {
      this.playFromCache(currentPosition);
    } else {
      this.isSeeking = false;
      this.clearSeekWatchdog();
      broadcastState();
      return false;
    }

    if (oldFFmpeg) {
      oldFFmpeg.kill();
    }

    broadcastState(currentPosition);
    return true;
  }

  // Skip to a specific index in the queue (index is from web UI where 0 = current song)
  skipTo(index) {
    // Index 0 is current song, so we need to adjust
    // Index 1 = songs[0], Index 2 = songs[1], etc.
    const queueIndex = index - 1;
    
    if (queueIndex < 0 || queueIndex >= this.songs.length) return false;
    
    // Remove songs before the target index
    this.songs = this.songs.slice(queueIndex);
    // Before the stop below, so the download the jumped-over song was holding is let go of
    // rather than staying in the way of the song the user actually asked for
    this.maintainPrefetch();

    // Stop current song to trigger playNext (jumping is a skip, so loop must not re-queue)
    this.stopForUserAction();
    return true;
  }

  // Remove a specific song from the queue (index is from web UI where 0 = current song)
  removeFromQueue(index) {
    // Index 0 is current song (can't remove)
    // Index 1 = songs[0], Index 2 = songs[1], etc.
    const queueIndex = index - 1;
    
    if (index === 0 || queueIndex < 0 || queueIndex >= this.songs.length) return false;
    
    // Remove the song at the specified index
    this.songs.splice(queueIndex, 1);
    console.log(`Removed song at index ${index} from queue`);

    this.maintainPrefetch();
    // Broadcast updated state
    broadcastState();
    return true;
  }

  // Shuffle the queue using Fisher-Yates algorithm
  shuffle() {
    if (this.songs.length < 2) return false;
    
    for (let i = this.songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.songs[i], this.songs[j]] = [this.songs[j], this.songs[i]];
    }
    
    console.log('Queue shuffled');
    this.maintainPrefetch();
    broadcastState();
    return true;
  }

  // Reorder queue - move song from one position to another
  // fromIndex and toIndex are 1-based (from web UI where 1 = first song in queue)
  reorder(fromIndex, toIndex) {
    // Convert to 0-based array indices
    const from = fromIndex - 1;
    let to = toIndex - 1;
    
    if (from < 0 || from >= this.songs.length) {
      console.log(`Invalid reorder from index: ${fromIndex}`);
      return false;
    }
    
    // Clamp 'to' to valid range
    to = Math.max(0, Math.min(to, this.songs.length - 1));
    
    if (from === to) {
      console.log('Reorder: same position, no change');
      return false;
    }
    
    // Remove the song from its original position
    const [song] = this.songs.splice(from, 1);
    
    // Insert at the new position
    this.songs.splice(to, 0, song);
    
    console.log(`Reordered queue: moved "${song.title}" from position ${fromIndex} to ${toIndex}`);
    this.maintainPrefetch();
    broadcastState();
    return true;
  }

  stop() {
    // Track listening time for current song before stopping. The Idle this triggers runs
    // playNext(), which then finds the clock already cleared instead of counting it twice.
    this.trackAndClearListening();

    this.songs = [];
    // Nothing is queued any more, so the background download is fetching a song that will
    // never play. Before stopForUserAction(), so it is not still holding the slot when the
    // Idle that follows runs playNext().
    this.maintainPrefetch();
    this.stopForUserAction();
    // Reset logged song tracker since we're stopping
    if (resetLastLoggedSongCallback) {
      resetLastLoggedSongCallback();
    }
    broadcastState();
  }

  leave() {
    // Track listening time for current song before leaving (no-op if stop() already did)
    this.trackAndClearListening();

    // destroy() throws on an already-destroyed connection, and leave() runs from a timer
    // callback where that would take down the process
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      this.connection.destroy();
    }
    this.cleanup();
  }

  cleanup() {
    // Empty the queue first: player.stop() below fires Idle synchronously, and an empty
    // queue plus the destroying flag keep that from restarting playback or re-tracking stats
    this.songs = [];
    this.destroying = true;

    // Stop playback and kill the encoder, otherwise ffmpeg keeps running headless
    this.player.stop(true);
    // Same for a ducked clip: stopping it ends the wait in duckAndPlay right away
    // instead of leaving its ffmpeg alive until the stall watchdog notices
    if (this.ttsPlayer) this.ttsPlayer.stop(true);
    if (this.currentFFmpeg) {
      this.currentFFmpeg.kill('SIGKILL');
      this.currentFFmpeg = null;
    }

    // Delete the /tmp cache file for the song we were playing...
    this.cleanupCachedAudio();
    // ...and the one for the song that was going to play next. Unconditional rather than via
    // maintainPrefetch(): a queue being torn down has no next song to reason about.
    this.invalidatePrefetch('the queue is being torn down');

    // After player.stop(), since the Idle -> playNext() above may have armed a fresh one
    this.clearAutoLeaveTimer();
    this.clearSeekWatchdog();

    this.isPlaying = false;
    this.isSeeking = false;
    this.skipRequested = false;
    this.currentSong = null;
    this.currentResource = null;
    this.connection = null;
    this.listenerConnection = null;
    // Reset logged song tracker on cleanup
    if (resetLastLoggedSongCallback) {
      resetLastLoggedSongCallback();
    }
    // Clear Discord presence
    if (updatePresenceCallback) {
      updatePresenceCallback(null);
    }
    // Only drop the map entry if it still points at us - a newer queue may own this guild now
    if (queues.get(this.guildId) === this) {
      queues.delete(this.guildId);
    }
    this.destroying = false;
    broadcastState();
  }

  getQueue() {
    return {
      current: this.currentSong,
      upcoming: this.songs,
      isPlaying: this.isPlaying
    };
  }
}

export function getQueue(guildId) {
  return queues.get(guildId);
}

/**
 * Push this guild's empty-queue auto-disconnect back by `ms` (see
 * MusicQueue#deferAutoLeave). Used by the voice assistant to keep the bot in
 * the channel for the length of a "Hey Jerry" interaction.
 * @returns {boolean} whether a pending timer was actually re-armed.
 */
export function deferAutoLeave(guildId, ms) {
  const queue = queues.get(guildId);
  return queue ? queue.deferAutoLeave(ms) : false;
}

// Get this guild's queue, creating it if there isn't one. One instance per guild, always.
//
// Every "start playing from nothing" caller (play.js, playlist.js, index.js's handleAddSong)
// does the same read-then-create, and none of them can guard against another one having done it
// first. Today they get away with it because each read and its create sit in the same
// synchronous run - but a second instance for one guild is not a cosmetic problem: the loser is
// orphaned while still running. It keeps its voice connection, downloads through the same
// single-slot gate, broadcasts its own state over the winner's, and no /stop or /skip can ever
// reach it again, since those only touch whatever is in this map. So creation hands back the
// live queue rather than replacing it, and the hazard is structurally gone instead of
// incidentally absent.
//
// A queue mid-teardown is not live: cleanup() drops its own map entry when it finishes, so the
// only way to see one here is from inside its own teardown, and that is not an instance to
// hand out.
export function createQueue(guildId, guildInfo = null) {
  const existing = queues.get(guildId);
  if (existing && !existing.destroying) {
    console.log(`[MusicQueue] Reusing the live queue for guild ${guildId} rather than replacing it`);
    // A caller that has fresher guild info (an icon that changed, a name) may as well pass it on
    if (guildInfo?.name) existing.guildName = guildInfo.name;
    if (guildInfo?.icon) existing.guildIcon = guildInfo.icon;
    return existing;
  }

  const queue = new MusicQueue(guildId, guildInfo);
  queues.set(guildId, queue);
  return queue;
}

// Guilds with a clip in flight on the queueless path below
const standaloneDucks = new Set();

// Play a clip on a voice connection that has no music queue behind it. /record joins
// the channel directly with joinVoiceChannel(), and the wake-word listener rides
// whatever connection is there - without this, Jerry would be mute in any guild where
// music was never started. There is no music player here, so nothing to pause or
// resume: subscribe a throwaway player, play, unsubscribe.
async function duckAndPlayOnConnection(guildId, resourceFactory) {
  const connection = getVoiceConnection(guildId);
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    console.log(`[MusicQueue] duckAndPlay: no ready voice connection for guild ${guildId}, skipping clip`);
    return false;
  }
  if (standaloneDucks.has(guildId)) {
    console.warn(`[MusicQueue] duckAndPlay: a clip is already playing in guild ${guildId}, skipping this one`);
    return false;
  }

  standaloneDucks.add(guildId);
  let player = null;
  let subscription;

  try {
    const resource = resourceFactory();

    // Per clip rather than per guild: one shared player subscribed to two connections
    // would play the same audio into both, and there is no queue lifecycle to hang a
    // longer-lived one off
    player = createAudioPlayer();
    player.on('error', error => {
      console.error(`[MusicQueue] Clip player error in guild ${guildId}:`, error.message);
    });

    subscription = connection.subscribe(player);
    if (!subscription) {
      console.log(`[MusicQueue] duckAndPlay: voice connection for guild ${guildId} went away before the clip started`);
      return false;
    }

    player.play(resource);
    const reason = await awaitClipEnd(player, resource);
    if (reason !== 'finished') player.stop(true);
    if (reason === 'finished' && resource.playbackDuration === 0) {
      console.warn('[MusicQueue] Clip ended without producing any audio');
      return false;
    }
    return reason === 'finished';
  } catch (error) {
    console.error('[MusicQueue] duckAndPlay: clip playback failed:', error.message);
    player?.stop(true);
    return false;
  } finally {
    // Safe even if the connection was destroyed mid-clip: unsubscribe() and the
    // setSpeaking() it triggers both check the connection's state first
    subscription?.unsubscribe();
    if (connection.state.status !== VoiceConnectionStatus.Ready) {
      console.log(`[MusicQueue] Clip ended with the voice connection ${connection.state.status} in guild ${guildId}`);
    }
    standaloneDucks.delete(guildId);
  }
}

// Play a short clip (wake beep, spoken reply) over whatever this guild is doing.
// No-ops when the bot has no ready voice connection there.
export async function duckAndPlay(guildId, resourceFactory) {
  // Only the queue's own path can duck music, so it wins whenever it holds the
  // connection; without one, the clip goes straight onto the connection
  const queue = queues.get(guildId);
  if (queue && queue.connection) {
    return queue.duckAndPlay(resourceFactory);
  }
  return duckAndPlayOnConnection(guildId, resourceFactory);
}

export function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  if (queue) {
    queue.cleanup();
  }
}

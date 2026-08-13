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
      saveStats();
      saveStatsTimeout = null;
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
      sleepTimer = setTimeout(() => {
        // Stop playback when timer expires
        const firstQueue = queues.values().next().value;
        if (firstQueue) {
          firstQueue.stop();
          firstQueue.leave();
        }
        globalSettings.sleepEndTime = null;
        saveSettings();
        broadcastState();
        console.log('Sleep timer expired - playback stopped');
      }, remaining);
    } else {
      globalSettings.sleepEndTime = null;
      saveSettings();
    }
  }
}

// Call after queues Map is defined
setTimeout(setupSleepTimer, 100);

// Sleep timer control functions (called from web server)
export function setSleepTimer(minutes) {
  // Clear existing timer if any
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }

  globalSettings.sleepEndTime = Date.now() + (minutes * 60 * 1000);
  saveSettings();

  sleepTimer = setTimeout(() => {
    // Stop playback when timer expires
    const firstQueue = queues.values().next().value;
    if (firstQueue) {
      firstQueue.stop();
      firstQueue.leave();
    }
    globalSettings.sleepEndTime = null;
    sleepTimer = null;
    saveSettings();
    broadcastState();
    console.log('Sleep timer expired - playback stopped');
  }, minutes * 60 * 1000);

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
  positionBroadcastInterval = setInterval(() => {
    const firstQueue = queues.values().next().value;
    if (firstQueue && firstQueue.isPlaying && firstQueue.songStartTime &&
        firstQueue.player.state.status !== AudioPlayerStatus.Paused) {
      broadcastState();
    } else {
      stopPositionBroadcast();
    }
  }, 1000);
}

function stopPositionBroadcast() {
  if (positionBroadcastInterval) {
    clearInterval(positionBroadcastInterval);
    positionBroadcastInterval = null;
  }
}

function broadcastState(seekPosition = null) {
  if (!webUpdateCallback) return;

  // Get first active queue (for now, support single guild)
  const firstQueue = queues.values().next().value;

  if (firstQueue) {
    // Calculate current playback position in seconds (paused time excluded)
    const isPaused = firstQueue.player.state.status === AudioPlayerStatus.Paused;
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
    const progressTimer = setInterval(() => {
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
    }, 1000);
    if (progressTimer.unref) progressTimer.unref();

    player.on(AudioPlayerStatus.Idle, onIdle);
    player.on('error', onError);
    resource.playStream.on('error', onStreamError);
  });
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
    this.cachedAudioPath = null; // Path to cached audio file
    this.isCaching = false; // Whether we're currently caching audio
    this.currentAudioUrl = null; // Current streaming URL
    this.songStartTime = null; // Timestamp when current song started playing
    this.pausedAt = null; // Timestamp of the pause currently in effect (null = not paused)
    this.totalPausedMs = 0; // Paused milliseconds already accumulated for this song
    this.seekWatchdog = null; // Handle for the timer that unsticks a seek that never resumed
    this.seekOffset = 0; // Offset in seconds for when song started (for seeking)
    this.historyIndex = -1; // Current position in recently played history (-1 = not navigating history)
    this.playingFromHistory = false; // Flag to prevent re-adding history songs
    this.cacheGeneration = 0; // Bumped whenever the current song changes - stale background downloads are discarded
    this.cachingGeneration = null; // Generation of the in-flight background download (null = none in flight)
    this.autoLeaveTimer = null; // Handle for the empty-queue auto-disconnect timer
    this.consecutiveFailures = 0; // Consecutive play() failures - trips a breaker at 3
    this.destroying = false; // True while cleanup() runs, so player events don't restart anything
    this.listenerConnection = null; // Connection object we already attached lifecycle listeners to
    this.recentRadioUrls = []; // Last 5 server-side radio auto-adds, to avoid looping on the same tracks
    this.ttsPlayer = null; // Dedicated player for ducked clips, created on first use (see duckAndPlay)
    this.duckActive = false; // True while a ducked clip is playing over the music
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
      this.playNext();
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
      }
      
      broadcastState();
    });

    this.player.on(AudioPlayerStatus.Paused, () => {
      console.log('Player paused');
      broadcastState();
    });

    this.player.on('error', error => {
      console.error(`Error in audio player for guild ${guildId}:`, error);
      this.isSeeking = false;
      this.clearSeekWatchdog();
      if (this.destroying) return;
      this.playNext();
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

      // Handle connection state
      this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          // Reconnect failed - tear down, but never destroy an already-destroyed connection
          if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
          }
          this.cleanup();
        }
      });

      this.connection.on('error', err => {
        console.error('[MusicQueue] connection error:', err.message);
      });
    }

    return this.connection;
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
      this.play();
    }
    
    return true;
  }

  async play() {
    console.log(`play() called - isPlaying: ${this.isPlaying}, songs in queue: ${this.songs.length}`);
    if (this.isPlaying || this.songs.length === 0) {
      console.log('Skipping play() - already playing or no songs');
      return;
    }

    // A song is starting, so the empty-queue disconnect no longer applies
    this.clearAutoLeaveTimer();

    // Clean up previous FFmpeg process and cached audio
    if (this.currentFFmpeg) {
      this.currentFFmpeg.kill();
      this.currentFFmpeg = null;
    }
    this.cleanupCachedAudio();

    this.isPlaying = true;
    this.currentSong = this.songs.shift();
    this.cacheGeneration++; // New song - any background download still in flight is now stale

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
      trackSongStarted(this.currentSong);
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

    try {
      if (!isAllowedMediaUrl(this.currentSong.url)) {
        throw new Error(`Refusing to pass unsupported URL to yt-dlp: ${this.currentSong.url}`);
      }

      // Get the audio URL for streaming
      // Format priority: opus (best quality) > m4a/aac > webm/vorbis > any audio > any format
      // Prefer 160kbps+ audio when available
      const result = await ytDlpExec(this.currentSong.url, {
        ...ytCookieOpts,
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        format: 'bestaudio[acodec=opus]/bestaudio[acodec=aac]/bestaudio[abr>=160]/bestaudio/best',
        audioQuality: 0 // Best quality
      });
      
      this.currentAudioUrl = result.url;
      
      // Log audio quality info for debugging
      if (result.acodec || result.abr) {
        console.log(`Audio quality: ${result.acodec || 'unknown'} @ ${result.abr || 'unknown'}kbps`);
      }
      
      // Start streaming immediately
      this.playFromUrl(this.currentAudioUrl, 0);
      
      // Start caching in the background for instant seeking later
      this.cacheAudioInBackground();
      
    } catch (error) {
      console.error('Error playing song:', error);
      // Drop the failed song BEFORE playNext() - otherwise loop mode 'song' re-queues it
      // and we spin on the same broken URL forever
      const failedSong = this.currentSong;
      this.currentSong = null;
      this.isPlaying = false;
      this.cleanupCachedAudio();

      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        console.error(`[MusicQueue] Skipping repeatedly failing song: ${failedSong?.title || 'unknown'}`);
        // Purge any remaining copies (loop re-queues, duplicate adds) of the failing song
        if (failedSong?.url) {
          this.songs = this.songs.filter(s => s.url !== failedSong.url);
        }
        this.consecutiveFailures = 0;
      }

      this.playNext();
    }
  }

  // Play from URL at specific position (for initial play and fallback seek)
  playFromUrl(audioUrl, seekSeconds = 0) {
    const ffmpegArgs = [];
    
    if (seekSeconds > 0) {
      ffmpegArgs.push('-ss', String(Math.floor(seekSeconds)));
    }
    
    // Store the seek offset - songStartTime will be set when player actually starts
    this.seekOffset = seekSeconds;
    
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
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

  // Cache audio in the background for instant seeking
  async cacheAudioInBackground() {
    if (!this.currentSong) return;

    // Snapshot the generation this download belongs to - the song may change while yt-dlp runs
    const gen = this.cacheGeneration;
    if (this.isCaching && this.cachingGeneration === gen) return; // already downloading this song

    this.isCaching = true;
    this.cachingGeneration = gen;
    const tempFileName = `godcord_${this.guildId}_${Date.now()}.opus`;
    const cachePath = join(tmpdir(), tempFileName);
    
    console.log(`Background caching audio to: ${cachePath}`);
    
    try {
      if (!isAllowedMediaUrl(this.currentSong.url)) {
        throw new Error(`Refusing to pass unsupported URL to yt-dlp: ${this.currentSong.url}`);
      }

      // Cache at highest quality opus (quality 0 = best, ~256kbps VBR)
      // Use same format preference as streaming for consistency
      await ytDlpExec(this.currentSong.url, {
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
      });
      
      // Only set cached path if this download still belongs to the song that's playing
      if (gen === this.cacheGeneration && this.isPlaying && this.currentSong) {
        this.cachedAudioPath = cachePath;
        console.log('Audio cached successfully - seeking will now be instant!');
        broadcastState(); // Update UI to show cached checkmark
      } else {
        // Song changed while we were downloading, discard this file
        console.log('Discarding stale background cache (song changed during download)');
        try { unlinkSync(cachePath); } catch (e) {}
      }
    } catch (error) {
      console.error('Background caching failed:', error);
      try { unlinkSync(cachePath); } catch (e) {}
    }

    // Only release the flag if a newer download hasn't already claimed it
    if (this.cachingGeneration === gen) {
      this.isCaching = false;
      this.cachingGeneration = null;
    }
  }

  // Play from cached audio file at specific position
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
    this.currentAudioUrl = null;
    this.isCaching = false;
    this.resetPlaybackClock();
    this.cacheGeneration++; // Invalidate any background download still in flight
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
    this.autoLeaveTimer = setTimeout(() => {
      this.autoLeaveTimer = null;
      // A timer left over from a discarded queue must never touch the live one
      if (queues.get(this.guildId) !== this) {
        console.log('[MusicQueue] Stale auto-leave timer fired for a replaced queue, ignoring');
        return;
      }
      if (this.songs.length === 0 && !this.isPlaying && !globalSettings.is24_7) {
        this.leave();
      }
    }, ms);
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
    this.seekWatchdog = setTimeout(() => {
      this.seekWatchdog = null;
      if (!this.isSeeking) return;
      console.warn('[MusicQueue] Seek watchdog fired - no Playing transition, clearing seek state');
      this.isSeeking = false;
      // The Idle that ended the old stream was swallowed, so nothing else will advance the queue
      if (!this.destroying && this.player.state.status === AudioPlayerStatus.Idle) {
        this.playNext();
      }
    }, SEEK_WATCHDOG_MS);
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
    if (status === AudioPlayerStatus.Idle) return false;

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

  pause() {
    const paused = this.player.pause();
    // Only start the clock on a real transition, so a double /pause cannot lose time
    if (paused && this.pausedAt === null) {
      this.pausedAt = Date.now();
    }
    return paused;
  }

  resume() {
    const resumed = this.player.unpause();
    if (resumed && this.pausedAt !== null) {
      this.totalPausedMs += Date.now() - this.pausedAt;
      this.pausedAt = null;
    }
    return resumed;
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
        this.pause();
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
          this.pause();
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
        if (duckPaused) this.resume();
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

    // Use cached file if available (instant), otherwise use URL (slower)
    if (this.cachedAudioPath && existsSync(this.cachedAudioPath)) {
      console.log('Using cached audio for instant seek');
      this.playFromCache(target);
    } else if (this.currentAudioUrl) {
      console.log('Cache not ready, using URL for seek (may have slight delay)');
      this.playFromUrl(this.currentAudioUrl, target);
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
    } else if (this.currentAudioUrl) {
      this.playFromUrl(this.currentAudioUrl, currentPosition);
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
    broadcastState();
    return true;
  }

  stop() {
    // Track listening time for current song before stopping. The Idle this triggers runs
    // playNext(), which then finds the clock already cleared instead of counting it twice.
    this.trackAndClearListening();

    this.songs = [];
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

    // Delete the /tmp cache file for the song we were playing
    this.cleanupCachedAudio();

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

export function createQueue(guildId, guildInfo = null) {
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

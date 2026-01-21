import { createAudioPlayer, createAudioResource, joinVoiceChannel, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import ytDlpPkg from 'yt-dlp-exec';
import { platform } from 'os';
import { spawn, execSync } from 'child_process';
let ytDlpExec;

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
// (moved up)
import ffmpegStatic from 'ffmpeg-static';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { unlinkSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Load recently played from file
function loadRecentlyPlayed() {
  try {
    if (existsSync(RECENTLY_PLAYED_FILE)) {
      const data = JSON.parse(readFileSync(RECENTLY_PLAYED_FILE, 'utf8'));
      // Filter out entries older than 7 days
      const now = Date.now();
      return data.filter(song => (now - song.playedAt) < SEVEN_DAYS_MS);
    }
  } catch (error) {
    console.error('Error loading recently played:', error);
  }
  return [];
}

// Save recently played to file
function saveRecentlyPlayed(recentlyPlayed) {
  try {
    // Ensure data directory exists
    const dataDir = dirname(RECENTLY_PLAYED_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    // Filter out entries older than 7 days before saving
    const now = Date.now();
    const filtered = recentlyPlayed.filter(song => (now - song.playedAt) < SEVEN_DAYS_MS);
    writeFileSync(RECENTLY_PLAYED_FILE, JSON.stringify(filtered, null, 2));
  } catch (error) {
    console.error('Error saving recently played:', error);
  }
}

// Global recently played list (shared across all guilds for persistence)
let globalRecentlyPlayed = loadRecentlyPlayed();
console.log(`Loaded ${globalRecentlyPlayed.length} recently played songs from storage`);

// Player settings persistence
function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
      // Check if sleep timer has expired
      if (data.sleepEndTime && data.sleepEndTime < Date.now()) {
        data.sleepEndTime = null;
      }
      return {
        loopMode: data.loopMode || 'off',
        is24_7: data.is24_7 || false,
        sleepEndTime: data.sleepEndTime || null
      };
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  return { loopMode: 'off', is24_7: false, sleepEndTime: null };
}

function saveSettings() {
  try {
    const dataDir = dirname(SETTINGS_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(SETTINGS_FILE, JSON.stringify(globalSettings, null, 2));
  } catch (error) {
    console.error('Error saving settings:', error);
  }
}

// Global settings (shared across all clients)
let globalSettings = loadSettings();
let sleepTimer = null;
console.log(`Loaded player settings: loopMode=${globalSettings.loopMode}, is24_7=${globalSettings.is24_7}, sleepEndTime=${globalSettings.sleepEndTime}`);

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

// Export getter for recently played (used by web server for initial state)
export function getRecentlyPlayed() {
  return globalRecentlyPlayed;
}

// Store queue per guild
const queues = new Map();

// Web dashboard update function (will be set by index.js)
let webUpdateCallback = null;

// Activity logger callbacks (will be set by index.js)
let logNowPlayingCallback = null;
let resetLastLoggedSongCallback = null;

export function setWebUpdateCallback(callback) {
  webUpdateCallback = callback;
}

export function setActivityLoggerCallback(logNowPlaying, resetLastLoggedSong) {
  logNowPlayingCallback = logNowPlaying;
  resetLastLoggedSongCallback = resetLastLoggedSong;
}

// Broadcast state to web dashboard
function broadcastState(seekPosition = null) {
  if (!webUpdateCallback) return;
  
  // Get first active queue (for now, support single guild)
  const firstQueue = queues.values().next().value;
  
  if (firstQueue) {
    // Debug: log current song thumbnail
    if (firstQueue.currentSong) {
      console.log('Current song thumbnail:', firstQueue.currentSong.thumbnail || 'NO THUMBNAIL');
    }
    webUpdateCallback({
      currentSong: firstQueue.currentSong,
      queue: firstQueue.songs,
      recentlyPlayed: globalRecentlyPlayed,
      isPlaying: firstQueue.isPlaying,
      isPaused: firstQueue.player.state.status === AudioPlayerStatus.Paused,
      volume: firstQueue.volume,
      guildId: firstQueue.guildId,
      guildName: firstQueue.guildName,
      guildIcon: firstQueue.guildIcon,
      voiceChannelName: firstQueue.voiceChannelName,
      seekPosition: seekPosition,
      isCached: !!(firstQueue.cachedAudioPath && existsSync(firstQueue.cachedAudioPath)),
      songStartTime: firstQueue.songStartTime,
      loopMode: globalSettings.loopMode,
      is24_7: globalSettings.is24_7,
      sleepEndTime: globalSettings.sleepEndTime
    });
  } else {
    webUpdateCallback({
      currentSong: null,
      queue: [],
      recentlyPlayed: globalRecentlyPlayed,
      isPlaying: false,
      isPaused: false,
      volume: 1.0,
      guildId: null,
      loopMode: globalSettings.loopMode,
      is24_7: globalSettings.is24_7,
      sleepEndTime: globalSettings.sleepEndTime
    });
  }
}

export class MusicQueue {
  constructor(guildId, guildInfo = null) {
    this.guildId = guildId;
    this.guildName = guildInfo?.name || null;
    this.guildIcon = guildInfo?.icon || null;
    this.voiceChannelName = null;
    this.songs = [];
    this.isPlaying = false;
    this.isSeeking = false;
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
    this.seekOffset = 0; // Offset in seconds for when song started (for seeking)
    this.historyIndex = -1; // Current position in recently played history (-1 = not navigating history)
    this.playingFromHistory = false; // Flag to prevent re-adding history songs
    // Note: loopMode, is24_7, and sleepEndTime are now in globalSettings for persistence

    // Handle player state changes - use arrow function to preserve 'this'
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Don't trigger playNext if we're seeking
      if (this.isSeeking) {
        console.log('Player went idle during seek, ignoring...');
        return;
      }
      console.log('Player went idle, playing next...');
      this.playNext();
    });

    this.player.on(AudioPlayerStatus.Playing, () => {
      console.log('Player is now playing');
      this.isSeeking = false; // Clear seeking flag when playing resumes
      
      // Set song start time when actually playing (accounting for seek offset)
      if (!this.songStartTime) {
        this.songStartTime = Date.now() - (this.seekOffset * 1000);
        console.log('Song start time set:', new Date(this.songStartTime), 'with offset:', this.seekOffset);
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
      this.playNext();
    });
  }

  async join(voiceChannel) {
    this.voiceChannelName = voiceChannel.name;
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });

    this.connection.subscribe(this.player);

    // Handle connection state
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        this.connection.destroy();
        this.cleanup();
      }
    });

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

    // Clean up previous FFmpeg process and cached audio
    if (this.currentFFmpeg) {
      this.currentFFmpeg.kill();
      this.currentFFmpeg = null;
    }
    this.cleanupCachedAudio();

    this.isPlaying = true;
    this.currentSong = this.songs.shift();
    
    // Only add to recently played if not playing from history navigation
    if (!this.playingFromHistory) {
      // Reset history index when playing new songs normally
      this.historyIndex = -1;
      
      // Add to global recently played (at the beginning, max 50)
      globalRecentlyPlayed.unshift({
        ...this.currentSong,
        playedAt: Date.now()
      });
      if (globalRecentlyPlayed.length > 50) {
        globalRecentlyPlayed.pop();
      }
      // Save to file for persistence
      saveRecentlyPlayed(globalRecentlyPlayed);
    }
    // Clear the flag for next song
    this.playingFromHistory = false;
    
    // Broadcast state immediately when song changes
    broadcastState();
    
    // Log the now playing song
    if (logNowPlayingCallback && this.currentSong) {
      logNowPlayingCallback(this.currentSong);
    }

    try {
      // Get the audio URL for streaming
      // Format priority: opus (best quality) > m4a/aac > webm/vorbis > any audio > any format
      // Prefer 160kbps+ audio when available
      const result = await ytDlpExec(this.currentSong.url, {
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
      this.isPlaying = false;
      this.cleanupCachedAudio();
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
      '-af', 'aresample=resampler=soxr', // High quality resampling
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
    if (this.isCaching || !this.currentSong) return;
    
    this.isCaching = true;
    const tempFileName = `godcord_${this.guildId}_${Date.now()}.opus`;
    const cachePath = join(tmpdir(), tempFileName);
    
    console.log(`Background caching audio to: ${cachePath}`);
    
    try {
      // Cache at highest quality opus (quality 0 = best, ~256kbps VBR)
      // Use same format preference as streaming for consistency
      await ytDlpExec(this.currentSong.url, {
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
      
      // Only set cached path if we're still playing the same song
      if (this.isPlaying && this.currentSong) {
        this.cachedAudioPath = cachePath;
        console.log('Audio cached successfully - seeking will now be instant!');
        broadcastState(); // Update UI to show cached checkmark
      } else {
        // Song changed, clean up the cache we just made
        try { unlinkSync(cachePath); } catch (e) {}
      }
    } catch (error) {
      console.error('Background caching failed:', error);
    }
    
    this.isCaching = false;
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
      '-af', 'aresample=resampler=soxr', // High quality resampling
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
    this.songStartTime = null;
  }

  async playNext() {
    console.log('playNext called, songs in queue:', this.songs.length);

    // Handle loop modes before cleanup
    if (this.currentSong && globalSettings.loopMode !== 'off') {
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
      // Handle 24/7 mode - don't disconnect
      if (globalSettings.is24_7) {
        console.log('Queue empty, but 24/7 mode is active - staying connected');
      } else {
        console.log('Queue empty, will disconnect in 60 seconds if no new songs');
        // Queue finished, disconnect after a delay
        setTimeout(() => {
          if (this.songs.length === 0 && !this.isPlaying && !globalSettings.is24_7) {
            this.leave();
          }
        }, 60000); // 1 minute
      }
    }
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
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
    this.player.stop();
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

  // Seek to a specific position in the current song (in seconds)
  async seek(seconds) {
    if (!this.currentSong || !this.connection) return false;
    
    console.log(`Seeking to ${seconds} seconds in ${this.currentSong.title}`);
    
    // Set seeking flag to prevent playNext from being triggered
    this.isSeeking = true;
    
    // Reset songStartTime so it gets recalculated when playback resumes
    this.songStartTime = null;
    
    // Store old FFmpeg reference
    const oldFFmpeg = this.currentFFmpeg;
    
    // Use cached file if available (instant), otherwise use URL (slower)
    if (this.cachedAudioPath && existsSync(this.cachedAudioPath)) {
      console.log('Using cached audio for instant seek');
      this.playFromCache(seconds);
    } else if (this.currentAudioUrl) {
      console.log('Cache not ready, using URL for seek (may have slight delay)');
      this.playFromUrl(this.currentAudioUrl, seconds);
    } else {
      console.log('No audio source available for seek');
      this.isSeeking = false;
      return false;
    }
    
    // Clean up old FFmpeg process AFTER starting new one
    if (oldFFmpeg) {
      oldFFmpeg.kill();
    }
    
    // Broadcast state with seek position
    broadcastState(seconds);
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
    
    // Stop current song to trigger playNext
    this.player.stop();
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
    this.songs = [];
    this.player.stop();
    // Reset logged song tracker since we're stopping
    if (resetLastLoggedSongCallback) {
      resetLastLoggedSongCallback();
    }
    broadcastState();
  }

  leave() {
    if (this.connection) {
      this.connection.destroy();
    }
    this.cleanup();
  }

  cleanup() {
    this.songs = [];
    this.isPlaying = false;
    this.currentSong = null;
    this.connection = null;
    // Reset logged song tracker on cleanup
    if (resetLastLoggedSongCallback) {
      resetLastLoggedSongCallback();
    }
    queues.delete(this.guildId);
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

export function createQueue(guildId, guildInfo = null) {
  const queue = new MusicQueue(guildId, guildInfo);
  queues.set(guildId, queue);
  return queue;
}

export function deleteQueue(guildId) {
  const queue = queues.get(guildId);
  if (queue) {
    queue.cleanup();
  }
}

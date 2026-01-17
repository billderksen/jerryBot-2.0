import { createAudioPlayer, createAudioResource, joinVoiceChannel, AudioPlayerStatus, VoiceConnectionStatus, entersState, StreamType } from '@discordjs/voice';
import ytDlpPkg from 'yt-dlp-exec';
const ytDlpExec = ytDlpPkg;
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

// Set FFmpeg path
process.env.FFMPEG_PATH = ffmpegPath;

// Store queue per guild
const queues = new Map();

// Web dashboard update function (will be set by index.js)
let webUpdateCallback = null;

export function setWebUpdateCallback(callback) {
  webUpdateCallback = callback;
}

// Broadcast state to web dashboard
function broadcastState(seekPosition = null) {
  if (!webUpdateCallback) return;
  
  // Get first active queue (for now, support single guild)
  const firstQueue = queues.values().next().value;
  
  if (firstQueue) {
    webUpdateCallback({
      currentSong: firstQueue.currentSong,
      queue: firstQueue.songs,
      isPlaying: firstQueue.isPlaying,
      isPaused: firstQueue.player.state.status === AudioPlayerStatus.Paused,
      volume: firstQueue.volume,
      guildId: firstQueue.guildId,
      guildName: firstQueue.guildName,
      guildIcon: firstQueue.guildIcon,
      seekPosition: seekPosition,
      isCached: !!(firstQueue.cachedAudioPath && existsSync(firstQueue.cachedAudioPath))
    });
  } else {
    webUpdateCallback({
      currentSong: null,
      queue: [],
      isPlaying: false,
      isPaused: false,
      volume: 1.0,
      guildId: null
    });
  }
}

export class MusicQueue {
  constructor(guildId, guildInfo = null) {
    this.guildId = guildId;
    this.guildName = guildInfo?.name || null;
    this.guildIcon = guildInfo?.icon || null;
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
    this.songs.push(song);
    console.log(`Song added: ${song.title}, Queue length now: ${this.songs.length}`);
    broadcastState();
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
    
    // Broadcast state immediately when song changes
    broadcastState();

    try {
      // Get the audio URL for streaming
      const result = await ytDlpExec(this.currentSong.url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        format: 'bestaudio[ext=webm]/bestaudio/best'
      });
      
      this.currentAudioUrl = result.url;
      
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
    
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
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
      resource.volume.setVolume(this.volume);
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
      await ytDlpExec(this.currentSong.url, {
        output: cachePath,
        extractAudio: true,
        audioFormat: 'opus',
        audioQuality: 0,
        noCheckCertificates: true,
        noWarnings: true,
        ffmpegLocation: ffmpegPath
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
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
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
      resource.volume.setVolume(this.volume);
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
  }

  async playNext() {
    console.log('playNext called, songs in queue:', this.songs.length);
    
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
      console.log('Queue empty, will disconnect in 60 seconds if no new songs');
      // Queue finished, disconnect after a delay
      setTimeout(() => {
        if (this.songs.length === 0 && !this.isPlaying) {
          this.leave();
        }
      }, 60000); // 1 minute
    }
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.currentResource && this.currentResource.volume) {
      this.currentResource.volume.setVolume(volume);
    }
    broadcastState();
  }

  skip() {
    this.player.stop();
  }

  // Seek to a specific position in the current song (in seconds)
  async seek(seconds) {
    if (!this.currentSong || !this.connection) return false;
    
    console.log(`Seeking to ${seconds} seconds in ${this.currentSong.title}`);
    
    // Set seeking flag to prevent playNext from being triggered
    this.isSeeking = true;
    
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

  stop() {
    this.songs = [];
    this.player.stop();
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

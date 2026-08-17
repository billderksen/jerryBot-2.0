import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue, createQueue, ytDlpExec, ytCookieOpts } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';
import { isAllowedMediaUrl, sanitizeSearchQuery } from '../utils/urlValidation.js';
import Spotify from 'spotify-url-info';
import { fetch } from 'undici';

const { getPreview, getTracks } = Spotify(fetch);

// Helper to check if URL is Spotify
function isSpotifyUrl(url) {
  return url.includes('spotify.com') || url.includes('spotify:');
}

// Search YouTube via yt-dlp (replaces the unmaintained play-dl search). Reuses
// musicQueue.js's already-configured, cookie-aware yt-dlp instance.
async function searchYoutube(query, limit = 5) {
  const results = await ytDlpExec(`ytsearch${limit}:${sanitizeSearchQuery(query)}`, {
    ...ytCookieOpts,
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    flatPlaylist: true,
    skipDownload: true
  });

  const entries = results.entries || [];
  return entries.map(video => ({
    title: video.title || 'Unknown Title',
    url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
    duration: video.duration || 0
  }));
}

// Helper to search YouTube for a song (used to match a Spotify track to a video)
async function searchYouTube(query) {
  const results = await searchYoutube(query, 1);
  return results[0] || null;
}

// What to tell the user about the song they just asked for, from what play() says happened to
// it. play() drops a song it cannot fetch and moves the queue on by itself, so "the await
// resolved" is not "it is playing" - an age-gated, region-locked or rate-limited song used to
// be announced as now playing and then never make a sound.
function describeStart(outcome, song) {
  const tag = song.source === 'spotify' ? ' 🎧' : '';
  if (outcome?.started) return `🎵 Now playing: **${song.title}**${tag}`;
  if (outcome?.reason === 'failed') {
    return `❌ Couldn't play **${song.title}**${tag} — ${outcome.detail}. Skipped it.`;
  }
  // Something else took the queue over while this was starting (a skip, a stop, another song)
  return `➕ Added to queue: **${song.title}**${tag}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play music in your voice channel')
    .addStringOption(option =>
      option
        .setName('song')
        .setDescription('Search for a song')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    
    if (!focusedValue || focusedValue.length < 2) {
      try {
        return await interaction.respond([]);
      } catch {
        return; // Interaction expired
      }
    }

    try {
      // Add timeout to prevent slow autocomplete responses
      const searchPromise = searchYoutube(focusedValue, 5);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Search timeout')), 2000)
      );

      const searchResults = await Promise.race([searchPromise, timeoutPromise]);

      const choices = searchResults.slice(0, 10).map(video => ({
        name: video.title.length > 100 ? video.title.substring(0, 97) + '...' : video.title,
        value: video.url
      }));

      await interaction.respond(choices);
    } catch (error) {
      // Only log if not a timeout or interaction error
      if (!error.message?.includes('timeout') && error.code !== 10062) {
        console.error('Error searching for songs:', error.message);
      }
      try {
        await interaction.respond([]);
      } catch {
        // Interaction already expired, ignore
      }
    }
  },

  async execute(interaction) {
    const songUrl = interaction.options.getString('song');
    const member = interaction.member;
    const voiceChannel = member.voice.channel;

    // Check if user is in a voice channel
    if (!voiceChannel) {
      return await interaction.reply({
        content: '❌ You need to be in a voice channel to play music!',
        flags: MessageFlags.Ephemeral
      });
    }

    // Check bot permissions
    const permissions = voiceChannel.permissionsFor(interaction.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak')) {
      return await interaction.reply({
        content: '❌ I need permissions to join and speak in your voice channel!',
        flags: MessageFlags.Ephemeral
      });
    }

    await interaction.deferReply();

    try {
      let song;
      
      // Check if it's a Spotify URL
      if (isSpotifyUrl(songUrl)) {
        // Get track info from Spotify
        const spotifyTrack = await getPreview(songUrl);
        const searchQuery = `${spotifyTrack.artist} - ${spotifyTrack.title}`;
        
        // Search YouTube for the song
        const ytResult = await searchYouTube(searchQuery);
        
        if (!ytResult) {
          return await interaction.editReply({
            content: `❌ Could not find "${searchQuery}" on YouTube.`
          });
        }
        
        song = {
          title: `${spotifyTrack.artist} - ${spotifyTrack.title}`,
          url: ytResult.url,
          duration: Math.floor(spotifyTrack.duration / 1000) || 0,
          thumbnail: spotifyTrack.image,
          requestedBy: interaction.member.displayName,
          requestedById: interaction.user.id,
          source: 'spotify'
        };
      } else if (isAllowedMediaUrl(songUrl)) {
        // Get song info using yt-dlp for YouTube/other URLs
        const videoInfo = await ytDlpExec(songUrl, {
          ...ytCookieOpts,
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          skipDownload: true
        });

        song = {
          title: videoInfo.title,
          url: videoInfo.webpage_url || songUrl,
          duration: videoInfo.duration || 0,
          thumbnail: videoInfo.thumbnail,
          requestedBy: interaction.member.displayName,
          requestedById: interaction.user.id,
          source: 'youtube'
        };
      } else {
        // Not a recognized media URL (or autocomplete was bypassed with free text) —
        // treat it as a YouTube search query instead of handing it to yt-dlp raw.
        const searchResult = await ytDlpExec(`ytsearch1:${sanitizeSearchQuery(songUrl)}`, {
          ...ytCookieOpts,
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          skipDownload: true
        });

        const videoInfo = searchResult.entries ? searchResult.entries[0] : searchResult;

        if (!videoInfo) {
          return await interaction.editReply({
            content: `❌ Could not find "${songUrl}" on YouTube.`
          });
        }

        song = {
          title: videoInfo.title,
          url: videoInfo.webpage_url || videoInfo.url || `https://www.youtube.com/watch?v=${videoInfo.id}`,
          duration: videoInfo.duration || 0,
          thumbnail: videoInfo.thumbnail,
          requestedBy: interaction.member.displayName,
          requestedById: interaction.user.id,
          source: 'youtube'
        };
      }

      // Get or create queue
      let queue = getQueue(interaction.guildId);
      
      if (!queue) {
        // Get guild info for the web dashboard
        const guildInfo = {
          name: interaction.guild.name,
          icon: interaction.guild.iconURL({ size: 128 })
        };
        queue = createQueue(interaction.guildId, guildInfo);
        await queue.join(voiceChannel);
        queue.addSong(song);
        const outcome = await queue.play();

        await interaction.editReply({ content: describeStart(outcome, song) });
      } else {
        queue.addSong(song);

        // If not currently playing, start playback
        if (!queue.isPlaying) {
          const outcome = await queue.play();
          await interaction.editReply({ content: describeStart(outcome, song) });
        } else {
          await interaction.editReply({
            content: `➕ Added to queue: **${song.title}**${song.source === 'spotify' ? ' 🎧' : ''}\nPosition: ${queue.songs.length}`
          });
        }
      }

      console.log(`\n[${new Date().toISOString()}] Music played by ${interaction.user.tag}:`);
      console.log(`Song: ${song.title}`);
      console.log(`URL: ${song.url}\n`);
      
      // Log the action
      logCommandAction(interaction.user, 'play', song.title);

    } catch (error) {
      console.error('Error playing music:', error);
      
      // Check for age-restricted video error
      let errorMessage = '❌ An error occurred while trying to play that song. Please try again.';
      if (error.stderr?.includes('Sign in to confirm your age')) {
        errorMessage = '❌ This video is age-restricted and requires YouTube login. Try a different video.';
      } else if (error.stderr?.includes('Video unavailable')) {
        errorMessage = '❌ This video is unavailable or private.';
      }
      
      try {
        await interaction.editReply({ content: errorMessage });
      } catch {
        // Interaction already expired
      }
    }
  }
};

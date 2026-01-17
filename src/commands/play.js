import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import play from 'play-dl';
import ytDlpPkg from 'yt-dlp-exec';
const ytDlpExec = ytDlpPkg;
import { getQueue, createQueue } from '../utils/musicQueue.js';
import Spotify from 'spotify-url-info';
import { fetch } from 'undici';

const { getPreview, getTracks } = Spotify(fetch);

// Helper to check if URL is Spotify
function isSpotifyUrl(url) {
  return url.includes('spotify.com') || url.includes('spotify:');
}

// Helper to search YouTube for a song
async function searchYouTube(query) {
  const results = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  return results[0] || null;
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
      const searchPromise = play.search(focusedValue, { limit: 5, source: { youtube: 'video' } });
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
          requestedBy: interaction.user.tag,
          source: 'spotify'
        };
      } else {
        // Get song info using yt-dlp for YouTube/other URLs
        const videoInfo = await ytDlpExec(songUrl, {
          dumpSingleJson: true,
          noCheckCertificates: true,
          noWarnings: true,
          // Skip age-restricted videos check (requires cookies for some videos)
          skipDownload: true
        });
        
        song = {
          title: videoInfo.title,
          url: videoInfo.webpage_url || songUrl,
          duration: videoInfo.duration || 0,
          thumbnail: videoInfo.thumbnail,
          requestedBy: interaction.user.tag,
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
        await queue.play();

        await interaction.editReply({
          content: `🎵 Now playing: **${song.title}**${song.source === 'spotify' ? ' 🎧' : ''}`
        });
      } else {
        queue.addSong(song);
        
        // If not currently playing, start playback
        if (!queue.isPlaying) {
          await queue.play();
          await interaction.editReply({
            content: `🎵 Now playing: **${song.title}**${song.source === 'spotify' ? ' 🎧' : ''}`
          });
        } else {
          await interaction.editReply({
            content: `➕ Added to queue: **${song.title}**${song.source === 'spotify' ? ' 🎧' : ''}\nPosition: ${queue.songs.length}`
          });
        }
      }

      console.log(`\n[${new Date().toISOString()}] Music played by ${interaction.user.tag}:`);
      console.log(`Song: ${song.title}`);
      console.log(`URL: ${song.url}\n`);

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

import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue, createQueue, ytDlpExec, ytCookieOpts } from '../utils/musicQueue.js';
import { logCommandAction } from '../utils/activityLogger.js';
import { isAllowedMediaUrl, sanitizeSearchQuery } from '../utils/urlValidation.js';
import {
  parseSpotifyUrl,
  getTrack,
  getPlaylistTracks,
  getAlbumTracks,
  resolveToYouTube,
  resolveAndQueueSpotifyTracks
} from '../utils/spotifyResolve.js';

// Spotify API errors (spotifyResolve.js's spotifyFetch) come through as a plain Error with the
// HTTP status embedded in the message; pull it back out so a 403 on a Spotify-owned editorial
// playlist (client-credentials tokens can't read those) can get its own friendly message. Mirrors
// server.js's handleSpotifyAdd — same wording, so a user sees one consistent message regardless
// of whether they hit this from Discord or the web dashboard.
function spotifyErrorStatus(error) {
  const match = /Spotify (?:API|token) request failed: (\d{3})/.exec(error?.message ?? '');
  return match ? parseInt(match[1], 10) : null;
}

// Adds a song to the guild's queue, joining the requester's voice channel first if the queue
// isn't connected yet, and starts playback if nothing is currently playing. Shared by the
// single-song path below and the Spotify playlist/album bulk-queue path, which both need
// "queue it, and start it if the queue was idle" but only the former reports per-song status
// back to the interaction.
async function queueAndMaybePlay(interaction, voiceChannel, song) {
  let queue = getQueue(interaction.guildId);

  if (!queue) {
    const guildInfo = {
      name: interaction.guild.name,
      icon: interaction.guild.iconURL({ size: 128 })
    };
    queue = createQueue(interaction.guildId, guildInfo);
  }

  // A queue can exist without being in a channel: a restart restores the queue but stays out
  // of an empty channel (see musicQueue's restoreQueueState). /play is what puts the bot
  // there, whether the queue is new or was waiting.
  if (!queue.connection) {
    await queue.join(voiceChannel);
    queue.addSong(song);
    const outcome = await queue.play();
    return { queue, outcome };
  }

  queue.addSong(song);
  if (!queue.isPlaying) {
    const outcome = await queue.play();
    return { queue, outcome };
  }

  return { queue, outcome: null };
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
  // Name the song play() actually acted on rather than the one this command asked for. They are
  // the same whenever this path is reached today - it only runs on an idle queue - but naming
  // the requested song for an outcome that belonged to another one is the same class of lie as
  // the rest of it, and cheaper to retire than to keep reasoning about.
  const acted = (outcome?.started || outcome?.reason === 'failed') ? (outcome.song ?? song) : song;
  const tag = acted.source === 'spotify' ? ' 🎧' : '';

  if (outcome?.started) return `🎵 Now playing: **${acted.title}**${tag}`;
  if (outcome?.reason === 'failed') {
    return `❌ Couldn't play **${acted.title}**${tag} — ${outcome.detail}. Skipped it.`;
  }
  // Something else took the queue over while this was starting (a skip, a stop, another song),
  // so the song this command added is in the queue rather than playing
  return `➕ Added to queue: **${acted.title}**${tag}`;
}

// Spotify playlist/album branch of /play: fetches the tracklist (capped at 100, same as the web
// dashboard's equivalent in server.js's handleSpotifyAdd), then resolves+queues each track to
// YouTube one at a time via resolveAndQueueSpotifyTracks, reusing queueAndMaybePlay as the
// per-track "add it, start it if the queue was idle" step. The interaction was already deferred
// by execute() before this ran, since a 100-track resolve is not a sub-3s operation.
async function handleSpotifyBulkPlay(interaction, { type, id }, voiceChannel) {
  try {
    const tracks = type === 'playlist'
      ? await getPlaylistTracks(id, 100)
      : (await getAlbumTracks(id)).slice(0, 100);

    if (tracks.length === 0) {
      return await interaction.editReply({
        content: '❌ Deze Spotify-playlist/album bevat geen beschikbare tracks.'
      });
    }

    const queueTrack = async (song) => {
      await queueAndMaybePlay(interaction, voiceChannel, {
        ...song,
        requestedBy: interaction.member.displayName,
        requestedById: interaction.user.id,
        source: 'youtube'
      });
      logCommandAction(interaction.user, 'play', song.title);
      return { success: true };
    };

    const { added, failed, total, aborted } = await resolveAndQueueSpotifyTracks(tracks, queueTrack, ytDlpExec);

    if (aborted) {
      return await interaction.editReply({ content: '❌ Toevoegen mislukt — zit de bot wel in een voicekanaal?' });
    }

    const message = failed > 0
      ? `${added} van ${total} toegevoegd; ${failed} niet gevonden`
      : `${added} van ${total} toegevoegd`;
    await interaction.editReply({ content: `✅ ${message}` });
  } catch (error) {
    console.error('Error playing Spotify playlist/album:', error);

    // A 403 on a Spotify-owned editorial playlist/album (client-credentials tokens can't read
    // those) gets the same friendly wording server.js's handleSpotifyAdd uses for the web
    // dashboard's equivalent flow, rather than the generic API-down message below.
    const status = spotifyErrorStatus(error);
    if (status === 403) {
      const message = type === 'album'
        ? 'Dit Spotify-album is niet op te vragen — probeer het later opnieuw.'
        : 'Deze Spotify-playlist is door Spotify zelf beheerd en niet op te vragen — gebruik een playlist van een gebruiker.';
      try {
        await interaction.editReply({ content: `❌ ${message}` });
      } catch {
        // Interaction already expired
      }
      return;
    }
    if (status === 429) {
      try {
        await interaction.editReply({ content: '❌ Spotify-zoeklimiet tijdelijk bereikt — probeer het over een minuutje opnieuw.' });
      } catch {
        // Interaction already expired
      }
      return;
    }

    try {
      await interaction.editReply({ content: '❌ Kon de Spotify-gegevens niet ophalen. Probeer het later opnieuw.' });
    } catch {
      // Interaction already expired
    }
  }
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

    // Spotify URLs (track/playlist/album) are detected before anything else. A track resolves
    // to a single YouTube video and joins the normal single-song flow below (reply shows the
    // Spotify title/artist); a playlist/album is a bulk operation handled separately since it
    // has no single `song` to hand to the shared queue-and-reply code and can take a while.
    const spotifyRef = parseSpotifyUrl(songUrl);

    if (spotifyRef && (spotifyRef.type === 'playlist' || spotifyRef.type === 'album')) {
      return await handleSpotifyBulkPlay(interaction, spotifyRef, voiceChannel);
    }

    try {
      let song;

      if (spotifyRef?.type === 'track') {
        const track = await getTrack(spotifyRef.id);
        const resolved = await resolveToYouTube(track, ytDlpExec);

        if (!resolved?.url) {
          return await interaction.editReply({
            content: `❌ Could not find "${track.artist} – ${track.title}" on YouTube.`
          });
        }

        song = {
          title: `${track.artist} – ${track.title}`,
          artist: track.artist,
          url: resolved.url,
          duration: track.durationSec,
          thumbnail: track.thumbnail,
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

      const { queue, outcome } = await queueAndMaybePlay(interaction, voiceChannel, song);

      if (outcome) {
        await interaction.editReply({ content: describeStart(outcome, song) });
      } else {
        await interaction.editReply({
          content: `➕ Added to queue: **${song.title}**${song.source === 'spotify' ? ' 🎧' : ''}\nPosition: ${queue.songs.length}`
        });
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

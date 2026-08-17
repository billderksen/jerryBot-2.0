import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { getQueue, createQueue, ytDlpExec, ytCookieOpts } from '../utils/musicQueue.js';
import { isAllowedMediaUrl } from '../utils/urlValidation.js';
import { createPlaylist, deletePlaylist, addSong, removeSong, getPlaylists, getPlaylist, getAllPlaylistNames, getPlaylistSongNames } from '../utils/playlists.js';

export default {
  data: new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Manage your personal playlists')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a new playlist')
        .addStringOption(opt => opt.setName('name').setDescription('Playlist name').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Delete a playlist')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist to delete').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a song to a playlist')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist to add to').setRequired(true).setAutocomplete(true))
        .addStringOption(opt => opt.setName('url').setDescription('Song URL (uses current song if empty)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a song from a playlist')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist').setRequired(true).setAutocomplete(true))
        .addStringOption(opt => opt.setName('song').setDescription('Song to remove').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sub =>
      sub.setName('play')
        .setDescription('Queue all songs from a playlist')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist to play').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sub =>
      sub.setName('shuffle')
        .setDescription('Queue all songs from a playlist in random order')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist to shuffle').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show your playlists')
    )
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show songs in a playlist')
        .addStringOption(opt => opt.setName('playlist').setDescription('Playlist to view').setRequired(true).setAutocomplete(true))
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const userId = interaction.user.id;

    if (focused.name === 'playlist') {
      const playlists = getAllPlaylistNames(userId);
      const filtered = playlists.filter(p => p.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
      try {
        await interaction.respond(filtered);
      } catch { /* expired */ }
    } else if (focused.name === 'song') {
      const playlistId = interaction.options.getString('playlist');
      const songs = getPlaylistSongNames(userId, playlistId);
      const filtered = songs.filter(s => s.name.toLowerCase().includes(focused.value.toLowerCase())).slice(0, 25);
      try {
        await interaction.respond(filtered);
      } catch { /* expired */ }
    }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    if (sub === 'create') {
      const name = interaction.options.getString('name');
      const createdBy = interaction.user.globalName || interaction.user.username;
      const result = createPlaylist(userId, name, createdBy);
      if (!result.success) {
        return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `✅ Playlist **${name}** created!`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'delete') {
      const playlistId = interaction.options.getString('playlist');
      const pl = getPlaylist(userId, playlistId);
      if (!pl) {
        return interaction.reply({ content: '❌ Playlist not found.', flags: MessageFlags.Ephemeral });
      }
      deletePlaylist(userId, playlistId);
      return interaction.reply({ content: `🗑️ Playlist **${pl.name}** deleted.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'add') {
      const playlistId = interaction.options.getString('playlist');
      const url = interaction.options.getString('url');

      // The same allowlist every other entry point applies before a URL goes anywhere near
      // yt-dlp (play.js, /api/queue/add, /api/youtube/playlist) - see urlValidation.js for
      // what an unrecognised positional argument does there. Checked before anything else is
      // read or written, since nothing about a URL this command cannot use is worth doing.
      if (url && !isAllowedMediaUrl(url)) {
        return interaction.reply({ content: '❌ Invalid or unsupported URL.', flags: MessageFlags.Ephemeral });
      }

      const pl = getPlaylist(userId, playlistId);
      if (!pl) {
        return interaction.reply({ content: '❌ Playlist not found.', flags: MessageFlags.Ephemeral });
      }

      let song;
      if (url) {
        // Real metadata, the way /api/queue/add does it: without this the stored "song" had
        // the raw input as its title and a duration of 0, which then rendered as an ugly
        // raw-URL entry everywhere the playlist is shown - on disk, permanently.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const videoInfo = await ytDlpExec(url, {
            ...ytCookieOpts,
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            skipDownload: true
          });
          song = {
            url: videoInfo.webpage_url || url,
            title: videoInfo.title || url,
            duration: videoInfo.duration || 0,
            thumbnail: videoInfo.thumbnail || null,
            source: 'youtube'
          };
        } catch (error) {
          console.error('[playlist] Could not look up song info:', error.message);
          return interaction.editReply({ content: '❌ Could not read that video — it may be private, unavailable or age-restricted.' });
        }

        const addResult = addSong(userId, playlistId, song);
        if (!addResult.success) {
          return interaction.editReply({ content: `❌ ${addResult.error}` });
        }
        return interaction.editReply({ content: `✅ Added **${song.title}** to **${pl.name}**` });
      } else {
        const queue = getQueue(interaction.guildId);
        if (!queue || !queue.currentSong) {
          return interaction.reply({ content: '❌ Nothing is playing and no URL provided.', flags: MessageFlags.Ephemeral });
        }
        song = queue.currentSong;
      }

      const result = addSong(userId, playlistId, song);
      if (!result.success) {
        return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `✅ Added **${song.title}** to **${pl.name}**`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'remove') {
      const playlistId = interaction.options.getString('playlist');
      const songIndex = parseInt(interaction.options.getString('song'));
      const pl = getPlaylist(userId, playlistId);
      if (!pl) {
        return interaction.reply({ content: '❌ Playlist not found.', flags: MessageFlags.Ephemeral });
      }
      const songName = pl.songs[songIndex]?.title || 'Unknown';
      const result = removeSong(userId, playlistId, songIndex);
      if (!result.success) {
        return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
      }
      return interaction.reply({ content: `🗑️ Removed **${songName}** from **${pl.name}**`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'play' || sub === 'shuffle') {
      const playlistId = interaction.options.getString('playlist');
      const pl = getPlaylist(userId, playlistId);
      if (!pl) {
        return interaction.reply({ content: '❌ Playlist not found.', flags: MessageFlags.Ephemeral });
      }
      if (pl.songs.length === 0) {
        return interaction.reply({ content: '❌ Playlist is empty.', flags: MessageFlags.Ephemeral });
      }

      const member = interaction.member;
      const voiceChannel = member.voice.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: '❌ You need to be in a voice channel!', flags: MessageFlags.Ephemeral });
      }

      const permissions = voiceChannel.permissionsFor(interaction.client.user);
      if (!permissions.has('Connect') || !permissions.has('Speak')) {
        return interaction.reply({ content: '❌ I need permissions to join and speak in your voice channel!', flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply();

      let queue = getQueue(interaction.guildId);
      if (!queue) {
        const guildInfo = {
          name: interaction.guild.name,
          icon: interaction.guild.iconURL({ size: 128 })
        };
        queue = createQueue(interaction.guildId, guildInfo);
      }
      // A queue can exist without being in a channel: a restart restores the queue but stays
      // out of an empty channel (see musicQueue's restoreQueueState).
      if (!queue.connection) {
        await queue.join(voiceChannel);
      }

      let songs = pl.songs.map(s => ({
        ...s,
        requestedBy: interaction.member.displayName,
        requestedById: interaction.user.id,
        source: 'youtube'
      }));

      if (sub === 'shuffle') {
        for (let i = songs.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [songs[i], songs[j]] = [songs[j], songs[i]];
        }
      }

      for (const song of songs) {
        queue.addSong(song);
      }

      let startNote = '';
      if (!queue.isPlaying) {
        // play() drops a song it cannot fetch and starts the one after it, so the first song
        // of a playlist can fail without the queue stopping - worth saying, since "Queued"
        // otherwise reads as "and the first one is playing"
        const outcome = await queue.play();
        if (outcome && !outcome.started && outcome.reason === 'failed') {
          startNote = `\n⚠️ Couldn't start **${outcome.song?.title ?? 'the first song'}** — ${outcome.detail}. Skipped it.`;
        }
      }

      const label = sub === 'shuffle' ? 'Shuffled' : 'Queued';
      return interaction.editReply({ content: `🎵 ${label} **${pl.name}** (${songs.length} songs)${startNote}` });
    }

    if (sub === 'list') {
      const playlists = getPlaylists(userId);
      if (playlists.length === 0) {
        return interaction.reply({ content: 'You have no playlists. Create one with `/playlist create`!', flags: MessageFlags.Ephemeral });
      }
      const list = playlists.map((p, i) => `${i + 1}. **${p.name}** — ${p.songCount} song${p.songCount !== 1 ? 's' : ''}`).join('\n');
      return interaction.reply({ content: `🎶 **Your Playlists**\n${list}`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'view') {
      const playlistId = interaction.options.getString('playlist');
      const pl = getPlaylist(userId, playlistId);
      if (!pl) {
        return interaction.reply({ content: '❌ Playlist not found.', flags: MessageFlags.Ephemeral });
      }
      if (pl.songs.length === 0) {
        return interaction.reply({ content: `📋 **${pl.name}** is empty.`, flags: MessageFlags.Ephemeral });
      }
      const list = pl.songs.slice(0, 20).map((s, i) => `${i + 1}. ${s.title}`).join('\n');
      const extra = pl.songs.length > 20 ? `\n...and ${pl.songs.length - 20} more` : '';
      return interaction.reply({ content: `📋 **${pl.name}** (${pl.songs.length} songs)\n${list}${extra}`, flags: MessageFlags.Ephemeral });
    }
  }
};

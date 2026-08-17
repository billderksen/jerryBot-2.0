import { test } from 'node:test';
import assert from 'node:assert/strict';
import playlistCommand from '../src/commands/playlist.js';

// `/playlist add <playlist> <url>` was the one user-facing entry point that took a raw URL
// without running it past isAllowedMediaUrl() and without looking up any metadata: it stored
// whatever string was typed, as both the URL and the title, with a duration of 0. The engine
// re-validates before it ever invokes yt-dlp, so this was never an SSRF - but the junk entry
// went to disk and then failed silently on every future playback of that playlist.
//
// The check runs before the playlist is even looked up, so this drives the real command
// without touching data/playlists.json.
function fakeInteraction(options) {
  const replies = [];
  return {
    replies,
    guildId: 'guild-under-test',
    user: { id: 'user-under-test' },
    options: {
      getSubcommand: () => 'add',
      getString: (name) => options[name] ?? null
    },
    reply: async (payload) => { replies.push(payload); },
    editReply: async (payload) => { replies.push(payload); },
    deferReply: async () => { replies.push('deferred'); }
  };
}

test('/playlist add: a URL yt-dlp must never be handed is refused, not stored', async () => {
  const interaction = fakeInteraction({ playlist: 'whatever', url: '--exec=touch /tmp/pwned' });

  await playlistCommand.execute(interaction);

  assert.equal(interaction.replies.length, 1, 'answered once, before anything was read or written');
  assert.match(interaction.replies[0].content, /Invalid or unsupported URL/);
});

test('/playlist add: an arbitrary http URL is refused too', async () => {
  const interaction = fakeInteraction({ playlist: 'whatever', url: 'http://169.254.169.254/latest/meta-data/' });

  await playlistCommand.execute(interaction);

  assert.match(interaction.replies[0].content, /Invalid or unsupported URL/);
});

test('/playlist add: a real YouTube URL gets past the allowlist and on to the lookup', async () => {
  // Not stored: the playlist id is nonsense, so the command stops at the lookup - which is
  // exactly far enough to show the allowlist is not what turned this one away.
  const interaction = fakeInteraction({ playlist: 'no-such-playlist', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });

  await playlistCommand.execute(interaction);

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].content, /Playlist not found/);
});

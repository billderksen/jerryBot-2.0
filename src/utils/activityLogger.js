// Activity Logger - Sends music bot activity to a Discord channel

const LOG_CHANNEL_ID = '1462410580185845893';

let discordClient = null;
let lastLoggedSong = null; // Track last logged song to avoid duplicates

export function setDiscordClient(client) {
  discordClient = client;
}

async function sendLogMessage(content) {
  if (!discordClient) {
    console.log('[ActivityLog] Discord client not set');
    return;
  }

  try {
    const channel = await discordClient.channels.fetch(LOG_CHANNEL_ID);
    if (channel) {
      await channel.send(content);
    }
  } catch (error) {
    console.error('[ActivityLog] Failed to send log message:', error.message);
  }
}

// Log when a user performs an action via Discord command
export async function logCommandAction(user, action, details = '') {
  const userMention = `<@${user.id}>`;
  let message = '';

  switch (action) {
    case 'play':
      message = `🎵 ${userMention} added a song to the queue${details ? `: **${details}**` : ''}`;
      break;
    case 'skip':
      message = `⏭️ ${userMention} skipped${details ? `: **${details}**` : ''}`;
      break;
    case 'pause':
      message = `⏸️ ${userMention} paused playback`;
      break;
    case 'resume':
      message = `▶️ ${userMention} resumed playback`;
      break;
    case 'stop':
      message = `⏹️ ${userMention} stopped playback and cleared the queue`;
      break;
    case 'volume':
      message = `🔊 ${userMention} set volume to **${details}%**`;
      break;
    case 'queue':
      // Don't log queue views - not really an action
      return;
    case 'nowplaying':
      // Don't log now playing views - not really an action
      return;
    default:
      message = `🎮 ${userMention} used **${action}**${details ? `: ${details}` : ''}`;
  }

  await sendLogMessage(message);
}

// Log when a user performs an action via web dashboard
export async function logWebAction(username, action, details = '') {
  let message = '';

  switch (action) {
    case 'play':
      message = `🎵 **${username}** (web) added a song to the queue${details ? `: **${details}**` : ''}`;
      break;
    case 'radio-add':
      message = `📻 **Radio** auto-queued${details ? `: **${details}**` : ''}`;
      break;
    case 'skip':
      message = `⏭️ **${username}** (web) skipped${details ? `: **${details}**` : ''}`;
      break;
    case 'previous':
      message = `⏮️ **${username}** (web) went to previous song`;
      break;
    case 'pause':
      message = `⏸️ **${username}** (web) paused playback`;
      break;
    case 'resume':
      message = `▶️ **${username}** (web) resumed playback`;
      break;
    case 'stop':
      message = `⏹️ **${username}** (web) stopped playback`;
      break;
    case 'volume':
      message = `🔊 **${username}** (web) set volume to **${details}%**`;
      break;
    case 'seek':
      message = `⏩ **${username}** (web) seeked to **${details}**`;
      break;
    case 'skipto':
      message = `⏭️ **${username}** (web) skipped to song #${details}`;
      break;
    case 'remove':
      message = `🗑️ **${username}** (web) removed song #${details} from queue`;
      break;
    default:
      message = `🎮 **${username}** (web) used **${action}**${details ? `: ${details}` : ''}`;
  }

  await sendLogMessage(message);
}

// Log when a new song starts playing (called from musicQueue)
export async function logNowPlaying(song, source = 'queue') {
  // Avoid duplicate logs for the same song
  const songKey = `${song.url}-${song.title}`;
  if (lastLoggedSong === songKey) {
    return;
  }
  lastLoggedSong = songKey;

  const duration = song.duration ? formatDuration(song.duration) : 'Unknown';
  const requestedBy = song.requestedBy || 'Unknown';
  
  let message = `🎶 **Now Playing:** ${song.title}\n`;
  message += `⏱️ Duration: ${duration} | 👤 Requested by: ${requestedBy}`;

  await sendLogMessage(message);
}

// Reset the last logged song (call when queue is cleared/stopped)
export function resetLastLoggedSong() {
  lastLoggedSong = null;
}

// Helper to format duration
function formatDuration(seconds) {
  if (!seconds || seconds === 0) return 'Unknown';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

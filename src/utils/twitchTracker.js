import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
import { EmbedBuilder } from 'discord.js';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '../../data/twitchStreamers.json');

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

let trackerData = null;
let pollInterval = null;
let discordClient = null;
let appAccessToken = null;
let tokenExpiresAt = 0;

// --- Data persistence ---

function loadData() {
  return loadJsonSync(DATA_FILE, {
    streamers: {},
    notificationChannelId: null
  });
}

function saveData() {
  saveJsonSync(DATA_FILE, trackerData);
}

// --- Twitch API auth (Client Credentials) ---

async function getAppAccessToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be set in .env');
  }

  // Reuse token if still valid (with 60s buffer)
  if (appAccessToken && Date.now() < tokenExpiresAt - 60000) {
    return appAccessToken;
  }

  const response = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    throw new Error(`Twitch token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  appAccessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  console.log('[Twitch Tracker] Obtained app access token');
  return appAccessToken;
}

async function twitchFetch(path) {
  const token = await getAppAccessToken();
  const clientId = process.env.TWITCH_CLIENT_ID;

  const response = await fetch(`${TWITCH_API_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-Id': clientId
    },
    signal: AbortSignal.timeout(10_000)
  });

  if (response.status === 401) {
    // Token expired, force refresh
    appAccessToken = null;
    tokenExpiresAt = 0;
    const newToken = await getAppAccessToken();
    const retry = await fetch(`${TWITCH_API_BASE}${path}`, {
      headers: {
        'Authorization': `Bearer ${newToken}`,
        'Client-Id': clientId
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!retry.ok) throw new Error(`Twitch API ${retry.status}: ${retry.statusText}`);
    return retry.json();
  }

  if (!response.ok) {
    throw new Error(`Twitch API ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

// --- Polling logic ---

async function checkStreams() {
  const usernames = Object.keys(trackerData.streamers);
  if (usernames.length === 0) return;

  // Collect all Twitch user IDs
  const userIds = [];
  for (const username of usernames) {
    const streamer = trackerData.streamers[username];
    if (streamer.twitchId) {
      userIds.push(streamer.twitchId);
    }
  }

  if (userIds.length === 0) return;

  try {
    // Batch request: GET /streams?user_id=X&user_id=Y
    const params = userIds.map(id => `user_id=${id}`).join('&');
    const data = await twitchFetch(`/streams?${params}`);
    const liveStreams = data.data || [];

    // Build a set of live twitch IDs for quick lookup
    const liveMap = new Map();
    for (const stream of liveStreams) {
      liveMap.set(stream.user_id, stream);
    }

    // Check each tracked streamer, tracking whether anything worth persisting changed
    let changed = false;
    const newSessions = [];

    for (const [username, streamer] of Object.entries(trackerData.streamers)) {
      const stream = liveMap.get(streamer.twitchId);
      if (stream) {
        // Streamer is live
        if (!streamer.isLive) changed = true;
        streamer.isLive = true;
        streamer.streamTitle = stream.title;
        streamer.gameName = stream.game_name;
        streamer.viewerCount = stream.viewer_count;
        streamer.startedAt = stream.started_at;

        if (stream.id !== streamer.lastNotifiedStreamId) {
          // New stream session - queue notification
          streamer.lastNotifiedStreamId = stream.id;
          changed = true;
          newSessions.push([username, streamer, stream]);
        }
      } else if (streamer.isLive) {
        // Streamer just went offline
        streamer.isLive = false;
        streamer.streamTitle = null;
        streamer.gameName = null;
        streamer.viewerCount = null;
        streamer.startedAt = null;
        changed = true;
      }
    }

    if (changed) saveData();

    for (const [username, streamer, stream] of newSessions) {
      await sendLiveNotification(username, streamer, stream);
    }
  } catch (error) {
    console.error('[Twitch Tracker] Error checking streams:', error.message);
  }
}

async function sendLiveNotification(username, streamer, stream) {
  if (!trackerData.notificationChannelId || !discordClient) return;

  try {
    const channel = await discordClient.channels.fetch(trackerData.notificationChannelId);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x9146FF)
      .setTitle(`${streamer.displayName} is now live!`)
      .setDescription(stream.title || 'No title')
      .setURL(`https://twitch.tv/${username}`)
      .addFields(
        { name: 'Category', value: stream.game_name || 'Unknown', inline: true },
        { name: 'Viewers', value: String(stream.viewer_count || 0), inline: true }
      )
      .setTimestamp();

    if (stream.thumbnail_url) {
      embed.setImage(`${stream.thumbnail_url.replace('{width}x{height}', '1280x720')}?t=${Date.now()}`);
    }

    if (streamer.profileImage) {
      embed.setThumbnail(streamer.profileImage);
    }

    // Build mentions string for subscribers
    const mentions = (streamer.subscribers || []).map(id => `<@${id}>`).join(' ');

    await channel.send({
      content: mentions || undefined,
      embeds: [embed]
    });

    console.log(`[Twitch Tracker] Sent live notification for ${streamer.displayName}`);
  } catch (error) {
    console.error(`[Twitch Tracker] Error sending notification for ${username}:`, error.message);
  }
}

// --- Exported API ---

export async function initTwitchTracker(client) {
  // Load tracker data unconditionally so /streamer subcommands and autocomplete
  // work even without Twitch credentials configured.
  discordClient = client;
  trackerData = loadData();
  console.log('[Twitch Tracker] Loaded', Object.keys(trackerData.streamers).length, 'tracked streamers');

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) {
    console.log('[Twitch Tracker] TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET not set - skipping live polling');
    return;
  }

  // Resolve Twitch user IDs for any streamers that don't have one yet
  await resolveUserIds();

  // Initial check
  checkStreams().catch(err => {
    console.error('[Twitch Tracker] Initial check failed:', err.message);
  });

  // Start polling
  pollInterval = setInterval(() => {
    checkStreams().catch(err => {
      console.error('[Twitch Tracker] Poll failed:', err.message);
    });
  }, POLL_INTERVAL_MS);
}

export function stopTwitchTracker() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function resolveUserIds() {
  const needsResolve = Object.entries(trackerData.streamers)
    .filter(([, s]) => !s.twitchId);

  if (needsResolve.length === 0) return;

  try {
    const params = needsResolve.map(([username]) => `login=${encodeURIComponent(username)}`).join('&');
    const data = await twitchFetch(`/users?${params}`);

    for (const user of (data.data || [])) {
      const login = user.login.toLowerCase();
      if (trackerData.streamers[login]) {
        trackerData.streamers[login].twitchId = user.id;
        trackerData.streamers[login].displayName = user.display_name;
        trackerData.streamers[login].profileImage = user.profile_image_url;
      }
    }
    saveData();
  } catch (error) {
    console.error('[Twitch Tracker] Error resolving user IDs:', error.message);
  }
}

export async function addStreamer(username, addedBy) {
  if (!username || typeof username !== 'string') {
    return { success: false, error: 'Invalid username' };
  }

  const login = username.toLowerCase().trim();

  if (trackerData.streamers[login]) {
    return { success: false, error: `${login} is already being tracked` };
  }

  try {
    // Validate via Twitch API
    const data = await twitchFetch(`/users?login=${encodeURIComponent(login)}`);
    const users = data.data || [];

    if (users.length === 0) {
      return { success: false, error: `Twitch user "${username}" not found` };
    }

    const user = users[0];

    trackerData.streamers[login] = {
      displayName: user.display_name,
      addedBy: addedBy || null,
      subscribers: [],
      lastNotifiedStreamId: null,
      profileImage: user.profile_image_url,
      twitchId: user.id,
      isLive: false,
      streamTitle: null,
      gameName: null,
      viewerCount: null,
      startedAt: null
    };
    saveData();

    return { success: true, displayName: user.display_name };
  } catch (error) {
    return { success: false, error: `Failed to look up "${username}": ${error.message}` };
  }
}

export function removeStreamer(username) {
  if (!username || typeof username !== 'string') {
    return { success: false, error: 'Invalid username' };
  }

  const login = username.toLowerCase().trim();

  if (!trackerData.streamers[login]) {
    return { success: false, error: `"${username}" is not being tracked` };
  }

  const displayName = trackerData.streamers[login].displayName;
  delete trackerData.streamers[login];
  saveData();

  return { success: true, displayName };
}

export function subscribeUser(username, userId) {
  if (!username || !userId) {
    return { success: false, error: 'Invalid username or user ID' };
  }

  const login = username.toLowerCase().trim();
  const streamer = trackerData.streamers[login];

  if (!streamer) {
    return { success: false, error: `"${username}" is not being tracked` };
  }

  if (!streamer.subscribers) streamer.subscribers = [];

  if (streamer.subscribers.includes(userId)) {
    return { success: false, error: 'You are already subscribed to this streamer' };
  }

  streamer.subscribers.push(userId);
  saveData();

  return { success: true, displayName: streamer.displayName };
}

export function unsubscribeUser(username, userId) {
  if (!username || !userId) {
    return { success: false, error: 'Invalid username or user ID' };
  }

  const login = username.toLowerCase().trim();
  const streamer = trackerData.streamers[login];

  if (!streamer) {
    return { success: false, error: `"${username}" is not being tracked` };
  }

  if (!streamer.subscribers) streamer.subscribers = [];

  const index = streamer.subscribers.indexOf(userId);
  if (index === -1) {
    return { success: false, error: 'You are not subscribed to this streamer' };
  }

  streamer.subscribers.splice(index, 1);
  saveData();

  return { success: true, displayName: streamer.displayName };
}

export function setNotificationChannel(channelId) {
  trackerData.notificationChannelId = channelId;
  saveData();
  return { success: true };
}

export function getTrackerData() {
  return {
    streamers: trackerData.streamers,
    notificationChannelId: trackerData.notificationChannelId
  };
}

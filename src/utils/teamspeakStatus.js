import http from 'http';
import { PermissionFlagsBits } from 'discord.js';

const SQ_HOST = '127.0.0.1';
const SQ_PORT = 10080;
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes (Discord rate-limits renames to 2/10min)

let sqApiKey = '';
let statusChannelId = '';
let lastCount = null;
let pollTimer = null;

function sqFetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: SQ_HOST,
      port: SQ_PORT,
      path,
      headers: { 'x-api-key': sqApiKey }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`TS6 ServerQuery ${path}: HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`TS6 ServerQuery ${path}: invalid JSON`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('TS6 ServerQuery timeout')); });
  });
}

async function getOnlineUserCount() {
  const data = await sqFetch('/1/clientlist');
  const list = Array.isArray(data.body) ? data.body : (data.body ? [data.body] : []);
  // Filter to real users only (client_type 0 = normal user, 1 = ServerQuery)
  return list.filter(c => String(c.client_type) === '0').length;
}

async function updateChannel(discordClient) {
  if (!statusChannelId || !sqApiKey) return;

  try {
    const count = await getOnlineUserCount();

    // Only rename if count changed
    if (count === lastCount) return;
    lastCount = count;

    const channel = discordClient.channels.cache.get(statusChannelId);
    if (!channel) {
      console.error('[TS6Status] Channel not found:', statusChannelId);
      return;
    }

    const name = `TeamSpeak: ${count} online`;
    await channel.setName(name);
    console.log(`[TS6Status] Updated channel to: ${name}`);
  } catch (err) {
    console.error('[TS6Status] Error:', err.message);
  }
}

export function initTeamspeakStatus(discordClient) {
  // Read env vars at init time (after dotenv has loaded)
  statusChannelId = process.env.TS6_STATUS_CHANNEL_ID || '';
  sqApiKey = process.env.TS6_API_KEY || '';

  if (!statusChannelId) {
    console.log('[TS6Status] No TS6_STATUS_CHANNEL_ID set, skipping');
    return;
  }
  if (!sqApiKey) {
    console.log('[TS6Status] No TS6_API_KEY set, skipping');
    return;
  }

  console.log('[TS6Status] Starting TeamSpeak status tracker (polling every 5 min)');

  // Lock permissions: everyone can see but nobody can connect
  try {
    const channel = discordClient.channels.cache.get(statusChannelId);
    if (channel) {
      channel.permissionOverwrites.edit(channel.guild.id, {
        [PermissionFlagsBits.ViewChannel]: true,
        [PermissionFlagsBits.Connect]: false,
      });
      console.log('[TS6Status] Locked channel permissions (view only, no connect)');
    }
  } catch (err) {
    console.error('[TS6Status] Failed to set permissions:', err.message);
  }

  // Initial update after a short delay (let Discord cache populate)
  setTimeout(() => updateChannel(discordClient), 5000);

  // Poll on interval
  pollTimer = setInterval(() => updateChannel(discordClient), POLL_INTERVAL);
}

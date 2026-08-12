import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '../../data/discordActivity.json');

const SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const PRUNE_DAYS = 14;

let data = { messages: {}, voiceSessions: {}, activeVoice: {}, totals: { messages: {}, voiceMinutes: {} } };
let saveTimer = null;
let dirty = false;
let discordClient = null;

function loadData() {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
      data = {
        messages: raw.messages || {},
        voiceSessions: raw.voiceSessions || {},
        activeVoice: raw.activeVoice || {},
        totals: raw.totals || { messages: {}, voiceMinutes: {} }
      };
      // Ensure sub-objects exist for older data files
      if (!data.totals.messages) data.totals.messages = {};
      if (!data.totals.voiceMinutes) data.totals.voiceMinutes = {};
    }
  } catch (e) {
    console.error('[DiscordTracker] Error loading data:', e.message);
  }
  pruneOldData();
}

function saveData() {
  try {
    const dataDir = dirname(DATA_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    dirty = false;
  } catch (e) {
    console.error('[DiscordTracker] Error saving data:', e.message);
  }
}

function markDirty() {
  dirty = true;
}

function pruneOldData() {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDay = getDayTimestamp(new Date(cutoff));

  // Prune message day buckets
  for (const userId of Object.keys(data.messages)) {
    const counts = data.messages[userId].counts;
    for (const dayKey of Object.keys(counts)) {
      if (Number(dayKey) < cutoffDay) {
        delete counts[dayKey];
      }
    }
    // Remove user entry if no counts remain
    if (Object.keys(counts).length === 0) {
      delete data.messages[userId];
    }
  }

  // Prune voice sessions
  for (const userId of Object.keys(data.voiceSessions)) {
    const entry = data.voiceSessions[userId];
    entry.sessions = (entry.sessions || []).filter(s => s.end >= cutoff);
    // Recalculate totalMinutes from remaining sessions
    entry.totalMinutes = entry.sessions.reduce((sum, s) => sum + (s.end - s.start) / 60000, 0);
    entry.totalMinutes = Math.round(entry.totalMinutes);
    if (entry.sessions.length === 0) {
      delete data.voiceSessions[userId];
    }
  }
}

function getDayTimestamp(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function recordMessage(userId, displayName) {
  if (!data.messages[userId]) {
    data.messages[userId] = { displayName, counts: {} };
  }
  data.messages[userId].displayName = displayName;

  const dayKey = String(getDayTimestamp(new Date()));
  data.messages[userId].counts[dayKey] = (data.messages[userId].counts[dayKey] || 0) + 1;

  // All-time total
  if (!data.totals.messages[userId]) {
    data.totals.messages[userId] = { displayName, count: 0 };
  }
  data.totals.messages[userId].displayName = displayName;
  data.totals.messages[userId].count++;

  markDirty();
}

export function handleVoiceUpdate(oldState, newState) {
  const userId = newState.member?.id || oldState.member?.id;
  if (!userId) return;

  // Ignore bots
  const member = newState.member || oldState.member;
  if (member?.user?.bot) return;

  const displayName = member?.displayName || member?.user?.username || 'Unknown';

  const wasInChannel = !!oldState.channelId;
  const isInChannel = !!newState.channelId;

  // User left voice entirely
  if (wasInChannel && !isInChannel) {
    flushVoiceSession(userId, displayName);
    return;
  }

  // User joined voice
  if (!wasInChannel && isInChannel) {
    data.activeVoice[userId] = Date.now();
    markDirty();
    return;
  }

  // User moved channels — session continues, no action needed
}

function flushVoiceSession(userId, displayName) {
  const joinTime = data.activeVoice[userId];
  if (!joinTime) return;

  delete data.activeVoice[userId];

  const now = Date.now();
  const durationMs = now - joinTime;
  // Ignore very short sessions (< 30 seconds)
  if (durationMs < 30000) {
    markDirty();
    return;
  }

  if (!data.voiceSessions[userId]) {
    data.voiceSessions[userId] = { displayName, totalMinutes: 0, sessions: [] };
  }
  data.voiceSessions[userId].displayName = displayName;
  data.voiceSessions[userId].sessions.push({ start: joinTime, end: now });
  data.voiceSessions[userId].totalMinutes += Math.round(durationMs / 60000);

  // All-time total
  if (!data.totals.voiceMinutes[userId]) {
    data.totals.voiceMinutes[userId] = { displayName, minutes: 0 };
  }
  data.totals.voiceMinutes[userId].displayName = displayName;
  data.totals.voiceMinutes[userId].minutes += Math.round(durationMs / 60000);

  markDirty();
}

export function getDiscordActivity(startMs, endMs) {
  const messageTotals = {};
  for (const [userId, entry] of Object.entries(data.messages)) {
    let count = 0;
    for (const [dayKey, dayCount] of Object.entries(entry.counts)) {
      const dayTs = Number(dayKey);
      // Day bucket overlaps window if dayTs < endMs and dayTs + 86400000 > startMs
      if (dayTs < endMs && dayTs + 86400000 > startMs) {
        count += dayCount;
      }
    }
    if (count > 0) {
      messageTotals[userId] = { name: entry.displayName, count };
    }
  }

  const voiceTotals = {};
  for (const [userId, entry] of Object.entries(data.voiceSessions)) {
    let minutes = 0;
    for (const session of entry.sessions) {
      // Clamp session to window
      const sStart = Math.max(session.start, startMs);
      const sEnd = Math.min(session.end, endMs);
      if (sEnd > sStart) {
        minutes += (sEnd - sStart) / 60000;
      }
    }
    // Also count active sessions
    if (data.activeVoice[userId]) {
      const sStart = Math.max(data.activeVoice[userId], startMs);
      const sEnd = Math.min(Date.now(), endMs);
      if (sEnd > sStart) {
        minutes += (sEnd - sStart) / 60000;
      }
    }
    minutes = Math.round(minutes);
    if (minutes > 0) {
      voiceTotals[userId] = { name: entry.displayName, minutes };
    }
  }

  // Count users currently in voice who have no completed sessions yet
  for (const [userId, joinTime] of Object.entries(data.activeVoice)) {
    if (voiceTotals[userId]) continue; // already counted above
    const sStart = Math.max(joinTime, startMs);
    const sEnd = Math.min(Date.now(), endMs);
    if (sEnd > sStart) {
      const minutes = Math.round((sEnd - sStart) / 60000);
      if (minutes > 0) {
        // Resolve display name from guild if possible
        let name = 'Unknown';
        if (discordClient) {
          const guild = discordClient.guilds.cache.get(process.env.GUILD_ID);
          const member = guild?.members.cache.get(userId);
          if (member) name = member.displayName || member.user.username;
        }
        voiceTotals[userId] = { name, minutes };
      }
    }
  }

  const messages = Object.values(messageTotals).sort((a, b) => b.count - a.count);
  const voice = Object.values(voiceTotals).sort((a, b) => b.minutes - a.minutes);

  return { messages, voice };
}

export function getDiscordTotals() {
  const messages = Object.values(data.totals.messages)
    .sort((a, b) => b.count - a.count);

  // Build voice totals including currently active sessions
  const voiceMap = {};
  for (const [userId, entry] of Object.entries(data.totals.voiceMinutes)) {
    voiceMap[userId] = { displayName: entry.displayName, minutes: entry.minutes };
  }

  // Add ongoing voice time for users currently in a channel
  const now = Date.now();
  for (const [userId, joinTime] of Object.entries(data.activeVoice)) {
    const activeMinutes = Math.round((now - joinTime) / 60000);
    if (activeMinutes <= 0) continue;
    if (voiceMap[userId]) {
      voiceMap[userId].minutes += activeMinutes;
    } else {
      // User in voice for the first time with no completed sessions
      let displayName = 'Unknown';
      if (discordClient) {
        const guild = discordClient.guilds.cache.get(process.env.GUILD_ID);
        const member = guild?.members.cache.get(userId);
        if (member) displayName = member.displayName || member.user.username;
      }
      voiceMap[userId] = { displayName, minutes: activeMinutes };
    }
  }

  const voice = Object.values(voiceMap).sort((a, b) => b.minutes - a.minutes);
  const totalMessages = messages.reduce((sum, m) => sum + m.count, 0);
  const totalVoiceMinutes = voice.reduce((sum, v) => sum + v.minutes, 0);

  return { messages, voice, totalMessages, totalVoiceMinutes };
}

export function initDiscordTracker(client) {
  discordClient = client;
  loadData();

  // Recover active voice sessions from current state
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) {
    for (const [, channel] of guild.channels.cache) {
      if (channel.isVoiceBased() && channel.members) {
        for (const [memberId, member] of channel.members) {
          if (!member.user.bot && !data.activeVoice[memberId]) {
            data.activeVoice[memberId] = Date.now();
          }
        }
      }
    }
  }

  // Listen for messages
  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    if (!message.guild) return; // ignore DMs
    const displayName = message.member?.displayName || message.author.globalName || message.author.username;
    recordMessage(message.author.id, displayName);
  });

  // Listen for voice state updates
  client.on('voiceStateUpdate', (oldState, newState) => {
    handleVoiceUpdate(oldState, newState);
  });

  // Periodic save
  saveTimer = setInterval(() => {
    if (dirty) saveData();
  }, SAVE_INTERVAL_MS);

  console.log('[DiscordTracker] Initialized');
}

export function stopDiscordTracker() {
  // Flush all active voice sessions
  for (const userId of Object.keys(data.activeVoice)) {
    const displayName = data.voiceSessions[userId]?.displayName || 'Unknown';
    flushVoiceSession(userId, displayName);
  }
  saveData();

  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
}

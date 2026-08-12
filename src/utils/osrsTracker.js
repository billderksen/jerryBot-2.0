import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '../../data/osrsTracker.json');

const WOM_BASE = 'https://api.wiseoldman.net/v2';
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const BASE_REQUEST_DELAY_MS = 3100; // 3.1 seconds between requests (20 req/60s limit)

let trackerData = null;
let refreshInterval = null;
let isRefreshing = false;

// --- Data persistence ---

function loadData() {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[OSRS Tracker] Error loading data:', error.message);
  }
  return {
    trackedPlayers: [2338746, 2339388, 2338689, 2498203],
    players: {},
    gains: {},
    lastRefresh: null
  };
}

function saveData() {
  try {
    const dataDir = dirname(DATA_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(DATA_FILE, JSON.stringify(trackerData, null, 2));
  } catch (error) {
    console.error('[OSRS Tracker] Error saving data:', error.message);
  }
}

// --- WOM API ---

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRequestDelay() {
  const playerCount = trackerData.trackedPlayers.length;
  const totalRequests = playerCount * 5; // 1 update POST + 1 detail fallback + 3 gain periods
  if (totalRequests <= 20) return BASE_REQUEST_DELAY_MS;
  // Scale delay to stay under 20 req/60s
  return Math.ceil(60000 / totalRequests) + 100;
}

async function womFetch(path) {
  const url = `${WOM_BASE}${path}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'JerryBot/2.0' }
  });
  if (!response.ok) {
    throw new Error(`WOM API ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

async function womPost(path) {
  const url = `${WOM_BASE}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'JerryBot/2.0' }
  });
  if (!response.ok) {
    throw new Error(`WOM API POST ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

function extractPlayerData(apiResponse) {
  const skills = {};
  const bosses = {};
  const activities = {};
  const snapshot = apiResponse.latestSnapshot;
  if (snapshot?.data?.skills) {
    for (const [name, skill] of Object.entries(snapshot.data.skills)) {
      skills[name] = {
        level: skill.level,
        experience: skill.experience,
        rank: skill.rank,
        ehp: skill.ehp
      };
    }
  }
  if (snapshot?.data?.bosses) {
    for (const [name, boss] of Object.entries(snapshot.data.bosses)) {
      bosses[name] = {
        kills: boss.kills,
        rank: boss.rank,
        ehb: boss.ehb
      };
    }
  }
  if (snapshot?.data?.activities) {
    for (const [name, activity] of Object.entries(snapshot.data.activities)) {
      activities[name] = {
        score: activity.score,
        rank: activity.rank
      };
    }
  }
  return {
    id: apiResponse.id,
    username: apiResponse.username,
    displayName: apiResponse.displayName,
    type: apiResponse.type,
    combatLevel: apiResponse.combatLevel,
    lastChangedAt: apiResponse.lastChangedAt,
    updatedAt: apiResponse.updatedAt,
    exp: apiResponse.exp,
    ehp: apiResponse.ehp,
    ehb: apiResponse.ehb,
    skills,
    bosses,
    activities
  };
}

function extractGainsData(apiResponse) {
  const skills = {};
  const bosses = {};
  const activities = {};
  if (apiResponse.data?.skills) {
    for (const [name, skill] of Object.entries(apiResponse.data.skills)) {
      skills[name] = {
        experience: skill.experience,
        level: skill.level,
        rank: skill.rank
      };
    }
  }
  if (apiResponse.data?.bosses) {
    for (const [name, boss] of Object.entries(apiResponse.data.bosses)) {
      bosses[name] = {
        kills: boss.kills,
        rank: boss.rank,
        ehb: boss.ehb
      };
    }
  }
  if (apiResponse.data?.activities) {
    for (const [name, activity] of Object.entries(apiResponse.data.activities)) {
      activities[name] = {
        score: activity.score,
        rank: activity.rank
      };
    }
  }
  return {
    startsAt: apiResponse.startsAt,
    endsAt: apiResponse.endsAt,
    skills,
    bosses,
    activities
  };
}

// --- Refresh logic ---

async function refreshAllPlayers() {
  if (isRefreshing) return;
  isRefreshing = true;

  const playerIds = trackerData.trackedPlayers;
  const requestDelay = getRequestDelay();

  for (const playerId of playerIds) {
    try {
      // First, get the player's username from cached data or fetch it
      let username = trackerData.players[playerId]?.username;
      if (!username) {
        const playerInfo = await womFetch(`/players/id/${playerId}`);
        username = playerInfo.username;
        await delay(requestDelay);
      }

      // POST to update the player on WOM (pulls fresh stats from OSRS hiscores)
      try {
        const updated = await womPost(`/players/${encodeURIComponent(username)}`);
        trackerData.players[playerId] = extractPlayerData(updated);
      } catch (updateError) {
        // Update may fail due to rate limits (429) or cooldown — fall back to GET
        console.warn(`[OSRS Tracker] Update POST failed for ${username}: ${updateError.message}, falling back to GET`);
        const player = await womFetch(`/players/id/${playerId}`);
        trackerData.players[playerId] = extractPlayerData(player);
      }
      await delay(requestDelay);

      const encodedName = encodeURIComponent(username);
      for (const period of ['day', 'week', 'month']) {
        try {
          const gains = await womFetch(`/players/${encodedName}/gained?period=${period}`);
          if (!trackerData.gains[playerId]) trackerData.gains[playerId] = {};
          trackerData.gains[playerId][period] = extractGainsData(gains);
        } catch (error) {
          console.error(`[OSRS Tracker] Error fetching ${period} gains for ${username}:`, error.message);
        }
        await delay(requestDelay);
      }
    } catch (error) {
      console.error(`[OSRS Tracker] Error refreshing player ${playerId}:`, error.message);
    }
  }

  trackerData.lastRefresh = new Date().toISOString();
  saveData();
  isRefreshing = false;
  console.log(`[OSRS Tracker] Refreshed ${playerIds.length} players at ${trackerData.lastRefresh}`);
}

// --- Inactivity helpers ---

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return 'Just now';
}

// --- Exported API ---

export function initTracker() {
  trackerData = loadData();

  refreshAllPlayers().catch(err => {
    console.error('[OSRS Tracker] Initial refresh failed:', err.message);
  });

  refreshInterval = setInterval(() => {
    refreshAllPlayers().catch(err => {
      console.error('[OSRS Tracker] Auto-refresh failed:', err.message);
    });
  }, REFRESH_INTERVAL_MS);

  console.log('[OSRS Tracker] Initialized with', trackerData.trackedPlayers.length, 'tracked players');
}

export function stopTracker() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

export function getTrackerData() {
  return {
    trackedPlayers: trackerData.trackedPlayers,
    players: trackerData.players,
    gains: trackerData.gains,
    lastRefresh: trackerData.lastRefresh
  };
}

export function getPlayerInactivity() {
  return trackerData.trackedPlayers.map(id => {
    const player = trackerData.players[id];
    if (!player) return { id, displayName: `Unknown (${id})`, lastChangedAt: null, inactiveDuration: null };

    const lastChanged = new Date(player.lastChangedAt);
    const now = new Date();
    const diffMs = now - lastChanged;

    return {
      id,
      displayName: player.displayName,
      lastChangedAt: player.lastChangedAt,
      inactiveDuration: formatDuration(diffMs),
      inactiveMs: diffMs
    };
  }).sort((a, b) => {
    if (!a.lastChangedAt) return 1;
    if (!b.lastChangedAt) return -1;
    return new Date(b.lastChangedAt) - new Date(a.lastChangedAt);
  });
}

export async function addPlayerByUsername(username) {
  if (!username || typeof username !== 'string') return { success: false, error: 'Invalid username' };

  try {
    const player = await womFetch(`/players/${encodeURIComponent(username)}`);
    const id = player.id;

    if (trackerData.trackedPlayers.includes(id)) {
      return { success: false, error: `${player.displayName} is already being tracked` };
    }

    trackerData.trackedPlayers.push(id);
    trackerData.players[id] = extractPlayerData(player);
    saveData();

    // Fetch gains in background
    const encodedUsername = encodeURIComponent(player.username);
    (async () => {
      for (const period of ['day', 'week', 'month']) {
        try {
          await delay(BASE_REQUEST_DELAY_MS);
          const gains = await womFetch(`/players/${encodedUsername}/gained?period=${period}`);
          if (!trackerData.gains[id]) trackerData.gains[id] = {};
          trackerData.gains[id][period] = extractGainsData(gains);
        } catch (e) { /* ignore */ }
      }
      saveData();
    })();

    return { success: true, player: { id, displayName: player.displayName } };
  } catch (error) {
    return { success: false, error: `Player "${username}" not found on WiseOldMan` };
  }
}

export function removePlayerByUsername(username) {
  if (!username || typeof username !== 'string') return { success: false, error: 'Invalid username' };

  const lower = username.toLowerCase();
  const entry = trackerData.trackedPlayers
    .map(id => ({ id, player: trackerData.players[id] }))
    .find(e => e.player?.username?.toLowerCase() === lower || e.player?.displayName?.toLowerCase() === lower);

  if (!entry) return { success: false, error: `Player "${username}" is not being tracked` };

  const { id, player } = entry;
  const displayName = player?.displayName || username;

  const index = trackerData.trackedPlayers.indexOf(id);
  trackerData.trackedPlayers.splice(index, 1);
  delete trackerData.players[id];
  delete trackerData.gains[id];
  saveData();

  return { success: true, displayName };
}

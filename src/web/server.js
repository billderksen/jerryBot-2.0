// Must be the first import: loads .env before any other import's subtree
// evaluates (see src/loadEnv.js for why a same-file top-level statement isn't
// enough — this module and its dependencies, like utils/musicQueue.js, read
// process.env values at their own top level).
import '../loadEnv.js';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ytDlpPkg from 'yt-dlp-exec';
import spotifyUrlInfo from 'spotify-url-info';
import { fetch } from 'undici';
import { getRecentlyPlayed, getListeningStats, getVoiceChannelMembers, getMemberDisplayName, setSleepTimer, cancelSleepTimer, applyMixerFilters, getMusicSettings, getRadioTracks } from '../utils/musicQueue.js';
import { createRoom, getRoom, deleteRoom, getRoomList, getLeaderboard, Player, setActivityLogger as setPictionaryActivityLogger } from '../utils/pictionaryGame.js';
import { createRoom as createHitsterRoom, getRoom as getHitsterRoom, deleteRoom as deleteHitsterRoom, getRoomList as getHitsterRoomList, getLeaderboard as getHitsterLeaderboard } from '../utils/hitsterGame.js';
import { createRoom as createPestenRoom, getRoom as getPestenRoom, deleteRoom as deletePestenRoom, getRoomList as getPestenRoomList, getLeaderboard as getPestenLeaderboard } from '../utils/pestenGame.js';
import { getTrackerData, getPlayerInactivity, addPlayerByUsername, removePlayerByUsername } from '../utils/osrsTracker.js';
import { createPlaylist, deletePlaylist, renamePlaylist, addSong, removeSong, reorderSong, reorderPlaylist, getPlaylists, getPlaylist } from '../utils/playlists.js';
import { getTrackerData as getTwitchTrackerData, addStreamer as addTwitchStreamer, removeStreamer as removeTwitchStreamer, subscribeUser as twitchSubscribeUser, unsubscribeUser as twitchUnsubscribeUser, setNotificationChannel as setTwitchNotificationChannel } from '../utils/twitchTracker.js';
import { getLatestRecap, getRecaps, getRecap, generateCurrentRecap, getRecapSettings, setRecapChannel, setRecapSchedule } from '../utils/weeklyRecap.js';
import { getBirthdays, getBirthdayChannel, setBirthdayChannel } from '../utils/birthdayTracker.js';
import { getLogChannelId, setLogChannelId } from '../utils/activityLogger.js';
import { getChatConfig, setChatModel, setChatSystemPrompt, setChatMaxTokens } from '../utils/openrouter.js';
import { getLeaderboard as getTriviaLeaderboard } from '../utils/triviaGame.js';
import { getDrivers, getRaces, submitPrediction, getPredictions, getUserPrediction, fetchAndScoreResults, getStandings, getRaceResults, isRaceLocked } from '../utils/f1Predictions.js';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import { platform } from 'os';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { randomBytes } from 'node:crypto';
import { isAllowedMediaUrl, sanitizeSearchQuery } from '../utils/urlValidation.js';

// Detect system yt-dlp for Linux
let ytDlpExec = ytDlpPkg;
const isLinux = platform() === 'linux';

if (isLinux) {
  // Try to find system yt-dlp
  let systemYtDlpPath = null;
  const possiblePaths = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp'];
  
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      systemYtDlpPath = p;
      break;
    }
  }
  
  if (!systemYtDlpPath) {
    try {
      systemYtDlpPath = execSync('which yt-dlp', { encoding: 'utf8' }).trim();
    } catch (e) {
      // yt-dlp not found in PATH
    }
  }
  
  if (systemYtDlpPath) {
    console.log(`[server.js] Using system yt-dlp: ${systemYtDlpPath}`);
    ytDlpExec = ytDlpPkg.create(systemYtDlpPath);
  } else {
    console.warn('[server.js] System yt-dlp not found, using bundled (may not work on Linux)');
  }
}

// YouTube cookies for authenticated access (improves radio variety, age-gated content, etc.)
// YOUTUBE_COOKIES_BROWSER=firefox  → extracts cookies from browser at runtime (simplest)
// YOUTUBE_COOKIES=path/to/file.txt → uses a Netscape-format cookies file
const ytCookieOpts = process.env.YOUTUBE_COOKIES_BROWSER
  ? { cookiesFromBrowser: process.env.YOUTUBE_COOKIES_BROWSER }
  : process.env.YOUTUBE_COOKIES && existsSync(process.env.YOUTUBE_COOKIES)
    ? { cookies: process.env.YOUTUBE_COOKIES }
    : {};

const { getData, getPreview, getTracks } = spotifyUrlInfo(fetch);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper function to get highest quality YouTube thumbnail
// Note: maxresdefault.jpg (1280x720) is not always available and returns a gray placeholder
// hqdefault.jpg (480x360) is reliably available for all videos
function getHighQualityThumbnail(video) {
  // FIRST: Try to construct hqdefault URL from video ID (reliably available)
  const videoId = video.id || extractVideoId(video.url) || extractVideoId(video.webpage_url);
  if (videoId) {
    return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  }

  // SECOND: Upgrade existing thumbnail URL to hqdefault quality
  if (video.thumbnail) {
    return video.thumbnail
      .replace(/\/default\.jpg/, '/hqdefault.jpg')
      .replace(/\/mqdefault\.jpg/, '/hqdefault.jpg')
      .replace(/\/sddefault\.jpg/, '/hqdefault.jpg')
      .replace(/\/maxresdefault\.jpg/, '/hqdefault.jpg')
      .replace(/\?.*$/, '');
  }

  // THIRD: If thumbnails array exists, find the highest resolution one
  if (video.thumbnails && Array.isArray(video.thumbnails) && video.thumbnails.length > 0) {
    const sorted = [...video.thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
    if (sorted[0]?.url) {
      return sorted[0].url;
    }
  }

  return null;
}

// Helper to extract video ID from YouTube URL
function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/|\/vi\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// OAuth2 Configuration - use getters to read at runtime after dotenv loads
const getClientId = () => process.env.CLIENT_ID;
const getClientSecret = () => process.env.CLIENT_SECRET;
const getRedirectUri = () => process.env.OAUTH_REDIRECT_URI || 'http://localhost:3001/auth/discord/callback';
const getRequiredRoleId = () => process.env.REQUIRED_ROLE_ID || '1462395138776236134';
const getRequiredGuildId = () => process.env.GUILD_ID || '918554414220972032';
const DJ_ROLE_ID = process.env.DJ_ROLE_ID || '1467139293586653339'; // "Website DJ Extraordinaire"
const CONTROL_PANEL_ROLE_ID = '1470048168543653919'; // "Control Panel"

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 1_048_576 });

// Session middleware with file-based store for persistence across restarts
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET missing or shorter than 32 chars — set it in .env (e.g. `openssl rand -hex 32`)');
}
import FileStoreFactory from 'session-file-store';
const FileStore = FileStoreFactory(session);
const sessionStore = new FileStore({
  path: join(__dirname, '../../data/sessions'), // Store sessions in data/sessions folder
  ttl: 7 * 24 * 60 * 60, // 7 days in seconds
  retries: 0, // Don't retry on missing files (expected for expired/invalid sessions)
  reapInterval: 3600, // Clean up expired sessions every hour
  logFn: () => {} // Suppress session-file-store logging
});

const cookieSecure = process.env.OAUTH_REDIRECT_URI?.startsWith('https') || false;
if (cookieSecure) {
  app.set('trust proxy', 1);
}

const sessionMiddleware = session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});

app.use(cookieParser());
app.use(sessionMiddleware);

// Baseline security headers on every response
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Tiny in-memory sliding-window rate limiter, keyed per user (or IP if logged out)
const rateBuckets = new Map(); // key -> [timestamps]
function rateLimit(name, maxHits, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.session?.user?.id || req.ip}`;
    const now = Date.now();
    const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= maxHits) return res.status(429).json({ error: 'Rate limit exceeded' });
    hits.push(now);
    rateBuckets.set(key, hits);
    next();
  };
}

// Store connected clients
const clients = new Set();

// Store pictionary room clients (roomId -> Set of ws)
const pictionaryClients = new Map();

// Store hitster room clients (roomId -> Set of ws)
const hitsterClients = new Map();

// Store pesten room clients (roomId -> Set of ws)
const pestenClients = new Map();

// Store current state
let currentState = {
  currentSong: null,
  queue: [],
  isPlaying: false,
  isPaused: false,
  volume: 1.0,
  guildName: ''
};

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.hasAccess) {
    return next();
  }
  // For API routes, return JSON error. Must check originalUrl, not path: when this runs
  // via app.use('/api', requireAuth), req.path is mount-relative (the '/api' prefix is
  // stripped), so it never starts with '/api/' - originalUrl keeps the full request path.
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // For page routes, redirect to login
  res.redirect('/login');
}

// Discord OAuth2 routes
app.get('/login', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'login.html'));
});

app.get('/auth/discord', (req, res) => {
  const scope = 'identify guilds.members.read';
  req.session.oauthState = randomBytes(16).toString('hex');
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${getClientId()}&redirect_uri=${encodeURIComponent(getRedirectUri())}&response_type=code&scope=${encodeURIComponent(scope)}&state=${req.session.oauthState}`;
  res.redirect(authUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/login?error=no_code');
  }

  // Validate OAuth state to prevent CSRF (Express 5 may hand back arrays for repeated query keys)
  const receivedState = req.query.state;
  const expectedState = req.session.oauthState;
  delete req.session.oauthState;
  if (typeof receivedState !== 'string' || typeof expectedState !== 'string' || receivedState !== expectedState) {
    return res.status(403).send('OAuth state mismatch');
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: getClientId(),
        client_secret: getClientSecret(),
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: getRedirectUri()
      })
    });

    const tokenData = await tokenResponse.json();
    
    if (tokenData.error) {
      console.error('OAuth token error:', tokenData);
      return res.redirect('/login?error=token_error');
    }

    const accessToken = tokenData.access_token;

    // Get user info
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const userData = await userResponse.json();

    // Get user's guild member info to check roles
    const memberResponse = await fetch(`https://discord.com/api/users/@me/guilds/${getRequiredGuildId()}/member`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    let hasAccess = false;
    let hasDJRole = false;
    let hasControlPanel = false;
    let serverNickname = null;

    if (memberResponse.ok) {
      const memberData = await memberResponse.json();
      // Check if user has the required role
      hasAccess = memberData.roles && memberData.roles.includes(getRequiredRoleId());
      hasDJRole = memberData.roles && memberData.roles.includes(DJ_ROLE_ID);
      hasControlPanel = memberData.roles && memberData.roles.includes(CONTROL_PANEL_ROLE_ID);
      // Get server nickname if set
      serverNickname = memberData.nick;
    }

    // Display name priority: server nickname > global display name > username
    const displayName = serverNickname || userData.global_name || userData.username;

    // Build user data, then regenerate the session before storing it so the
    // pre-login (pre-auth) session ID is discarded and can't be fixated.
    const sessionUser = {
      id: userData.id,
      username: userData.username,
      displayName: displayName,
      discriminator: userData.discriminator,
      avatar: userData.avatar,
      hasAccess: hasAccess,
      hasDJRole: hasDJRole,
      hasControlPanel: hasControlPanel
    };

    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) {
        console.error('Session regenerate error:', regenerateErr);
        return res.redirect('/login?error=session_error');
      }

      req.session.user = sessionUser;
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.redirect('/login?error=session_error');
        }
        if (hasAccess) {
          res.redirect('/');
        } else {
          res.redirect('/access-denied');
        }
      });
    });

  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect('/login?error=oauth_error');
  }
});

// Store bot info for login page
let botInfo = null;

export function setBotInfo(info) {
  botInfo = info;
}

// API endpoint for bot info (public)
app.get('/api/bot-info', (req, res) => {
  if (botInfo) {
    res.json(botInfo);
  } else {
    res.status(503).json({ error: 'Bot not ready' });
  }
});

// Activity logger (will be set by index.js)
let activityLogger = null;

export function setActivityLogger(logger) {
  activityLogger = logger;
}

// Member fetcher (will be set by index.js) - used to get fresh nicknames
let memberFetcher = null;

export function setMemberFetcher(fetcher) {
  memberFetcher = fetcher;
}

// Discord client reference (set by index.js for channel listing)
let discordClientRef = null;

export function setDiscordClient(client) {
  discordClientRef = client;
}

app.get('/access-denied', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'access-denied.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// API to get current user (no auth required - used on access-denied page)
app.get('/api/me', async (req, res) => {
  if (req.session && req.session.user) {
    const user = { ...req.session.user };

    // Try to get fresh nickname and roles from Discord bot
    if (memberFetcher && user.id) {
      try {
        const memberData = await memberFetcher(user.id);
        if (memberData) {
          user.displayName = memberData.nickname || memberData.globalName || user.username;
          user.hasDJRole = memberData.roles && memberData.roles.includes(DJ_ROLE_ID);
          user.hasControlPanel = memberData.roles && memberData.roles.includes(CONTROL_PANEL_ROLE_ID);
          req.session.user.displayName = user.displayName;
          req.session.user.hasDJRole = user.hasDJRole;
          req.session.user.hasControlPanel = user.hasControlPanel;
        }
      } catch (error) {
        console.error('Error fetching member data:', error);
      }
    }

    res.json(user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// No-cache for HTML pages (prevent stale browser cache)
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api') && !req.path.startsWith('/images')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// Protect the main dashboard
app.get('/', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Protect all API routes EXCEPT /api/me (which is above this middleware)
app.use('/api', requireAuth);

app.use(express.json());

// Serve images folder
app.use('/images', express.static(join(__dirname, '../images')));

// Serve static JS files from public directory
app.get('/watch-together.js', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'watch-together.js'));
});

// Serve shared frontend scripts (e.g. common.js)
app.use('/js', express.static(join(__dirname, 'public', 'js')));

// API endpoint to get current state
app.get('/api/state', (req, res) => {
  res.json(currentState);
});

// API endpoint to get listening stats
app.get('/api/stats', (req, res) => {
  const stats = getListeningStats();
  
  // Process stats for the frontend
  const topUsers = Object.entries(stats.users || {})
    .map(([id, data]) => ({
      id,
      displayName: data.displayName || id,
      ...data
    }))
    .sort((a, b) => b.totalListeningTime - a.totalListeningTime)
    .slice(0, 20);
  
  const topSongs = Object.entries(stats.songs || {})
    .map(([key, data]) => ({
      key,
      ...data
    }))
    .sort((a, b) => (b.totalListeningTime || 0) - (a.totalListeningTime || 0))
    .slice(0, 50);
  
  res.json({
    topUsers,
    topSongs,
    totalSongsPlayed: stats.totalSongsPlayed || 0,
    totalListeningTime: stats.totalListeningTime || 0,
    uniqueUsers: Object.keys(stats.users || {}).length,
    uniqueSongs: Object.keys(stats.songs || {}).length
  });
});

// Serve stats page
app.get('/stats', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'stats.html'));
});

// Serve Pictionary game page
app.get('/pictionary', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'pictionary.html'));
});

// Pictionary API endpoints
app.get('/api/pictionary/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

app.get('/api/pictionary/rooms', (req, res) => {
  res.json(getRoomList());
});

// Serve Hitster game page
app.get('/hitster', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'hitster.html'));
});

// Hitster API endpoints
app.get('/api/hitster/leaderboard', (req, res) => {
  res.json(getHitsterLeaderboard());
});

app.get('/api/hitster/rooms', (req, res) => {
  res.json(getHitsterRoomList());
});

// Serve Pesten game page
app.get('/pesten', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'pesten.html'));
});

// Pesten API endpoints
app.get('/api/pesten/leaderboard', (req, res) => {
  res.json(getPestenLeaderboard());
});

app.get('/api/pesten/rooms', (req, res) => {
  res.json(getPestenRoomList());
});

// Serve OSRS Tracker page
app.get('/osrs', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'osrs.html'));
});

// OSRS Tracker API endpoints
app.get('/api/osrs/players', (req, res) => {
  res.json(getTrackerData());
});

app.get('/api/osrs/inactivity', (req, res) => {
  res.json(getPlayerInactivity());
});

// Serve Twitch Alerts page
app.get('/twitch', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'twitch.html'));
});

// Serve Weekly Recap page
app.get('/recap', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'recap.html'));
});

// Twitch Tracker API endpoints
app.get('/api/twitch/streamers', (req, res) => {
  res.json(getTwitchTrackerData());
});

app.post('/api/twitch/streamers/add', async (req, res) => {
  // DJ role check
  let hasDJ = req.session?.user?.hasDJRole;
  if (memberFetcher && req.session?.user?.id) {
    try {
      const memberData = await memberFetcher(req.session.user.id);
      hasDJ = memberData?.roles?.includes(DJ_ROLE_ID) || false;
    } catch (e) {
      return res.status(403).json({ error: 'DJ role required' });
    }
  }
  if (!hasDJ) {
    return res.status(403).json({ error: 'DJ role required' });
  }
  const { username } = req.body;
  const result = await addTwitchStreamer(username, req.session?.user?.id);
  res.json(result);
});

app.post('/api/twitch/streamers/remove', async (req, res) => {
  let hasDJ = req.session?.user?.hasDJRole;
  if (memberFetcher && req.session?.user?.id) {
    try {
      const memberData = await memberFetcher(req.session.user.id);
      hasDJ = memberData?.roles?.includes(DJ_ROLE_ID) || false;
    } catch (e) {
      return res.status(403).json({ error: 'DJ role required' });
    }
  }
  if (!hasDJ) {
    return res.status(403).json({ error: 'DJ role required' });
  }
  const { username } = req.body;
  const result = removeTwitchStreamer(username);
  res.json(result);
});

app.post('/api/twitch/streamers/subscribe', (req, res) => {
  const { username } = req.body;
  const userId = req.session?.user?.id;
  const result = twitchSubscribeUser(username, userId);
  res.json(result);
});

app.post('/api/twitch/streamers/unsubscribe', (req, res) => {
  const { username } = req.body;
  const userId = req.session?.user?.id;
  const result = twitchUnsubscribeUser(username, userId);
  res.json(result);
});

app.post('/api/twitch/channel', async (req, res) => {
  let hasDJ = req.session?.user?.hasDJRole;
  if (memberFetcher && req.session?.user?.id) {
    try {
      const memberData = await memberFetcher(req.session.user.id);
      hasDJ = memberData?.roles?.includes(DJ_ROLE_ID) || false;
    } catch (e) {
      return res.status(403).json({ error: 'DJ role required' });
    }
  }
  if (!hasDJ) {
    return res.status(403).json({ error: 'DJ role required' });
  }
  const { channelId } = req.body;
  const result = setTwitchNotificationChannel(channelId);
  res.json(result);
});

// API to get text channels for the channel selector (filtered by user permissions)
app.get('/api/twitch/channels', async (req, res) => {
  const guildId = getRequiredGuildId();
  if (!discordClientRef) {
    return res.json([]);
  }
  const guild = discordClientRef.guilds.cache.get(guildId);
  if (!guild) {
    return res.json([]);
  }
  const userId = req.session?.user?.id;
  let member = null;
  if (userId) {
    try {
      member = await guild.members.fetch(userId);
    } catch (e) { /* user not in guild */ }
  }
  const textChannels = guild.channels.cache
    .filter(ch => ch.type === 0 && (!member || ch.permissionsFor(member).has('ViewChannel')))
    .map(ch => ({ id: ch.id, name: ch.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(textChannels);
});

// Birthday calendar API
app.get('/api/birthdays', (req, res) => {
  res.json(getBirthdays());
});

// General channels endpoint (reuses twitch/channels logic)
app.get('/api/channels', async (req, res) => {
  const guildId = getRequiredGuildId();
  if (!discordClientRef) return res.json([]);
  const guild = discordClientRef.guilds.cache.get(guildId);
  if (!guild) return res.json([]);
  const userId = req.session?.user?.id;
  let member = null;
  if (userId) {
    try { member = await guild.members.fetch(userId); } catch (e) {}
  }
  const textChannels = guild.channels.cache
    .filter(ch => ch.type === 0 && (!member || ch.permissionsFor(member).has('ViewChannel')))
    .map(ch => ({ id: ch.id, name: ch.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(textChannels);
});

// Admin settings API
app.get('/api/admin/settings', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });

  const guildId = getRequiredGuildId();
  const recapSettings = getRecapSettings();
  const twitchData = getTwitchTrackerData();
  const chatConfig = getChatConfig();
  const musicSettings = getMusicSettings();
  const osrsData = getTrackerData();
  const osrsPlayers = osrsData && osrsData.players ? Object.values(osrsData.players).map(p => ({ id: p.id, displayName: p.displayName, username: p.username })) : [];

  // Server overview
  let serverInfo = null;
  if (discordClientRef) {
    const guild = discordClientRef.guilds.cache.get(guildId);
    if (guild) {
      serverInfo = {
        name: guild.name,
        memberCount: guild.memberCount,
        onlineCount: guild.members.cache.filter(m => m.presence?.status && m.presence.status !== 'offline').size,
        channelCount: guild.channels.cache.size,
        roleCount: guild.roles.cache.size,
        boostLevel: guild.premiumTier,
        boostCount: guild.premiumSubscriptionCount
      };
    }
  }

  res.json({
    birthday: { channelId: getBirthdayChannel(guildId) },
    recap: {
      channelId: recapSettings.channelId,
      scheduleDay: recapSettings.scheduleDay,
      scheduleHour: recapSettings.scheduleHour,
      scheduleDayName: recapSettings.scheduleDayName
    },
    twitch: { channelId: twitchData.notificationChannelId },
    activityLog: { channelId: getLogChannelId() },
    chat: chatConfig,
    music: musicSettings,
    osrs: { players: osrsPlayers },
    server: serverInfo
  });
});

app.post('/api/admin/birthday/channel', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { channelId } = req.body;
  const guildId = getRequiredGuildId();
  setBirthdayChannel(guildId, channelId);
  res.json({ success: true });
});

app.post('/api/admin/recap/channel', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { channelId } = req.body;
  const result = setRecapChannel(channelId);
  res.json(result);
});

app.post('/api/admin/recap/schedule', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { day, hour } = req.body;
  const result = setRecapSchedule(day, hour);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/admin/activitylog/channel', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { channelId } = req.body;
  setLogChannelId(channelId);
  res.json({ success: true });
});

app.post('/api/admin/chat/model', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'Model is required' });
  setChatModel(model);
  res.json({ success: true });
});

app.post('/api/admin/chat/systemprompt', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
  setChatSystemPrompt(prompt);
  res.json({ success: true });
});

app.post('/api/admin/chat/maxtokens', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { tokens } = req.body;
  const num = parseInt(tokens);
  if (isNaN(num) || num < 1 || num > 4096) return res.status(400).json({ error: 'Tokens must be between 1 and 4096' });
  setChatMaxTokens(num);
  res.json({ success: true });
});

app.post('/api/admin/osrs/add', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const result = await addPlayerByUsername(username);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/admin/osrs/remove', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const result = removePlayerByUsername(username);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// Weekly Recap API endpoints
app.get('/api/recap/latest', (req, res) => {
  const recap = getLatestRecap();
  if (!recap) return res.status(404).json({ error: 'No recaps yet' });
  res.json(recap);
});

app.get('/api/recap/list', (req, res) => {
  res.json(getRecaps());
});

app.post('/api/recap/generate', rateLimit('recap', 2, 60_000), (req, res) => {
  const recap = generateCurrentRecap();
  res.json(recap);
});

app.get('/api/recap/:id', (req, res) => {
  const recap = getRecap(req.params.id);
  if (!recap) return res.status(404).json({ error: 'Recap not found' });
  res.json(recap);
});

// Serve playlists page
app.get('/playlists', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'playlists.html'));
});

// Serve birthdays calendar page
app.get('/birthdays', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'birthdays.html'));
});

// Serve trivia leaderboard page
app.get('/trivia', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'trivia.html'));
});

// Trivia leaderboard API
app.get('/api/trivia/leaderboard', (req, res) => {
  res.json(getTriviaLeaderboard());
});

// Serve F1 Predictions page
app.get('/f1', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'f1.html'));
});

// F1 Predictions API endpoints
app.get('/api/f1/drivers', (req, res) => {
  res.json(getDrivers());
});

app.get('/api/f1/races', (req, res) => {
  res.json(getRaces(req.session.user.id));
});

app.get('/api/f1/standings', (req, res) => {
  res.json(getStandings());
});

app.get('/api/f1/predictions/:round', (req, res) => {
  res.json(getPredictions(req.params.round));
});

app.get('/api/f1/results/:round', (req, res) => {
  const results = getRaceResults(req.params.round);
  if (!results) return res.status(404).json({ error: 'No results for this race yet' });
  res.json(results);
});

app.post('/api/f1/predict', (req, res) => {
  const { round, p1, p2, p3, fastestLap } = req.body;
  if (!round || !p1 || !p2 || !p3 || !fastestLap) {
    return res.status(400).json({ error: 'Missing required fields: round, p1, p2, p3, fastestLap' });
  }
  if (isRaceLocked(round)) {
    return res.status(400).json({ error: 'Predictions are closed for this race' });
  }
  const userId = req.session.user.id;
  const displayName = req.session.user.displayName || req.session.user.globalName || req.session.user.username;
  const avatarHash = req.session.user.avatar;
  const result = submitPrediction(userId, displayName, avatarHash, round, { p1, p2, p3, fastestLap });
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/f1/fetchresults/:round', async (req, res) => {
  let hasCP = req.session?.user?.hasControlPanel;
  if (memberFetcher && req.session?.user?.id) {
    try { const memberData = await memberFetcher(req.session.user.id); hasCP = memberData?.roles?.includes(CONTROL_PANEL_ROLE_ID) || false; } catch (e) { return res.status(403).json({ error: 'Control Panel role required' }); }
  }
  if (!hasCP) return res.status(403).json({ error: 'Control Panel role required' });
  try {
    const results = await fetchAndScoreResults(req.params.round);
    broadcast('f1_results', { round: req.params.round, results });
    res.json({ success: true, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Serve admin control panel page
app.get('/admin', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin.html'));
});

// Playlist API endpoints
app.get('/api/playlists', (req, res) => {
  const userId = req.session.user.id;
  res.json(getPlaylists(userId));
});

app.get('/api/playlists/:id', (req, res) => {
  const userId = req.session.user.id;
  const playlist = getPlaylist(userId, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json(playlist);
});

app.post('/api/playlists', (req, res) => {
  const userId = req.session.user.id;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const createdBy = req.session.user.globalName || req.session.user.username || 'Unknown';
  const result = createPlaylist(userId, name.trim(), createdBy);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.put('/api/playlists/reorder', (req, res) => {
  const userId = req.session.user.id;
  const { from, to } = req.body;
  if (from === undefined || to === undefined) return res.status(400).json({ error: 'from and to are required' });
  const result = reorderPlaylist(userId, from, to);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.put('/api/playlists/:id', (req, res) => {
  const userId = req.session.user.id;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const result = renamePlaylist(userId, req.params.id, name.trim());
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.delete('/api/playlists/:id', (req, res) => {
  const userId = req.session.user.id;
  const result = deletePlaylist(userId, req.params.id);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.post('/api/playlists/:id/songs', (req, res) => {
  const userId = req.session.user.id;
  const { url, title, thumbnail, duration } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  const result = addSong(userId, req.params.id, { url, title: title || url, thumbnail, duration: duration || 0 });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.delete('/api/playlists/:id/songs/:index', (req, res) => {
  const userId = req.session.user.id;
  const index = parseInt(req.params.index);
  if (isNaN(index)) return res.status(400).json({ error: 'Invalid index' });
  const result = removeSong(userId, req.params.id, index);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.put('/api/playlists/:id/songs/reorder', (req, res) => {
  const userId = req.session.user.id;
  const { from, to } = req.body;
  if (from === undefined || to === undefined) return res.status(400).json({ error: 'from and to are required' });
  const result = reorderSong(userId, req.params.id, from, to);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

app.post('/api/playlists/:id/play', async (req, res) => {
  const userId = req.session.user.id;
  const playlist = getPlaylist(userId, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  if (playlist.songs.length === 0) return res.status(400).json({ error: 'Playlist is empty' });

  const username = req.session.user.username || 'Web Dashboard';
  const requestedById = req.session.user.id;

  for (const song of playlist.songs) {
    if (addSongHandler) {
      await addSongHandler({
        url: song.url,
        title: song.title,
        duration: song.duration,
        thumbnail: song.thumbnail,
        requestedBy: username,
        requestedById,
        source: 'youtube'
      }, currentState.guildId);
    }
  }

  if (activityLogger && activityLogger.logWebAction) {
    activityLogger.logWebAction(username, 'play', `playlist: ${playlist.name} (${playlist.songs.length} songs)`);
  }

  res.json({ success: true, queued: playlist.songs.length });
});

app.post('/api/playlists/:id/shuffle', async (req, res) => {
  const userId = req.session.user.id;
  const playlist = getPlaylist(userId, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  if (playlist.songs.length === 0) return res.status(400).json({ error: 'Playlist is empty' });

  const username = req.session.user.username || 'Web Dashboard';
  const requestedById = req.session.user.id;

  // Fisher-Yates shuffle
  const songs = [...playlist.songs];
  for (let i = songs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [songs[i], songs[j]] = [songs[j], songs[i]];
  }

  for (const song of songs) {
    if (addSongHandler) {
      await addSongHandler({
        url: song.url,
        title: song.title,
        duration: song.duration,
        thumbnail: song.thumbnail,
        requestedBy: username,
        requestedById,
        source: 'youtube'
      }, currentState.guildId);
    }
  }

  if (activityLogger && activityLogger.logWebAction) {
    activityLogger.logWebAction(username, 'shuffle-play', `playlist: ${playlist.name} (${songs.length} songs)`);
  }

  res.json({ success: true, queued: songs.length });
});

// API endpoint to search for songs
app.get('/api/search', rateLimit('search', 15, 60_000), async (req, res) => {
  const query = req.query.q;
  const count = Math.max(1, Math.min(parseInt(req.query.count) || 10, 50)); // Default 10, max 50
  if (!query || query.length < 2) {
    return res.json([]);
  }
  
  try {
    // Check if query is a direct YouTube video URL
    const ytVideoMatch = query.match(/^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);

    if (ytVideoMatch && isAllowedMediaUrl(query)) {
      // Fetch video info directly instead of searching
      const videoInfo = await ytDlpExec(query, {
        ...ytCookieOpts,
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        skipDownload: true
      });
      return res.json([{
        title: videoInfo.title || 'Unknown Title',
        url: videoInfo.webpage_url || query,
        duration: videoInfo.duration || 0,
        thumbnail: getHighQualityThumbnail(videoInfo),
        channel: videoInfo.channel || videoInfo.uploader || 'Unknown'
      }]);
    }

    // Use yt-dlp for searching (more reliable than play-dl)
    const results = await ytDlpExec(`ytsearch${count}:${sanitizeSearchQuery(query)}`, {
      ...ytCookieOpts,
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      flatPlaylist: true,
      skipDownload: true
    });

    const entries = results.entries || [];
    const songs = entries.map(video => ({
      title: video.title || 'Unknown Title',
      url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
      duration: video.duration || 0,
      thumbnail: getHighQualityThumbnail(video),
      channel: video.channel || video.uploader || 'Unknown'
    }));
    res.json(songs);
  } catch (error) {
    console.error('Search error:', error);
    res.json([]);
  }
});

// API endpoint to get Spotify track info
app.get('/api/spotify/track', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  try {
    const data = await getData(url);
    
    if (data.type === 'track') {
      // Single track
      const track = {
        title: `${data.artists?.[0]?.name || 'Unknown'} - ${data.name}`,
        artist: data.artists?.map(a => a.name).join(', ') || 'Unknown',
        duration: Math.floor((data.duration_ms || 0) / 1000),
        thumbnail: data.album?.images?.[0]?.url || data.coverArt?.sources?.[0]?.url || null,
        spotifyUrl: url,
        searchQuery: `${data.artists?.[0]?.name || ''} ${data.name}`.trim()
      };
      res.json({ type: 'track', tracks: [track] });
    } else if (data.type === 'playlist' || data.type === 'album') {
      // Playlist or album - use getTracks for better track data
      let tracks = [];
      let totalFromSource = 0;
      try {
        const trackList = await getTracks(url);
        totalFromSource = trackList.length;
        tracks = trackList.slice(0, 100).map(track => ({
          title: `${track.artists?.[0]?.name || track.artist || 'Unknown'} - ${track.name}`,
          artist: track.artists?.map(a => a.name).join(', ') || track.artist || 'Unknown',
          duration: Math.floor((track.duration_ms || 0) / 1000),
          thumbnail: track.album?.images?.[0]?.url || data.images?.[0]?.url || null,
          spotifyUrl: track.external_urls?.spotify || url,
          searchQuery: `${track.artists?.[0]?.name || track.artist || ''} ${track.name}`.trim()
        }));
      } catch (e) {
        // Fallback to data.trackList if getTracks fails
        const trackList = data.trackList || data.tracks?.items || [];
        totalFromSource = trackList.length;
        tracks = trackList.slice(0, 100).map(item => {
          const track = item.track || item;
          return {
            title: `${track.artists?.[0]?.name || track.subtitle || 'Unknown'} - ${track.name || track.title}`,
            artist: track.artists?.map(a => a.name).join(', ') || track.subtitle || 'Unknown',
            duration: Math.floor((track.duration_ms || track.duration || 0) / 1000),
            thumbnail: track.album?.images?.[0]?.url || data.coverArt?.sources?.[0]?.url || null,
            spotifyUrl: track.external_urls?.spotify || url,
            searchQuery: `${track.artists?.[0]?.name || track.subtitle || ''} ${track.name || track.title}`.trim()
          };
        });
      }
      // Report the playlist's real total from metadata if available
      const playlistTotal = data.trackCount || data.tracks?.total || totalFromSource;
      res.json({
        type: data.type,
        name: data.name,
        tracks,
        total: playlistTotal
      });
    } else {
      res.status(400).json({ error: 'Unsupported Spotify link type' });
    }
  } catch (error) {
    console.error('Spotify error:', error);
    res.status(500).json({ error: 'Failed to get Spotify data' });
  }
});

// API endpoint to search YouTube for a song (used for Spotify -> YouTube conversion)
app.get('/api/youtube/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }
  
  try {
    // Add "official audio" to search for better matching on Spotify conversions
    const searchQuery = `${sanitizeSearchQuery(query)} official audio`;
    const results = await ytDlpExec(`ytsearch3:${searchQuery}`, {
      ...ytCookieOpts,
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      flatPlaylist: true,
      skipDownload: true
    });
    
    const entries = results.entries || [];
    if (entries.length > 0) {
      // Prefer videos with "official" or "audio" in title, avoid "live", "cover", "remix"
      const scored = entries.map(v => {
        let score = 0;
        const title = (v.title || '').toLowerCase();
        if (title.includes('official')) score += 3;
        if (title.includes('audio')) score += 2;
        if (title.includes('lyrics')) score += 1;
        if (title.includes('live')) score -= 3;
        if (title.includes('cover')) score -= 3;
        if (title.includes('remix')) score -= 2;
        if (title.includes('karaoke')) score -= 4;
        if (title.includes('instrumental')) score -= 2;
        return { ...v, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const video = scored[0];
      res.json({
        title: video.title || 'Unknown Title',
        url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration || 0,
        thumbnail: getHighQualityThumbnail(video)
      });
    } else {
      res.status(404).json({ error: 'No results found' });
    }
  } catch (error) {
    console.error('YouTube search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// API endpoint to get YouTube playlist info
app.get('/api/youtube/playlist', rateLimit('ytplaylist', 3, 60_000), async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({ error: 'Invalid or unsupported URL' });
  }

  try {
    const results = await ytDlpExec(url, {
      ...ytCookieOpts,
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      flatPlaylist: true,
      skipDownload: true
    });

    // Check if it's a playlist
    if (!results.entries || results.entries.length === 0) {
      return res.status(400).json({ error: 'Not a valid playlist or playlist is empty' });
    }
    
    const tracks = results.entries
      .filter(video => {
        const title = (video.title || '').toLowerCase();
        return title !== '[deleted video]' && title !== '[private video]'
          && title !== 'deleted video' && title !== 'private video'
          && !video.is_unavailable;
      })
      .map(video => ({
        title: video.title || 'Unknown Title',
        url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration || 0,
        thumbnail: getHighQualityThumbnail(video),
        channel: video.channel || video.uploader || 'Unknown'
      }));
    
    res.json({
      type: 'playlist',
      name: results.title || 'YouTube Playlist',
      tracks,
      total: results.playlist_count || tracks.length
    });
  } catch (error) {
    console.error('YouTube playlist error:', error);
    res.status(500).json({ error: 'Failed to get playlist data' });
  }
});

// API endpoint to get YouTube radio/mix (similar songs)
app.get('/api/youtube/radio', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Video URL is required' });
  }

  // Delegates to musicQueue.js's helper - the same lookup server-side radio
  // auto-fill uses when playNext() runs with no dashboard connected.
  const tracks = await getRadioTracks(videoUrl);
  if (tracks.length === 0) {
    return res.status(404).json({ error: 'No radio mix found for this video' });
  }
  res.json({ tracks });
});

// API endpoint to get lyrics for a song
app.get('/api/lyrics', async (req, res) => {
  const { title, artist } = req.query;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    // Clean up title - remove common suffixes like (Official Video), [Lyrics], etc.
    let cleanTitle = title
      .replace(/\(official\s*(music\s*)?video\)/gi, '')
      .replace(/\(lyric\s*video\)/gi, '')
      .replace(/\(audio\)/gi, '')
      .replace(/\[.*?\]/g, '')
      .replace(/\s*-\s*$/, '')
      .trim();

    // Try to extract artist from title if not provided (format: "Artist - Song")
    let searchArtist = artist || '';
    let searchTitle = cleanTitle;

    if (!artist && cleanTitle.includes(' - ')) {
      const parts = cleanTitle.split(' - ');
      searchArtist = parts[0].trim();
      searchTitle = parts.slice(1).join(' - ').trim();
    }

    // First try: search with artist and title
    let lrclibUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(searchArtist + ' ' + searchTitle)}`;
    let response = await fetch(lrclibUrl);
    let results = await response.json();

    // If no results, try with just the clean title
    if (!results || results.length === 0) {
      lrclibUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`;
      response = await fetch(lrclibUrl);
      results = await response.json();
    }

    // If still no results, try with original title
    if (!results || results.length === 0) {
      lrclibUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(title)}`;
      response = await fetch(lrclibUrl);
      results = await response.json();
    }

    if (!results || results.length === 0) {
      return res.status(404).json({ error: 'Lyrics not found' });
    }

    // Get the first result (best match)
    const bestMatch = results[0];

    // Return synced lyrics if available, otherwise plain lyrics
    const lyrics = {
      title: bestMatch.trackName,
      artist: bestMatch.artistName,
      synced: !!bestMatch.syncedLyrics,
      lyrics: bestMatch.syncedLyrics || bestMatch.plainLyrics || null
    };

    if (!lyrics.lyrics) {
      return res.status(404).json({ error: 'Lyrics not found' });
    }

    res.json(lyrics);
  } catch (error) {
    console.error('Lyrics fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
});

// API endpoint to add song to queue
app.post('/api/queue/add', rateLimit('queueadd', 20, 60_000), async (req, res) => {
  const { url, title, duration, thumbnail, guildId, requestedBy: customRequestedBy } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!isAllowedMediaUrl(url)) {
    return res.status(400).json({ error: 'Invalid or unsupported URL' });
  }

  // Use custom requestedBy if provided (e.g., for Radio), otherwise use session username
  const requestedBy = customRequestedBy || req.session?.user?.username || 'Web Dashboard';
  const requestedById = req.session?.user?.id || null;
  const isRadio = customRequestedBy && customRequestedBy.toLowerCase().includes('radio');
  
  try {
    // Get full song info if needed (skip if we already have title, duration, and thumbnail)
    let song = { url, title, duration, thumbnail, requestedBy, requestedById, source: 'youtube' };
    
    if (!title || !duration || !thumbnail) {
      const videoInfo = await ytDlpExec(url, {
        ...ytCookieOpts,
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        skipDownload: true
      });
      song = {
        title: title || videoInfo.title,
        url: videoInfo.webpage_url || url,
        duration: duration || videoInfo.duration || 0,
        thumbnail: thumbnail || getHighQualityThumbnail(videoInfo),
        requestedBy,
        requestedById,
        source: 'youtube'
      };
    }
    
    // Add to queue via command handler
    if (addSongHandler) {
      const result = await addSongHandler(song, guildId || currentState.guildId);
      console.log('Add song result:', result);
      if (result.success === false) {
        return res.status(400).json({ success: false, error: result.error });
      }
      
      // Log the action (skip radio auto-adds to avoid spam, but log a simplified message)
      if (activityLogger && activityLogger.logWebAction) {
        if (isRadio) {
          // Log radio additions with a distinct message
          activityLogger.logWebAction('📻 Radio', 'radio-add', song.title);
        } else {
          const username = req.session?.user?.username || 'Web Dashboard';
          activityLogger.logWebAction(username, 'play', song.title);
        }
      }
      
      res.json({ success: true, song, result });
    } else {
      res.status(500).json({ error: 'Queue not available' });
    }
  } catch (error) {
    console.error('Error adding song:', error);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// WebSocket connection handling with authentication
wss.on('connection', (ws, req) => {
  // Reject cross-origin WebSocket connections before registering any handlers.
  // Browsers send an Origin header on WS upgrades; non-browser clients (or same-origin
  // requests without one) simply won't have it, so only check when it's present.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch (e) { /* malformed Origin header — treat as mismatch below */ }

    let redirectHost = null;
    try {
      redirectHost = new URL(getRedirectUri()).host;
    } catch (e) { /* fall through */ }

    if (originHost !== req.headers.host && originHost !== redirectHost) {
      console.log(`WebSocket connection rejected: Origin mismatch (${origin})`);
      ws.close(4403, 'Unauthorized: Origin mismatch');
      return;
    }
  }

  // Parse session cookie to verify authentication
  const cookies = cookie.parse(req.headers.cookie || '');
  const sessionId = cookies['connect.sid'];
  
  if (!sessionId) {
    console.log('WebSocket connection rejected: No session cookie');
    ws.close(4001, 'Unauthorized: No session');
    return;
  }
  
  // Parse the signed session ID
  const unsignedSessionId = cookieParser.signedCookie(
    decodeURIComponent(sessionId),
    sessionSecret
  );
  
  if (!unsignedSessionId) {
    console.log('WebSocket connection rejected: Invalid session signature');
    ws.close(4001, 'Unauthorized: Invalid session');
    return;
  }
  
  // Load session from store using the session ID
  sessionStore.get(unsignedSessionId, (err, sessionData) => {
    // Treat missing session (ENOENT) as not authenticated, not as an error
    if (err && err.code !== 'ENOENT') {
      console.log('WebSocket connection rejected: Session store error', err);
      ws.close(4001, 'Unauthorized: Session error');
      return;
    }
    
    if (!sessionData || !sessionData.user || !sessionData.user.hasAccess) {
      console.log('WebSocket connection rejected: User not authenticated or no access');
      ws.close(4001, 'Unauthorized: Access denied');
      return;
    }
    
    // Store user info on websocket for command handling
    ws.user = sessionData.user;
    
    console.log(`Web client connected: ${ws.user.username}`);
    clients.add(ws);
    
    // Send current state immediately (include recently played from musicQueue)
    const stateWithRecentlyPlayed = { ...currentState, recentlyPlayed: getRecentlyPlayed() };
    ws.send(JSON.stringify({ type: 'state', data: stateWithRecentlyPlayed }));
    
    // Broadcast updated listeners list to all clients (including new one)
    setTimeout(() => broadcastListeners(), 100);
    
    ws.on('close', () => {
      console.log(`Web client disconnected: ${ws.user?.username || 'unknown'}`);
      clients.delete(ws);
      // Clean up pictionary room membership
      cleanupPictionaryClient(ws);
      // Clean up hitster room membership
      cleanupHitsterClient(ws);
      // Clean up pesten room membership
      cleanupPestenClient(ws);
      // Broadcast updated listeners list after disconnect
      broadcastListeners();
    });
    
    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        console.log(`Received from ${ws.user.username}:`, data);

        // Handle commands from web interface
        if (data.type === 'command') {
          // Mixer commands require DJ role - check live from bot's guild cache
          if (data.command.startsWith('mixer-')) {
            let hasDJ = ws.user.hasDJRole;
            if (memberFetcher) {
              try {
                const memberData = await memberFetcher(ws.user.id);
                hasDJ = memberData?.roles?.includes(DJ_ROLE_ID) || false;
                ws.user.hasDJRole = hasDJ;
              } catch (e) {
                // Fail closed: deny if the live role refresh throws
                hasDJ = false;
              }
            }
            if (!hasDJ) {
              ws.send(JSON.stringify({
                type: 'error',
                message: 'You need the "Website DJ Extraordinaire" role to use mixer controls.'
              }));
              return;
            }
          }
          handleWebCommand(data.command, data.guildId, ws.user.username, ws);
        }

        // Handle Pictionary messages
        if (data.type && data.type.startsWith('pictionary:')) {
          handlePictionaryMessage(ws, data);
        }

        // Handle Hitster messages
        if (data.type && data.type.startsWith('hitster:')) {
          handleHitsterMessage(ws, data);
        }

        // Handle Pesten messages
        if (data.type && data.type.startsWith('pesten:')) {
          handlePestenMessage(ws, data);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    });
  });
});

// Get list of users viewing the web dashboard
async function getWebViewers() {
  const viewers = [];
  const seenUserIds = new Set();
  
  for (const client of clients) {
    if (client.readyState === 1 && client.user) {
      // Deduplicate by user ID
      if (!seenUserIds.has(client.user.id)) {
        seenUserIds.add(client.user.id);
        
        // Try to fetch fresh display name from Discord
        const memberData = await getMemberDisplayName(client.user.id);
        
        viewers.push({
          id: client.user.id,
          username: memberData?.username || client.user.username,
          displayName: memberData?.displayName || client.user.username,
          avatar: memberData?.avatar || client.user.avatar
        });
      }
    }
  }
  return viewers;
}

// Get list of users in voice channel with the bot
async function getVoiceListeners() {
  return await getVoiceChannelMembers();
}

// Broadcast listeners update to all clients (both web viewers and voice channel members)
export async function broadcastListeners() {
  const webViewers = await getWebViewers();
  const voiceListeners = await getVoiceListeners();
  broadcast('listeners', { webViewers, voiceListeners });
}

// Broadcast to all connected clients
export function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Update state and broadcast
export function updateState(newState) {
  currentState = { ...currentState, ...newState };
  console.log('Broadcasting state - isPlaying:', currentState.isPlaying, 'isPaused:', currentState.isPaused, 'currentSong:', currentState.currentSong?.title);
  broadcast('state', currentState);
}

// Command handler (will be connected to music queue)
let commandHandler = null;
let addSongHandler = null;

export function setCommandHandler(handler) {
  commandHandler = handler;
}

export function setAddSongHandler(handler) {
  addSongHandler = handler;
}

// @param ws - the client that asked, if there is one. Commands that can silently do nothing
//   (pause/resume during the download gap, or with nothing playing) answer with a reason, and
//   it goes back to that one client as an error toast: those two produce no player transition
//   when they no-op, so there is no state broadcast to correct the button with.
function handleWebCommand(command, guildId, username = 'Web Dashboard', ws = null) {
  let result;
  if (commandHandler) {
    result = commandHandler(command, guildId);
  }

  if (result && result.ok === false && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'error', message: result.message }));
  }

  // Log the action
  if (activityLogger && activityLogger.logWebAction) {
    const { logWebAction } = activityLogger;
    
    if (command === 'pause') {
      logWebAction(username, 'pause');
    } else if (command === 'resume') {
      logWebAction(username, 'resume');
    } else if (command === 'skip') {
      logWebAction(username, 'skip');
    } else if (command === 'previous') {
      logWebAction(username, 'previous');
    } else if (command === 'stop') {
      logWebAction(username, 'stop');
    } else if (command === 'shuffle') {
      logWebAction(username, 'shuffle');
    } else if (command.startsWith('volume:')) {
      const level = command.split(':')[1];
      logWebAction(username, 'volume', level);
    } else if (command.startsWith('skipto:')) {
      const index = parseInt(command.split(':')[1]) + 1; // Convert to 1-based
      logWebAction(username, 'skipto', index);
    } else if (command.startsWith('remove:')) {
      const index = parseInt(command.split(':')[1]) + 1; // Convert to 1-based
      logWebAction(username, 'remove', index);
    } else if (command.startsWith('seek:')) {
      const seconds = parseFloat(command.split(':')[1]);
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      logWebAction(username, 'seek', `${mins}:${secs.toString().padStart(2, '0')}`);
    } else if (command.startsWith('reorder:')) {
      logWebAction(username, 'reorder');
    } else if (command === 'loop') {
      logWebAction(username, 'loop');
    } else if (command === '24/7') {
      logWebAction(username, '24/7');
    } else if (command === 'radio') {
      logWebAction(username, 'radio');
    } else if (command.startsWith('sleep-set:')) {
      const minutes = parseInt(command.split(':')[1]);
      setSleepTimer(minutes);
      logWebAction(username, 'sleep-set', `${minutes} minutes`);
    } else if (command === 'sleep-cancel') {
      cancelSleepTimer();
      logWebAction(username, 'sleep-cancel');
    } else if (command.startsWith('mixer-bass:')) {
      // Every numeric mixer value is guarded the way handleMusicCommand guards volume/seek/
      // reorder: clampMixerFilters() rounds and clamps, and Math.max/min/round all propagate
      // NaN, so a malformed frame (an empty or non-numeric suffix) used to write NaN into the
      // guild's saved filters and hand ffmpeg a broken filter string for every listener.
      const value = parseFloat(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ bass: value });
        logWebAction(username, 'mixer-bass', `${value}dB`);
      }
    } else if (command.startsWith('mixer-treble:')) {
      const value = parseFloat(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ treble: value });
        logWebAction(username, 'mixer-treble', `${value}dB`);
      }
    } else if (command.startsWith('mixer-speed:')) {
      const value = parseFloat(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ speed: value });
        logWebAction(username, 'mixer-speed', `${value}x`);
      }
    } else if (command.startsWith('mixer-mid:')) {
      const value = parseFloat(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ mid: value });
        logWebAction(username, 'mixer-mid', `${value}dB`);
      }
    } else if (command.startsWith('mixer-karaoke:')) {
      const value = command.split(':')[1] === 'true';
      applyMixerFilters({ karaoke: value });
      logWebAction(username, 'mixer-karaoke', value ? 'on' : 'off');
    } else if (command.startsWith('mixer-8d:')) {
      const value = command.split(':')[1] === 'true';
      applyMixerFilters({ eightD: value });
      logWebAction(username, 'mixer-8d', value ? 'on' : 'off');
    } else if (command.startsWith('mixer-8drate:')) {
      const value = parseFloat(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ eightDRate: value });
        logWebAction(username, 'mixer-8drate', `${value}Hz`);
      }
    } else if (command.startsWith('mixer-reverb:')) {
      const value = parseInt(command.split(':')[1]);
      if (Number.isFinite(value)) {
        applyMixerFilters({ reverb: value });
        logWebAction(username, 'mixer-reverb', `${value}%`);
      }
    } else if (command.startsWith('mixer-compressor:')) {
      const value = command.split(':')[1] === 'true';
      applyMixerFilters({ compressor: value });
      logWebAction(username, 'mixer-compressor', value ? 'on' : 'off');
    } else if (command.startsWith('mixer-flanger:')) {
      const value = command.split(':')[1] === 'true';
      applyMixerFilters({ flanger: value });
      logWebAction(username, 'mixer-flanger', value ? 'on' : 'off');
    } else if (command.startsWith('mixer-preset:')) {
      const preset = command.split(':')[1];
      const defaults = { bass: 0, mid: 0, treble: 0, speed: 1.0, karaoke: false, eightD: false, eightDRate: 0.15, reverb: 0, compressor: false, flanger: false };
      const presets = {
        normal:    { ...defaults },
        bassboost: { ...defaults, bass: 10 },
        nightcore: { ...defaults, treble: 3, speed: 1.25 },
        slowed:    { ...defaults, bass: 3, treble: -2, speed: 0.85 },
        karaoke:   { ...defaults, karaoke: true },
        eightd:    { ...defaults, eightD: true, reverb: 20 },
        nightmode: { ...defaults, compressor: true }
      };
      if (presets[preset]) {
        applyMixerFilters(presets[preset]);
        logWebAction(username, 'mixer-preset', preset);
      }
    }
  }
}

// Pictionary WebSocket handlers
function handlePictionaryMessage(ws, data) {
  const { type } = data;
  const user = ws.user;

  switch (type) {
    case 'pictionary:room:create': {
      const { name, settings } = data;
      const room = createRoom(
        name || `${user.displayName}'s Room`,
        user.id,
        user.displayName,
        user.avatar,
        settings
      );
      room.setBroadcastCallback(broadcastToRoom);
      ws.pictionaryRoomId = room.id;
      addClientToRoom(ws, room.id);
      ws.send(JSON.stringify({
        type: 'pictionary:room:joined',
        data: { room: room.toJSON(), isHost: true }
      }));
      // Broadcast updated room list to all clients
      broadcastRoomList();
      break;
    }

    case 'pictionary:room:join': {
      const { roomId } = data;
      const room = getRoom(roomId);
      if (!room) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:error',
          data: { error: 'Room not found' }
        }));
        return;
      }
      const player = new Player(user.id, user.displayName, user.avatar);
      const result = room.addPlayer(player);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:error',
          data: { error: result.error }
        }));
        return;
      }
      ws.pictionaryRoomId = room.id;
      ws.isSpectator = result.asSpectator || false;
      addClientToRoom(ws, room.id);
      ws.send(JSON.stringify({
        type: 'pictionary:room:joined',
        data: {
          room: room.toJSON(),
          isHost: room.hostId === user.id,
          isSpectator: result.asSpectator || false
        }
      }));
      // Send current draw state and game info if game is in progress
      if (room.state === 'playing' || room.state === 'between_rounds') {
        ws.send(JSON.stringify({
          type: 'pictionary:draw:state',
          data: room.getDrawState()
        }));
        // Send current game state to spectator
        if (result.asSpectator) {
          ws.send(JSON.stringify({
            type: 'pictionary:game:state',
            data: {
              round: room.currentRound,
              totalRounds: room.totalRounds,
              drawerId: room.getCurrentDrawer()?.id,
              drawerName: room.getCurrentDrawer()?.displayName,
              hint: room.currentHint,
              state: room.state,
              players: room.getPlayerList()
            }
          }));
        }
      }
      broadcastRoomList();
      break;
    }

    case 'pictionary:room:rejoin': {
      const { roomId } = data;
      const room = getRoom(roomId);
      if (!room || !room.hasPlayer(user.id)) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:rejoinFailed',
          data: {}
        }));
        return;
      }
      // Reconnect the player
      const player = new Player(user.id, user.displayName, user.avatar);
      const result = room.addPlayer(player);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:rejoinFailed',
          data: {}
        }));
        return;
      }
      ws.pictionaryRoomId = room.id;
      ws.isSpectator = result.asSpectator || false;
      addClientToRoom(ws, room.id);
      ws.send(JSON.stringify({
        type: 'pictionary:room:joined',
        data: {
          room: room.toJSON(),
          isHost: room.hostId === user.id,
          isSpectator: result.asSpectator || false
        }
      }));
      // Send current draw state and game info if game is in progress
      if (room.state === 'playing' || room.state === 'between_rounds') {
        ws.send(JSON.stringify({
          type: 'pictionary:draw:state',
          data: room.getDrawState()
        }));
        // Send current game state
        ws.send(JSON.stringify({
          type: 'pictionary:game:state',
          data: {
            round: room.currentRound,
            totalRounds: room.totalRounds,
            drawerId: room.getCurrentDrawer()?.id,
            drawerName: room.getCurrentDrawer()?.displayName,
            hint: room.currentHint,
            state: room.state,
            players: room.getPlayerList()
          }
        }));
      }
      break;
    }

    case 'pictionary:room:leave': {
      const roomId = ws.pictionaryRoomId;
      if (roomId) {
        const room = getRoom(roomId);
        if (room) {
          room.removePlayer(user.id);
          // Delete room only if no players AND no spectators
          if (room.players.size === 0 && room.spectators.size === 0) {
            deleteRoom(roomId);
          }
        }
        removeClientFromRoom(ws, roomId);
        ws.pictionaryRoomId = null;
        ws.isSpectator = false;
        broadcastRoomList();
      }
      break;
    }

    case 'pictionary:room:start': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room) return;
      if (room.hostId !== user.id) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:error',
          data: { error: 'Only host can start the game' }
        }));
        return;
      }
      const result = room.startGame();
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pictionary:room:error',
          data: { error: result.error }
        }));
      }
      broadcastRoomList();
      break;
    }

    case 'pictionary:game:selectWord': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'choosing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      const { word } = data;
      room.selectWord(word);
      break;
    }

    case 'pictionary:game:guess': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      const { guess } = data;
      const result = room.handleGuess(user.id, guess);
      if (result.close) {
        ws.send(JSON.stringify({
          type: 'pictionary:game:closeGuess',
          data: { guess }
        }));
      }
      break;
    }

    case 'pictionary:game:giveHint': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      const result = room.giveHint(user.id);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pictionary:game:hintError',
          data: { error: result.error }
        }));
      }
      // Hint broadcast is handled by room.giveHint()
      break;
    }

    case 'pictionary:chat:message': {
      const roomId = ws.pictionaryRoomId;
      if (!roomId) return;
      const { message } = data;
      broadcastToRoom(roomId, 'chat:message', {
        playerId: user.id,
        displayName: user.displayName,
        message: message.slice(0, 200) // Limit message length
      });
      break;
    }

    case 'pictionary:reaction': {
      const roomId = ws.pictionaryRoomId;
      if (!roomId) return;
      const { emoji } = data;
      // Only allow specific emojis
      const allowedEmojis = ['👍', '😂', '🔥', '😮', '🎨'];
      if (!allowedEmojis.includes(emoji)) return;
      // Broadcast to everyone except sender
      broadcastToRoom(roomId, 'reaction', { emoji, playerId: user.id }, user.id);
      break;
    }

    case 'pictionary:draw:stroke': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      const { stroke } = data;
      room.addStroke(stroke);
      break;
    }

    case 'pictionary:draw:clear': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      room.clearCanvas();
      break;
    }

    case 'pictionary:draw:undo': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      room.undo();
      break;
    }

    case 'pictionary:draw:redo': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      room.redo();
      break;
    }

    case 'pictionary:draw:fill': {
      const roomId = ws.pictionaryRoomId;
      const room = getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentDrawer()?.id !== user.id) return;
      const { x, y, color } = data;
      // Fill is handled as a special stroke type
      room.addStroke({ type: 'fill', x, y, color });
      break;
    }

    case 'pictionary:rooms:list': {
      ws.send(JSON.stringify({
        type: 'pictionary:rooms:list',
        data: { rooms: getRoomList() }
      }));
      break;
    }

    case 'pictionary:leaderboard': {
      ws.send(JSON.stringify({
        type: 'pictionary:leaderboard',
        data: { leaderboard: getLeaderboard() }
      }));
      break;
    }
  }
}

// Pictionary room client management
function addClientToRoom(ws, roomId) {
  if (!pictionaryClients.has(roomId)) {
    pictionaryClients.set(roomId, new Set());
  }
  pictionaryClients.get(roomId).add(ws);
}

function removeClientFromRoom(ws, roomId) {
  const roomClients = pictionaryClients.get(roomId);
  if (roomClients) {
    roomClients.delete(ws);
    if (roomClients.size === 0) {
      pictionaryClients.delete(roomId);
    }
  }
}

// Broadcast to all clients in a pictionary room
function broadcastToRoom(roomId, type, data, excludeId = null, onlyToId = null) {
  const roomClients = pictionaryClients.get(roomId);
  if (!roomClients) return;

  const message = JSON.stringify({ type: `pictionary:${type}`, data });

  roomClients.forEach(client => {
    if (client.readyState !== 1) return; // Not open
    if (excludeId && client.user?.id === excludeId) return;
    if (onlyToId && client.user?.id !== onlyToId) return;
    client.send(message);
  });
}

// Broadcast room list to all connected clients
function broadcastRoomList() {
  const message = JSON.stringify({
    type: 'pictionary:rooms:list',
    data: { rooms: getRoomList() }
  });
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Clean up pictionary room when client disconnects
function cleanupPictionaryClient(ws) {
  const roomId = ws.pictionaryRoomId;
  if (roomId) {
    const room = getRoom(roomId);
    if (room) {
      room.removePlayer(ws.user?.id);
      if (room.players.size === 0) {
        deleteRoom(roomId);
      }
    }
    removeClientFromRoom(ws, roomId);
    broadcastRoomList();
  }
}

// Hitster WebSocket handlers
function handleHitsterMessage(ws, data) {
  const { type } = data;
  const user = ws.user;

  switch (type) {
    case 'hitster:room:list': {
      ws.send(JSON.stringify({
        type: 'hitster:room:list',
        rooms: getHitsterRoomList()
      }));
      break;
    }

    case 'hitster:leaderboard': {
      ws.send(JSON.stringify({
        type: 'hitster:leaderboard',
        players: getHitsterLeaderboard()
      }));
      break;
    }

    case 'hitster:room:rejoin': {
      const { roomId } = data;
      const room = getHitsterRoom(roomId);
      if (!room || !room.hasPlayer(user.id)) {
        ws.send(JSON.stringify({ type: 'hitster:room:rejoinFailed' }));
        return;
      }
      // Reconnect the player
      const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null;
      const result = room.addPlayer(user.id, user.displayName, avatarUrl);
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'hitster:room:rejoinFailed' }));
        return;
      }
      ws.hitsterRoomId = roomId;
      ws.hitsterIsSpectator = result.isSpectator || false;
      addHitsterClientToRoom(ws, roomId);
      ws.send(JSON.stringify({
        type: 'hitster:room:joined',
        room: room.getPublicState(),
        isSpectator: result.isSpectator || false,
        timeline: room.getPlayerTimeline(user.id)
      }));
      // Broadcast room update to all in room
      broadcastToHitsterRoom(roomId, 'hitster:room:updated', { room: room.getPublicState() });
      break;
    }

    case 'hitster:room:create': {
      const { name, settings } = data;
      const roomId = `hitster_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null;
      const room = createHitsterRoom(roomId, name || `${user.displayName}'s Room`, user.id, user.displayName, settings);
      room.addPlayer(user.id, user.displayName, avatarUrl);
      ws.hitsterRoomId = roomId;
      addHitsterClientToRoom(ws, roomId);
      ws.send(JSON.stringify({
        type: 'hitster:room:joined',
        room: room.getPublicState(),
        isSpectator: false,
        timeline: []
      }));
      broadcastHitsterRoomList();
      break;
    }

    case 'hitster:room:join': {
      const { roomId } = data;
      const room = getHitsterRoom(roomId);
      if (!room) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: 'Room not found'
        }));
        return;
      }
      const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null;
      const result = room.addPlayer(user.id, user.displayName, avatarUrl);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: result.error
        }));
        return;
      }
      ws.hitsterRoomId = roomId;
      ws.hitsterIsSpectator = result.isSpectator || false;
      addHitsterClientToRoom(ws, roomId);
      ws.send(JSON.stringify({
        type: 'hitster:room:joined',
        room: room.getPublicState(),
        isSpectator: result.isSpectator || false,
        timeline: room.getPlayerTimeline(user.id)
      }));
      // Broadcast room update to all in room
      broadcastToHitsterRoom(roomId, 'hitster:room:updated', { room: room.getPublicState() });
      broadcastHitsterRoomList();
      break;
    }

    case 'hitster:room:leave': {
      const roomId = ws.hitsterRoomId;
      if (roomId) {
        const room = getHitsterRoom(roomId);
        if (room) {
          const isEmpty = room.removePlayer(user.id);
          if (isEmpty) {
            deleteHitsterRoom(roomId);
          } else {
            broadcastToHitsterRoom(roomId, 'hitster:room:updated', { room: room.getPublicState() });
          }
        }
        removeHitsterClientFromRoom(ws, roomId);
        ws.hitsterRoomId = null;
        ws.hitsterIsSpectator = false;
        ws.send(JSON.stringify({ type: 'hitster:room:left' }));
        broadcastHitsterRoomList();
      }
      break;
    }

    case 'hitster:game:start': {
      const roomId = ws.hitsterRoomId;
      const room = getHitsterRoom(roomId);
      if (!room) return;
      if (room.hostId !== user.id) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: 'Only host can start the game'
        }));
        return;
      }
      const result = room.startGame();
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: result.error
        }));
        return;
      }
      broadcastToHitsterRoom(roomId, 'hitster:game:started', { room: room.getPublicState() });
      broadcastHitsterRoomList();
      // Start first turn
      startHitsterTurn(roomId);
      break;
    }

    case 'hitster:game:place': {
      const roomId = ws.hitsterRoomId;
      const room = getHitsterRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.getCurrentPlayer()?.id !== user.id) return;
      if (room.turnPhase !== 'placing') return;

      const { position } = data;
      const result = room.placeCard(user.id, position);

      if (!result.valid) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: result.error
        }));
        return;
      }

      // Broadcast placement result
      broadcastToHitsterRoom(roomId, 'hitster:game:result', {
        playerId: user.id,
        playerName: user.displayName,
        correct: result.correct,
        song: result.song,
        timeline: result.newTimeline
      });

      if (result.gameWon) {
        // Game over
        room.endGame(user.id);
        const finalScores = Array.from(room.players.values())
          .map(p => ({ id: p.id, name: p.name, score: p.score }))
          .sort((a, b) => b.score - a.score);
        broadcastToHitsterRoom(roomId, 'hitster:game:end', {
          winner: result.winner,
          finalScores
        });
        broadcastHitsterRoomList();
      } else if (result.correct) {
        // Move to next turn
        setTimeout(() => {
          room.nextTurn();
          startHitsterTurn(roomId);
        }, 3000);
      } else if (result.canSteal) {
        // Start steal phase
        const stealerId = room.stealQueue[0];
        const stealer = room.players.get(stealerId);
        broadcastToHitsterRoom(roomId, 'hitster:game:steal', {
          stealerId,
          stealerName: stealer?.name
        });
      } else {
        // No one can steal, move to next turn
        setTimeout(() => {
          room.nextTurn();
          startHitsterTurn(roomId);
        }, 3000);
      }
      break;
    }

    case 'hitster:game:steal': {
      const roomId = ws.hitsterRoomId;
      const room = getHitsterRoom(roomId);
      if (!room || room.turnPhase !== 'stealing') return;

      const { position } = data;
      const result = room.stealCard(user.id, position);

      if (!result.valid) {
        ws.send(JSON.stringify({
          type: 'hitster:room:error',
          message: result.error
        }));
        return;
      }

      broadcastToHitsterRoom(roomId, 'hitster:game:stealResult', {
        playerId: user.id,
        playerName: user.displayName,
        correct: result.correct,
        song: result.song,
        timeline: result.newTimeline,
        passed: false
      });

      if (result.gameWon) {
        room.endGame(user.id);
        const finalScores = Array.from(room.players.values())
          .map(p => ({ id: p.id, name: p.name, score: p.score }))
          .sort((a, b) => b.score - a.score);
        broadcastToHitsterRoom(roomId, 'hitster:game:end', {
          winner: result.winner,
          finalScores
        });
        broadcastHitsterRoomList();
      } else if (result.correct || result.noMoreStealers) {
        // Move to next turn
        setTimeout(() => {
          room.nextTurn();
          startHitsterTurn(roomId);
        }, 3000);
      } else if (result.nextStealer) {
        // Next stealer's turn
        const stealer = room.players.get(result.nextStealer);
        broadcastToHitsterRoom(roomId, 'hitster:game:steal', {
          stealerId: result.nextStealer,
          stealerName: stealer?.name
        });
      }
      break;
    }

    case 'hitster:game:passSteal': {
      const roomId = ws.hitsterRoomId;
      const room = getHitsterRoom(roomId);
      if (!room || room.turnPhase !== 'stealing') return;

      const result = room.passSteal(user.id);

      if (!result.valid) return;

      broadcastToHitsterRoom(roomId, 'hitster:game:stealResult', {
        playerId: user.id,
        playerName: user.displayName,
        passed: true
      });

      if (result.noMoreStealers) {
        setTimeout(() => {
          room.nextTurn();
          startHitsterTurn(roomId);
        }, 2000);
      } else if (result.nextStealer) {
        const stealer = room.players.get(result.nextStealer);
        broadcastToHitsterRoom(roomId, 'hitster:game:steal', {
          stealerId: result.nextStealer,
          stealerName: stealer?.name
        });
      }
      break;
    }

    case 'hitster:chat': {
      const roomId = ws.hitsterRoomId;
      if (!roomId) return;
      const { message } = data;
      broadcastToHitsterRoom(roomId, 'hitster:chat', {
        author: user.displayName,
        message: message.slice(0, 200)
      });
      break;
    }
  }
}

// Start a new turn in Hitster
function startHitsterTurn(roomId) {
  const room = getHitsterRoom(roomId);
  if (!room || room.state !== 'playing') return;

  const currentPlayer = room.getCurrentPlayer();
  if (!currentPlayer) return;

  // Draw a song
  const songData = room.drawSong();

  // Broadcast turn start
  broadcastToHitsterRoom(roomId, 'hitster:game:turn', {
    currentPlayerId: currentPlayer.id,
    currentPlayerName: currentPlayer.name
  });

  // Send song to all players
  broadcastToHitsterRoom(roomId, 'hitster:game:song', {
    youtubeId: songData.youtubeId
  });

  // After listen time, move to placing phase
  setTimeout(() => {
    const currentRoom = getHitsterRoom(roomId);
    if (currentRoom && currentRoom.turnPhase === 'listening') {
      currentRoom.startPlacingPhase();
      broadcastToHitsterRoom(roomId, 'hitster:game:placePhase', {});
    }
  }, room.settings.listenTime * 1000);
}

// Hitster room client management
function addHitsterClientToRoom(ws, roomId) {
  if (!hitsterClients.has(roomId)) {
    hitsterClients.set(roomId, new Set());
  }
  hitsterClients.get(roomId).add(ws);
}

function removeHitsterClientFromRoom(ws, roomId) {
  const roomClients = hitsterClients.get(roomId);
  if (roomClients) {
    roomClients.delete(ws);
    if (roomClients.size === 0) {
      hitsterClients.delete(roomId);
    }
  }
}

function broadcastToHitsterRoom(roomId, type, data) {
  const roomClients = hitsterClients.get(roomId);
  if (!roomClients) return;

  const message = JSON.stringify({ type, ...data });

  roomClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function broadcastHitsterRoomList() {
  const message = JSON.stringify({
    type: 'hitster:room:list',
    rooms: getHitsterRoomList()
  });
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function cleanupHitsterClient(ws) {
  const roomId = ws.hitsterRoomId;
  if (roomId) {
    const room = getHitsterRoom(roomId);
    if (room) {
      const isEmpty = room.removePlayer(ws.user?.id);
      if (isEmpty) {
        deleteHitsterRoom(roomId);
      }
    }
    removeHitsterClientFromRoom(ws, roomId);
    broadcastHitsterRoomList();
  }
}

// Pesten WebSocket handlers
function handlePestenMessage(ws, data) {
  const { type } = data;
  const user = ws.user;

  switch (type) {
    case 'pesten:getRooms': {
      ws.send(JSON.stringify({
        type: 'pesten:roomList',
        rooms: getPestenRoomList()
      }));
      break;
    }

    case 'pesten:getLeaderboard': {
      ws.send(JSON.stringify({
        type: 'pesten:leaderboard',
        leaderboard: getPestenLeaderboard()
      }));
      break;
    }

    case 'pesten:rejoinRoom': {
      const { roomId } = data;
      const room = getPestenRoom(roomId);
      if (!room || !room.hasPlayer(user.id)) {
        ws.send(JSON.stringify({ type: 'pesten:rejoinFailed' }));
        return;
      }
      // Reconnect the player
      const result = room.addPlayer(
        user.id,
        user.displayName,
        user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null
      );
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'pesten:rejoinFailed' }));
        return;
      }
      ws.pestenRoomId = roomId;
      addPestenClientToRoom(ws, roomId);
      ws.send(JSON.stringify({
        type: 'pesten:rejoined',
        room: room.getState(user.id)
      }));
      // Broadcast room update to all in room
      broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
      break;
    }

    case 'pesten:createRoom': {
      const { name, maxPlayers, turnTimeLimit } = data;
      const room = createPestenRoom(
        name || `${user.displayName}'s Room`,
        user.id,
        user.displayName,
        user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        maxPlayers || 4,
        turnTimeLimit || 30
      );

      // Set up turn timeout callback
      room.setTurnTimeoutCallback((roomId, timedOutPlayerId, result, drawCount) => {
        const updatedRoom = getPestenRoom(roomId);
        if (updatedRoom) {
          // Send personalized state to each player (so they see their own hand)
          const roomClients = pestenClients.get(roomId);
          if (roomClients) {
            roomClients.forEach(client => {
              if (client.readyState === 1 && client.user) {
                client.send(JSON.stringify({
                  type: 'pesten:turnTimeout',
                  playerId: timedOutPlayerId,
                  drawCount,
                  room: updatedRoom.getState(client.user.id)
                }));
              }
            });
          }
        }
      });

      ws.pestenRoomId = room.id;
      addPestenClientToRoom(ws, room.id);
      ws.send(JSON.stringify({
        type: 'pesten:roomCreated',
        room: room.getState(user.id)
      }));
      broadcastPestenRoomList();
      break;
    }

    case 'pesten:joinRoom': {
      const { roomId } = data;
      const room = getPestenRoom(roomId);
      if (!room) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: 'Room not found'
        }));
        return;
      }
      const result = room.addPlayer(
        user.id,
        user.displayName,
        user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null
      );
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: result.error
        }));
        return;
      }
      ws.pestenRoomId = roomId;
      addPestenClientToRoom(ws, roomId);
      ws.send(JSON.stringify({
        type: 'pesten:roomJoined',
        room: room.getState(user.id)
      }));
      // Broadcast room update to all in room
      broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
      broadcastPestenRoomList();
      break;
    }

    case 'pesten:leaveRoom': {
      const { roomId } = data;
      if (roomId) {
        const room = getPestenRoom(roomId);
        if (room) {
          const result = room.removePlayer(user.id);
          if (room.players.length === 0) {
            deletePestenRoom(roomId);
          } else {
            broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
          }
        }
        removePestenClientFromRoom(ws, roomId);
        ws.pestenRoomId = null;
        ws.send(JSON.stringify({ type: 'pesten:roomLeft' }));
        broadcastPestenRoomList();
      }
      break;
    }

    case 'pesten:addBot': {
      const { roomId } = data;
      const room = getPestenRoom(roomId);
      if (!room) return;
      if (room.hostId !== user.id) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: 'Only host can add bots'
        }));
        return;
      }
      const result = room.addBot();
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: result.error
        }));
        return;
      }
      broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
      broadcastPestenRoomList();
      break;
    }

    case 'pesten:removeBot': {
      const { roomId, botId } = data;
      const room = getPestenRoom(roomId);
      if (!room) return;
      if (room.hostId !== user.id) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: 'Only host can remove bots'
        }));
        return;
      }
      const result = room.removeBot(botId);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: result.error
        }));
        return;
      }
      broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
      broadcastPestenRoomList();
      break;
    }

    case 'pesten:startGame': {
      const { roomId } = data;
      const room = getPestenRoom(roomId);
      if (!room) return;
      if (room.hostId !== user.id) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: 'Only host can start the game'
        }));
        return;
      }
      const result = room.startGame();
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: result.error
        }));
        return;
      }
      // Send game state to each player (with their own hand)
      broadcastPestenGameState(roomId);
      broadcastPestenRoomList();

      // Check if first player is a bot
      setTimeout(() => processBotTurn(roomId), 1000);
      break;
    }

    case 'pesten:playCard': {
      const { roomId, cardId, chosenSuit } = data;
      const room = getPestenRoom(roomId);
      if (!room) return;

      const result = room.playCard(user.id, cardId, chosenSuit);
      if (!result.success) {
        if (result.needsSuit) {
          ws.send(JSON.stringify({
            type: 'pesten:needsSuit'
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'pesten:error',
            message: result.error
          }));
        }
        return;
      }

      broadcastPestenGameState(roomId);

      if (result.gameOver) {
        broadcastPestenRoomList();
      } else {
        // Check if next player is a bot
        setTimeout(() => processBotTurn(roomId), 1000);
      }
      break;
    }

    case 'pesten:drawCard': {
      const { roomId } = data;
      const room = getPestenRoom(roomId);
      if (!room) return;

      const result = room.drawCard(user.id);
      if (!result.success) {
        ws.send(JSON.stringify({
          type: 'pesten:error',
          message: result.error
        }));
        return;
      }

      broadcastPestenGameState(roomId);

      // Check if next player is a bot
      setTimeout(() => processBotTurn(roomId), 1000);
      break;
    }
  }
}

// Process bot turns
function processBotTurn(roomId) {
  const room = getPestenRoom(roomId);
  if (!room || room.gameState !== 'playing') return;

  const currentPlayer = room.getCurrentPlayer();
  if (!currentPlayer || !currentPlayer.isBot) return;

  const botMove = room.getBotMove(currentPlayer.id);
  if (!botMove) return;

  if (botMove.action === 'draw') {
    room.drawCard(currentPlayer.id);
  } else if (botMove.action === 'play') {
    room.playCard(currentPlayer.id, botMove.cardId, botMove.chosenSuit);
  }

  broadcastPestenGameState(roomId);

  // Check if game is over
  if (room.gameState === 'finished') {
    broadcastPestenRoomList();
    return;
  }

  // Check if next player is also a bot
  setTimeout(() => processBotTurn(roomId), 1500);
}

// Pesten room client management
function addPestenClientToRoom(ws, roomId) {
  if (!pestenClients.has(roomId)) {
    pestenClients.set(roomId, new Set());
  }
  pestenClients.get(roomId).add(ws);
}

function removePestenClientFromRoom(ws, roomId) {
  const roomClients = pestenClients.get(roomId);
  if (roomClients) {
    roomClients.delete(ws);
    if (roomClients.size === 0) {
      pestenClients.delete(roomId);
    }
  }
}

function broadcastToPestenRoom(roomId, type, data) {
  const roomClients = pestenClients.get(roomId);
  if (!roomClients) return;

  const message = JSON.stringify({ type, ...data });

  roomClients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Broadcast game state to each player with their own hand visible
function broadcastPestenGameState(roomId) {
  const room = getPestenRoom(roomId);
  if (!room) return;

  const roomClients = pestenClients.get(roomId);
  if (!roomClients) return;

  roomClients.forEach(client => {
    if (client.readyState === 1 && client.user) {
      const state = room.getState(client.user.id);
      client.send(JSON.stringify({
        type: 'pesten:gameState',
        state
      }));
    }
  });
}

function broadcastPestenRoomList() {
  const message = JSON.stringify({
    type: 'pesten:roomList',
    rooms: getPestenRoomList()
  });
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function cleanupPestenClient(ws) {
  const roomId = ws.pestenRoomId;
  if (roomId) {
    const room = getPestenRoom(roomId);
    if (room) {
      room.removePlayer(ws.user?.id);
      if (room.players.length === 0) {
        deletePestenRoom(roomId);
      } else {
        broadcastToPestenRoom(roomId, 'pesten:roomUpdated', { room: room.getState() });
      }
    }
    removePestenClientFromRoom(ws, roomId);
    broadcastPestenRoomList();
  }
}

// Start server
const PORT = process.env.WEB_PORT || 3001;

export function startWebServer() {
  server.listen(PORT, () => {
    console.log(`🌐 Web dashboard running at http://localhost:${PORT}`);
  });
}

export { currentState };

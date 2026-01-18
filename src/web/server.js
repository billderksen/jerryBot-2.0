import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ytDlpPkg from 'yt-dlp-exec';
import spotifyUrlInfo from 'spotify-url-info';
import { fetch } from 'undici';
import { getRecentlyPlayed } from '../utils/musicQueue.js';
import session from 'express-session';
import cookieParser from 'cookie-parser';

const ytDlpExec = ytDlpPkg;
const { getData, getPreview, getTracks } = spotifyUrlInfo(fetch);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// OAuth2 Configuration - use getters to read at runtime after dotenv loads
const getClientId = () => process.env.CLIENT_ID;
const getClientSecret = () => process.env.CLIENT_SECRET;
const getRedirectUri = () => process.env.OAUTH_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';
const getRequiredRoleId = () => process.env.REQUIRED_ROLE_ID || '1462395138776236134';
const getRequiredGuildId = () => process.env.GUILD_ID || '918554414220972032';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Session middleware
app.use(cookieParser());
app.use(session({
  secret: process.env.SESSION_SECRET || 'jerrybot_default_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, // Set to true in production with HTTPS
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

// Store connected clients
const clients = new Set();

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
  // For API routes, return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // For page routes, redirect to login
  res.redirect('/login');
}

// Discord OAuth2 routes
app.get('/login', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'login.html'));
});

app.get('/auth/discord', (req, res) => {
  const scope = 'identify guilds guilds.members.read';
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${getClientId()}&redirect_uri=${encodeURIComponent(getRedirectUri())}&response_type=code&scope=${encodeURIComponent(scope)}`;
  res.redirect(authUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/login?error=no_code');
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
    
    if (memberResponse.ok) {
      const memberData = await memberResponse.json();
      // Check if user has the required role
      hasAccess = memberData.roles && memberData.roles.includes(getRequiredRoleId());
    }

    // Store user in session
    req.session.user = {
      id: userData.id,
      username: userData.username,
      discriminator: userData.discriminator,
      avatar: userData.avatar,
      hasAccess: hasAccess
    };

    if (hasAccess) {
      res.redirect('/');
    } else {
      res.redirect('/access-denied');
    }

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

app.get('/access-denied', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'access-denied.html'));
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// API to get current user (no auth required - used on access-denied page)
app.get('/api/me', (req, res) => {
  if (req.session && req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Protect the main dashboard
app.get('/', requireAuth, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Protect all API routes EXCEPT /api/me (which is above this middleware)
app.use('/api', requireAuth);

app.use(express.json());

// API endpoint to get current state
app.get('/api/state', (req, res) => {
  res.json(currentState);
});

// API endpoint to search for songs
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  const count = Math.min(parseInt(req.query.count) || 10, 50); // Default 10, max 50
  if (!query || query.length < 2) {
    return res.json([]);
  }
  
  try {
    // Use yt-dlp for searching (more reliable than play-dl)
    const results = await ytDlpExec(`ytsearch${count}:${query}`, {
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
      thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || null,
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
      try {
        const trackList = await getTracks(url);
        tracks = trackList.slice(0, 50).map(track => ({
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
        tracks = trackList.slice(0, 50).map(item => {
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
      res.json({ 
        type: data.type, 
        name: data.name,
        tracks,
        total: tracks.length
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
    const searchQuery = `${query} official audio`;
    const results = await ytDlpExec(`ytsearch3:${searchQuery}`, {
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
        thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || null
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
app.get('/api/youtube/playlist', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  try {
    const results = await ytDlpExec(url, {
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
    
    const tracks = results.entries.slice(0, 100).map(video => ({
      title: video.title || 'Unknown Title',
      url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
      duration: video.duration || 0,
      thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || null,
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
  
  try {
    // Extract video ID from URL
    const videoIdMatch = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }
    const videoId = videoIdMatch[1];
    
    // YouTube Mix playlist URL format: list=RD<videoId>
    const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
    
    const results = await ytDlpExec(mixUrl, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      flatPlaylist: true,
      skipDownload: true,
      playlistEnd: 25 // Get up to 25 songs from the mix
    });
    
    if (!results.entries || results.entries.length === 0) {
      return res.status(404).json({ error: 'No radio mix found for this video' });
    }
    
    // Filter out the current video and return the rest
    const tracks = results.entries
      .filter(video => video.id !== videoId)
      .slice(0, 20)
      .map(video => ({
        title: video.title || 'Unknown Title',
        url: video.url || `https://www.youtube.com/watch?v=${video.id}`,
        duration: video.duration || 0,
        thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || null,
        channel: video.channel || video.uploader || 'Unknown'
      }));
    
    res.json({ tracks });
  } catch (error) {
    console.error('YouTube radio error:', error);
    res.status(500).json({ error: 'Failed to get radio mix' });
  }
});

// API endpoint to add song to queue
app.post('/api/queue/add', async (req, res) => {
  const { url, title, duration, thumbnail, guildId, requestedBy: customRequestedBy } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  // Use custom requestedBy if provided (e.g., for Radio), otherwise use session username
  const requestedBy = customRequestedBy || req.session?.user?.username || 'Web Dashboard';
  const isRadio = customRequestedBy && customRequestedBy.toLowerCase().includes('radio');
  
  try {
    // Get full song info if needed
    let song = { url, title, duration, thumbnail, requestedBy, source: 'youtube' };
    
    if (!title) {
      const videoInfo = await ytDlpExec(url, {
        dumpSingleJson: true,
        noCheckCertificates: true,
        noWarnings: true,
        skipDownload: true
      });
      song = {
        title: videoInfo.title,
        url: videoInfo.webpage_url || url,
        duration: videoInfo.duration || 0,
        thumbnail: videoInfo.thumbnail,
        requestedBy,
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

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Web client connected');
  clients.add(ws);
  
  // Send current state immediately (include recently played from musicQueue)
  const stateWithRecentlyPlayed = { ...currentState, recentlyPlayed: getRecentlyPlayed() };
  ws.send(JSON.stringify({ type: 'state', data: stateWithRecentlyPlayed }));
  
  ws.on('close', () => {
    console.log('Web client disconnected');
    clients.delete(ws);
  });
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received from web client:', data);
      
      // Handle commands from web interface
      if (data.type === 'command') {
        handleWebCommand(data.command, data.guildId, data.username);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  });
});

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

function handleWebCommand(command, guildId, username = 'Web Dashboard') {
  if (commandHandler) {
    commandHandler(command, guildId);
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
    }
  }
}

// Start server
const PORT = process.env.WEB_PORT || 3000;

export function startWebServer() {
  server.listen(PORT, () => {
    console.log(`🌐 Web dashboard running at http://localhost:${PORT}`);
  });
}

export { currentState };

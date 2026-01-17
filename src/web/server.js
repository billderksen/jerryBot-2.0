import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import ytDlpPkg from 'yt-dlp-exec';
const ytDlpExec = ytDlpPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

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

// Serve static files
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// API endpoint to get current state
app.get('/api/state', (req, res) => {
  res.json(currentState);
});

// API endpoint to search for songs
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 2) {
    return res.json([]);
  }
  
  try {
    // Use yt-dlp for searching (more reliable than play-dl)
    const results = await ytDlpExec(`ytsearch10:${query}`, {
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

// API endpoint to add song to queue
app.post('/api/queue/add', async (req, res) => {
  const { url, title, duration, thumbnail, guildId } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  
  try {
    // Get full song info if needed
    let song = { url, title, duration, thumbnail, requestedBy: 'Web Dashboard', source: 'youtube' };
    
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
        requestedBy: 'Web Dashboard',
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
  
  // Send current state immediately
  ws.send(JSON.stringify({ type: 'state', data: currentState }));
  
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
        handleWebCommand(data.command, data.guildId);
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

function handleWebCommand(command, guildId) {
  if (commandHandler) {
    commandHandler(command, guildId);
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

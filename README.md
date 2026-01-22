# JerryBot 2.0

A feature-rich Discord bot with a web dashboard, music player, multiplayer games, and AI chat capabilities.

## Features

### Music Player
- **Web Dashboard** - Beautiful web interface to control music playback
- **YouTube Integration** - Play songs from YouTube URLs or search queries
- **Queue Management** - Add, remove, reorder, and shuffle songs
- **Playback Controls** - Play, pause, skip, previous, seek, volume control
- **Loop Modes** - Off, single track, or entire queue
- **24/7 Mode** - Keep the bot in voice channel
- **Radio Mode** - Auto-play similar songs when queue is empty
- **Sleep Timer** - Automatically stop playback after set time
- **Recently Played** - Browse up to 150 recent songs with search and filtering
- **Listening Stats** - Track play counts and listening time per song

### Multiplayer Games
- **Pesten** - Dutch card game with turn timers, animations, and bot players
- **Hitster** - Music guessing game where you build a timeline of songs by release year
- **Pictionary** - Drawing and guessing game with multiple brush tools and colors

### Other Features
- **AI Chat** - `/chat` command powered by OpenRouter API
- **Discord OAuth2** - Secure login with Discord, shows server nicknames
- **Real-time Updates** - WebSocket-based live updates across all connected clients
- **Activity Logging** - Track who played what and when
- **Persistent Storage** - Settings, stats, and history survive restarts

## Prerequisites

- Node.js 18.x or higher
- FFmpeg (for audio processing)
- yt-dlp (for YouTube downloads)
- A Discord bot token
- An OpenRouter API key (optional, for AI chat)

## Setup Instructions

### Linux Setup (Debian/Ubuntu)

```bash
# Make the setup script executable and run it
chmod +x setup-linux.sh
./setup-linux.sh
```

Or manually:
```bash
# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install FFmpeg
sudo apt install -y ffmpeg

# Install yt-dlp
sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod a+rx /usr/local/bin/yt-dlp

# Install build tools for native modules
sudo apt install -y build-essential python3

# Install npm dependencies
npm install
```

### Windows Setup

```bash
cd "c:\path\to\jerryBot 2.0"
npm install
```

Note: FFmpeg and yt-dlp binaries are bundled for Windows.

### Configure Environment Variables

Copy `.env.example` to `.env` and configure:

```env
# Discord Bot
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
GUILD_ID=your_server_id

# Discord OAuth2 (for web dashboard)
CLIENT_SECRET=your_discord_client_secret
OAUTH_REDIRECT_URI=http://localhost:3001/auth/discord/callback

# Access Control
REQUIRED_ROLE_ID=role_id_required_to_access_dashboard

# OpenRouter API (optional, for /chat command)
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4o

# Web Server
WEB_PORT=3001
```

### Deploy Slash Commands

```bash
npm run deploy
```

### Run the Bot

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## Project Structure

```
jerryBot 2.0/
├── src/
│   ├── commands/           # Discord slash commands
│   │   ├── chat.js         # AI chat command
│   │   ├── play.js         # Music play command
│   │   └── ...
│   ├── utils/
│   │   ├── musicQueue.js   # Music queue management
│   │   ├── activityLogger.js
│   │   ├── pestenGame.js   # Pesten card game logic
│   │   ├── hitsterGame.js  # Hitster game logic
│   │   └── pictionaryGame.js
│   ├── web/
│   │   ├── server.js       # Express + WebSocket server
│   │   └── public/         # Web dashboard files
│   │       ├── index.html  # Music player dashboard
│   │       ├── pesten.html # Pesten game
│   │       ├── hitster.html
│   │       ├── pictionary.html
│   │       └── stats.html  # Listening statistics
│   ├── index.js            # Main bot entry point
│   └── deploy-commands.js
├── data/                   # Persistent storage
│   ├── recentlyPlayed.json
│   ├── listeningStats.json
│   ├── playerSettings.json
│   └── ...
├── .env.example
├── package.json
└── README.md
```

## Web Dashboard

Access the web dashboard at `http://localhost:3001` (or your configured domain).

### Pages
- `/` - Music player with queue, controls, and recently played
- `/stats` - Listening statistics and play counts
- `/pesten` - Pesten card game
- `/hitster` - Hitster music game
- `/pictionary` - Pictionary drawing game

## Discord Commands

| Command | Description |
|---------|-------------|
| `/play <query>` | Play a song from YouTube |
| `/skip` | Skip the current song |
| `/queue` | Show the current queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/stop` | Stop playback and clear queue |
| `/volume <0-100>` | Set volume |
| `/chat <message>` | Chat with AI |

## Production Deployment

### Systemd Service

```bash
sudo nano /etc/systemd/system/jerrybot.service
```

```ini
[Unit]
Description=JerryBot Discord Bot
After=network.target

[Service]
Type=simple
User=your_username
WorkingDirectory=/path/to/jerrybot
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable jerrybot
sudo systemctl start jerrybot
```

### Nginx Reverse Proxy (HTTPS)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot --nginx -d yourdomain.com
```

## Troubleshooting

**Music not playing:**
- Check FFmpeg: `ffmpeg -version`
- Check yt-dlp: `yt-dlp --version`
- Update yt-dlp: `sudo yt-dlp -U`

**Bot not responding:**
- Run `npm run deploy` to register commands
- Check bot permissions in Discord server
- Verify tokens in `.env`

**Web dashboard login issues:**
- Verify `CLIENT_SECRET` and `OAUTH_REDIRECT_URI`
- Check redirect URL matches Discord Developer Portal settings
- Ensure user has the required role

**Port already in use:**
- Find process: `sudo lsof -i :3001`
- Change `WEB_PORT` in `.env`

## License

MIT

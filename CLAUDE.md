# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JerryBot 2.0 is a Discord bot with web dashboard featuring music playback, multiplayer games (Pesten, Hitster, Pictionary), and AI chat integration. Built with Discord.js v14, Express.js, and WebSocket for real-time updates.

## Commands

```bash
npm install          # Install dependencies
npm run deploy       # Register Discord slash commands (required after command changes)
npm start            # Production mode
npm run dev          # Development with auto-reload (--watch)
```

## Architecture

### Entry Points
- `src/index.js` - Discord bot bootstrap, loads commands dynamically from `src/commands/`
- `src/web/server.js` - Express + WebSocket server with Discord OAuth2

### Core Pattern: Callback Registration
The bot uses callback registration to connect components:
```javascript
// index.js registers handlers that utilities call
setCommandHandler(fn)           // Web dashboard triggers music commands
setActivityLoggerCallback(fn)   // Music queue broadcasts now-playing to Discord
setWebUpdateCallback(fn)        // State changes broadcast via WebSocket
setAddSongHandler(fn)           // Web dashboard adds songs to queue
```

### Key Modules
- `src/utils/musicQueue.js` - Audio playback engine (queue, seek, loop, 24/7 mode, radio auto-play)
- `src/utils/pictionaryGame.js` - Drawing game with room management
- `src/utils/pestenGame.js` - Dutch card game with bot AI players
- `src/utils/hitsterGame.js` - Music timeline guessing game
- `src/utils/activityLogger.js` - Logs user actions to Discord channel
- `src/utils/openrouter.js` - AI API wrapper for OpenRouter

### Data Flow
```
Discord Commands → src/commands/*.js → Utils → WebSocket broadcast → Web clients
Web Dashboard → Express API → Command Handler → Utils → WebSocket broadcast
```

### Persistence
JSON files in `data/` directory:
- `recentlyPlayed.json` - Song history (7-day window)
- `listeningStats.json` - Play counts per song
- `playerSettings.json` - User preferences (volume, loop mode)
- `*Leaderboard.json` - Game scores
- `sessions/` - Express session files

## Technical Details

- **ES Modules** - Uses `import`/`export` (not CommonJS)
- **Node.js 18+** required
- **External dependencies**: FFmpeg and yt-dlp (system binaries preferred, npm packages as fallback)
- **Real-time sync**: WebSocket broadcasts state to all connected web clients
- **Session persistence**: File-based sessions survive server restarts

## Environment Variables

Copy `.env.example` to `.env`. Required:
- `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` - Discord bot credentials
- `CLIENT_SECRET`, `OAUTH_REDIRECT_URI` - OAuth2 for web dashboard
- `REQUIRED_ROLE_ID` - Discord role required to access dashboard
- `WEB_PORT` - Web server port (default 3001)

Optional:
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` - AI chat feature

## Web Dashboard Routes

- `/` - Music player with queue and controls
- `/stats` - Listening statistics
- `/pesten`, `/hitster`, `/pictionary` - Multiplayer games

# CLAUDE.md — Jigsaw Puzzle Game

## Project Overview

Multiplayer web-hosted jigsaw puzzle game. Players join rooms from a lobby, collaborate (co-op) or race to complete puzzles, and track statistics. Supports guest play and accounts (Discord OAuth + username/password). Classic jigsaw piece shapes with knobs/holes, piece merging into groups, and real-time multiplayer with visible piece dragging.

## Tech Stack

- **Backend:** Node.js + Express 5 + WebSocket (ws) + SQLite (better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JS + HTML5 Canvas
- **Auth:** Passport.js (local strategy + Discord OAuth2)
- **Image processing:** Sharp (resize uploads)
- **Module system:** ES Modules (`import`/`export`)

## Commands

```bash
npm install          # Install dependencies
npm start            # Production mode
npm run dev          # Development with auto-reload
```

## Architecture

```
Browser (Canvas + vanilla JS)
    ↕ WebSocket (real-time: piece moves, locks, cursors, snaps)
    ↕ HTTP REST (auth, rooms, stats, image upload)
Express Server (src/server.js)
    ↕ better-sqlite3
SQLite Database (data/jigsaw.db)
```

- Server is authoritative for piece placement validation and scoring (anti-cheat)
- Puzzle piece shapes generated from deterministic seed (client-side cutting via bezier curves)
- WebSocket for all real-time interactions; REST for auth, rooms, stats, images
- Coordinate system: 1000x1000 unit board, pieces at `(col * pieceWidth, row * pieceHeight)`

## Key Files

### Server-side (`src/`)
- `server.js` — Express + HTTP + WebSocket server, middleware, static files, route mounting
- `db.js` — SQLite schema (users, stats, rooms, room_players, puzzle_images, puzzle_history)
- `auth.js` — Passport local + Discord OAuth2 strategies, register/login/logout/me routes
- `rooms.js` — Room CRUD API, active rooms Map, periodic cleanup interval
- `websocket.js` — WebSocket handler: join, start, lock, move, drop, unlock, chat, disconnect
- `upload.js` — Image upload with Sharp resize (max 2000px, 10MB limit)
- `stats.js` — Stats/leaderboard/history API routes
- `seedImages.js` — Scans `puzzle images/` and registers built-in images in DB

### Client-side (`public/js/`)
- `puzzleGenerator.js` — Seeded RNG, jigsaw edge generation, bezier curve Path2D creation
- `puzzleRenderer.js` — Canvas rendering: piece drawing with clipping, zoom/pan, hit testing
- `puzzleInteraction.js` — Mouse/touch input, drag, snap, piece groups, pinch-to-zoom
- `game.js` — Game orchestrator: ties renderer + interaction + network together
- `network.js` — WebSocket client with event emitter, auto-reconnect, throttled moves
- `lobby.js` — Room list, create room modal, image picker, guest flow, leaderboard tab
- `profile.js` — Profile page: stats cards, puzzle history

### Pages (`public/`)
- `index.html` — Lobby with room list and leaderboard tabs
- `game.html` — Game page with canvas, sidebar (desktop) / bottom drawer (mobile)
- `profile.html` — User profile with ranked/unranked stats and history
- `login.html` / `register.html` — Auth pages

## Game Modes

- **Co-op:** Shared board, piece locking with live drag visibility, individual scores per player
- **Race:** Each player gets their own independent board, progress bars shown, first to complete wins

## Scoring

- **Ranked:** Points from built-in images only (in `puzzle images/`). Stats accumulate on profile.
- **Unranked:** Points from user-uploaded images, tracked separately to prevent gaming via simple images.

## Piece Count Presets

| Preset | Grid | Pieces |
|--------|------|--------|
| 24 | 6x4 | 24 |
| 48 | 8x6 | 48 |
| 100 | 10x10 | 100 |
| 200 | 20x10 | 200 |

## Piece Mechanics

- Classic jigsaw shapes with knobs (outward) and holes (inward) via bezier curves
- Edge types generated from deterministic seed — all clients produce identical pieces
- Pieces merge into groups when correctly placed adjacent to each other
- Groups move as one unit when dragged
- Piece locking: server grants/denies lock requests, other players see pieces being dragged in real-time with player color/name

## WebSocket Protocol

Client → Server: `join`, `start`, `lock`, `move`, `drop`, `unlock`, `chat`
Server → Client: `joined`, `started`, `player_joined`, `player_left`, `locked`, `moved`, `placed`, `unlocked`, `completed`, `race_progress`, `race_complete`, `chat_msg`, `host_changed`, `error`

## Auth

- **Guest:** Temporary display name stored in sessionStorage, no persistent stats
- **Local:** Username (3-20 chars) + password (6+ chars), bcrypt hashed
- **Discord OAuth2:** Login with Discord, auto-creates account with Discord username + avatar
- Discord username collision: appends discriminator suffix if username is taken

## Environment Variables

Copy `.env.example` to `.env`. Required:
- `SESSION_SECRET` — Express session secret
- `PORT` — Web server port (default 3000)

Optional:
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` — Discord OAuth2

## Database

SQLite via better-sqlite3 with WAL mode. Database file at `data/jigsaw.db` (auto-created on first run).

Tables: `users`, `stats`, `rooms`, `room_players`, `puzzle_images`, `puzzle_history`

**Scaling note:** If the game grows large, migrate to PostgreSQL. The SQL is near-identical; switch the driver and connection config.

## API Routes

### Auth
- `POST /auth/register` — `{ username, password }` → `{ user }`
- `POST /auth/login` — `{ username, password }` → `{ user }`
- `POST /auth/logout` → `{ ok: true }`
- `GET /auth/me` → `{ user }` or `{ user: null }`
- `GET /auth/discord` — Start Discord OAuth flow
- `GET /auth/discord/callback` — OAuth callback

### Rooms
- `GET /api/rooms` — List active rooms
- `POST /api/rooms` — `{ name, mode, pieceCount, imageId, guestName? }` → `{ roomId }`
- `GET /api/rooms/:id` — Room details with players
- `DELETE /api/rooms/:id` — Delete room (authenticated host only)

### Images
- `GET /api/images` — List puzzle images
- `POST /api/upload` — Upload custom image (multipart form, 10MB max)

### Stats
- `GET /api/stats/:userId` — User stats
- `GET /api/stats/:userId/history` — Last 20 puzzles
- `GET /api/leaderboard` — Top 20 by ranked pieces

## Room Lifecycle

1. Host creates room → appears in lobby as "waiting"
2. Players join → see player list and image preview
3. Host starts → pieces scatter, game begins
4. Players drag/drop pieces → server validates placements
5. Puzzle complete → scores saved, completion screen
6. Auto-cleanup: 5 min after completion, 30 min inactivity

## TODO / Future Features

- **Roguelike elements/upgrades** — power-ups, modifiers, progression system (design TBD). Architecture should accommodate per-player modifiers.
- **Admin panel** — web UI for managing built-in puzzle images (upload, remove, reorder). Currently images are added manually to `puzzle images/` folder.
- **PostgreSQL migration** — when player base outgrows SQLite
- **Rate limiting** — uploads and WebSocket messages need rate limiting for production
- **Session store** — switch from MemoryStore to a persistent session store for production

## Maintenance Notes

- When adding new built-in puzzle images, place them in `puzzle images/` — they auto-register on server start via `seedImages.js`
- Keep this CLAUDE.md updated when making significant changes
- The coordinate system is 1000-based (board is 1000/cols wide per piece) — both server and client must agree
- Server uses mulberry32 PRNG for piece scattering; client uses LCG for piece shapes — these are independent concerns using the same seed

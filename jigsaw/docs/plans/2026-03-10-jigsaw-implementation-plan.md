# Jigsaw Puzzle Game — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multiplayer web-hosted jigsaw puzzle game with lobby, real-time co-op/race modes, accounts, and statistics.

**Architecture:** Express server with WebSocket (ws) for real-time puzzle interactions, REST API for auth/rooms/stats, HTML5 Canvas for puzzle rendering, SQLite for persistence. Server-authoritative piece placement validation.

**Tech Stack:** Node.js 20, Express 5, ws, better-sqlite3, passport, bcrypt, HTML5 Canvas, vanilla JS/CSS

---

## Phase 1: Project Scaffolding and Database

### Task 1: Initialize project and install dependencies

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`

**Step 1: Initialize npm project**

Run: `cd "/home/benin/Scripts/jerryBot 2.0/jigsaw" && npm init -y`

Then edit `package.json`:

```json
{
  "name": "jigsaw-puzzle",
  "version": "1.0.0",
  "description": "Multiplayer web-hosted jigsaw puzzle game",
  "main": "src/server.js",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js",
    "test": "node --test tests/**/*.test.js"
  }
}
```

**Step 2: Install dependencies**

Run:
```bash
npm install express ws better-sqlite3 passport passport-local passport-discord bcrypt dotenv express-session multer uuid sharp
```

**Step 3: Create `.env.example`**

```env
PORT=3000
SESSION_SECRET=change-me-to-a-random-string

# Discord OAuth2 (optional)
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://localhost:3000/auth/discord/callback
```

**Step 4: Create `.gitignore`**

```
node_modules/
data/*.db
uploads/*
!uploads/.gitkeep
.env
sessions/
```

**Step 5: Create directory structure**

```bash
mkdir -p src public/js public/css data uploads tests
touch uploads/.gitkeep
```

**Step 6: Commit**

```bash
git add -A
git commit -m "chore: initialize project with dependencies and folder structure"
```

---

### Task 2: Database schema and initialization

**Files:**
- Create: `src/db.js`
- Create: `src/seedImages.js`

**Step 1: Create database module**

`src/db.js` initializes SQLite and creates tables on first run:

```js
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'jigsaw.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    discord_id TEXT UNIQUE,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stats (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    ranked_pieces_placed INTEGER DEFAULT 0,
    ranked_puzzles_completed INTEGER DEFAULT 0,
    unranked_pieces_placed INTEGER DEFAULT 0,
    unranked_puzzles_completed INTEGER DEFAULT 0,
    total_time_played INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS puzzle_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_builtin BOOLEAN DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_user_id INTEGER REFERENCES users(id),
    host_guest_name TEXT,
    mode TEXT NOT NULL DEFAULT 'coop',
    piece_count INTEGER NOT NULL DEFAULT 24,
    image_id INTEGER REFERENCES puzzle_images(id),
    status TEXT NOT NULL DEFAULT 'waiting',
    is_ranked BOOLEAN DEFAULT 0,
    seed INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS room_players (
    room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    guest_name TEXT,
    pieces_placed INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS puzzle_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    room_id TEXT,
    image_name TEXT,
    piece_count INTEGER,
    pieces_placed INTEGER,
    mode TEXT,
    is_ranked BOOLEAN,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export default db;
```

**Step 2: Create built-in image seeder**

`src/seedImages.js`:

```js
import db from './db.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUZZLE_DIR = join(__dirname, '..', 'puzzle images');

export function seedBuiltinImages() {
  const files = readdirSync(PUZZLE_DIR).filter(f =>
    /\.(png|jpe?g|webp)$/i.test(f)
  );

  const insert = db.prepare(
    'INSERT OR IGNORE INTO puzzle_images (filename, display_name, is_builtin) VALUES (?, ?, 1)'
  );

  for (const file of files) {
    const displayName = file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    insert.run(file, displayName);
  }
}
```

**Step 3: Test database initialization**

Run: `node -e "import('./src/db.js').then(() => console.log('DB OK'))"`
Expected: "DB OK" and `data/jigsaw.db` created

**Step 4: Commit**

```bash
git add src/db.js src/seedImages.js data/
git commit -m "feat: add SQLite database schema and built-in image seeder"
```

---

## Phase 2: Express Server and Auth

### Task 3: Basic Express server with static files

**Files:**
- Create: `src/server.js`
- Create: `public/index.html` (minimal placeholder)
- Create: `public/css/style.css`

**Step 1: Create the Express server**

`src/server.js` — sets up Express, session middleware, static file serving, creates HTTP server and WebSocketServer (wired up later). Imports and runs `seedBuiltinImages()`. Listens on PORT from env.

**Step 2: Create minimal lobby placeholder page and base CSS**

Dark theme CSS with variables: `--bg-primary: #1a1a2e`, `--bg-secondary: #16213e`, `--bg-card: #0f3460`, `--accent: #e94560`, etc.

**Step 3: Test server starts**

Run: `node src/server.js`
Expected: "Jigsaw server running on port 3000"

**Step 4: Commit**

```bash
git add src/server.js public/
git commit -m "feat: add Express server with static file serving"
```

---

### Task 4: Local authentication (register, login, logout)

**Files:**
- Create: `src/auth.js`
- Modify: `src/server.js` — import and call `setupAuth(app)`

**Step 1: Create auth module**

`src/auth.js` exports `setupAuth(app)` which:
- Configures passport with serialize/deserialize (by user id)
- Adds LocalStrategy: looks up user by username, compares bcrypt hash
- Adds routes:
  - `POST /auth/register` — validate username (3-20 chars), password (6+ chars), check unique, hash password, insert user + stats, auto-login
  - `POST /auth/login` — passport local authenticate, return user JSON
  - `POST /auth/logout` — req.logout
  - `GET /auth/me` — return current user or null

**Step 2: Wire into server.js**

Add `import { setupAuth } from './auth.js'` and call `setupAuth(app)` after session middleware.

**Step 3: Commit**

```bash
git add src/auth.js src/server.js
git commit -m "feat: add local authentication (register, login, logout)"
```

---

### Task 5: Discord OAuth2 authentication

**Files:**
- Modify: `src/auth.js` — add Discord strategy and routes

**Step 1: Add Discord strategy**

Only initialize if `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` are set. Use `passport-discord` with scope `['identify']`. On callback: find or create user by discord_id, set avatar URL from Discord CDN.

Routes:
- `GET /auth/discord` — start OAuth flow
- `GET /auth/discord/callback` — handle callback, redirect to `/`

**Step 2: Commit**

```bash
git add src/auth.js
git commit -m "feat: add Discord OAuth2 authentication"
```

---

## Phase 3: Room Management and Lobby

### Task 6: Room CRUD API

**Files:**
- Create: `src/rooms.js`
- Modify: `src/server.js` — mount routes

**Step 1: Create room routes module**

`src/rooms.js` — Express Router with:
- `GET /api/rooms` — list non-completed rooms with player count and progress (from in-memory `activeRooms` Map)
- `POST /api/rooms` — create room: validate name, mode (coop/race), pieceCount (24/48/100/200), imageId. Generate UUID and random seed. Set is_ranked from image.is_builtin. Auto-add host as first player.
- `GET /api/rooms/:id` — room details with player list
- `GET /api/images` — list available puzzle images
- `DELETE /api/rooms/:id` — host-only room deletion

Export `activeRooms` Map for use by WebSocket handler.

**Step 2: Mount in server.js**

**Step 3: Commit**

```bash
git add src/rooms.js src/server.js
git commit -m "feat: add room CRUD API and image listing"
```

---

### Task 7: Lobby frontend

**Files:**
- Rewrite: `public/index.html` — full lobby UI
- Create: `public/js/lobby.js`
- Create: `public/css/lobby.css`
- Create: `public/login.html`
- Create: `public/register.html`

**Step 1: Build lobby page**

Header with game title, auth state (login/register buttons or username + logout).

Room list: cards showing room name, host, piece count, mode badge (co-op/race), player count, progress bar, ranked/unranked badge. Click to join.

"Create Room" button opens modal: room name input, piece count dropdown (24/48/100/200), mode toggle, image picker (grid of thumbnails from `/api/images`), optional file upload for custom image.

Guest name prompt when creating/joining without account.

Auto-refresh room list every 5 seconds via polling `/api/rooms`.

**Step 2: Build login and register pages**

Simple forms posting to `/auth/login` and `/auth/register`, redirect to lobby on success. Link to each other. Optional "Login with Discord" button.

**Step 3: Commit**

```bash
git add public/
git commit -m "feat: add lobby UI with room list, auth pages, and room creation"
```

---

### Task 8: Image upload for custom puzzles

**Files:**
- Create: `src/upload.js`
- Modify: `src/server.js` — mount upload route

**Step 1: Create upload handler**

`src/upload.js` — Express Router:
- `POST /api/upload` — multer single file upload, max 10MB, PNG/JPEG/WebP only
- Use `sharp` to resize if larger than 2000px on longest side
- Save to `uploads/` with UUID filename
- Insert into `puzzle_images` with `is_builtin = 0`
- Return `{ imageId, filename }`

**Step 2: Mount in server.js**

**Step 3: Commit**

```bash
git add src/upload.js src/server.js
git commit -m "feat: add image upload with validation and resizing"
```

---

## Phase 4: Puzzle Engine (Client-Side)

### Task 9: Puzzle piece shape generation

**Files:**
- Create: `public/js/puzzleGenerator.js`

**Step 1: Implement jigsaw piece shape generator**

Core algorithm:
1. Seeded RNG (deterministic from room seed so all clients generate identical shapes)
2. For the grid (cols x rows), generate edge types: each internal edge randomly gets knob direction
3. Each piece has 4 edges: top, right, bottom, left — each is flat (border), knob (+1), or hole (-1)
4. Each edge is drawn with bezier curves for classic jigsaw tab shape:
   - Start at edge start point
   - Line to ~35% along edge
   - Bezier curve outward (knob) or inward (hole) forming the tab
   - Line to edge end point
5. Export function: `generatePuzzlePieces(cols, rows, pieceWidth, pieceHeight, seed)` returns array of piece objects with `{ row, col, edges, createPath(offsetX, offsetY) }` where `createPath` returns a Path2D

The tab shape bezier curves should have enough "neck" to look like real jigsaw pieces (narrow neck, rounded bulb).

**Step 2: Commit**

```bash
git add public/js/puzzleGenerator.js
git commit -m "feat: add jigsaw piece shape generator with bezier curves"
```

---

### Task 10: Canvas puzzle renderer

**Files:**
- Create: `public/js/puzzleRenderer.js`

**Step 1: Implement PuzzleRenderer class**

```
class PuzzleRenderer {
  constructor(canvas, image, pieces, pieceWidth, pieceHeight)
```

Responsibilities:
- **drawPiece(piece, x, y, options)** — clip source image to piece shape via Path2D, draw border stroke. Options: `lifted` (add drop shadow + slight scale), `lockedBy` (colored outline + player name label), `opacity`.
- **drawBoard()** — clear canvas, apply zoom/pan transform matrix, draw target grid outline (faint), draw all placed pieces, then all unplaced pieces on top.
- **screenToBoard(x, y)** / **boardToScreen(x, y)** — coordinate conversion accounting for zoom and pan.
- **setZoom(zoom, centerX, centerY)** — zoom toward a point.
- **pan(dx, dy)** — pan the view.

The piece image is extracted by:
1. Creating a clipping path from the piece's Path2D (with extra padding for knobs)
2. Drawing the source image offset so the correct region aligns with the clip
3. Stroking the path for the piece border

**Step 2: Commit**

```bash
git add public/js/puzzleRenderer.js
git commit -m "feat: add Canvas puzzle renderer with zoom/pan support"
```

---

### Task 11: Piece interaction (drag, snap, merge groups)

**Files:**
- Create: `public/js/puzzleInteraction.js`

**Step 1: Implement PuzzleInteraction class**

```
class PuzzleInteraction {
  constructor(renderer, socket)
```

**Mouse events:**
- mousedown: hit-test pieces (unplaced first, check Path2D contains point), if hit → send lock request via WebSocket
- mousemove: if holding piece, move it (and its group), broadcast position
- mouseup: drop piece, check snap distance to correct position, send drop to server

**Touch events:**
- Single touch: same as mouse (drag pieces)
- Two-finger: pinch-to-zoom (track distance between touches) and pan (track midpoint movement)
- Prevent default touch behaviors on canvas

**Piece groups:**
- `groups` Map: groupId → Set of piece indices
- `pieceGroup` Map: pieceIndex → groupId
- When server confirms placement adjacent to another placed piece, merge groups
- Dragging any piece in a group moves all pieces in that group

**Snap logic:**
- Client-side: if piece center is within `snapDistance` of correct position, send drop request
- Server validates and confirms

**Hit testing:**
- Iterate pieces in reverse draw order (top to bottom)
- Use `ctx.isPointInPath(piece.path, x, y)` for accurate shape hit testing

**Step 2: Commit**

```bash
git add public/js/puzzleInteraction.js
git commit -m "feat: add piece interaction with drag, snap, and group merging"
```

---

## Phase 5: WebSocket Multiplayer

### Task 12: WebSocket server handler

**Files:**
- Create: `src/websocket.js`
- Modify: `src/server.js` — call `setupWebSocket(wss, sessionMiddleware)`

**Step 1: Implement WebSocket handler**

`src/websocket.js` exports `setupWebSocket(wss, sessionMiddleware)`.

**Message protocol (JSON):**

Client to Server:
- `{ type: "join", roomId, userId?, guestName? }`
- `{ type: "lock", pieceIndex }`
- `{ type: "move", pieceIndex, x, y }` (throttled by client ~15-20/sec)
- `{ type: "drop", pieceIndex, x, y }`
- `{ type: "unlock", pieceIndex }`
- `{ type: "start" }` (host only)
- `{ type: "chat", text }`

Server to Client:
- `{ type: "joined", playerId, players, puzzleState }` (full state on join)
- `{ type: "player_joined", player }`
- `{ type: "player_left", playerId }`
- `{ type: "locked", pieceIndex, playerId, playerName, playerColor }`
- `{ type: "moved", pieceIndex, x, y, playerId }`
- `{ type: "placed", pieceIndex, x, y, playerId, score, mergedGroup? }`
- `{ type: "unlocked", pieceIndex }`
- `{ type: "started", pieces[] }` (initial scattered positions)
- `{ type: "completed", scores[] }`
- `{ type: "chat_msg", playerId, name, text }`
- `{ type: "error", message }`

**Server-side puzzle state (in activeRooms Map):**
```js
{
  pieces: [{ index, correctCol, correctRow, currentX, currentY, placed, lockedBy }],
  placedCount: 0,
  players: Map<playerId, { ws, userId, guestName, username, color, score }>,
  started: false,
  grid: { cols, rows },
  pieceWidth, pieceHeight,
  imageFilename, isRanked, mode
}
```

**Key logic:**
- On "join": add player to room, assign color, send current state
- On "start": generate scattered positions for all pieces, broadcast to all
- On "lock": if piece not already locked/placed, lock it, broadcast
- On "move": broadcast to all other players (don't echo back to sender)
- On "drop": validate position against correct position (within threshold). If correct: mark placed, increment score, check for adjacent placed pieces for group merging, broadcast "placed". If incorrect: broadcast "unlocked".
- On disconnect: unlock all pieces held by player, broadcast player_left
- On completion (all pieces placed): calculate final scores, update database stats, broadcast "completed"

**Piece scattering algorithm (on game start):**
- Define a scattering area around the board (e.g. 1.5x the board dimensions)
- Randomly place pieces within this area, using the room's seed for determinism
- Ensure pieces don't overlap significantly (basic grid-based distribution with jitter)

**Step 2: Wire into server.js**

```js
import { setupWebSocket } from './websocket.js';
setupWebSocket(wss, sessionMiddleware);
```

**Step 3: Commit**

```bash
git add src/websocket.js src/server.js
git commit -m "feat: add WebSocket server for real-time multiplayer puzzle state"
```

---

### Task 13: Client-side WebSocket and game page

**Files:**
- Create: `public/js/network.js`
- Create: `public/js/game.js`
- Create: `public/game.html`
- Create: `public/css/game.css`

**Step 1: Create WebSocket client wrapper**

`public/js/network.js`:
- Connect to `ws://host/ws?roomId=X`
- Event emitter pattern: `on(type, callback)` for each message type
- `send(type, data)` helper
- Auto-reconnect with exponential backoff
- Throttle outgoing "move" messages to ~60ms intervals

**Step 2: Create game orchestrator**

`public/js/game.js`:
- Load room data via REST (`/api/rooms/:id`)
- Load puzzle image
- Generate pieces using `puzzleGenerator.js` with room's seed
- Create `PuzzleRenderer` and `PuzzleInteraction`
- Wire network events:
  - `locked` → highlight piece with player color
  - `moved` → update piece position, redraw
  - `placed` → snap piece, update score, check group merge
  - `player_joined/left` → update player list
  - `started` → set initial piece positions, enable interaction
  - `completed` → show results overlay
- Wire interaction events → network sends
- Render loop: requestAnimationFrame for smooth updates

**Step 3: Create game page HTML**

`public/game.html`:
- Full viewport layout
- Canvas element (main area)
- Sidebar (desktop): player list with colors + scores, progress bar, timer, chat input + messages
- Piece count / completion percentage display

**Step 4: Create game CSS**

Desktop: canvas ~75% width, sidebar 25%. Mobile (< 768px): canvas full width, bottom drawer.

**Step 5: Commit**

```bash
git add public/js/ public/game.html public/css/game.css
git commit -m "feat: add game page with WebSocket client and multiplayer rendering"
```

---

## Phase 6: Race Mode

### Task 14: Race mode implementation

**Files:**
- Modify: `src/websocket.js` — race mode state and logic
- Modify: `public/js/game.js` — race mode UI

**Server changes:**
- For race mode, create separate puzzle state per player (same seed/scatter, independent placement tracking)
- Each player only interacts with their own pieces
- No piece locking needed (each player has their own set)
- Broadcast progress: `{ type: "race_progress", playerId, progress }` (0-100%)
- First to complete: `{ type: "race_complete", winner, finalScores }`

**Client changes:**
- In race mode, only render own pieces
- Show progress bars for all players (overlay or sidebar)
- Disable seeing other players' piece movements
- Show completion celebration when someone finishes

**Step: Commit**

```bash
git add src/websocket.js public/js/game.js
git commit -m "feat: add race mode with per-player boards and progress tracking"
```

---

## Phase 7: Stats and Profile

### Task 15: Stats API and profile page

**Files:**
- Create: `src/stats.js`
- Create: `public/profile.html`
- Create: `public/js/profile.js`
- Create: `public/css/profile.css`
- Modify: `src/server.js` — mount stats routes

**Step 1: Create stats API**

`src/stats.js` — Express Router:
- `GET /api/stats/:userId` — return user stats (ranked + unranked separately)
- `GET /api/stats/:userId/history` — return last 20 puzzle_history entries
- `GET /api/leaderboard` — top 20 players by ranked_pieces_placed, with username

**Step 2: Update WebSocket completion handler**

When puzzle completes, for each logged-in player:
- Update `stats` table: increment ranked or unranked pieces_placed and puzzles_completed
- Insert into `puzzle_history`

**Step 3: Build profile page**

- User info header (username, avatar, join date)
- Two stat cards: Ranked (pieces placed, puzzles completed, avg per puzzle) and Unranked (same)
- Recent puzzle history table (image name, pieces, score, mode, date)

**Step 4: Add leaderboard to lobby**

Add a leaderboard section/tab to the lobby page showing top players.

**Step 5: Commit**

```bash
git add src/stats.js public/profile.html public/js/profile.js public/css/profile.css src/server.js src/websocket.js
git commit -m "feat: add player stats, profile page, and leaderboard"
```

---

## Phase 8: Mobile Optimization

### Task 16: Responsive layout and touch controls

**Files:**
- Modify: `public/css/game.css` — responsive breakpoints
- Modify: `public/css/lobby.css` — responsive lobby
- Modify: `public/css/style.css` — responsive base
- Modify: `public/js/puzzleInteraction.js` — touch refinements

**CSS changes:**
- `@media (max-width: 768px)`: game sidebar becomes bottom drawer with drag handle to show/hide
- Lobby: room cards stack vertically, full-width create button, image picker becomes scrollable row
- Profile: single column layout

**Touch refinements:**
- Improve pinch-to-zoom smoothness (track gesture start distance, compute scale ratio)
- Add momentum/inertia to pan gestures
- Ensure piece hit testing works accurately with touch coordinates
- Add `touch-action: none` on canvas to prevent browser gestures
- Floating action buttons (zoom reset, center board) positioned for thumb reach

**Step: Commit**

```bash
git add public/css/ public/js/puzzleInteraction.js
git commit -m "feat: add responsive layout and touch controls for mobile"
```

---

## Phase 9: Polish and Final Integration

### Task 17: In-room chat

**Files:**
- Modify: `src/websocket.js` — chat message handling
- Modify: `public/js/game.js` — chat UI rendering

**Implementation:**
- Client sends `{ type: "chat", text }` (max 200 chars, sanitize HTML)
- Server broadcasts `{ type: "chat_msg", playerId, name, text, color }`
- Chat messages displayed in sidebar/drawer with player color coding
- No persistence — messages only exist while room is active

**Step: Commit**

```bash
git add src/websocket.js public/js/game.js
git commit -m "feat: add in-room text chat"
```

---

### Task 18: Room cleanup and disconnect handling

**Files:**
- Modify: `src/websocket.js` — cleanup logic
- Modify: `src/rooms.js` — periodic cleanup

**Implementation:**
- Player disconnect: unlock all held pieces, broadcast `player_left`, remove from room
- Host disconnect: migrate host to next player; if no players left, mark room for cleanup
- Room auto-delete: 5 minutes after completion, 30 minutes of inactivity (no WebSocket connections)
- Periodic cleanup interval (every 5 minutes) checks for stale rooms in DB
- Prevent duplicate connections: if same user/guest joins a room they're already in, close old connection

**Step: Commit**

```bash
git add src/websocket.js src/rooms.js
git commit -m "feat: add room cleanup, host migration, and disconnect handling"
```

---

### Task 19: Piece tray and scattered initial state

**Files:**
- Modify: `public/js/puzzleRenderer.js` — piece tray rendering
- Modify: `public/js/game.js` — piece tray interaction

**Implementation:**
- Piece tray: scrollable area below/around the board where unplaced pieces sit
- When game starts, pieces appear scattered in the tray area
- Players drag from tray to board
- On desktop: tray is a strip below the canvas or around the board edges
- On mobile: tray is in a collapsible bottom section
- As pieces get placed, tray shrinks

**Step: Commit**

```bash
git add public/js/
git commit -m "feat: add piece tray for unplaced pieces"
```

---

### Task 20: Final testing and documentation

**Files:**
- Modify: `CLAUDE.md` — final update with all features documented

**Steps:**
1. Test full flow: register, create room, join, play co-op, complete, check stats/profile
2. Test guest flow: play as guest, verify no stats saved
3. Test race mode with 2+ players
4. Test mobile (Chrome DevTools device mode): touch drag, pinch zoom, bottom drawer
5. Test ranked vs unranked scoring (built-in image vs uploaded image)
6. Test 200-piece puzzle performance
7. Test Discord OAuth (if credentials configured)
8. Update CLAUDE.md with final state of all features

**Step: Commit**

```bash
git add -A
git commit -m "chore: final documentation and testing"
```

---

## Implementation Order Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | 1-2 | Project setup, database schema |
| 2 | 3-5 | Express server, local auth, Discord OAuth |
| 3 | 6-8 | Room API, lobby UI, image upload |
| 4 | 9-11 | Puzzle engine (shapes, rendering, interaction) |
| 5 | 12-13 | WebSocket multiplayer |
| 6 | 14 | Race mode |
| 7 | 15 | Stats and profile |
| 8 | 16 | Mobile optimization |
| 9 | 17-20 | Chat, cleanup, polish |

Total: 20 tasks across 9 phases.

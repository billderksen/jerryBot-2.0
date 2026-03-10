# Jigsaw Puzzle Game — Design Document

**Date:** 2026-03-10

## Overview

A web-hosted multiplayer jigsaw puzzle game. Players join rooms from a lobby, collaborate or race to complete puzzles, and track their statistics over time. Supports guest play and accounts (Discord OAuth + username/password).

## Tech Stack

- **Backend:** Node.js + Express + WebSocket (ws)
- **Frontend:** Vanilla HTML/CSS/JS + HTML5 Canvas
- **Database:** SQLite (via better-sqlite3)
- **Auth:** Passport.js with local strategy + Discord OAuth2

## Architecture

```
Browser (Canvas + vanilla JS)
    ↕ WebSocket (real-time: piece moves, locks, cursors, snaps)
    ↕ HTTP REST (auth, rooms, stats, image upload)
Express Server (Node.js)
    ↕ better-sqlite3
SQLite Database
```

- WebSocket handles all real-time puzzle interactions
- REST API for auth, room CRUD, stats, leaderboards
- Canvas rendering for the puzzle board
- Puzzle piece cutting (jigsaw shapes with knobs/holes) done client-side from source image
- Server is authoritative for piece placement validation and scoring (prevents cheating)

## Data Model

### Users
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| username | TEXT UNIQUE | |
| password_hash | TEXT | Nullable (Discord-only users) |
| discord_id | TEXT UNIQUE | Nullable (local-only users) |
| avatar_url | TEXT | |
| created_at | DATETIME | |

### Stats
| Column | Type | Notes |
|--------|------|-------|
| user_id | INTEGER FK | |
| ranked_pieces_placed | INTEGER | Built-in image puzzles |
| ranked_puzzles_completed | INTEGER | |
| unranked_pieces_placed | INTEGER | User-uploaded image puzzles |
| unranked_puzzles_completed | INTEGER | |
| total_time_played | INTEGER | Seconds |

### Rooms
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| name | TEXT | |
| host_user_id | INTEGER FK | |
| mode | TEXT | "coop" or "race" |
| piece_count | INTEGER | 24, 48, 100, or 200 |
| image_id | INTEGER FK | |
| status | TEXT | "waiting", "playing", "completed" |
| is_ranked | BOOLEAN | Derived from image.is_builtin |
| created_at | DATETIME | |

### Puzzle Images
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| filename | TEXT | |
| display_name | TEXT | |
| is_builtin | BOOLEAN | true = ranked eligible |
| uploaded_by | INTEGER FK | Nullable for built-in |

### Room Players (scores per room)
| Column | Type | Notes |
|--------|------|-------|
| room_id | TEXT FK | |
| user_id | INTEGER FK | Nullable for guests |
| guest_name | TEXT | For guest players |
| pieces_placed | INTEGER | |
| joined_at | DATETIME | |

## Game Modes

### Co-op (default)
- Shared board, all players work on one puzzle
- Individual piece-placement scores tracked
- Piece locking: picking up a piece locks it for that player, visible to all

### Race
- Each player gets their own board with identical piece layout
- First to complete wins
- Progress bars shown for all players

## Piece Mechanics

- Classic jigsaw shapes with knobs (outward) and holes (inward); flat edges on borders
- Edge shapes generated from a deterministic seed — all clients produce identical pieces
- **Merging groups:** When two adjacent correctly-placed pieces are next to each other, they merge into a group that moves as one unit
- **Piece locking with live drag visibility:**
  1. Player picks up a piece → server locks it → all clients see the piece "lift" (scale-up + shadow) with player's color/name tag
  2. Drag position broadcast via WebSocket (~15-20 updates/sec, throttled)
  3. Drop: if correct → snap + score + broadcast; if not → stays where dropped, lock released
- **Server-side validation:** Server confirms correct placement, awards points, broadcasts snap

## Piece Count Presets

| Preset | Grid | Total Pieces |
|--------|------|-------------|
| 24 | 6x4 | 24 |
| 48 | 8x6 | 48 |
| 100 | 10x10 | 100 |
| 200 | 20x10 | 200 |

## Scoring

### Ranked (built-in images only)
- 1 point per correctly placed piece
- Stats accumulate on user profile

### Unranked (user-uploaded images)
- Same scoring mechanics
- Tracked separately in stats to prevent gaming via simple images

## Auth

- **Guest:** Temporary display name, no persistent stats
- **Local account:** Username + password (bcrypt hashed)
- **Discord OAuth2:** Login with Discord account
- Users with both Discord and local can link them (same user record)

## Lobby & Room Flow

1. **Lobby** — lists active rooms: name, host, piece count, mode, player count, progress %, ranked/unranked badge
2. **Create Room** — form: room name, piece count, mode (co-op/race), image (built-in or upload custom)
3. **Waiting room** — image preview + player list, host starts when ready
4. **Playing** — puzzle board with sidebar/drawer
5. **Completed** — results screen with scores
6. Auto-cleanup after completion or inactivity timeout

## Frontend Layout

### Desktop
- Puzzle board (Canvas, ~75% width)
- Right sidebar: player list (colors, scores), chat, puzzle info (piece count, progress, timer)

### Mobile
- Full-screen puzzle board with pinch-to-zoom and pan
- Bottom drawer (swipe up) for player list, chat, puzzle info
- Floating action buttons for zoom reset and piece tray

### Visual Style
- Clean, modern, dark background (puzzle image pops)
- Each player gets a distinct color for cursor, piece highlights, and name tags
- Piece tray: scrollable area around/below the board for unplaced pieces

## Profile Page (logged-in users only)

- Username, avatar, account creation date
- Ranked stats: pieces placed, puzzles completed
- Unranked stats: separate tracking
- Recent puzzle history

## Future Considerations

- **Roguelike elements/upgrades** — to be designed later, architecture should accommodate power-ups/modifiers per player
- **Admin panel** — web UI for managing built-in puzzle images (upload, remove, reorder)
- **PostgreSQL migration** — SQLite chosen for simplicity; migration to PostgreSQL is straightforward if the game scales up (near-identical SQL, switch the driver)

# CLAUDE.md — Jigsaw Puzzle Game

## Project Overview

Multiplayer web-hosted jigsaw puzzle game. Players join rooms from a lobby, collaborate (co-op) or race to complete puzzles, and track statistics. Supports guest play and accounts (Discord OAuth + username/password).

## Tech Stack

- **Backend:** Node.js + Express + WebSocket (ws) + SQLite (better-sqlite3)
- **Frontend:** Vanilla HTML/CSS/JS + HTML5 Canvas
- **Auth:** Passport.js (local strategy + Discord OAuth2)
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
Express Server
    ↕ better-sqlite3
SQLite Database (data/jigsaw.db)
```

- Server is authoritative for piece placement validation and scoring
- Puzzle piece shapes generated from deterministic seed (client-side cutting)
- WebSocket for all real-time interactions; REST for everything else

## Key Directories

- `src/` — Server-side code
- `public/` — Frontend (HTML, CSS, JS)
- `public/js/` — Client-side modules (canvas, pieces, networking, UI)
- `puzzle images/` — Built-in puzzle images (ranked play)
- `uploads/` — User-uploaded puzzle images (unranked play)
- `data/` — SQLite database
- `docs/plans/` — Design documents

## Game Modes

- **Co-op:** Shared board, piece locking with live drag visibility, individual scores
- **Race:** Each player gets their own board, first to complete wins

## Scoring

- **Ranked:** Points from built-in images only (in `puzzle images/`)
- **Unranked:** Points from user-uploaded images, tracked separately to prevent gaming

## Piece Count Presets

24 (6x4), 48 (8x6), 100 (10x10), 200 (20x10)

## Auth

- Guest: temporary display name, no persistent stats
- Local: username + password (bcrypt)
- Discord OAuth2: login with Discord
- Users can link Discord + local accounts

## Environment Variables

Copy `.env.example` to `.env`. Required:
- `SESSION_SECRET` — Express session secret
- `PORT` — Web server port (default 3000)

Optional:
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` — Discord OAuth2

## Database

SQLite via better-sqlite3. Database file at `data/jigsaw.db`.

Tables: users, stats, rooms, room_players, puzzle_images

**Scaling note:** If the game grows large, migrate to PostgreSQL. The SQL is near-identical; switch the driver and connection config. Use a query builder or keep raw SQL compatible with both.

## TODO / Future Features

- **Roguelike elements/upgrades** — power-ups, modifiers, progression system (design TBD)
- **Admin panel** — web UI for managing built-in puzzle images (upload, remove, reorder)
- **PostgreSQL migration** — when player base outgrows SQLite

## Maintenance Notes

- When adding new built-in puzzle images, place them in `puzzle images/` and register them in the database
- Keep this CLAUDE.md updated when making significant changes

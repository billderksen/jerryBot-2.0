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
npm test             # Run the test suite (node --test test/)
```

## Architecture

### Entry Points
- `src/index.js` - Discord bot bootstrap, loads commands dynamically from `src/commands/`
- `src/web/server.js` - Express + WebSocket server with Discord OAuth2
- `src/loadEnv.js` - Loads `.env` into `process.env`; must be the literal first import in any entry-point-adjacent file (`index.js`, `web/server.js`) so it runs before other imports' subtrees evaluate

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
- `src/utils/musicQueue.js` - Audio playback engine (queue, seek, loop, 24/7 mode, server-side radio auto-play — runs in the queue itself, no browser tab needed). All YouTube search/playback goes through the system `yt-dlp` binary (play-dl was removed)
- `src/utils/queueState.js` - Queue snapshot file IO + the pure restore arithmetic (staleness, position clamp, join/hold decision). See [Queue Persistence](#queue-persistence-surviving-a-restart)
- `src/utils/voiceRecorder.js` - Streams a target user's voice channel audio to disk (`.wav`), 30-minute hard cap
- `src/utils/pictionaryGame.js` - Drawing game with room management
- `src/utils/pestenGame.js` - Dutch card game with bot AI players
- `src/utils/plaatjeGame.js` - HITSTER room state machine, round rules, and leaderboard persistence (see [Hitster](#hitster-muziek-tijdlijnspel)). Internal modules, WS message prefixes (`plaatje:*`), API routes (`/api/plaatje/*`), and data files keep the historical working name `plaatje*` — only what users see is HITSTER
- `src/utils/plaatjeAudio.js` - HITSTER song pool, gated clip download, and Jerry-in-VC playback
- `src/utils/plaatjeText.js` - HITSTER fuzzy guess matching and playlist-import title parsing (pure, no IO)
- `src/utils/activityLogger.js` - Logs user actions to Discord channel
- `src/utils/openrouter.js` - AI API wrapper for OpenRouter; model/prompt/token settings persisted in `data/aiSettings.json`, editable via the admin panel
- `src/utils/levelSystem.js` - XP/level system rewarding message and voice activity
- `src/utils/birthdayTracker.js` - Birthday persistence + daily announcement scheduler
- `src/utils/reminderTracker.js` - Reminder persistence + per-reminder setTimeout scheduling (delays beyond ~24.8 days are chained to avoid Node's setTimeout overflow; failed deliveries are retried)
- `src/utils/triviaGame.js` - The Trivia API integration, leaderboard persistence, session management
- `src/utils/lastSeenTracker.js` - Tracks user last-seen timestamps (messages, presence, voice)
- `src/utils/f1Predictions.js` - F1 fantasy predictions (driver/race data, scoring, Jolpica API integration)
- `src/utils/teamspeakStatus.js` - TeamSpeak 6 user count → Discord voice channel name (currently disabled on this host — see [TeamSpeak Status Channel](#teamspeak-status-channel))
- `src/utils/voiceAssistant.js` - "Hey Jerry" orchestrator: opt-in store, receiver subscriptions, wake pipeline, intent dispatch (see [Hey Jerry Voice Assistant](#hey-jerry-voice-assistant))
- `src/utils/speech/wakeword.js` - Node wrapper around the openWakeWord Python sidecar (`scripts/wakeword_sidecar.py`), 16 audio slots, auto-respawn
- `src/utils/speech/transcribe.js` - Speech-to-text via Groq's hosted Whisper; throws `TranscribeError` with a `.stage`
- `src/utils/speech/intent.js` - Transcript → intent: offline Dutch fast path, then an OpenRouter JSON-mode fallback; never rejects
- `src/utils/speech/tts.js` - Piper text-to-speech + the wake beep, serialized per guild and ducked over the music
- `src/web/public/js/common.js` - Shared frontend module (escapeHtml, nav, reconnecting WebSocket, toasts) used by all 13 dashboard pages

### Data Flow
```
Discord Commands → src/commands/*.js → Utils → WebSocket broadcast → Web clients
Web Dashboard → Express API → Command Handler → Utils → WebSocket broadcast
```

### Persistence
JSON files in `data/` directory:
- `recentlyPlayed.json` - Song history (7-day window)
- `listeningStats.json` - Play counts per song
- `playerSettings.json` - Shared player settings (loop mode, 24/7, radio, sleep timer, mixer filters, `normalizeAudio`, `crossfadeSec`)
- `queueState.json` - The live music queue, so a restart can put it back (see [Queue Persistence](#queue-persistence-surviving-a-restart))
- `*Leaderboard.json` - Game scores
- `levels.json` - User XP, levels, and role rewards
- `birthdays.json` - User birthdays and announcement channel config
- `reminders.json` - Pending reminders with fire timestamps
- `triviaLeaderboard.json` - Trivia game player stats
- `lastSeen.json` - User last-seen timestamps (messages, presence, voice)
- `f1Predictions.json` - F1 fantasy predictions, results cache, season standings
- `aiSettings.json` - AI chat model/system prompt/max tokens, editable via the admin panel (persisted here, not env vars)
- `voiceAssistant.json` - "Hey Jerry" opt-in consent list (`{ optedIn: { [userId]: { since } } }`)
- `commandLog.txt` - Slash command usage log
- `sessions/` - Express session files

## Technical Details

- **ES Modules** - Uses `import`/`export` (not CommonJS)
- **Node.js 20+** required (see `engines` in `package.json`)
- **External dependencies**: FFmpeg and the system `yt-dlp` binary (auto-updated daily by a system timer; play-dl was removed, all YouTube search/playback/radio goes through yt-dlp)
- **Real-time sync**: WebSocket broadcasts state to all connected web clients
- **Session persistence**: File-based sessions survive server restarts
- **Graceful shutdown**: SIGINT/SIGTERM (and uncaughtException) flush levelSystem, discordTracker, lastSeen, and listening-stats state to disk before exit. `pm2 restart` is safe; `ecosystem.config.cjs` sets `kill_timeout: 8000` to give the flush time to finish before SIGKILL

## Environment Variables

Copy `.env.example` to `.env`. Required:
- `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID` - Discord bot credentials
- `CLIENT_SECRET`, `OAUTH_REDIRECT_URI` - OAuth2 for web dashboard
- `REQUIRED_ROLE_ID` - Discord role required to access dashboard
- `WEB_PORT` - Web server port (default 3001)
- `SESSION_SECRET` - Session cookie signing secret (`openssl rand -hex 32`); **the bot refuses to boot without this set**

Optional:
- `OPENROUTER_API_KEY` - AI chat feature (model/prompt/tokens are configured separately in `data/aiSettings.json` via the admin panel, not env vars)
- `YOUTUBE_COOKIES` / `YOUTUBE_COOKIES_BROWSER` - Improves radio variety with authenticated YouTube access
- `TS6_API_KEY`, `TS6_STATUS_CHANNEL_ID` - TeamSpeak status voice channel (currently unset/disabled on this host)
- `GENERAL_CHANNEL_ID`, `ACTIVITY_LOG_CHANNEL_ID`, `DJ_ROLE_ID`, `BOT_ADMIN_USER_ID` - Overrides for IDs that otherwise fall back to in-code literals (level-up/anti-offline announcements, activity log channel, streamer/recap DJ role gate, OSRS tracker admin gate)
- `GROQ_API_KEY` - Speech-to-text for "Hey Jerry". Without it the whole voice assistant is skipped at startup
- `WAKEWORD_MODEL_PATH`, `WAKEWORD_THRESHOLD` - Wake-word model override (default `tools/models/hey_jarvis_v0.1.onnx`) and detection threshold 0.0-1.0 (default 0.5)

Piper TTS deliberately has **no** env overrides: `scripts/setup-voice.sh` installs it at the fixed paths `tools/piper/piper` and `tools/piper/nl_voice.onnx`, and `tts.js` looks only there.

## Web Dashboard Routes

- `/` - Music player with queue and controls
- `/stats` - Listening statistics
- `/pesten`, `/hitster`, `/pictionary` - Multiplayer games (`/plaatje` redirects to `/hitster`)
- `/trivia` - Trivia leaderboard
- `/f1` - F1 Predictions fantasy league (race calendar, predictions, leaderboard)
- `/birthdays` - Birthday calendar (month grid view of all registered birthdays)
- `/admin` - Bot control panel (requires Control Panel role, manages birthday/recap/twitch/activity-log channels, AI chat model/prompt/tokens, OSRS tracker players, music status, server overview)

All routes except `/login` and the OAuth callback go through `requireAuth`: unauthenticated requests get a JSON `401` under `/api/*` and a `302` redirect to `/login` for page routes.

## Queue Persistence (surviving a restart)

The music queue is written to `data/queueState.json` and read back at startup, so a deploy or a crash mid-song does not end the evening.

**Writers** — `flushQueueState()` from `index.js`'s `flushState()` (synchronous, no awaits: it also runs on `uncaughtException`), plus a 5s-debounced `scheduleQueueStateSave()` on every meaningful mutation and a 10s refresh while a song plays. The refresh is what a SIGKILL/crash falls back on, and it keeps the saved position fresh — a crash resumes up to 10s **early**, never late. `saveQueueStateNow()` writes immediately without the shutdown latch.

**Snapshot** (per guild): current song, queue, pause-corrected position in seconds, volume, voice channel id, whether the user had paused, and a timestamp. `queue.snapshot()` builds it; a song with no URL is dropped.

**Restore** — `restoreQueueState()` runs once from `ClientReady` (after `initVoiceAssistant`, so the join is seen by the assistant's own voice-state listener). `planQueueRestore()` in `queueState.js` makes the whole decision:

| Situation | What happens |
|---|---|
| Snapshot > 30 min old, or untimestamped | Discarded with a log |
| Humans in the saved channel | Join, restore the queue, resume the song from its saved position (clamped to `duration - 1`) via `play({ startAtSeconds })` |
| Channel empty of humans, channel gone, user had paused, or nothing was playing | Restore the queue only — no join, no playback, logged with the reason |
| A `/play` got there first | Left alone |

The file is cleared before the restore acts on it (a restore that crashed would otherwise be retried forever) and on a user `/stop` or `leave()` — a restart must not undo a decision somebody made. A connection that dies on its own deliberately leaves it in place.

A restored-but-not-joined queue exists without a voice connection, which is why `play.js`, `playlist.js` and `index.js`'s `handleAddSong` all join when `!queue.connection` rather than only when the queue is new.

## 24/7 Auto-Rejoin

With 24/7 mode **on**, an unrecoverable voice connection error still tears down cleanly (normal mode is unchanged — queue stopped, bot out) and then tries to get back: a snapshot is taken at teardown time, written to disk, and `scheduleRejoin()` retries the same channel at 10s, 30s, 60s, then every 5 min, giving up at 30 min (8 attempts, the last at ~26.7 min). On success it rejoins and resumes the interrupted song from where it stopped, reusing the same restore plan with the age and audience checks turned off.

Attempts abort instantly if: someone starts music in that guild (`createQueue` cancels the pending rejoin), 24/7 is toggled off (`toggle24_7`), or the bot shuts down (`flushQueueState`). Every attempt re-checks all of it, and again after the join lands — a join can take 15s, plenty of time for a `/play` to claim the queue. A failed attempt leaves no queue holding a dead connection.

Pure helpers, all tested: `planRejoinDelay(attempt, elapsedMs)`, `rejoinAbortReason({...})`. `isRejoinPending(guildId)` says whether an effort is in flight.

## Audio: Loudness Normalization and Crossfade

Both live in `src/utils/musicQueue.js` and are configured by editing `data/playerSettings.json`
(no UI yet). Both default ON; a missing or malformed value reads as the default, and only an
explicit `0` / `false` turns one off.

| Setting | Default | Meaning |
|---|---|---|
| `normalizeAudio` | `true` | EBU R128 loudness normalization to I=-16 LUFS, TP=-1.5, LRA=11 |
| `crossfadeSec` | `2.5` | Fade length between songs, in seconds. `0` = off, max 12 |

### Loudness normalization
Two-pass loudnorm without re-encoding anything. The **prefetch** download decodes the finished
file once with `loudnorm=...:print_format=json` and the measured values are kept, keyed by the
/tmp path they describe; at playback they are handed to `loudnorm` in the ffmpeg that already
runs, which makes its single pass equivalent to a real second pass.

The analysis pass costs ~8.6s of CPU per 4-minute track, so it runs **only on the background
prefetch**, never on the play-path download (that would be seconds of silence with somebody
waiting). A song the queue had to fetch on the spot - the first song of a session, or a rapid
skip - plays unnormalized. Any measurement failure logs and plays unnormalized; nothing here can
keep a song from starting. Playback itself costs ~3.6% of one core.

A song claiming its prefetch (`takePrefetched`) **kills an analysis still in flight** and plays
unnormalized, rather than making the start wait out the pass - otherwise a skip in the first ~10s
of a song blocks the next start for up to the whole 120s measurement timeout. An aborted or
timed-out pass answers `null` **even if ffmpeg printed a summary**: SIGTERM'd ffmpeg still prints
loudnorm's numbers for the part of the file it processed, and a level measured from half a second
of a song is worse than no level at all.

### Crossfade
At `[duration - crossfadeSec]` a single ffmpeg is spawned with two file inputs joined by
`acrossfade`, and its output replaces the resource the player holds. Scheduling is derived from
the pause-corrected playback clock (`getPlaybackElapsedMs`) and re-armed on every pause, resume,
seek and filter change. Position/log/presence/listening-credit change hands at the fade's
**midpoint**.

Refused (plain transition instead), see `decideTransition()`: a skip/stop/jump, a repeat of the
same song (`loopMode: 'song'`, a one-song queue loop, or the same URL twice), a ducked "Hey Jerry"
clip in flight, a prefetch that has not landed (never waited for), an unknown or too-short
duration, and any mixer speed other than 1.0. Note `loopMode: 'queue'` **does** crossfade, and
the handover re-queues the outgoing song at the back the way `playNext()` would.

Each filter branch ends in `apad=whole_dur`, because `acrossfade` emits **zero bytes** when either
input is shorter than the fade - a silent song rather than a rough transition.

There are exactly **two ffmpeg spawn sites** (`playFromCache` and `playCrossfadeTransition`),
kept adjacent in the class; both go through `spawnEncoder()`/`startResource()` so the s16le
48kHz stereo contract handed to the player is identical.

## Level/XP System

Users earn XP from messaging (15-25 XP per message, 60s cooldown) and voice chat (10 XP/min, requires 2+ humans, skips deafened users). XP curve: `xpForLevel(n) = 5n² + 50n + 100`. Level-up embeds are sent in-channel for messages, or system/general channel for voice. Optional role rewards configurable in `data/levels.json` under `roleRewards` (e.g. `{ "5": "roleId" }`).

Commands:
- `/rank [@user]` - Show level, XP, progress bar, and rank
- `/leaderboard` - Top 10 users by XP

Implementation: `src/utils/levelSystem.js` (core), `src/commands/rank.js`, `src/commands/leaderboard.js`

## Birthday Tracker

Users can register their birthday (day + month, no year for privacy). Daily check at 08:00 server time posts birthday announcements to a configured channel.

Commands:
- `/birthday set <day> <month>` - Set your birthday
- `/birthday remove` - Remove your birthday
- `/birthday list` - Show all birthdays sorted by next upcoming
- `/birthday channel <#channel>` - Set announcement channel (Admin only)

Implementation: `src/utils/birthdayTracker.js` (core + scheduler), `src/commands/birthday.js`

## Reminders

Users can set timed reminders that ping them (and optionally others) in the channel where the reminder was created.

Commands:
- `/reminder set <hour> <minute> <message>` - Set a reminder (optional: `day`, `month`, `user1`-`user5`, `role1`-`role3`)
- `/reminder list` - Show your pending reminders
- `/reminder cancel <id>` - Cancel a reminder by ID

Reminders persist across restarts via `data/reminders.json`. Each reminder gets a unique ID and its own `setTimeout`. If the time has already passed today (and no date was specified), it schedules for tomorrow. If a specific date in the past is given, it rolls to next year. Delays beyond Node's ~24.8-day `setTimeout` limit (2^31-1 ms) are chained rather than overflowing, so reminders far in the future fire correctly. Failed deliveries are retried.

Implementation: `src/utils/reminderTracker.js` (core + scheduling), `src/commands/reminder.js`

## Hitster (muziek-tijdlijnspel)

Web-based multiplayer music-timeline game at `/hitster` (built during development under the working name PLAATJE — internal modules, WS message types (`plaatje:*`), API routes (`/api/plaatje/*`), and data files still use that name; only the user-facing route, page title, and copy were renamed to HITSTER), following the rules of the official Hitster party game: a mystery song plays, the active player places it on their personal timeline by release year, then everyone else may spend a token to challenge ("HITSTER!") with their own guess at the correct slot before the reveal — a correct challenge steals the card.

A game table can also be started from Discord with `/hitster [kaarten] [audio] [pool]`, which posts a non-ephemeral embed with a join link (`/hitster?room=<roomId>`) that deep-links straight into the table.

**Secrecy invariant**: the server never reveals a mystery song's identity before the reveal. The round clip is served from `GET /api/plaatje/audio/:roomId` as a bare, 75s-capped mp3 stream with no title/artist in the URL, headers, or body — access is gated to that room's players/spectators via the session, and the endpoint 404s outside the `listening`/`challenge` phases.

**Hybrid audio**: each room picks `audioMode` at creation — `browser` streams the clip to every client's own `<audio>` element (default), or `vc` has Jerry join the game's voice channel and play the clip there so nobody needs headphones open in a tab; `plaatjeAudio.js` owns both paths and refuses `vc` if the connection is held by music or a recording.

**Playlist import**: `POST /api/plaatje/import/fetch` pulls a YouTube playlist via `yt-dlp` (flat, no download) and parses each title into artist/title/year with `plaatjeText.js`; `POST /api/plaatje/import/save` persists the reviewed rows (1-500 songs) as a named pool in `data/plaatjeImports.json`. The built-in song pool lives in `data/hitsterSongs.json` (name predates the PLAATJE rename, kept as-is).

Leaderboard persists in `data/plaatjeLeaderboard.json` as `{ players: { id: { displayName, gamesPlayed, gamesWon, cardsWon, tokensEarned } } }`, written by `recordGameResult()` when a room finishes.

Implementation: `src/utils/plaatjeGame.js` (room state machine, round rules, leaderboard), `src/utils/plaatjeAudio.js` (song pool, gated clip download, VC playback), `src/utils/plaatjeText.js` (fuzzy guess matching, import title parsing), `src/web/public/plaatje.html` (lobby + game UI), Hitster routes/WS handlers in `src/web/server.js`, `src/commands/hitster.js` (`/hitster` slash command — creates a table and posts the join link, via `createPlaatjeRoomFromDiscord()` exported from `server.js`). Full design spec: `docs/superpowers/specs/2026-08-22-plaatje-game-design.md` (local, gitignored).

## Trivia Game

Discord trivia game using The Trivia API (the-trivia-api.com, 12k+ vetted questions, no API key needed). Two modes: **buttons** (everyone picks, all correct score) and **race** (first correct answer wins). Leaderboard persists in `data/triviaLeaderboard.json`.

**Custom local categories** with ~150 hand-curated questions each (50 easy, 50 medium, 50 hard) stored in `data/`:
- Lord of the Rings (`data/lotrQuestions.json`)
- Old School RuneScape (`data/osrsQuestions.json`)
- Pokemon (`data/pokemonQuestions.json`)
- World of Warcraft (`data/wowQuestions.json`)

Local categories are defined in the `LOCAL_CATEGORIES` map in `triviaGame.js`. To add a new custom category: create a JSON file in `data/`, add it to `LOCAL_CATEGORIES` and `CATEGORY_NAMES` in `triviaGame.js`, and add the choice to both `trivia.js` and `challenge.js` CATEGORIES arrays.

Commands:
- `/trivia start [mode] [questions] [category] [difficulty]` - Start a trivia game in the channel
- `/trivia stop` - Stop the current game (starter or admin)
- `/trivia leaderboard` - Show top 10 players

Implementation: `src/utils/triviaGame.js` (core), `src/commands/trivia.js`

## Challenge (1v1 Trivia Duel)

Head-to-head trivia duels between two players. Uses the same Trivia API and leaderboard as `/trivia`. Challenger picks an opponent; opponent must accept within 30s. Both answer 5 questions with A/B/C/D buttons (15s per question). Only the two duelists can answer. Running score and per-question results shown after each question. Final embed declares winner with accuracy breakdown. Both players' stats update in `data/triviaLeaderboard.json`.

Commands:
- `/challenge @user [category] [difficulty]` - Challenge a user to a 1v1 trivia duel

Implementation: `src/commands/challenge.js`, reuses `fetchQuestions` and `updateLeaderboard` from `src/utils/triviaGame.js`

## F1 Predictions (Fantasy League)

Web-based F1 prediction game where users predict the podium (P1, P2, P3) and fastest lap for each race. Predictions can be submitted via the web dashboard or Discord slash command. Results are fetched from the Jolpica API and broadcast in Discord.

### How It Works
- Users predict P1, P2, P3, and fastest lap before each race
- Predictions lock automatically at race start time
- After the race, an admin fetches results via the admin panel
- Results are scored and broadcast to Discord + web dashboard via WebSocket

### Scoring System
| Category | Points |
|---|---|
| Correct P1 (winner) | 25 |
| Correct P2 | 18 |
| Correct P3 | 15 |
| Right driver on podium, wrong position | 5 |
| Correct fastest lap | 10 |
| Perfect podium bonus (all 3 exact) | +10 |

Max per race: 78 points (25 + 18 + 15 + 10 + 10 bonus).

### Commands
- `/f1 predict <round> <p1> <p2> <p3> <fastest_lap>` - Submit prediction (driver options have autocomplete)
- `/f1 standings` - Show season leaderboard
- `/f1 results <round>` - Show race results and scores
- `/f1 mypredictions` - Show your predictions for the season

### Web Dashboard
Route: `/f1` - Full prediction UI with race calendar, driver picker, leaderboard, and results viewer.

### Data
- `data/f1Predictions.json` - All predictions, race results cache, and season standings
- Results API: [Jolpica API](https://github.com/jolpica/jolpica-f1) (`https://api.jolpi.ca/ergast/f1/{year}/{round}/results/`)

### API Routes (in `server.js`)
- `GET /api/f1/drivers` - Driver list with team colors
- `GET /api/f1/races` - All races with lock status and user predictions
- `GET /api/f1/standings` - Season leaderboard
- `GET /api/f1/predictions/:round` - All predictions for a race
- `GET /api/f1/results/:round` - Race results + scored predictions
- `POST /api/f1/predict` - Submit prediction `{ round, p1, p2, p3, fastestLap }`
- `POST /api/f1/fetchresults/:round` - Admin: fetch + score results from Jolpica API

### Updating for a New Season
The driver grid and race calendar are defined as constants in `src/utils/f1Predictions.js`:

**To update drivers** (e.g. new season, mid-season driver swap): Edit the `DRIVERS` array in `f1Predictions.js`. Each driver entry has: `{ id, name, number, constructor, teamColor }`. The `id` must match the Jolpica API `driverId` (lowercase surname, e.g. `"verstappen"`, `"norris"`). Team colors are hex codes used in the web UI.

**To update the race calendar**: Edit the `RACES` array in `f1Predictions.js`. Each race has: `{ round, name, circuit, location, date (ISO string), sprint (bool) }`. The `round` number must match the Jolpica API round numbers. Also update `createF1Events.js` if you want matching Discord scheduled events.

**To add a new season**: Clear or archive `data/f1Predictions.json`, update `DRIVERS` and `RACES` in `f1Predictions.js`, and optionally update the year in the Jolpica API URL (`API_YEAR` constant).

Implementation: `src/utils/f1Predictions.js` (core logic + data), `src/commands/f1.js` (Discord command), `src/web/public/f1.html` (web UI), API routes in `src/web/server.js`

## Last Seen

Tracks when users were last active via messages, presence changes (going offline), and voice channel activity. Data persists in `data/lastSeen.json` with debounced saves.

Commands:
- `/lastseen @user` - Shows when the user was last seen, or their current status if online

Implementation: `src/utils/lastSeenTracker.js` (core + persistence), `src/commands/lastseen.js`, tracking hooks in `src/index.js` (MessageCreate, PresenceUpdate, VoiceStateUpdate)

## Voice Recording

Records a target user's voice channel audio to a `.wav` file. Gated behind the **Manage Server** permission, requires an explicit target user (the invoker can't silently record themselves-and-others), and announces publicly (non-ephemeral) when a recording starts so the room knows. Audio streams to disk as it's captured rather than buffering in memory, with a hard 30-minute cap that auto-stops the recording.

Commands:
- `/record start <target>` - Start recording a user in your voice channel
- `/record stop` - Stop recording and save the `.wav` file

Implementation: `src/commands/record.js`, `src/utils/voiceRecorder.js`

## Hey Jerry Voice Assistant

Say **"Hey Jerry"** in a voice channel the bot is in, wait for the beep, then give a command in Dutch. Everything except speech-to-text and intent parsing runs locally.

The bot has to be in the channel to hear anything, and `/heyjerry join` is how it gets there without starting music: it joins your channel undeafened and listens, nothing else. `/heyjerry leave` sends it away again. Playing something (`/play`, or "Hey Jerry, speel …") reuses that same connection rather than creating a second one.

### The consent invariant

**Jerry only ever subscribes to the audio of users who ran `/heyjerry on`.** This is the rule the whole feature is built around, so it is worth stating precisely:

- There is exactly **one** `receiver.subscribe()` call in `voiceAssistant.js` — the wake-word monitor in `startMonitoring()` — and it is immediately preceded by an `isOptedIn()` check in the same function. The utterance capture is a tee of that monitor's decoded stream, not a second subscription.
- The set of people to listen to is decided in **one** place — `doSync()`, reached only via `syncSubscriptions(guildId)` — as "non-bot members of the bot's current voice channel who are opted in". Anyone else is unsubscribed and has their wake-word slot released.
- `syncSubscriptions()` runs on voice connection state changes, on every `VoiceStateUpdate`, on `/heyjerry on|off`, and from a 30s reconcile timer. All of it is serialized on a per-guild promise chain so concurrent triggers can't double-subscribe.
- Consent is re-checked **again** after the utterance is recorded. Someone who runs `/heyjerry off` mid-sentence has their audio discarded before it would reach any API.
- The bot self-deafens by default (it receives no audio at all). It rejoins **undeafened** only while at least one opted-in member is in the channel, and re-deafens when the last one leaves or opts out. Re-deafening is deferred while an interaction or a `/record` session is in flight.

Opt-in state lives in `data/voiceAssistant.json` and is written synchronously on every change — consent must survive a crash.

### Commands

- `/heyjerry on` - Let Jerry listen to you
- `/heyjerry off` - Stop Jerry from listening (takes effect before the reply is sent)
- `/heyjerry status` - Your opt-in state, whether the assistant is running, and who else in your voice channel is opted in
- `/heyjerry join` - Bring Jerry into your voice channel to listen, without starting music. Requires you to be in a voice channel **and** opted in — summoning a bot that isn't allowed to hear you does nothing. Refused when the assistant isn't running, and when music or a `/record` session holds the connection in another channel. Announced in-channel, not ephemerally.
- `/heyjerry leave` - Send Jerry away. Open to opted-in members in his channel, or anyone with Manage Server. Refused while music is playing/queued (use `/stop`) or a recording is running (use `/record stop`) — those own the connection.
- `/heyjerry replies <on|off>` - Toggle whether Jerry speaks replies out loud vs. only reporting in the activity log (requires Manage Server)

Listed under the **utility** category in `/help`, which reads the subcommand list off the command builder, so all six show up there automatically.

### Connection ownership

A guild has one voice connection, and three commands can create it: `/play` (via `MusicQueue#join`), `/record start`, and `/heyjerry join`. Whoever created it owns its lifecycle, and the other two must not hang it up. `voiceConnectionOwner({ connection, queueConnection, recording })` in `voiceAssistant.js` is the single test — `'music'` when `getQueue(guildId).connection` **is** this connection object, `'recorder'` while a recording runs, `'assistant'` otherwise.

The assistant hangs up on a connection it owns 60s after the channel's last non-bot member leaves (`shouldAssistantAutoLeave`). The timer is armed and cancelled from `doSync()`, so every trigger that reconciles subscriptions re-decides it, and everything is re-checked when it fires: a connection replaced by a reconnect, `/play` claiming it mid-countdown, or people coming back all cancel the hang-up. Unknown inputs (channel not in cache, `musicQueue` import failed) fail safe by staying. The music queue keeps its own separate empty-queue auto-leave for connections it owns.

### Pipeline

```
opted-in member speaks
  → receiver subscription → opus decode (48k stereo) → downsample to 16k mono
  → openWakeWord sidecar → 'wake' event
  → rate limit (10/min per guild, max 2 concurrent, one at a time per user)
  → beep → record until 1000ms of silence (10s hard cap)
  → Groq Whisper → parseIntent → dispatch
  → spoken Dutch reply (Piper, ducked over the music) + an embed in the activity-log channel
```

Every stage is individually try/caught. Any failure speaks `"Sorry, dat verstond ik niet."` and posts an embed naming the stage that failed (transcription failures are reported as `transcribe:<stage>` from `TranscribeError.stage`).

### Intents and spoken replies

| Intent | Dispatches to | Says |
|---|---|---|
| `play <query>` | the same add-song handler the web dashboard uses, after `sanitizeSearchQuery` | `Oké, ik speel <title>` |
| `skip` / `pause` / `resume` | the same music command handler the web dashboard uses | `Oké` |
| `stop` | ditto — but speaks *before* disconnecting, since the command leaves the channel | `Oké` |
| `volume <0-100>` | `volume:<n>` on the command handler | `Volume naar <n>` |
| `volume` relative (`harder` / `zachter` / `veel harder` / `veel zachter`) | reads the queue's current level, moves it by ±15 (±30 for "veel"), clamped 0-100, then `volume:<n>` | `Volume naar <n>`, or `Het volume staat al op <n>` at either end of the slider |
| `nowplaying` / `queue` | reads the guild's `MusicQueue` | the title / how many tracks are queued |
| `remind <n> <message>` | `reminderTracker.addReminder` (`fireAt = now + n·60000`, general channel) | `Ik herinner je over <N> minuten` |
| `ask <question>` | OpenRouter chat with `getChatConfig()`'s model | the answer, truncated to 400 chars — the full text goes in the embed |

Music commands go through the *same* `handleMusicCommand` / `handleAddSong` functions in `index.js` that the web dashboard is wired to, so voice and dashboard share exactly one code path.

Relative volume is a `{ action: 'volume', relative: ±15|±30 }` intent - a direction, not a level,
because the resulting level depends on where the volume is now and only the dispatcher can see
that. `validateIntent` takes an absolute `volume` **or** a `relative`, never both. The phrase table
(`RELATIVE_VOLUME_PHRASES` in `speech/intent.js`) is whole-utterance anchored like `EXACT_PHRASES`,
which is what keeps a bare "harder" safe to accept while "dat is harder dan ik dacht" never reaches
it; the LLM fallback can also return `relative` for phrasings the table misses.

### Setup

```bash
scripts/setup-voice.sh   # Piper + Dutch voice, openWakeWord venv, wake-word models (idempotent)
```

Everything is installed under `tools/`, which is gitignored. Then set `GROQ_API_KEY` in `.env` and restart.

The assistant logs `[VoiceAssistant] Initialized (wake word: hey_jarvis)` on startup, or `[VoiceAssistant] Disabled: <reason>` and skips itself entirely when `GROQ_API_KEY` is missing, the wake-word model/venv is absent, or Piper is not installed. The rest of the bot boots normally either way.

### Swapping in a custom `hey_jerry.onnx`

The stock model is openWakeWord's pretrained **hey_jarvis**, which is why the bot answers to "Hey Jarvis" out of the box. To use a real "Hey Jerry" phrase, train one with [openWakeWord's automatic model training notebook](https://github.com/dscripka/openWakeWord#training-new-models), drop the resulting `hey_jerry.onnx` into `tools/models/`, and point the bot at it:

```bash
WAKEWORD_MODEL_PATH=tools/models/hey_jerry.onnx
```

No code changes are needed — the sidecar loads whatever model that path names, and the startup log line reports the model actually loaded. Tune `WAKEWORD_THRESHOLD` (default `0.5`) if the new model wakes too easily or not easily enough.

### Notes and limitations

- Jerry never joins a voice channel on its own; it rides whatever connection is already there (music playback or `/record`). If the bot isn't in a channel, there is nothing to wake.
- Starting music creates the voice connection self-deafened, so the assistant performs one extra rejoin to undeafen itself. That causes a brief audio hiccup at the moment music starts in a channel with an opted-in member.
- The wake-word sidecar has 16 audio slots shared across all guilds; a 17th simultaneous listener evicts the least recently assigned one.

Implementation: `src/utils/voiceAssistant.js` (orchestrator), `src/utils/speech/*` (wake word, transcription, intent, TTS), `src/commands/heyjerry.js`, `scripts/wakeword_sidecar.py`, `scripts/setup-voice.sh`. Started by `initVoiceAssistant(client, handlers)` in the `ClientReady` handler (after the music/web wiring it dispatches through) and torn down by `stopVoiceAssistant()` in `flushState()`.

## TeamSpeak Status Channel

**Currently disabled on this host** (the TS6 server was removed 2026-08-12; `TS6_API_KEY`/`TS6_STATUS_CHANNEL_ID` are commented out in `.env` and `initTeamspeakStatus()` skips setup at startup with both unset). Documented here for whenever TS6 comes back.

A Discord voice channel that displays the current TeamSpeak 6 user count in its name (e.g. "TeamSpeak: 3 online"). The channel is view-only — permissions are set on startup to allow `ViewChannel` but deny `Connect` for @everyone.

- Polls the TS6 WebQuery HTTP API (`/1/clientlist` on port 10080) every 5 minutes
- Only renames the channel when the count actually changes (Discord rate-limits renames to 2 per 10 minutes)
- Filters out ServerQuery clients (type 1), only counts real users (type 0)

Environment variables (in `.env`):
- `TS6_API_KEY` - TeamSpeak 6 ServerQuery API key
- `TS6_STATUS_CHANNEL_ID` - Discord voice channel ID to update

Implementation: `src/utils/teamspeakStatus.js`, initialized in `src/index.js` (`ClientReady` handler)

## Command Logging

All slash command usage is logged to `data/commandLog.txt` with timestamp, user, command name, subcommand, and options.

## Deleted Message Logging

Deleted messages are logged both to `data/deletedMessages.log` (file) and to a `delete-log` Discord channel (red embed, matching the `edit-log` pattern for edited messages).

## AI Chat (Multi-turn Conversations)

The `/chat` command uses OpenRouter API (currently Grok model) for AI responses. Supports **multi-turn conversations** via Discord reply chains:
- User runs `/chat` with a question → bot replies with answer
- User **replies** to the bot's answer with a follow-up → bot reads the full conversation history from the reply chain and responds with context
- Conversation history is capped at 10 turns to limit token usage
- The bot identifies its own chat messages by the `**Question:**` prefix format
- Implementation spans: `src/utils/openrouter.js` (accepts message history), `src/index.js` (reply chain handler), `src/commands/chat.js` (initial question)
- `/chatmodel show` and `/chatmodel set <model>` (requires Manage Server) view/change the persisted `/chat` model at runtime, with autocomplete sourced from the OpenRouter models API. Implementation: `src/commands/chatmodel.js`

## Help Command

`/help` — Shows all bot commands in an interactive embed with a dropdown menu to browse categories. The command dynamically reads from `interaction.client.commands`, so new commands appear automatically. Categories are defined in the `CATEGORIES` array at the top of `src/commands/help.js`.

**When adding a new command**: Add the command name to the appropriate category's `commands` array in `src/commands/help.js`. Available categories: `music`, `games`, `social`, `stats`, `utility`. If the command doesn't fit, create a new category entry.

## Maintenance Notes

- **Keep CLAUDE.md updated**: When making significant changes (new features, new modules, architectural changes, new commands, new environment variables), update this file to reflect them. This ensures future Claude Code sessions have accurate context.
- **Restart bot after every edit**: The bot runs under pm2 as `jerrybot`. After making code changes, always restart with `pm2 restart jerrybot` and check logs with `pm2 logs jerrybot --lines 20 --nostream` to verify no startup errors.
- **Command logging is automatic**: All slash commands are logged to `data/commandLog.txt` via the `InteractionCreate` handler in `src/index.js` (before `command.execute()`). New commands added to `src/commands/` are logged automatically — no extra code needed per command.
- **Help command categories**: When adding a new slash command, also add its name to the appropriate category in `src/commands/help.js` `CATEGORIES` array so it shows up in `/help`.

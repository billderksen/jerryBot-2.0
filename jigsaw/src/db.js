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

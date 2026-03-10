import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from './db.js';

const router = Router();

// In-memory room state for puzzle pieces, player connections (used by WebSocket later)
export const activeRooms = new Map();

// ── Periodic Room Cleanup ──
// Runs every 5 minutes: deletes stale rooms from DB and activeRooms
const CLEANUP_INTERVAL = 5 * 60 * 1000;      // 5 minutes
const COMPLETION_TTL = 5 * 60 * 1000;         // 5 min after completion
const INACTIVITY_TTL = 30 * 60 * 1000;        // 30 min inactivity

export function startRoomCleanup() {
  setInterval(() => {
    const now = Date.now();

    // 1. Clean up active rooms with no players (inactivity)
    for (const [roomId, state] of activeRooms) {
      if (state.players.size === 0) {
        // Room has no players — check if it has been empty long enough
        if (!state._emptyAt) {
          state._emptyAt = now;
        } else if (now - state._emptyAt > 60000) {
          // Empty for over 1 minute, remove from memory
          activeRooms.delete(roomId);
        }
      } else {
        // Reset empty timer if players exist
        state._emptyAt = null;
        // Track last activity
        state._lastActivity = now;
      }
    }

    // 2. Delete completed rooms from DB older than COMPLETION_TTL
    try {
      const completedCutoff = new Date(now - COMPLETION_TTL).toISOString();
      const completedRooms = db.prepare(
        "SELECT id FROM rooms WHERE status = 'completed' AND created_at < ?"
      ).all(completedCutoff);

      for (const room of completedRooms) {
        db.prepare('DELETE FROM room_players WHERE room_id = ?').run(room.id);
        db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
        activeRooms.delete(room.id);
      }
    } catch (err) {
      console.error('Room cleanup error (completed):', err.message);
    }

    // 3. Delete waiting/playing rooms with no active players that are stale (30 min)
    try {
      const staleCutoff = new Date(now - INACTIVITY_TTL).toISOString();
      const staleRooms = db.prepare(
        "SELECT id FROM rooms WHERE status IN ('waiting', 'playing') AND created_at < ?"
      ).all(staleCutoff);

      for (const room of staleRooms) {
        // Only delete if no active players in memory
        const active = activeRooms.get(room.id);
        if (!active || active.players.size === 0) {
          db.prepare('DELETE FROM room_players WHERE room_id = ?').run(room.id);
          db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
          activeRooms.delete(room.id);
        }
      }
    } catch (err) {
      console.error('Room cleanup error (stale):', err.message);
    }
  }, CLEANUP_INTERVAL);

  console.log('Room cleanup interval started (every 5 min)');
}

const VALID_PIECE_COUNTS = [24, 48, 100, 200];
const VALID_MODES = ['coop', 'race'];

// GET /api/images — list all puzzle images
router.get('/api/images', (req, res) => {
  const images = db.prepare(
    'SELECT * FROM puzzle_images ORDER BY is_builtin DESC, display_name ASC'
  ).all();
  res.json(images);
});

// GET /api/rooms — list non-completed rooms
router.get('/api/rooms', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, pi.display_name as image_name,
      (SELECT COUNT(*) FROM room_players WHERE room_id = r.id) as player_count
    FROM rooms r
    LEFT JOIN puzzle_images pi ON r.image_id = pi.id
    WHERE r.status != 'completed'
    ORDER BY r.created_at DESC
  `).all();

  // Add progress from activeRooms
  const result = rooms.map(room => ({
    ...room,
    progress: activeRooms.get(room.id)?.progress ?? 0
  }));

  res.json(result);
});

// POST /api/rooms — create a room
router.post('/api/rooms', (req, res) => {
  try {
    const { name, mode, pieceCount, imageId, guestName } = req.body;

    // Must be logged in or provide a guest name
    const userId = req.user?.id ?? null;
    if (!userId && !guestName) {
      return res.status(401).json({ error: 'Must be logged in or provide a guest name' });
    }

    // Validate
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Room name is required' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Mode must be "coop" or "race"' });
    }
    if (!VALID_PIECE_COUNTS.includes(pieceCount)) {
      return res.status(400).json({ error: `Piece count must be one of: ${VALID_PIECE_COUNTS.join(', ')}` });
    }

    const image = db.prepare('SELECT * FROM puzzle_images WHERE id = ?').get(imageId);
    if (!image) {
      return res.status(400).json({ error: 'Invalid image ID' });
    }

    const roomId = uuidv4();
    const seed = Math.floor(Math.random() * 2147483647);
    const isRanked = image.is_builtin ? 1 : 0;

    db.prepare(`
      INSERT INTO rooms (id, name, host_user_id, host_guest_name, mode, piece_count, image_id, status, is_ranked, seed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
    `).run(roomId, name.trim(), userId, guestName || null, mode, pieceCount, imageId, isRanked, seed);

    // Auto-add host as first room_player
    db.prepare(`
      INSERT INTO room_players (room_id, user_id, guest_name)
      VALUES (?, ?, ?)
    `).run(roomId, userId, guestName || null);

    res.status(201).json({ roomId });
  } catch (err) {
    console.error('Error creating room:', err);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// GET /api/rooms/:id — room details with player list
router.get('/api/rooms/:id', (req, res) => {
  const room = db.prepare(`
    SELECT r.*, pi.display_name as image_name, pi.filename as image_filename
    FROM rooms r
    LEFT JOIN puzzle_images pi ON r.image_id = pi.id
    WHERE r.id = ?
  `).get(req.params.id);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const players = db.prepare(`
    SELECT rp.*, u.username
    FROM room_players rp
    LEFT JOIN users u ON rp.user_id = u.id
    WHERE rp.room_id = ?
    ORDER BY rp.joined_at ASC
  `).all(req.params.id);

  res.json({
    ...room,
    progress: activeRooms.get(room.id)?.progress ?? 0,
    players
  });
});

// DELETE /api/rooms/:id — host-only deletion
router.delete('/api/rooms/:id', (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(req.params.id);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const userId = req.user?.id ?? null;

  // Check if requester is the host
  const isHost = (userId && room.host_user_id === userId) ||
    (!userId && req.body?.guestName && room.host_guest_name === req.body.guestName);

  if (!isHost) {
    return res.status(403).json({ error: 'Only the host can delete this room' });
  }

  db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
  activeRooms.delete(req.params.id);

  res.json({ ok: true });
});

export default router;

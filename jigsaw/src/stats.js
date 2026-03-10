import { Router } from 'express';
import db from './db.js';

const router = Router();

// GET /api/stats/:userId — user stats
router.get('/api/stats/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const user = db.prepare(`
    SELECT id, username, avatar_url, created_at FROM users WHERE id = ?
  `).get(userId);

  if (!user) return res.status(404).json({ error: 'User not found' });

  const stats = db.prepare(`
    SELECT ranked_pieces_placed, ranked_puzzles_completed,
           unranked_pieces_placed, unranked_puzzles_completed,
           total_time_played
    FROM stats WHERE user_id = ?
  `).get(userId) || {
    ranked_pieces_placed: 0,
    ranked_puzzles_completed: 0,
    unranked_pieces_placed: 0,
    unranked_puzzles_completed: 0,
    total_time_played: 0
  };

  res.json({ user, stats });
});

// GET /api/stats/:userId/history — last 20 puzzle history entries
router.get('/api/stats/:userId/history', (req, res) => {
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const history = db.prepare(`
    SELECT image_name, piece_count, pieces_placed, mode, is_ranked, completed_at
    FROM puzzle_history
    WHERE user_id = ?
    ORDER BY completed_at DESC
    LIMIT 20
  `).all(userId);

  res.json(history);
});

// GET /api/leaderboard — top 20 players by ranked_pieces_placed
router.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_url,
           s.ranked_pieces_placed, s.ranked_puzzles_completed
    FROM stats s
    JOIN users u ON u.id = s.user_id
    WHERE s.ranked_pieces_placed > 0
    ORDER BY s.ranked_pieces_placed DESC
    LIMIT 20
  `).all();

  res.json(rows);
});

export default router;

import { parse } from 'url';
import db from './db.js';
import { activeRooms } from './rooms.js';

const PLAYER_COLORS = ['#e94560', '#2ed573', '#3498db', '#f39c12', '#9b59b6', '#1abc9c', '#e74c3c', '#2ecc71'];

const GRID_MAP = {
  24: { cols: 6, rows: 4 },
  48: { cols: 8, rows: 6 },
  100: { cols: 10, rows: 10 },
  200: { cols: 20, rows: 10 }
};

const BOARD_SIZE = 1000;

function broadcastToRoom(roomState, message, excludePlayerId = null) {
  const data = JSON.stringify(message);
  for (const [pid, player] of roomState.players) {
    if (pid !== excludePlayerId && player.ws.readyState === 1) {
      player.ws.send(data);
    }
  }
}

function sendMsg(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function generatePlayerId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Simple seeded PRNG (mulberry32)
function seededRandom(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateScatteredPositions(cols, rows, pieceWidth, pieceHeight, seed) {
  const rng = seededRandom(seed);
  const boardWidth = cols * pieceWidth;
  const boardHeight = rows * pieceHeight;

  // Scatter area: extend by 50% on all sides
  const marginX = boardWidth * 0.5;
  const marginY = boardHeight * 0.5;
  const scatterMinX = -marginX;
  const scatterMaxX = boardWidth + marginX;
  const scatterMinY = -marginY;
  const scatterMaxY = boardHeight + marginY;

  const positions = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = scatterMinX + rng() * (scatterMaxX - scatterMinX);
      const y = scatterMinY + rng() * (scatterMaxY - scatterMinY);
      positions.push({ col, row, x, y });
    }
  }
  return positions;
}

export function setupWebSocket(wss, sessionMiddleware) {
  // Map ws -> playerId for cleanup on disconnect
  const wsToPlayer = new Map();

  wss.on('connection', (ws, req) => {
    // Parse session
    sessionMiddleware(req, {}, () => {});
    const userId = req.session?.passport?.user || null;
    let user = null;
    if (userId) {
      user = db.prepare('SELECT id, username, avatar_url FROM users WHERE id = ?').get(userId);
    }

    // Parse roomId from query string
    const { query } = parse(req.url, true);
    const initialRoomId = query.roomId || null;

    let playerId = null;
    let currentRoomId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return sendMsg(ws, { type: 'error', message: 'Invalid JSON' });
      }

      switch (msg.type) {
        case 'join':
          handleJoin(msg);
          break;
        case 'start':
          handleStart();
          break;
        case 'lock':
          handleLock(msg);
          break;
        case 'move':
          handleMove(msg);
          break;
        case 'drop':
          handleDrop(msg);
          break;
        case 'unlock':
          handleUnlock(msg);
          break;
        case 'chat':
          handleChat(msg);
          break;
        default:
          sendMsg(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    });

    ws.on('close', () => {
      handleDisconnect();
    });

    ws.on('error', () => {
      handleDisconnect();
    });

    function handleJoin(msg) {
      const roomId = msg.roomId || initialRoomId;
      if (!roomId) {
        return sendMsg(ws, { type: 'error', message: 'Room ID required' });
      }

      // Look up room in DB
      const room = db.prepare(`
        SELECT r.*, pi.filename as image_filename, pi.display_name as image_name
        FROM rooms r
        LEFT JOIN puzzle_images pi ON r.image_id = pi.id
        WHERE r.id = ?
      `).get(roomId);

      if (!room) {
        return sendMsg(ws, { type: 'error', message: 'Room not found' });
      }
      if (room.status === 'completed') {
        return sendMsg(ws, { type: 'error', message: 'Room is already completed' });
      }

      const guestName = msg.guestName || null;
      if (!user && !guestName) {
        return sendMsg(ws, { type: 'error', message: 'Must be logged in or provide a guest name' });
      }

      // Initialize room in activeRooms if needed
      if (!activeRooms.has(roomId)) {
        const grid = GRID_MAP[room.piece_count] || GRID_MAP[24];
        const pieceWidth = BOARD_SIZE / grid.cols;
        const pieceHeight = BOARD_SIZE / grid.rows;

        activeRooms.set(roomId, {
          pieces: [],
          placedCount: 0,
          players: new Map(),
          started: room.status === 'playing',
          grid,
          pieceWidth,
          pieceHeight,
          imageFilename: room.image_filename,
          isRanked: room.is_ranked,
          mode: room.mode,
          seed: room.seed,
          startTime: room.status === 'playing' ? Date.now() : null,
          hostPlayerId: null
        });
      }

      const roomState = activeRooms.get(roomId);

      // Assign player
      playerId = generatePlayerId();
      currentRoomId = roomId;

      const colorIndex = roomState.players.size % PLAYER_COLORS.length;
      const color = PLAYER_COLORS[colorIndex];

      const playerEntry = {
        ws,
        userId: user?.id || null,
        guestName,
        username: user?.username || guestName || 'Guest',
        color,
        score: 0
      };

      roomState.players.set(playerId, playerEntry);
      wsToPlayer.set(ws, { playerId, roomId });

      // Set host if first player
      if (!roomState.hostPlayerId) {
        roomState.hostPlayerId = playerId;
      }

      // Add to room_players DB (only if not already there)
      const existingPlayer = db.prepare(
        'SELECT * FROM room_players WHERE room_id = ? AND (user_id = ? OR guest_name = ?)'
      ).get(roomId, user?.id || null, guestName);
      if (!existingPlayer) {
        db.prepare('INSERT INTO room_players (room_id, user_id, guest_name) VALUES (?, ?, ?)').run(
          roomId, user?.id || null, guestName
        );
      }

      // Build players list for joined message
      const playersArray = [];
      for (const [pid, p] of roomState.players) {
        playersArray.push({
          id: pid,
          username: p.username,
          color: p.color,
          score: p.score,
          isHost: pid === roomState.hostPlayerId
        });
      }

      // Build puzzle state
      let puzzleState = [];
      if (roomState.started) {
        if (roomState.mode === 'race' && roomState.playerPuzzles) {
          // Race mode: give new player their own puzzle copy if they don't have one
          if (!roomState.playerPuzzles.has(playerId)) {
            roomState.playerPuzzles.set(playerId, {
              pieces: roomState.pieces.map(p => ({ ...p })),
              placedCount: 0
            });
          }
          const playerPuzzle = roomState.playerPuzzles.get(playerId);
          puzzleState = playerPuzzle.pieces.map(p => ({
            index: p.index,
            currentX: p.currentX,
            currentY: p.currentY,
            placed: p.placed,
            lockedBy: null,
            lockedByName: null,
            lockedByColor: null
          }));
        } else {
          puzzleState = roomState.pieces.map(p => ({
            index: p.index,
            currentX: p.currentX,
            currentY: p.currentY,
            placed: p.placed,
            lockedBy: p.lockedBy,
            lockedByName: p.lockedBy ? roomState.players.get(p.lockedBy)?.username : null,
            lockedByColor: p.lockedBy ? roomState.players.get(p.lockedBy)?.color : null
          }));
        }
      }

      // Send joined to new player
      sendMsg(ws, {
        type: 'joined',
        playerId,
        players: playersArray,
        puzzleState,
        roomInfo: {
          id: roomId,
          name: room.name,
          mode: room.mode,
          pieceCount: room.piece_count,
          imageFilename: room.image_filename,
          imageName: room.image_name,
          isRanked: room.is_ranked,
          status: room.status,
          started: roomState.started,
          grid: roomState.grid,
          pieceWidth: roomState.pieceWidth,
          pieceHeight: roomState.pieceHeight,
          hostPlayerId: roomState.hostPlayerId
        }
      });

      // Broadcast player_joined to others
      broadcastToRoom(roomState, {
        type: 'player_joined',
        player: {
          id: playerId,
          username: playerEntry.username,
          color,
          score: 0,
          isHost: playerId === roomState.hostPlayerId
        }
      }, playerId);
    }

    function handleStart() {
      if (!currentRoomId || !playerId) {
        return sendMsg(ws, { type: 'error', message: 'Not in a room' });
      }

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState) {
        return sendMsg(ws, { type: 'error', message: 'Room not found' });
      }

      // Verify host
      if (roomState.hostPlayerId !== playerId) {
        return sendMsg(ws, { type: 'error', message: 'Only the host can start the game' });
      }

      if (roomState.started) {
        return sendMsg(ws, { type: 'error', message: 'Game already started' });
      }

      const { cols, rows } = roomState.grid;
      const positions = generateScatteredPositions(
        cols, rows, roomState.pieceWidth, roomState.pieceHeight, roomState.seed
      );

      const pieces = positions.map((p, i) => ({
        index: i,
        correctCol: p.col,
        correctRow: p.row,
        currentX: p.x,
        currentY: p.y,
        placed: false,
        lockedBy: null
      }));

      roomState.pieces = pieces;
      roomState.placedCount = 0;
      roomState.started = true;
      roomState.startTime = Date.now();

      // Update DB
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('playing', currentRoomId);

      if (roomState.mode === 'race') {
        // Race mode: each player gets their own copy of the puzzle
        roomState.playerPuzzles = new Map();
        for (const [pid] of roomState.players) {
          roomState.playerPuzzles.set(pid, {
            pieces: pieces.map(p => ({ ...p })),
            placedCount: 0
          });
        }

        // Send each player their own piece positions
        for (const [pid, player] of roomState.players) {
          const playerPuzzle = roomState.playerPuzzles.get(pid);
          const piecesData = playerPuzzle.pieces.map(p => ({
            index: p.index,
            currentX: p.currentX,
            currentY: p.currentY,
            placed: false,
            lockedBy: null
          }));
          sendMsg(player.ws, {
            type: 'started',
            pieces: piecesData
          });
        }
      } else {
        // Co-op mode: shared pieces
        const piecesData = roomState.pieces.map(p => ({
          index: p.index,
          currentX: p.currentX,
          currentY: p.currentY,
          placed: false,
          lockedBy: null
        }));

        broadcastToRoom(roomState, {
          type: 'started',
          pieces: piecesData
        });
      }
    }

    function handleLock(msg) {
      if (!currentRoomId || !playerId) {
        return sendMsg(ws, { type: 'error', message: 'Not in a room' });
      }

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState || !roomState.started) {
        return sendMsg(ws, { type: 'error', message: 'Game not started' });
      }

      // Race mode: each player has their own pieces, no conflicts possible
      if (roomState.mode === 'race') {
        const playerPuzzle = roomState.playerPuzzles?.get(playerId);
        if (!playerPuzzle) return;

        const pieceIndex = msg.pieceIndex;
        if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= playerPuzzle.pieces.length) return;

        const piece = playerPuzzle.pieces[pieceIndex];
        if (piece.placed) return;

        piece.lockedBy = playerId;
        const player = roomState.players.get(playerId);

        // Only send confirmation back to the requesting player
        sendMsg(ws, {
          type: 'locked',
          pieceIndex,
          playerId,
          playerName: player.username,
          playerColor: player.color
        });
        return;
      }

      const pieceIndex = msg.pieceIndex;
      if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= roomState.pieces.length) {
        return sendMsg(ws, { type: 'error', message: 'Invalid piece index' });
      }

      const piece = roomState.pieces[pieceIndex];
      if (piece.placed) {
        return sendMsg(ws, { type: 'error', message: 'Piece already placed' });
      }
      if (piece.lockedBy && piece.lockedBy !== playerId) {
        return sendMsg(ws, { type: 'error', message: 'Piece locked by another player' });
      }

      piece.lockedBy = playerId;
      const player = roomState.players.get(playerId);

      broadcastToRoom(roomState, {
        type: 'locked',
        pieceIndex,
        playerId,
        playerName: player.username,
        playerColor: player.color
      });
    }

    function handleMove(msg) {
      if (!currentRoomId || !playerId) return;

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState || !roomState.started) return;

      // Race mode: update the player's own puzzle, no broadcast needed
      if (roomState.mode === 'race') {
        const playerPuzzle = roomState.playerPuzzles?.get(playerId);
        if (!playerPuzzle) return;

        const pieceIndex = msg.pieceIndex;
        if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= playerPuzzle.pieces.length) return;

        const piece = playerPuzzle.pieces[pieceIndex];
        if (piece.lockedBy !== playerId) return;

        piece.currentX = msg.x;
        piece.currentY = msg.y;
        // No broadcast — each player only sees their own board
        return;
      }

      const pieceIndex = msg.pieceIndex;
      if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= roomState.pieces.length) return;

      const piece = roomState.pieces[pieceIndex];
      if (piece.lockedBy !== playerId) return;

      piece.currentX = msg.x;
      piece.currentY = msg.y;

      // Broadcast to others only
      broadcastToRoom(roomState, {
        type: 'moved',
        pieceIndex,
        x: msg.x,
        y: msg.y,
        playerId
      }, playerId);
    }

    function handleDrop(msg) {
      if (!currentRoomId || !playerId) {
        return sendMsg(ws, { type: 'error', message: 'Not in a room' });
      }

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState || !roomState.started) {
        return sendMsg(ws, { type: 'error', message: 'Game not started' });
      }

      // Race mode: validate against the player's own puzzle
      if (roomState.mode === 'race') {
        const playerPuzzle = roomState.playerPuzzles?.get(playerId);
        if (!playerPuzzle) return;

        const pieceIndex = msg.pieceIndex;
        if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= playerPuzzle.pieces.length) return;

        const piece = playerPuzzle.pieces[pieceIndex];
        if (piece.lockedBy !== playerId) return;

        const correctX = piece.correctCol * roomState.pieceWidth;
        const correctY = piece.correctRow * roomState.pieceHeight;
        const dist = Math.sqrt((msg.x - correctX) ** 2 + (msg.y - correctY) ** 2);
        const snapThreshold = Math.min(roomState.pieceWidth, roomState.pieceHeight) * 0.25;

        if (dist <= snapThreshold) {
          piece.placed = true;
          piece.currentX = correctX;
          piece.currentY = correctY;
          piece.lockedBy = null;
          playerPuzzle.placedCount++;

          const player = roomState.players.get(playerId);
          player.score++;

          // Update DB pieces_placed
          if (player.userId) {
            db.prepare(
              'UPDATE room_players SET pieces_placed = pieces_placed + 1 WHERE room_id = ? AND user_id = ?'
            ).run(currentRoomId, player.userId);
          } else if (player.guestName) {
            db.prepare(
              'UPDATE room_players SET pieces_placed = pieces_placed + 1 WHERE room_id = ? AND guest_name = ?'
            ).run(currentRoomId, player.guestName);
          }

          const totalPieces = playerPuzzle.pieces.length;
          const progress = Math.round((playerPuzzle.placedCount / totalPieces) * 100);

          // Send placed confirmation to the player
          sendMsg(ws, {
            type: 'placed',
            pieceIndex,
            correctX,
            correctY,
            playerId,
            score: player.score
          });

          // Broadcast progress to all players
          broadcastToRoom(roomState, {
            type: 'race_progress',
            playerId,
            playerName: player.username,
            playerColor: player.color,
            progress,
            placedCount: playerPuzzle.placedCount,
            totalPieces
          });

          // Check if this player completed the puzzle
          if (playerPuzzle.placedCount === totalPieces) {
            const completionTime = roomState.startTime ? Math.floor((Date.now() - roomState.startTime) / 1000) : 0;

            // Build scores for all players
            const scores = [];
            for (const [pid, p] of roomState.players) {
              const pp = roomState.playerPuzzles.get(pid);
              scores.push({
                playerId: pid,
                username: p.username,
                color: p.color,
                score: pp ? pp.placedCount : 0,
                totalPieces,
                completionTime: pp && pp.placedCount === totalPieces ? completionTime : null
              });
            }

            scores.sort((a, b) => (b.score || 0) - (a.score || 0));

            broadcastToRoom(roomState, {
              type: 'race_complete',
              winner: { id: playerId, name: player.username, color: player.color, time: completionTime },
              scores
            });

            // Update DB and stats
            handleRaceCompletion(roomState, currentRoomId);
          }
        } else {
          // Incorrect - update position and unlock
          piece.currentX = msg.x;
          piece.currentY = msg.y;
          piece.lockedBy = null;

          sendMsg(ws, {
            type: 'unlocked',
            pieceIndex
          });
        }
        return;
      }

      // Co-op mode (original logic)
      const pieceIndex = msg.pieceIndex;
      if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= roomState.pieces.length) {
        return sendMsg(ws, { type: 'error', message: 'Invalid piece index' });
      }

      const piece = roomState.pieces[pieceIndex];
      if (piece.lockedBy !== playerId) {
        return sendMsg(ws, { type: 'error', message: 'Piece not locked by you' });
      }

      const correctX = piece.correctCol * roomState.pieceWidth;
      const correctY = piece.correctRow * roomState.pieceHeight;
      const dist = Math.sqrt((msg.x - correctX) ** 2 + (msg.y - correctY) ** 2);
      const snapThreshold = Math.min(roomState.pieceWidth, roomState.pieceHeight) * 0.25;

      if (dist <= snapThreshold) {
        // Correct placement
        piece.placed = true;
        piece.currentX = correctX;
        piece.currentY = correctY;
        piece.lockedBy = null;
        roomState.placedCount++;

        const player = roomState.players.get(playerId);
        player.score++;

        // Update DB pieces_placed
        if (player.userId) {
          db.prepare(
            'UPDATE room_players SET pieces_placed = pieces_placed + 1 WHERE room_id = ? AND user_id = ?'
          ).run(currentRoomId, player.userId);
        } else if (player.guestName) {
          db.prepare(
            'UPDATE room_players SET pieces_placed = pieces_placed + 1 WHERE room_id = ? AND guest_name = ?'
          ).run(currentRoomId, player.guestName);
        }

        // Update progress on activeRooms for room list display
        roomState.progress = Math.round((roomState.placedCount / roomState.pieces.length) * 100);

        broadcastToRoom(roomState, {
          type: 'placed',
          pieceIndex,
          correctX,
          correctY,
          playerId,
          score: player.score
        });

        // Check completion
        if (roomState.placedCount === roomState.pieces.length) {
          handleCompletion(roomState, currentRoomId);
        }
      } else {
        // Incorrect - update position and unlock
        piece.currentX = msg.x;
        piece.currentY = msg.y;
        piece.lockedBy = null;

        broadcastToRoom(roomState, {
          type: 'unlocked',
          pieceIndex
        });
      }
    }

    function handleUnlock(msg) {
      if (!currentRoomId || !playerId) return;

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState || !roomState.started) return;

      // Race mode: unlock in the player's own puzzle
      if (roomState.mode === 'race') {
        const playerPuzzle = roomState.playerPuzzles?.get(playerId);
        if (!playerPuzzle) return;

        const pieceIndex = msg.pieceIndex;
        if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= playerPuzzle.pieces.length) return;

        const piece = playerPuzzle.pieces[pieceIndex];
        if (piece.lockedBy !== playerId) return;

        piece.lockedBy = null;

        sendMsg(ws, {
          type: 'unlocked',
          pieceIndex
        });
        return;
      }

      const pieceIndex = msg.pieceIndex;
      if (pieceIndex == null || pieceIndex < 0 || pieceIndex >= roomState.pieces.length) return;

      const piece = roomState.pieces[pieceIndex];
      if (piece.lockedBy !== playerId) return;

      piece.lockedBy = null;

      broadcastToRoom(roomState, {
        type: 'unlocked',
        pieceIndex
      });
    }

    function handleChat(msg) {
      if (!currentRoomId || !playerId) return;

      const roomState = activeRooms.get(currentRoomId);
      if (!roomState) return;

      const text = typeof msg.text === 'string' ? msg.text.slice(0, 200) : '';
      if (!text) return;

      const player = roomState.players.get(playerId);

      broadcastToRoom(roomState, {
        type: 'chat_msg',
        playerId,
        name: player.username,
        text,
        color: player.color
      });
    }

    function handleRaceCompletion(roomState, roomId) {
      // Update room status
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('completed', roomId);

      const playTime = roomState.startTime ? Math.floor((Date.now() - roomState.startTime) / 1000) : 0;
      const isRanked = roomState.isRanked;
      const totalPieces = roomState.pieces.length;

      for (const [pid, player] of roomState.players) {
        const pp = roomState.playerPuzzles?.get(pid);
        const piecesPlaced = pp ? pp.placedCount : 0;

        if (player.userId) {
          const piecesCol = isRanked ? 'ranked_pieces_placed' : 'unranked_pieces_placed';
          const puzzlesCol = isRanked ? 'ranked_puzzles_completed' : 'unranked_puzzles_completed';

          db.prepare('INSERT OR IGNORE INTO stats (user_id) VALUES (?)').run(player.userId);

          db.prepare(`
            UPDATE stats SET
              ${piecesCol} = ${piecesCol} + ?,
              ${puzzlesCol} = ${puzzlesCol} + 1,
              total_time_played = total_time_played + ?
            WHERE user_id = ?
          `).run(piecesPlaced, playTime, player.userId);

          db.prepare(`
            INSERT INTO puzzle_history (user_id, room_id, image_name, piece_count, pieces_placed, mode, is_ranked)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            player.userId,
            roomId,
            roomState.imageFilename,
            totalPieces,
            piecesPlaced,
            'race',
            isRanked ? 1 : 0
          );
        }
      }
    }

    function handleCompletion(roomState, roomId) {
      // Update room status
      db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run('completed', roomId);

      const playTime = roomState.startTime ? Math.floor((Date.now() - roomState.startTime) / 1000) : 0;
      const isRanked = roomState.isRanked;

      // Build scores
      const scores = [];
      for (const [pid, player] of roomState.players) {
        scores.push({
          playerId: pid,
          username: player.username,
          color: player.color,
          score: player.score
        });

        // Update stats for logged-in users
        if (player.userId) {
          const piecesCol = isRanked ? 'ranked_pieces_placed' : 'unranked_pieces_placed';
          const puzzlesCol = isRanked ? 'ranked_puzzles_completed' : 'unranked_puzzles_completed';

          // Ensure stats row exists
          db.prepare('INSERT OR IGNORE INTO stats (user_id) VALUES (?)').run(player.userId);

          db.prepare(`
            UPDATE stats SET
              ${piecesCol} = ${piecesCol} + ?,
              ${puzzlesCol} = ${puzzlesCol} + 1,
              total_time_played = total_time_played + ?
            WHERE user_id = ?
          `).run(player.score, playTime, player.userId);

          // Insert puzzle history
          db.prepare(`
            INSERT INTO puzzle_history (user_id, room_id, image_name, piece_count, pieces_placed, mode, is_ranked)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            player.userId,
            roomId,
            roomState.imageFilename,
            roomState.pieces.length,
            player.score,
            roomState.mode,
            isRanked ? 1 : 0
          );
        }
      }

      // Sort by score descending
      scores.sort((a, b) => b.score - a.score);

      broadcastToRoom(roomState, {
        type: 'completed',
        scores,
        isRanked: !!isRanked
      });
    }

    function handleDisconnect() {
      const info = wsToPlayer.get(ws);
      if (!info) return;

      const { playerId: pid, roomId } = info;
      wsToPlayer.delete(ws);

      const roomState = activeRooms.get(roomId);
      if (!roomState) return;

      // Unlock all pieces locked by this player
      if (roomState.mode === 'race') {
        // Race mode: just remove their puzzle state
        if (roomState.playerPuzzles) {
          roomState.playerPuzzles.delete(pid);
        }
      } else if (roomState.pieces) {
        for (const piece of roomState.pieces) {
          if (piece.lockedBy === pid) {
            piece.lockedBy = null;
            broadcastToRoom(roomState, {
              type: 'unlocked',
              pieceIndex: piece.index
            });
          }
        }
      }

      // Remove player
      roomState.players.delete(pid);

      // Broadcast player_left
      broadcastToRoom(roomState, {
        type: 'player_left',
        playerId: pid
      });

      // If disconnected player was host, migrate
      if (roomState.hostPlayerId === pid) {
        const nextPlayer = roomState.players.keys().next();
        if (!nextPlayer.done) {
          roomState.hostPlayerId = nextPlayer.value;
          // Notify remaining players of new host
          broadcastToRoom(roomState, {
            type: 'host_changed',
            playerId: roomState.hostPlayerId
          });
        }
      }

      // If no players left, clean up after timeout
      if (roomState.players.size === 0) {
        setTimeout(() => {
          const current = activeRooms.get(roomId);
          if (current && current.players.size === 0) {
            activeRooms.delete(roomId);
          }
        }, 60000); // 1 minute timeout
      }
    }
  });
}

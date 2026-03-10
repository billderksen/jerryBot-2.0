/**
 * Main game orchestrator — ties together puzzle generation, rendering,
 * interaction, and network communication.
 */

import { generatePuzzlePieces } from './puzzleGenerator.js';
import { PuzzleRenderer } from './puzzleRenderer.js';
import { PuzzleInteraction } from './puzzleInteraction.js';
import { GameNetwork } from './network.js';

class Game {
  constructor() {
    this.roomId = new URLSearchParams(location.search).get('room');
    if (!this.roomId) {
      location.href = '/';
      return;
    }

    this.canvas = document.getElementById('puzzle-canvas');
    this.network = null;
    this.renderer = null;
    this.interaction = null;
    this.myPlayerId = null;
    this.players = new Map();
    this.roomInfo = null;
    this.isHost = false;
    this.totalPieces = 0;
    this.placedPieces = 0;
    this.isRaceMode = false;
    this.raceProgress = new Map(); // playerId → { name, color, progress, placedCount, totalPieces }

    this.init();
  }

  async init() {
    // 1. Fetch room data from REST API
    try {
      const res = await fetch(`/api/rooms/${this.roomId}`);
      if (!res.ok) {
        alert('Room not found');
        location.href = '/';
        return;
      }
      this.roomInfo = await res.json();
    } catch (err) {
      console.error('Failed to fetch room:', err);
      alert('Could not connect to server');
      location.href = '/';
      return;
    }

    // 2. Set up network
    const guestName = sessionStorage.getItem('guestName') || 'Guest';
    this.network = new GameNetwork(this.roomId);
    this.setupNetworkHandlers();

    // 3. Join room via WebSocket once connected
    this.network.on('connected', () => {
      this.network.send('join', { roomId: this.roomId, guestName });
      this.setConnectionStatus(true);
    });

    this.network.on('disconnected', () => {
      this.setConnectionStatus(false);
    });

    // 4. Set up UI event listeners
    this.setupUIHandlers();

    // 5. Handle window resize
    window.addEventListener('resize', () => {
      if (this.renderer) {
        this.renderer.resize();
        this.renderer.drawBoard();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Network handlers                                                   */
  /* ------------------------------------------------------------------ */

  setupNetworkHandlers() {
    // Handle "joined" — receive full state
    this.network.on('joined', (msg) => {
      this.myPlayerId = msg.playerId;
      this.players = new Map(Object.entries(msg.players || {}));
      this.isHost = msg.isHost;
      this.isRaceMode = msg.roomInfo?.mode === 'race';

      this.updatePlayerList();
      this.updateRoomInfo();

      // If game already started, set up the puzzle
      if (msg.puzzleState) {
        this.setupPuzzle(msg.puzzleState);
        this.hideWaitingOverlay();
      } else {
        this.showWaitingOverlay();
      }

      // Show/hide start button
      const startBtn = document.getElementById('start-btn');
      if (this.isHost && !msg.puzzleState) {
        startBtn.style.display = 'inline-flex';
      } else {
        startBtn.style.display = 'none';
      }
    });

    // Handle "started" — game begins
    this.network.on('started', (msg) => {
      this.setupPuzzle(msg);
      this.hideWaitingOverlay();
      document.getElementById('start-btn').style.display = 'none';

      // In race mode, initialize progress for all players at 0%
      if (this.isRaceMode) {
        for (const [pid, player] of this.players) {
          this.raceProgress.set(pid, {
            name: player.name || player.username || 'Guest',
            color: player.color || '#888',
            progress: 0,
            placedCount: 0,
            totalPieces: this.totalPieces
          });
        }
        this.updateRaceProgressUI();
      }
    });

    // Handle "player_joined"
    this.network.on('player_joined', (msg) => {
      this.players.set(msg.player.id, msg.player);
      this.updatePlayerList();
      this.addSystemMessage(msg.player.name + ' joined');
    });

    // Handle "player_left"
    this.network.on('player_left', (msg) => {
      const player = this.players.get(msg.playerId);
      const name = player ? player.name : 'Someone';
      this.players.delete(msg.playerId);
      this.updatePlayerList();
      this.addSystemMessage(name + ' left');
    });

    // Handle "host_changed" — host migrated to another player
    this.network.on('host_changed', (msg) => {
      for (const [pid, player] of this.players) {
        player.isHost = (pid === msg.playerId);
      }
      this.isHost = (msg.playerId === this.myPlayerId);
      this.updatePlayerList();
      const newHost = this.players.get(msg.playerId);
      this.addSystemMessage((newHost?.name || 'Someone') + ' is now the host');
    });

    // Handle "locked" — a piece was locked by a player
    this.network.on('locked', (msg) => {
      if (msg.playerId === this.myPlayerId) {
        this.interaction?.confirmLock(msg.pieceIndex);
      }
      this.renderer?.updatePieceState(msg.pieceIndex, {
        lockedBy: msg.playerId,
        playerColor: msg.playerColor,
        playerName: msg.playerName
      });
      this.interaction?.requestRedraw();
    });

    // Handle "moved" — another player moved a piece (co-op only)
    this.network.on('moved', (msg) => {
      if (this.isRaceMode) return; // Race mode: no shared pieces
      if (msg.playerId === this.myPlayerId) return;
      this.renderer?.updatePieceState(msg.pieceIndex, { x: msg.x, y: msg.y });
      this.interaction?.requestRedraw();
    });

    // Handle "placed" — piece correctly placed
    this.network.on('placed', (msg) => {
      this.renderer?.updatePieceState(msg.pieceIndex, {
        x: msg.correctX,
        y: msg.correctY,
        placed: true,
        lockedBy: null
      });
      const player = this.players.get(msg.playerId);
      if (player) player.score = msg.score;
      this.placedPieces = msg.placedCount ?? (this.placedPieces + 1);
      this.updatePlayerList();
      this.updateProgress();
      this.interaction?.confirmPlacement(msg.pieceIndex, msg.correctX, msg.correctY);

      // In race mode, update own progress in the race progress map
      if (this.isRaceMode && msg.playerId === this.myPlayerId) {
        const me = this.players.get(this.myPlayerId);
        const progress = this.totalPieces > 0 ? Math.round((this.placedPieces / this.totalPieces) * 100) : 0;
        this.raceProgress.set(this.myPlayerId, {
          name: me?.name || 'You',
          color: me?.color || '#888',
          progress,
          placedCount: this.placedPieces,
          totalPieces: this.totalPieces
        });
        this.updateRaceProgressUI();
      }
    });

    // Handle "unlocked" — piece released
    this.network.on('unlocked', (msg) => {
      if (msg.playerId === this.myPlayerId) {
        this.interaction?.denyLock(msg.pieceIndex);
      }
      this.renderer?.updatePieceState(msg.pieceIndex, {
        lockedBy: null,
        playerColor: null,
        playerName: null
      });
      this.interaction?.releasePiece(msg.pieceIndex);
      this.interaction?.requestRedraw();
    });

    // Handle "completed" — puzzle finished (co-op)
    this.network.on('completed', (msg) => {
      this.showCompletionScreen(msg.scores, msg.isRanked);
    });

    // Handle "race_progress" — another player's progress update
    this.network.on('race_progress', (msg) => {
      this.raceProgress.set(msg.playerId, {
        name: msg.playerName,
        color: msg.playerColor,
        progress: msg.progress,
        placedCount: msg.placedCount,
        totalPieces: msg.totalPieces
      });
      this.updateRaceProgressUI();
    });

    // Handle "race_complete" — someone finished the race
    this.network.on('race_complete', (msg) => {
      this.showRaceCompleteScreen(msg.winner, msg.scores);
    });

    // Handle "chat_msg"
    this.network.on('chat_msg', (msg) => {
      this.addChatMessage(msg.name, msg.text, msg.color);
    });

    // Handle "error"
    this.network.on('error', (msg) => {
      console.error('Server error:', msg.message);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Puzzle setup                                                       */
  /* ------------------------------------------------------------------ */

  setupPuzzle(puzzleState) {
    const img = new Image();
    const imageUrl = this.roomInfo.is_builtin
      ? `/puzzle-images/${encodeURIComponent(this.roomInfo.image_filename)}`
      : `/uploads/${encodeURIComponent(this.roomInfo.image_filename)}`;

    img.onload = () => {
      const { cols, rows, pieceWidth, pieceHeight, seed } = puzzleState;

      const pieces = generatePuzzlePieces(cols, rows, pieceWidth, pieceHeight, seed);

      this.totalPieces = pieces.length;
      this.placedPieces = 0;

      this.renderer = new PuzzleRenderer(this.canvas, img, pieces, pieceWidth, pieceHeight, cols, rows);
      this.renderer.resize();

      // Set initial piece positions from server state
      const states = new Map();
      if (puzzleState.pieces) {
        puzzleState.pieces.forEach(p => {
          if (p.placed) this.placedPieces++;
          states.set(p.index, {
            x: p.currentX,
            y: p.currentY,
            placed: p.placed,
            lockedBy: p.lockedBy,
            playerColor: p.playerColor || null,
            playerName: p.playerName || null
          });
        });
      }
      this.renderer.setPieceStates(states);

      this.interaction = new PuzzleInteraction(this.renderer, {
        onLockRequest: (pieceIndex) => {
          this.network.send('lock', { pieceIndex });
        },
        onMove: (pieceIndex, x, y) => {
          this.network.sendMove(pieceIndex, x, y);
        },
        onDrop: (pieceIndex, x, y) => {
          this.network.send('drop', { pieceIndex, x, y });
        },
        onUnlock: (pieceIndex) => {
          this.network.send('unlock', { pieceIndex });
        }
      });

      this.renderer.centerBoard();
      this.renderer.drawBoard();
      this.updateProgress();
    };

    img.onerror = () => {
      console.error('Failed to load puzzle image:', imageUrl);
    };

    img.src = imageUrl;
  }

  /* ------------------------------------------------------------------ */
  /*  UI setup                                                           */
  /* ------------------------------------------------------------------ */

  setupUIHandlers() {
    // Start button
    const startBtn = document.getElementById('start-btn');
    startBtn.addEventListener('click', () => {
      this.network.send('start', { roomId: this.roomId });
      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';
    });

    // Chat input
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');

    const sendChat = () => {
      const text = chatInput.value.trim();
      if (!text) return;
      this.network.send('chat', { text });
      chatInput.value = '';
    };

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendChat();
      }
    });

    chatSend.addEventListener('click', sendChat);

    // Back to lobby button
    document.getElementById('back-to-lobby').addEventListener('click', () => {
      location.href = '/';
    });

    // Mobile sidebar toggle with swipe support
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-handle');
    if (handle) {
      handle.addEventListener('click', () => {
        sidebar.classList.toggle('expanded');
      });

      // Swipe gesture on sidebar handle
      let touchStartY = 0;
      let touchStartTime = 0;
      handle.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
      }, { passive: true });

      handle.addEventListener('touchend', (e) => {
        const touchEndY = e.changedTouches[0].clientY;
        const deltaY = touchStartY - touchEndY;
        const elapsed = Date.now() - touchStartTime;
        // Quick swipe threshold: >40px in <300ms
        if (elapsed < 300 && Math.abs(deltaY) > 40) {
          if (deltaY > 0) {
            sidebar.classList.add('expanded');     // swipe up → open
          } else {
            sidebar.classList.remove('expanded');  // swipe down → close
          }
        }
      }, { passive: true });
    }

    // Floating action buttons (mobile)
    const fabCenter = document.getElementById('fab-center');
    if (fabCenter) {
      fabCenter.addEventListener('click', () => {
        if (this.renderer) {
          this.renderer.centerBoard();
          this.renderer.drawBoard();
        }
      });
    }

    const fabFitAll = document.getElementById('fab-fit-all');
    if (fabFitAll) {
      fabFitAll.addEventListener('click', () => {
        if (this.renderer) {
          this.renderer.fitAllPieces();
          this.renderer.drawBoard();
        }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  UI update methods                                                  */
  /* ------------------------------------------------------------------ */

  updatePlayerList() {
    const container = document.getElementById('player-list');
    if (!container) return;

    container.textContent = '';

    // Sort by score descending
    const sorted = [...this.players.entries()].sort((a, b) => {
      return (b[1].score || 0) - (a[1].score || 0);
    });

    for (const [id, player] of sorted) {
      const el = document.createElement('div');
      el.className = 'player-item';
      if (id === this.myPlayerId) el.classList.add('player-self');

      const colorDot = document.createElement('span');
      colorDot.className = 'player-color';
      colorDot.style.background = player.color || '#888';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'player-name';
      nameSpan.textContent = player.name || 'Guest';

      if (player.isHost) {
        const hostTag = document.createElement('span');
        hostTag.className = 'host-tag';
        hostTag.textContent = 'HOST';
        nameSpan.appendChild(document.createTextNode(' '));
        nameSpan.appendChild(hostTag);
      }

      if (id === this.myPlayerId) {
        const youTag = document.createElement('span');
        youTag.className = 'you-tag';
        youTag.textContent = 'YOU';
        nameSpan.appendChild(document.createTextNode(' '));
        nameSpan.appendChild(youTag);
      }

      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'player-score';
      scoreSpan.textContent = player.score || 0;

      el.appendChild(colorDot);
      el.appendChild(nameSpan);
      el.appendChild(scoreSpan);
      container.appendChild(el);
    }

    // Update player count in waiting overlay
    const countDisplay = document.getElementById('player-count-display');
    if (countDisplay) {
      countDisplay.textContent = this.players.size + ' player' + (this.players.size !== 1 ? 's' : '') + ' in room';
    }
  }

  updateProgress() {
    const bar = document.getElementById('progress-bar');
    const text = document.getElementById('progress-text');
    if (!bar || !text) return;

    const pct = this.totalPieces > 0
      ? Math.round((this.placedPieces / this.totalPieces) * 100)
      : 0;

    bar.style.width = pct + '%';
    text.textContent = this.placedPieces + '/' + this.totalPieces + ' (' + pct + '%)';
  }

  updateRoomInfo() {
    if (!this.roomInfo) return;

    const nameEl = document.getElementById('sidebar-room-name');
    const roomNameDisplay = document.getElementById('room-name-display');
    const modeBadge = document.getElementById('mode-badge');
    const rankedBadge = document.getElementById('ranked-badge');
    const pieceBadge = document.getElementById('piece-badge');

    if (nameEl) nameEl.textContent = this.roomInfo.name || 'Puzzle Room';
    if (roomNameDisplay) roomNameDisplay.textContent = this.roomInfo.name || 'Puzzle Room';

    if (modeBadge) {
      const mode = this.roomInfo.mode || 'coop';
      modeBadge.textContent = mode.toUpperCase();
      modeBadge.className = 'badge badge-' + mode;
    }

    if (rankedBadge) {
      const ranked = this.roomInfo.is_ranked;
      rankedBadge.textContent = ranked ? 'RANKED' : 'CASUAL';
      rankedBadge.className = 'badge ' + (ranked ? 'badge-ranked' : 'badge-unranked');
    }

    if (pieceBadge) {
      const pieces = this.roomInfo.piece_count || '?';
      pieceBadge.textContent = pieces + ' PCS';
      pieceBadge.className = 'badge badge-pieces';
    }

    document.title = (this.roomInfo.name || 'Puzzle') + ' - Jigsaw';
  }

  addChatMessage(name, text, color) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'chat-msg';

    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = timeStr;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.style.color = color || '#888';
    nameSpan.textContent = name + ':';

    // textContent is safe against XSS — no innerHTML used
    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = ' ' + text;

    el.appendChild(timeSpan);
    el.appendChild(document.createTextNode(' '));
    el.appendChild(nameSpan);
    el.appendChild(textSpan);
    container.appendChild(el);

    container.scrollTop = container.scrollHeight;
  }

  addSystemMessage(text) {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    const el = document.createElement('div');
    el.className = 'chat-msg chat-system';
    el.textContent = text;
    container.appendChild(el);
    container.scrollTop = container.scrollHeight;
  }

  updateRaceProgressUI() {
    let container = document.getElementById('race-progress');
    if (!container) {
      // Create the race progress container in the sidebar, after the progress container
      const progressContainer = document.getElementById('progress-container');
      if (!progressContainer) return;
      container = document.createElement('div');
      container.id = 'race-progress';
      container.style.cssText = 'margin-top: 12px;';
      const heading = document.createElement('h4');
      heading.textContent = 'Race Progress';
      heading.style.cssText = 'margin: 0 0 8px; font-size: 13px; color: var(--text-secondary, #aaa);';
      container.appendChild(heading);
      progressContainer.parentNode.insertBefore(container, progressContainer.nextSibling);
    }

    // Remove old bars (keep heading)
    while (container.children.length > 1) {
      container.removeChild(container.lastChild);
    }

    // Sort by progress descending
    const sorted = [...this.raceProgress.entries()].sort((a, b) => b[1].progress - a[1].progress);

    for (const [pid, data] of sorted) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom: 6px;';

      const label = document.createElement('div');
      label.style.cssText = 'display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 2px;';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = data.name + (pid === this.myPlayerId ? ' (you)' : '');
      nameSpan.style.color = data.color;
      const pctSpan = document.createElement('span');
      pctSpan.textContent = data.progress + '%';
      pctSpan.style.color = 'var(--text-secondary, #aaa)';
      label.appendChild(nameSpan);
      label.appendChild(pctSpan);

      const track = document.createElement('div');
      track.style.cssText = 'height: 6px; background: var(--bg-tertiary, #333); border-radius: 3px; overflow: hidden;';
      const bar = document.createElement('div');
      bar.style.cssText = `height: 100%; width: ${data.progress}%; background: ${data.color}; border-radius: 3px; transition: width 0.3s ease;`;
      track.appendChild(bar);

      row.appendChild(label);
      row.appendChild(track);
      container.appendChild(row);
    }
  }

  showRaceCompleteScreen(winner, scores) {
    const overlay = document.getElementById('completion-overlay');
    const scoresContainer = document.getElementById('final-scores');
    if (!overlay || !scoresContainer) return;

    scoresContainer.textContent = '';

    // Winner announcement
    const winnerDiv = document.createElement('div');
    winnerDiv.style.cssText = 'text-align: center; margin-bottom: 16px;';

    const winnerName = document.createElement('div');
    winnerName.style.cssText = `font-size: 22px; font-weight: bold; color: ${winner.color || '#f1c40f'};`;
    winnerName.textContent = winner.name + ' wins!';

    const winnerTime = document.createElement('div');
    winnerTime.style.cssText = 'font-size: 14px; color: var(--text-secondary, #aaa); margin-top: 4px;';
    const mins = Math.floor(winner.time / 60);
    const secs = winner.time % 60;
    winnerTime.textContent = 'Completed in ' + (mins > 0 ? mins + 'm ' : '') + secs + 's';

    winnerDiv.appendChild(winnerName);
    winnerDiv.appendChild(winnerTime);
    scoresContainer.appendChild(winnerDiv);

    // Scores table
    const table = document.createElement('div');
    table.className = 'scores-table';

    const header = document.createElement('div');
    header.className = 'scores-header';
    const headerPlayer = document.createElement('span');
    headerPlayer.textContent = 'Player';
    const headerScore = document.createElement('span');
    headerScore.textContent = 'Progress';
    header.appendChild(headerPlayer);
    header.appendChild(headerScore);
    table.appendChild(header);

    const sortedScores = Array.isArray(scores)
      ? scores.sort((a, b) => (b.score || 0) - (a.score || 0))
      : [];

    sortedScores.forEach((entry, i) => {
      const row = document.createElement('div');
      const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      row.className = 'scores-row' + (medal ? ' ' + medal : '');
      if (entry.playerId === winner.id) {
        row.style.border = '1px solid ' + (winner.color || '#f1c40f');
      }

      const rank = document.createElement('span');
      rank.className = 'score-rank';
      rank.textContent = '#' + (i + 1);

      const name = document.createElement('span');
      name.className = 'score-name';
      name.style.color = entry.color || '#888';
      name.textContent = entry.username || 'Guest';

      const score = document.createElement('span');
      score.className = 'score-value';
      const total = entry.totalPieces || this.totalPieces;
      const pct = total > 0 ? Math.round((entry.score / total) * 100) : 0;
      score.textContent = entry.score + '/' + total + ' (' + pct + '%)';

      row.appendChild(rank);
      row.appendChild(name);
      row.appendChild(score);
      table.appendChild(row);
    });

    scoresContainer.appendChild(table);

    // Update the overlay heading for race mode
    const heading = overlay.querySelector('h2');
    if (heading) heading.textContent = 'Race Complete!';

    overlay.style.display = 'flex';
  }

  showCompletionScreen(scores, isRanked) {
    const overlay = document.getElementById('completion-overlay');
    const scoresContainer = document.getElementById('final-scores');
    if (!overlay || !scoresContainer) return;

    scoresContainer.textContent = '';

    const table = document.createElement('div');
    table.className = 'scores-table';

    // Header
    const header = document.createElement('div');
    header.className = 'scores-header';
    const headerPlayer = document.createElement('span');
    headerPlayer.textContent = 'Player';
    const headerScore = document.createElement('span');
    headerScore.textContent = 'Pieces';
    header.appendChild(headerPlayer);
    header.appendChild(headerScore);
    table.appendChild(header);

    // Sort scores descending
    const sortedScores = Array.isArray(scores)
      ? scores.sort((a, b) => (b.score || 0) - (a.score || 0))
      : [];

    sortedScores.forEach((entry, i) => {
      const row = document.createElement('div');
      const medal = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      row.className = 'scores-row' + (medal ? ' ' + medal : '');

      const rank = document.createElement('span');
      rank.className = 'score-rank';
      rank.textContent = '#' + (i + 1);

      const name = document.createElement('span');
      name.className = 'score-name';
      name.style.color = entry.color || '#888';
      name.textContent = entry.name || 'Guest';

      const score = document.createElement('span');
      score.className = 'score-value';
      score.textContent = entry.score || 0;

      row.appendChild(rank);
      row.appendChild(name);
      row.appendChild(score);
      table.appendChild(row);
    });

    scoresContainer.appendChild(table);

    if (isRanked) {
      const notice = document.createElement('p');
      notice.className = 'ranked-notice';
      notice.textContent = 'Ranked game — results saved';
      scoresContainer.appendChild(notice);
    }

    overlay.style.display = 'flex';
  }

  showWaitingOverlay() {
    const overlay = document.getElementById('waiting-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  hideWaitingOverlay() {
    const overlay = document.getElementById('waiting-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  setConnectionStatus(connected) {
    const indicator = document.getElementById('connection-status');
    if (!indicator) return;
    indicator.className = connected ? 'status-dot connected' : 'status-dot disconnected';
    indicator.title = connected ? 'Connected' : 'Reconnecting...';
  }
}

// Start the game when the page loads
const game = new Game();

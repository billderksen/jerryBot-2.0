/**
 * Handles all user input for the jigsaw puzzle: mouse, touch, drag,
 * snap detection, and piece group management.
 */

class PuzzleInteraction {
  /**
   * @param {PuzzleRenderer} renderer
   * @param {object} callbacks
   * @param {function} callbacks.onLockRequest - (pieceIndex) => void
   * @param {function} callbacks.onMove        - (pieceIndex, x, y) => void
   * @param {function} callbacks.onDrop        - (pieceIndex, x, y) => void
   * @param {function} callbacks.onUnlock      - (pieceIndex) => void
   */
  constructor(renderer, callbacks) {
    this.renderer = renderer;
    this.callbacks = callbacks;

    // Drag state
    this.heldPiece = null;
    this.heldOffset = { x: 0, y: 0 };
    this.isDragging = false;
    this.lockConfirmed = false;

    // Pan state
    this.isPanning = false;
    this.lastPanX = 0;
    this.lastPanY = 0;

    // Touch state
    this.lastTouchDist = 0;
    this.lastTouchMid = null;

    // Throttle
    this.lastMoveTime = 0;
    this.moveThrottleMs = 60;

    // Groups: groupId -> Set<pieceIndex>, pieceIndex -> groupId
    this.groups = new Map();
    this.pieceGroup = new Map();
    this._nextGroupId = 1;

    // Snap distance: piece must be within this many px of correct pos to snap
    this.snapDistance = renderer.pieceWidth * 0.25;

    // Render loop
    this._animFrameId = null;
    this._renderLoopRunning = false;

    // Bind and attach events
    this._bindEvents();
  }

  /* ------------------------------------------------------------------ */
  /*  Event binding                                                      */
  /* ------------------------------------------------------------------ */

  _bindEvents() {
    const canvas = this.renderer.canvas;

    // Prevent default touch actions on canvas
    canvas.style.touchAction = 'none';

    // Mouse
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);

    canvas.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup', this._onMouseUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });

    // Touch
    this._onTouchStart = this._handleTouchStart.bind(this);
    this._onTouchMove = this._handleTouchMove.bind(this);
    this._onTouchEnd = this._handleTouchEnd.bind(this);

    canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    canvas.addEventListener('touchend', this._onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', this._onTouchEnd, { passive: false });
  }

  /* ------------------------------------------------------------------ */
  /*  Mouse handlers                                                     */
  /* ------------------------------------------------------------------ */

  _handleMouseDown(e) {
    const rect = this.renderer.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const board = this.renderer.screenToBoard(screenX, screenY);

    const hit = this.renderer.hitTest(board.x, board.y);

    if (hit >= 0) {
      const state = this.renderer.pieceStates.get(hit);
      if (state && !state.placed && !state.lockedBy) {
        this.heldPiece = hit;
        this.lockConfirmed = false;
        this.isDragging = true;
        this.heldOffset.x = board.x - state.x;
        this.heldOffset.y = board.y - state.y;
        this.callbacks.onLockRequest(hit);
        this.startRenderLoop();
      }
    } else {
      // Start panning
      this.isPanning = true;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
    }
  }

  _handleMouseMove(e) {
    if (this.heldPiece !== null && this.lockConfirmed) {
      const rect = this.renderer.canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const board = this.renderer.screenToBoard(screenX, screenY);

      const newX = board.x - this.heldOffset.x;
      const newY = board.y - this.heldOffset.y;

      this._movePieceTo(this.heldPiece, newX, newY);

      // Throttle network broadcasts
      const now = Date.now();
      if (now - this.lastMoveTime >= this.moveThrottleMs) {
        this.lastMoveTime = now;
        this.callbacks.onMove(this.heldPiece, newX, newY);
      }
    } else if (this.isPanning) {
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;
      this.renderer.pan(dx, dy);
      this.requestRedraw();
    }
  }

  _handleMouseUp(e) {
    if (this.heldPiece !== null) {
      const state = this.renderer.pieceStates.get(this.heldPiece);
      if (state) {
        this.callbacks.onDrop(this.heldPiece, state.x, state.y);
      }
      this.heldPiece = null;
      this.isDragging = false;
      this.lockConfirmed = false;
      this.stopRenderLoop();
      this.requestRedraw();
    }

    this.isPanning = false;
  }

  _handleWheel(e) {
    e.preventDefault();
    const rect = this.renderer.canvas.getBoundingClientRect();
    const centerX = e.clientX - rect.left;
    const centerY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    this.renderer.setZoom(this.renderer.zoom * factor, centerX, centerY);
    this.requestRedraw();
  }

  /* ------------------------------------------------------------------ */
  /*  Touch handlers                                                     */
  /* ------------------------------------------------------------------ */

  _handleTouchStart(e) {
    e.preventDefault();

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = this.renderer.canvas.getBoundingClientRect();
      const screenX = touch.clientX - rect.left;
      const screenY = touch.clientY - rect.top;
      const board = this.renderer.screenToBoard(screenX, screenY);

      const hit = this.renderer.hitTest(board.x, board.y);

      if (hit >= 0) {
        const state = this.renderer.pieceStates.get(hit);
        if (state && !state.placed && !state.lockedBy) {
          this.heldPiece = hit;
          this.lockConfirmed = false;
          this.isDragging = true;
          this.heldOffset.x = board.x - state.x;
          this.heldOffset.y = board.y - state.y;
          this.callbacks.onLockRequest(hit);
          this.startRenderLoop();
        }
      } else {
        this.isPanning = true;
        this.lastPanX = touch.clientX;
        this.lastPanY = touch.clientY;
      }
    } else if (e.touches.length === 2) {
      // Drop any held piece on pinch start
      if (this.heldPiece !== null) {
        const state = this.renderer.pieceStates.get(this.heldPiece);
        if (state) {
          this.callbacks.onDrop(this.heldPiece, state.x, state.y);
        }
        this.heldPiece = null;
        this.isDragging = false;
        this.lockConfirmed = false;
        this.stopRenderLoop();
      }
      this.isPanning = false;

      // Start pinch
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      this.lastTouchDist = this._touchDist(t0, t1);
      this.lastTouchMid = this._touchMid(t0, t1);
    }
  }

  _handleTouchMove(e) {
    e.preventDefault();

    if (e.touches.length === 1) {
      const touch = e.touches[0];

      if (this.heldPiece !== null && this.lockConfirmed) {
        const rect = this.renderer.canvas.getBoundingClientRect();
        const screenX = touch.clientX - rect.left;
        const screenY = touch.clientY - rect.top;
        const board = this.renderer.screenToBoard(screenX, screenY);

        const newX = board.x - this.heldOffset.x;
        const newY = board.y - this.heldOffset.y;

        this._movePieceTo(this.heldPiece, newX, newY);

        const now = Date.now();
        if (now - this.lastMoveTime >= this.moveThrottleMs) {
          this.lastMoveTime = now;
          this.callbacks.onMove(this.heldPiece, newX, newY);
        }
      } else if (this.isPanning) {
        const dx = touch.clientX - this.lastPanX;
        const dy = touch.clientY - this.lastPanY;
        this.lastPanX = touch.clientX;
        this.lastPanY = touch.clientY;
        this.renderer.pan(dx, dy);
        this.requestRedraw();
      }
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0];
      const t1 = e.touches[1];

      // Pinch zoom
      const dist = this._touchDist(t0, t1);
      if (this.lastTouchDist > 0) {
        const ratio = dist / this.lastTouchDist;
        const mid = this._touchMid(t0, t1);
        const rect = this.renderer.canvas.getBoundingClientRect();
        const cx = mid.x - rect.left;
        const cy = mid.y - rect.top;

        this.renderer.setZoom(this.renderer.zoom * ratio, cx, cy);

        // Two-finger pan
        if (this.lastTouchMid) {
          const panDx = mid.x - this.lastTouchMid.x;
          const panDy = mid.y - this.lastTouchMid.y;
          this.renderer.pan(panDx, panDy);
        }

        this.lastTouchMid = mid;
        this.requestRedraw();
      }
      this.lastTouchDist = dist;
    }
  }

  _handleTouchEnd(e) {
    e.preventDefault();

    if (e.touches.length === 0) {
      // All fingers lifted
      if (this.heldPiece !== null) {
        const state = this.renderer.pieceStates.get(this.heldPiece);
        if (state) {
          this.callbacks.onDrop(this.heldPiece, state.x, state.y);
        }
        this.heldPiece = null;
        this.isDragging = false;
        this.lockConfirmed = false;
        this.stopRenderLoop();
        this.requestRedraw();
      }
      this.isPanning = false;
      this.lastTouchDist = 0;
      this.lastTouchMid = null;
    } else if (e.touches.length === 1) {
      // Went from pinch to single finger — treat as pan start
      this.lastTouchDist = 0;
      this.lastTouchMid = null;
      const touch = e.touches[0];
      this.isPanning = true;
      this.lastPanX = touch.clientX;
      this.lastPanY = touch.clientY;
    }
  }

  _touchDist(t0, t1) {
    const dx = t0.clientX - t1.clientX;
    const dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _touchMid(t0, t1) {
    return {
      x: (t0.clientX + t1.clientX) / 2,
      y: (t0.clientY + t1.clientY) / 2
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Piece movement (with group support)                                */
  /* ------------------------------------------------------------------ */

  _movePieceTo(pieceIndex, newX, newY) {
    const state = this.renderer.pieceStates.get(pieceIndex);
    if (!state) return;

    const dx = newX - state.x;
    const dy = newY - state.y;

    // Move the held piece
    this.renderer.updatePieceState(pieceIndex, { x: newX, y: newY, lifted: true });

    // Move all other pieces in the same group
    const group = this.getGroup(pieceIndex);
    for (const idx of group) {
      if (idx === pieceIndex) continue;
      const s = this.renderer.pieceStates.get(idx);
      if (s) {
        this.renderer.updatePieceState(idx, {
          x: s.x + dx,
          y: s.y + dy,
          lifted: true
        });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Group management                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Merge two pieces into the same group.
   */
  mergePieces(index1, index2) {
    const g1 = this.pieceGroup.get(index1);
    const g2 = this.pieceGroup.get(index2);

    if (g1 != null && g2 != null) {
      if (g1 === g2) return; // already same group
      // Merge smaller into larger
      const set1 = this.groups.get(g1);
      const set2 = this.groups.get(g2);
      const [keepId, keepSet, mergeId, mergeSet] =
        set1.size >= set2.size
          ? [g1, set1, g2, set2]
          : [g2, set2, g1, set1];

      for (const idx of mergeSet) {
        keepSet.add(idx);
        this.pieceGroup.set(idx, keepId);
      }
      this.groups.delete(mergeId);
    } else if (g1 != null) {
      this.groups.get(g1).add(index2);
      this.pieceGroup.set(index2, g1);
    } else if (g2 != null) {
      this.groups.get(g2).add(index1);
      this.pieceGroup.set(index1, g2);
    } else {
      // Neither has a group; create new
      const gid = this._nextGroupId++;
      const set = new Set([index1, index2]);
      this.groups.set(gid, set);
      this.pieceGroup.set(index1, gid);
      this.pieceGroup.set(index2, gid);
    }
  }

  /**
   * Get the Set of piece indices sharing a group with pieceIndex.
   */
  getGroup(pieceIndex) {
    const gid = this.pieceGroup.get(pieceIndex);
    if (gid != null && this.groups.has(gid)) {
      return this.groups.get(gid);
    }
    return new Set([pieceIndex]);
  }

  /* ------------------------------------------------------------------ */
  /*  Lock / placement confirmations (called by network layer)           */
  /* ------------------------------------------------------------------ */

  /**
   * Server granted the lock — allow dragging.
   */
  confirmLock(pieceIndex) {
    if (this.heldPiece === pieceIndex) {
      this.lockConfirmed = true;
      this.renderer.updatePieceState(pieceIndex, { lifted: true });
      this.requestRedraw();
    }
  }

  /**
   * Server denied the lock — release the piece locally.
   */
  denyLock(pieceIndex) {
    if (this.heldPiece === pieceIndex) {
      this.heldPiece = null;
      this.isDragging = false;
      this.lockConfirmed = false;
      this.stopRenderLoop();
      this.requestRedraw();
    }
  }

  /**
   * Server confirmed correct placement — snap and mark placed.
   */
  confirmPlacement(pieceIndex, x, y) {
    this.renderer.updatePieceState(pieceIndex, {
      x,
      y,
      placed: true,
      lifted: false,
      lockedBy: null,
      playerColor: null,
      playerName: null
    });

    // Check for adjacent placed pieces and merge groups
    const piece = this.renderer.pieces[pieceIndex];
    const { col, row } = piece;
    const cols = this.renderer.cols;
    const rows = this.renderer.rows;

    const neighbors = [
      { dc: -1, dr: 0 },
      { dc: 1, dr: 0 },
      { dc: 0, dr: -1 },
      { dc: 0, dr: 1 }
    ];

    for (const { dc, dr } of neighbors) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const neighborIndex = nr * cols + nc;
      const neighborState = this.renderer.pieceStates.get(neighborIndex);
      if (neighborState && neighborState.placed) {
        this.mergePieces(pieceIndex, neighborIndex);
      }
    }

    this.requestRedraw();
  }

  /**
   * Another player released a piece lock.
   */
  releasePiece(pieceIndex) {
    this.renderer.updatePieceState(pieceIndex, {
      lifted: false,
      lockedBy: null,
      playerColor: null,
      playerName: null
    });
    this.requestRedraw();
  }

  /* ------------------------------------------------------------------ */
  /*  Snap detection                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Check if a piece at (x, y) is close enough to its correct grid position.
   */
  isCloseEnough(piece, x, y) {
    const correct = this.renderer.getCorrectPosition(piece);
    const dx = x - correct.x;
    const dy = y - correct.y;
    return Math.sqrt(dx * dx + dy * dy) < this.snapDistance;
  }

  /* ------------------------------------------------------------------ */
  /*  Render loop                                                        */
  /* ------------------------------------------------------------------ */

  startRenderLoop() {
    if (this._renderLoopRunning) return;
    this._renderLoopRunning = true;

    const loop = () => {
      if (!this._renderLoopRunning) return;
      this.renderer.drawBoard();
      this._animFrameId = requestAnimationFrame(loop);
    };
    this._animFrameId = requestAnimationFrame(loop);
  }

  stopRenderLoop() {
    this._renderLoopRunning = false;
    if (this._animFrameId != null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  /**
   * Single redraw for non-drag state changes.
   */
  requestRedraw() {
    requestAnimationFrame(() => this.renderer.drawBoard());
  }

  /* ------------------------------------------------------------------ */
  /*  Cleanup                                                            */
  /* ------------------------------------------------------------------ */

  destroy() {
    const canvas = this.renderer.canvas;
    canvas.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    canvas.removeEventListener('wheel', this._onWheel);
    canvas.removeEventListener('touchstart', this._onTouchStart);
    canvas.removeEventListener('touchmove', this._onTouchMove);
    canvas.removeEventListener('touchend', this._onTouchEnd);
    canvas.removeEventListener('touchcancel', this._onTouchEnd);
    this.stopRenderLoop();
  }
}

export { PuzzleInteraction };

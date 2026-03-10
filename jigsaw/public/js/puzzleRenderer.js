/**
 * Canvas puzzle renderer with zoom/pan support.
 *
 * Draws jigsaw pieces (placed and unplaced) on an HTML5 Canvas,
 * handling clipping, tab overflow, coordinate transforms, and hit-testing.
 */

class PuzzleRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLImageElement} image - Loaded source image
   * @param {Array} pieces - Piece objects from puzzleGenerator (row, col, edges, createPath)
   * @param {number} pieceWidth - Grid cell width in px
   * @param {number} pieceHeight - Grid cell height in px
   * @param {number} cols
   * @param {number} rows
   */
  constructor(canvas, image, pieces, pieceWidth, pieceHeight, cols, rows) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = image;
    this.pieces = pieces;
    this.pieceWidth = pieceWidth;
    this.pieceHeight = pieceHeight;
    this.cols = cols;
    this.rows = rows;

    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;

    // Map of piece index → { x, y, placed, lockedBy, playerColor, playerName, groupId }
    this.pieceStates = new Map();

    // Padding ratio for tab overflow
    this.tabPadding = 0.22;
  }

  /* ------------------------------------------------------------------ */
  /*  State helpers                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Set all piece positions/states at once (e.g. from server snapshot).
   * @param {Map|Object|Array} states
   */
  setPieceStates(states) {
    this.pieceStates.clear();
    if (states instanceof Map) {
      states.forEach((v, k) => this.pieceStates.set(Number(k), v));
    } else if (Array.isArray(states)) {
      states.forEach((s, i) => { if (s) this.pieceStates.set(i, s); });
    } else if (states && typeof states === 'object') {
      for (const [k, v] of Object.entries(states)) {
        this.pieceStates.set(Number(k), v);
      }
    }
  }

  /**
   * Update a single piece's state.
   */
  updatePieceState(index, state) {
    const existing = this.pieceStates.get(index) || {};
    this.pieceStates.set(index, { ...existing, ...state });
  }

  /* ------------------------------------------------------------------ */
  /*  Coordinate transforms                                              */
  /* ------------------------------------------------------------------ */

  screenToBoard(screenX, screenY) {
    return {
      x: (screenX - this.panX) / this.zoom,
      y: (screenY - this.panY) / this.zoom
    };
  }

  boardToScreen(boardX, boardY) {
    return {
      x: boardX * this.zoom + this.panX,
      y: boardY * this.zoom + this.panY
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Zoom / Pan                                                         */
  /* ------------------------------------------------------------------ */

  setZoom(newZoom, centerX, centerY) {
    const boardBefore = this.screenToBoard(centerX, centerY);
    this.zoom = Math.max(0.2, Math.min(3, newZoom));
    const boardAfter = this.screenToBoard(centerX, centerY);
    this.panX += (boardAfter.x - boardBefore.x) * this.zoom;
    this.panY += (boardAfter.y - boardBefore.y) * this.zoom;
  }

  pan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
  }

  /* ------------------------------------------------------------------ */
  /*  Main render                                                        */
  /* ------------------------------------------------------------------ */

  drawBoard() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const dpr = window.devicePixelRatio || 1;

    // Clear
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    // DPI scaling is already applied in resize(), so we work in CSS pixels
    ctx.translate(this.panX, this.panY);
    ctx.scale(this.zoom, this.zoom);

    // 1. Draw target grid (faint outlines)
    this._drawGrid(ctx);

    // 2. Collect placed and unplaced piece indices
    const placed = [];
    const unplaced = [];

    for (let i = 0; i < this.pieces.length; i++) {
      const state = this.pieceStates.get(i);
      if (!state) continue;
      if (state.placed) {
        placed.push(i);
      } else {
        unplaced.push(i);
      }
    }

    // 3. Draw placed pieces first (fully opaque, no highlight)
    for (const i of placed) {
      const piece = this.pieces[i];
      const state = this.pieceStates.get(i);
      this.drawPiece(piece, state.x, state.y, { placed: true });
    }

    // 4. Draw unplaced pieces on top
    for (const i of unplaced) {
      const piece = this.pieces[i];
      const state = this.pieceStates.get(i);
      this.drawPiece(piece, state.x, state.y, {
        placed: false,
        lifted: !!state.lifted,
        lockedBy: state.lockedBy || null,
        playerColor: state.playerColor || null,
        playerName: state.playerName || null,
        opacity: 1
      });
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Grid background                                                    */
  /* ------------------------------------------------------------------ */

  _drawGrid(ctx) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 0.5;

    const totalW = this.cols * this.pieceWidth;
    const totalH = this.rows * this.pieceHeight;

    // Outer border
    ctx.strokeRect(0, 0, totalW, totalH);

    // Vertical lines
    for (let c = 1; c < this.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * this.pieceWidth, 0);
      ctx.lineTo(c * this.pieceWidth, totalH);
      ctx.stroke();
    }

    // Horizontal lines
    for (let r = 1; r < this.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * this.pieceHeight);
      ctx.lineTo(totalW, r * this.pieceHeight);
      ctx.stroke();
    }

    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /*  Draw a single piece                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} piece - Piece from puzzleGenerator
   * @param {number} x - Board x of the piece's top-left grid cell
   * @param {number} y - Board y of the piece's top-left grid cell
   * @param {object} options
   */
  drawPiece(piece, x, y, options = {}) {
    const {
      placed = false,
      lifted = false,
      lockedBy = null,
      playerColor = null,
      playerName = null,
      opacity = 1
    } = options;

    const ctx = this.ctx;
    const pw = this.pieceWidth;
    const ph = this.pieceHeight;
    const padding = pw * this.tabPadding;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Lifted effect: slight scale-up and drop shadow
    if (lifted) {
      ctx.save();
      ctx.translate(x + pw / 2, y + ph / 2);
      ctx.scale(1.05, 1.05);
      ctx.translate(-(x + pw / 2), -(y + ph / 2));

      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 4;
    }

    // Build clip path at the piece's draw position, accounting for tab padding.
    // createPath expects the top-left of the grid cell.
    const clipPath = piece.createPath(x, y);

    // Clip and draw the image region
    ctx.save();
    ctx.clip(clipPath);

    // Source region in the image: the piece's cell plus padding for tabs.
    // We draw a larger region so knobs that extend beyond the cell are visible.
    const srcX = piece.col * pw - padding;
    const srcY = piece.row * ph - padding;
    const srcW = pw + padding * 2;
    const srcH = ph + padding * 2;

    // Destination: same region in board space
    const destX = x - padding;
    const destY = y - padding;

    ctx.drawImage(
      this.image,
      srcX, srcY, srcW, srcH,
      destX, destY, srcW, srcH
    );
    ctx.restore(); // end clip

    // Stroke the piece border
    if (!placed) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke(clipPath);
    }

    // Placed glow
    if (placed) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 0.5;
      ctx.stroke(clipPath);
    }

    // Locked indicator
    if (lockedBy && playerColor) {
      ctx.strokeStyle = playerColor;
      ctx.lineWidth = 3;
      ctx.stroke(clipPath);

      // Name tag
      if (playerName) {
        const tagX = x + pw / 2;
        const tagY = y - padding - 4;
        const fontSize = Math.max(10, Math.min(14, pw * 0.12));
        ctx.font = `bold ${fontSize}px sans-serif`;
        const metrics = ctx.measureText(playerName);
        const tagW = metrics.width + 8;
        const tagH = fontSize + 4;

        ctx.fillStyle = playerColor;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.roundRect(tagX - tagW / 2, tagY - tagH, tagW, tagH, 3);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(playerName, tagX, tagY - 2);
      }
    }

    if (lifted) {
      ctx.restore(); // end lifted transform + shadow
    }

    ctx.restore(); // end global alpha
  }

  /* ------------------------------------------------------------------ */
  /*  Hit testing                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Find which unplaced piece is at the given board coordinates.
   * Returns piece index or -1.
   */
  hitTest(boardX, boardY) {
    // Iterate in reverse so topmost (last drawn) pieces are checked first
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const state = this.pieceStates.get(i);
      if (!state || state.placed) continue;

      const piece = this.pieces[i];
      const path = piece.createPath(state.x, state.y);

      if (this.ctx.isPointInPath(path, boardX, boardY)) {
        return i;
      }
    }
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Return the correct board position for a piece (where it belongs).
   */
  getCorrectPosition(piece) {
    return {
      x: piece.col * this.pieceWidth,
      y: piece.row * this.pieceHeight
    };
  }

  /**
   * Handle canvas resize — match parent container, maintain DPI.
   */
  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.ctx.scale(dpr, dpr);
  }

  /**
   * Center the puzzle in the viewport with zoom-to-fit.
   */
  centerBoard() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const totalW = this.cols * this.pieceWidth;
    const totalH = this.rows * this.pieceHeight;

    // Add some margin (10% on each side)
    const marginFactor = 0.8;
    const scaleX = (rect.width * marginFactor) / totalW;
    const scaleY = (rect.height * marginFactor) / totalH;
    this.zoom = Math.min(scaleX, scaleY);
    this.zoom = Math.max(0.2, Math.min(3, this.zoom));

    // Center
    this.panX = (rect.width - totalW * this.zoom) / 2;
    this.panY = (rect.height - totalH * this.zoom) / 2;
  }
}

export { PuzzleRenderer };

/**
 * Jigsaw Puzzle Piece Shape Generator
 *
 * Generates classic jigsaw piece shapes with interlocking knobs and holes
 * using bezier curves. All generation is deterministic given the same seed.
 */

/**
 * Create a seeded random number generator (LCG).
 * All clients produce identical output from the same seed.
 */
function createRNG(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

/**
 * Draw a single jigsaw edge onto a Path2D.
 *
 * @param {Path2D} path     - The path to draw onto (assumes current point is at fromX, fromY)
 * @param {number} fromX    - Start X
 * @param {number} fromY    - Start Y
 * @param {number} toX      - End X
 * @param {number} toY      - End Y
 * @param {number} tabType  - 0 = flat, 1 = knob (outward), -1 = hole (inward)
 */
function drawEdge(path, fromX, fromY, toX, toY, tabType) {
  if (tabType === 0) {
    path.lineTo(toX, toY);
    return;
  }

  // Edge direction vector
  const dx = toX - fromX;
  const dy = toY - fromY;

  // Perpendicular vector (tab direction depends on tabType sign)
  const px = -dy * tabType;
  const py = dx * tabType;

  // Scale perpendicular by tab height ratio
  const tabHeight = 0.2;
  const nx = px * tabHeight;
  const ny = py * tabHeight;

  // Line to start of neck (~35% along the edge, slightly pinched inward)
  path.lineTo(
    fromX + dx * 0.35 - nx * 0.05,
    fromY + dy * 0.35 - ny * 0.05
  );

  // Curve outward to form the rounded bulb of the tab
  path.bezierCurveTo(
    fromX + dx * 0.35 + nx * 0.4,  fromY + dy * 0.35 + ny * 0.4,   // control 1 (neck exit)
    fromX + dx * 0.45 + nx * 1.0,  fromY + dy * 0.45 + ny * 1.0,   // control 2 (bulb rise)
    fromX + dx * 0.5  + nx * 1.0,  fromY + dy * 0.5  + ny * 1.0    // top of bulb
  );

  // Curve back from bulb to the other side of the neck
  path.bezierCurveTo(
    fromX + dx * 0.55 + nx * 1.0,  fromY + dy * 0.55 + ny * 1.0,   // control 1 (bulb descent)
    fromX + dx * 0.65 + nx * 0.4,  fromY + dy * 0.65 + ny * 0.4,   // control 2 (neck entry)
    fromX + dx * 0.65 - nx * 0.05, fromY + dy * 0.65 - ny * 0.05   // neck exit point
  );

  // Line to end of edge
  path.lineTo(toX, toY);
}

/**
 * Generate all jigsaw puzzle pieces for a grid.
 *
 * @param {number} cols        - Number of columns
 * @param {number} rows        - Number of rows
 * @param {number} pieceWidth  - Width of each piece's grid cell in pixels
 * @param {number} pieceHeight - Height of each piece's grid cell in pixels
 * @param {number} seed        - Seed for deterministic RNG
 * @returns {Array} Array of piece objects
 */
function generatePuzzlePieces(cols, rows, pieceWidth, pieceHeight, seed) {
  const rng = createRNG(seed);

  // ---------- Generate edge types ----------

  // Horizontal edges: between row r and row r+1, for each column c
  // hEdges[r][c] = 1 or -1  (value is what the TOP piece sees on its bottom)
  const hEdges = [];
  for (let r = 0; r < rows - 1; r++) {
    hEdges[r] = [];
    for (let c = 0; c < cols; c++) {
      hEdges[r][c] = rng() < 0.5 ? 1 : -1;
    }
  }

  // Vertical edges: between col c and col c+1, for each row r
  // vEdges[r][c] = 1 or -1  (value is what the LEFT piece sees on its right)
  const vEdges = [];
  for (let r = 0; r < rows; r++) {
    vEdges[r] = [];
    for (let c = 0; c < cols - 1; c++) {
      vEdges[r][c] = rng() < 0.5 ? 1 : -1;
    }
  }

  // ---------- Build piece objects ----------

  const pieces = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Determine edge types for this piece
      const top    = r === 0        ? 0 : -hEdges[r - 1][c]; // opposite of what the piece above has on its bottom
      const bottom = r === rows - 1 ? 0 :  hEdges[r][c];
      const left   = c === 0        ? 0 : -vEdges[r][c - 1]; // opposite of what the piece to the left has on its right
      const right  = c === cols - 1 ? 0 :  vEdges[r][c];

      const piece = {
        row: r,
        col: c,
        edges: { top, right, bottom, left },

        /**
         * Create a Path2D for this piece.
         * @param {number} offsetX - X position of the piece's grid cell top-left corner
         * @param {number} offsetY - Y position of the piece's grid cell top-left corner
         * @returns {Path2D}
         */
        createPath(offsetX, offsetY) {
          const path = new Path2D();
          const x = offsetX;
          const y = offsetY;
          const w = pieceWidth;
          const h = pieceHeight;

          // Start at top-left corner
          path.moveTo(x, y);

          // Top edge: left to right
          drawEdge(path, x, y, x + w, y, this.edges.top);

          // Right edge: top to bottom
          drawEdge(path, x + w, y, x + w, y + h, this.edges.right);

          // Bottom edge: right to left (reversed direction)
          drawEdge(path, x + w, y + h, x, y + h, -this.edges.bottom);

          // Left edge: bottom to top (reversed direction)
          drawEdge(path, x, y + h, x, y, -this.edges.left);

          path.closePath();
          return path;
        }
      };

      pieces.push(piece);
    }
  }

  return pieces;
}

export { generatePuzzlePieces, createRNG };

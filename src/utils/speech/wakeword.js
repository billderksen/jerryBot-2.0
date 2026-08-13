// Node-side wrapper around the openWakeWord sidecar (scripts/wakeword_sidecar.py).
//
// The sidecar is a single long-lived Python process that handles up to 16 audio
// "slots" (one per active user), each with its own openwakeword.Model instance
// for state isolation. Audio is streamed to the sidecar over stdin using a
// small binary framing protocol; wake-word detections come back as JSON lines
// on stdout.
//
// Wire protocol (see scripts/wakeword_sidecar.py for the Python side):
//   stdin  (Node -> sidecar), one frame per message:
//     uint8    slot          (0-15)
//     uint16LE sampleCount
//     int16LE  samples[sampleCount]
//   A frame with sampleCount === 0 is a control message meaning "release
//   slot N" (drop that slot's model + buffered audio); no sample bytes follow.
//
//   stdout (sidecar -> Node), one JSON object per line:
//     {"slot": <int>, "score": <float>}   -- emitted on wake-word detection

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const PYTHON_PATH = path.join(PROJECT_ROOT, 'tools', 'wakeword-venv', 'bin', 'python');
const SIDECAR_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'wakeword_sidecar.py');
const DEFAULT_MODEL_PATH = path.join(PROJECT_ROOT, 'tools', 'models', 'hey_jarvis_v0.1.onnx');
const DEFAULT_THRESHOLD = 0.5;

const MIN_SLOT = 0;
const MAX_SLOT = 15;

// Respawn backoff schedule (ms). After this many consecutive crashes without
// a stable run in between, the engine gives up respawning and logs once.
const RESPAWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

// How long a child must stay alive before a subsequent crash is treated as a
// "fresh" failure again (resets the backoff schedule and give-up state).
const STABILITY_WINDOW_MS = 30000;

/**
 * Encode one audio frame for the wakeword sidecar wire protocol.
 * @param {number} slot - integer 0-15 identifying the audio slot.
 * @param {Int16Array|number[]} samples - PCM samples for this frame.
 * @returns {Buffer}
 */
export function encodeFrame(slot, samples) {
  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
    throw new RangeError(`encodeFrame: slot must be an integer in [${MIN_SLOT}, ${MAX_SLOT}], got ${slot}`);
  }
  const sampleCount = samples.length;
  if (!Number.isInteger(sampleCount) || sampleCount < 0 || sampleCount > 0xffff) {
    throw new RangeError(`encodeFrame: sampleCount out of uint16 range, got ${sampleCount}`);
  }

  const buf = Buffer.alloc(1 + 2 + sampleCount * 2);
  buf.writeUInt8(slot, 0);
  buf.writeUInt16LE(sampleCount, 1);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(samples[i], 3 + i * 2);
  }
  return buf;
}

export class WakewordEngine extends EventEmitter {
  constructor({ modelPath, threshold } = {}) {
    super();
    this.modelPath = modelPath || process.env.WAKEWORD_MODEL_PATH || DEFAULT_MODEL_PATH;
    this.threshold = threshold ?? (process.env.WAKEWORD_THRESHOLD !== undefined
      ? Number(process.env.WAKEWORD_THRESHOLD)
      : DEFAULT_THRESHOLD);

    this.child = null;
    this.stopping = false;
    this.stdoutBuffer = '';

    this.respawnAttempt = 0;
    this.respawnTimer = null;
    this.stabilityTimer = null;
    this.gaveUpLogged = false;

    this.droppedFrameCount = 0;
    this.droppedOutageLogged = false;
  }

  /** Checks that the venv python interpreter and the wake-word model file exist. */
  static isAvailable() {
    const modelPath = process.env.WAKEWORD_MODEL_PATH || DEFAULT_MODEL_PATH;
    return existsSync(PYTHON_PATH) && existsSync(modelPath);
  }

  start() {
    this.stopping = false;
    this._spawn();
  }

  stop() {
    this.stopping = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  /**
   * Feed audio samples for a given slot into the sidecar. Never throws:
   * if the sidecar is down or the write fails, the frame is dropped and
   * counted, logging the outage once (not per-frame).
   */
  feedAudio(slot, samples) {
    if (!this.child || !this.child.stdin.writable) {
      this._dropFrame('sidecar unavailable, dropping audio frames');
      return;
    }
    try {
      const buf = encodeFrame(slot, samples);
      this.child.stdin.write(buf);
      this.droppedOutageLogged = false;
    } catch (err) {
      this._dropFrame(`failed to feed audio frame: ${err.message}`);
    }
  }

  /** Tell the sidecar to drop a slot's model state and buffered audio. */
  releaseSlot(slot) {
    if (!this.child || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(encodeFrame(slot, new Int16Array(0)));
    } catch (err) {
      console.error('[Wakeword] failed to release slot', slot, err.message);
    }
  }

  _dropFrame(reason) {
    this.droppedFrameCount += 1;
    if (!this.droppedOutageLogged) {
      console.error(`[Wakeword] ${reason} (dropped count: ${this.droppedFrameCount})`);
      this.droppedOutageLogged = true;
    }
  }

  _spawn() {
    if (this.stopping) return;

    const child = spawn(PYTHON_PATH, [
      SIDECAR_SCRIPT,
      '--model', this.modelPath,
      '--threshold', String(this.threshold),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.child = child;
    this.stdoutBuffer = '';

    child.stdout.on('data', (data) => this._handleStdout(data));
    child.stderr.on('data', (data) => {
      for (const line of data.toString('utf8').split('\n')) {
        if (line.trim()) console.error('[Wakeword]', line.trim());
      }
    });

    child.on('error', (err) => {
      console.error('[Wakeword] failed to spawn sidecar:', err.message);
    });

    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stabilityTimer) {
        clearTimeout(this.stabilityTimer);
        this.stabilityTimer = null;
      }
      if (!this.stopping) this._scheduleRespawn();
    });

    // If the sidecar stays up longer than the full backoff schedule, treat
    // it as recovered: reset attempt count / give-up state for next time.
    this.stabilityTimer = setTimeout(() => {
      this.respawnAttempt = 0;
      this.gaveUpLogged = false;
    }, STABILITY_WINDOW_MS);
    if (this.stabilityTimer.unref) this.stabilityTimer.unref();
  }

  _scheduleRespawn() {
    if (this.respawnAttempt >= RESPAWN_BACKOFF_MS.length) {
      if (!this.gaveUpLogged) {
        console.error(`[Wakeword] sidecar crashed ${RESPAWN_BACKOFF_MS.length} times in a row, giving up on respawning`);
        this.gaveUpLogged = true;
      }
      return;
    }
    const delay = RESPAWN_BACKOFF_MS[this.respawnAttempt];
    this.respawnAttempt += 1;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this._spawn();
    }, delay);
    if (this.respawnTimer.unref) this.respawnTimer.unref();
  }

  _handleStdout(data) {
    this.stdoutBuffer += data.toString('utf8');
    let idx;
    while ((idx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore stray non-JSON output on stdout
      }
      if (typeof msg.slot === 'number' && typeof msg.score === 'number') {
        this.emit('wake', { slot: msg.slot, score: msg.score });
      }
    }
  }
}

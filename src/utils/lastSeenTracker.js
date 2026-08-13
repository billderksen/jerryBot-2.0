import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { loadJsonSync, saveJsonSync } from './jsonStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'lastSeen.json');

let data = loadJsonSync(DATA_FILE, {});
let saveTimeout = null;

// Debounced save — writes at most once per 10 seconds to avoid excessive I/O
function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveJsonSync(DATA_FILE, data);
  }, 10000);
}

/**
 * Update a user's last seen timestamp.
 * @param {string} userId
 * @param {string} displayName
 * @param {'message'|'presence'|'voice'} type - What triggered the update
 */
export function updateLastSeen(userId, displayName, type) {
  data[userId] = {
    displayName,
    timestamp: Date.now(),
    type
  };
  scheduleSave();
}

/**
 * Get a user's last seen data.
 * @param {string} userId
 * @returns {{ displayName: string, timestamp: number, type: string } | null}
 */
export function getLastSeen(userId) {
  return data[userId] || null;
}

/**
 * Immediately flush any pending debounced save (bypasses the 10s debounce).
 * Used on shutdown so in-flight updates aren't lost.
 */
export function flushLastSeen() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  saveJsonSync(DATA_FILE, data);
}

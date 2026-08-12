import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_FILE = join(__dirname, '..', '..', 'data', 'lastSeen.json');

let data = {};
let saveTimeout = null;

// Load on startup
try {
  if (existsSync(DATA_FILE)) {
    data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.error('[LastSeen] Error loading data:', e.message);
}

// Debounced save — writes at most once per 10 seconds to avoid excessive I/O
function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    try {
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('[LastSeen] Error saving data:', e.message);
    }
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

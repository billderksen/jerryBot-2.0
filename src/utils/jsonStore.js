import { readFileSync, writeFileSync, renameSync, copyFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function loadJsonSync(filePath, fallback) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return structuredClone(fallback); // missing/unreadable: fresh start
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    try {
      copyFileSync(filePath, `${filePath}.corrupt`);
      console.error(`[jsonStore] Corrupt JSON backed up: ${filePath}.corrupt (${err.message})`);
    } catch (backupErr) {
      console.error(`[jsonStore] Corrupt JSON at ${filePath}, backup FAILED: ${backupErr.message}`);
    }
    return structuredClone(fallback);
  }
}

export function saveJsonSync(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

import db from './db.js';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUZZLE_DIR = join(__dirname, '..', 'puzzle images');

export function seedBuiltinImages() {
  const files = readdirSync(PUZZLE_DIR).filter(f =>
    /\.(png|jpe?g|webp)$/i.test(f)
  );

  const insert = db.prepare(
    'INSERT OR IGNORE INTO puzzle_images (filename, display_name, is_builtin) VALUES (?, ?, 1)'
  );

  for (const file of files) {
    const displayName = file.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    insert.run(file, displayName);
  }
}

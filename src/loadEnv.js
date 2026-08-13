import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Side-effect-only module: loads .env into process.env. Import this as the
// LITERAL FIRST import declaration in any entry-point-adjacent file (index.js,
// web/server.js) so it evaluates before any other import's subtree — ES module
// evaluation is depth-first in declaration order, so a first-position import's
// side effects run before later imports' dependencies do, even though a plain
// top-level statement placed among import declarations would not (all import
// declarations in a file are evaluated before any of that file's own
// non-import top-level statements run).
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

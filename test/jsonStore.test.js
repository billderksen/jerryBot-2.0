import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadJsonSync, saveJsonSync } from '../src/utils/jsonStore.js';

test('round-trips an object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js-'));
  const file = join(dir, 'a.json');
  saveJsonSync(file, { x: 1, arr: [1, 2] });
  assert.deepEqual(loadJsonSync(file, {}), { x: 1, arr: [1, 2] });
});

test('missing file returns a copy of fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js-'));
  const fallback = { players: {} };
  const got = loadJsonSync(join(dir, 'nope.json'), fallback);
  assert.deepEqual(got, fallback);
  got.players.a = 1;
  assert.deepEqual(fallback, { players: {} }); // fallback not mutated
});

test('corrupt file is backed up, fallback returned, original preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{"truncated": tru');
  const got = loadJsonSync(file, { ok: true });
  assert.deepEqual(got, { ok: true });
  assert.ok(existsSync(file + '.corrupt'));
  assert.equal(readFileSync(file + '.corrupt', 'utf8'), '{"truncated": tru');
});

test('save creates parent directories and leaves no tmp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'js-'));
  const file = join(dir, 'deep', 'nested', 'b.json');
  saveJsonSync(file, [1]);
  assert.deepEqual(loadJsonSync(file, []), [1]);
  assert.ok(!existsSync(file + '.tmp'));
});

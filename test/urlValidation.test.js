import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedMediaUrl, sanitizeSearchQuery } from '../src/utils/urlValidation.js';

test('accepts youtube and spotify URLs', () => {
  assert.ok(isAllowedMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.ok(isAllowedMediaUrl('https://youtu.be/dQw4w9WgXcQ'));
  assert.ok(isAllowedMediaUrl('https://music.youtube.com/watch?v=x'));
  assert.ok(isAllowedMediaUrl('https://open.spotify.com/track/abc'));
});

test('rejects option injection, other hosts, and garbage', () => {
  assert.equal(isAllowedMediaUrl('--exec=id'), false);
  assert.equal(isAllowedMediaUrl('-x'), false);
  assert.equal(isAllowedMediaUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedMediaUrl('https://evil.com/?u=youtube.com'), false);
  assert.equal(isAllowedMediaUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedMediaUrl('not a url'), false);
});

test('sanitizeSearchQuery strips leading dashes and caps length', () => {
  assert.equal(sanitizeSearchQuery('--exec rm -rf beat it'), 'exec rm -rf beat it');
  assert.equal(sanitizeSearchQuery('  -x hello'), 'x hello');
  assert.equal(sanitizeSearchQuery('a'.repeat(300)).length, 200);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTimeoutDelay, isValidCalendarDate } from '../src/utils/reminderTracker.js';

test('delays are capped at 24h and never negative', () => {
  assert.equal(nextTimeoutDelay(5_000), 5_000);
  assert.equal(nextTimeoutDelay(40 * 24 * 3600 * 1000), 86_400_000); // 40 days -> 24h hop
  assert.equal(nextTimeoutDelay(-100), 0);
});

test('valid calendar dates round-trip, invalid ones are rejected', () => {
  assert.ok(isValidCalendarDate(29, 2, 2028));   // leap year
  assert.ok(!isValidCalendarDate(29, 2, 2026));  // not a leap year
  assert.ok(!isValidCalendarDate(31, 4, 2026));  // April has 30 days
  assert.ok(isValidCalendarDate(31, 12, 2026));
});

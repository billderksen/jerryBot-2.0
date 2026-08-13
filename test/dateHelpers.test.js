import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLeapYear } from '../src/utils/birthdayTracker.js';

test('isLeapYear identifies leap years correctly', () => {
  assert.equal(isLeapYear(2024), true);   // divisible by 4, not a century year
  assert.equal(isLeapYear(2026), false);  // not divisible by 4
  assert.equal(isLeapYear(2000), true);   // century year divisible by 400
});

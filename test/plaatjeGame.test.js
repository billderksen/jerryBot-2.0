import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placementIsCorrect, insertIndexForYear, resolveRound,
  startOffsetSeconds, clampCardsToWin, canHostSkipTurn, shouldDeleteRoom
} from '../src/utils/plaatjeGame.js';

test('placementIsCorrect: randen, midden, gelijke jaartallen', () => {
  const tl = [1978, 1991, 2004];
  assert.equal(placementIsCorrect(tl, 0, 1965), true);   // vóór alles
  assert.equal(placementIsCorrect(tl, 3, 2016), true);   // na alles
  assert.equal(placementIsCorrect(tl, 1, 1985), true);   // tussen 1978 en 1991
  assert.equal(placementIsCorrect(tl, 1, 2010), false);
  assert.equal(placementIsCorrect(tl, 1, 1991), true);   // gelijk jaar links van 1991 telt
  assert.equal(placementIsCorrect(tl, 2, 1991), true);   // en rechts ervan ook
  assert.equal(placementIsCorrect([], 0, 1999), true);   // lege tijdlijn
});

test('insertIndexForYear: sorteert stabiel', () => {
  assert.equal(insertIndexForYear([1978, 1991, 2004], 1991), 2);
  assert.equal(insertIndexForYear([1978, 1991, 2004], 1960), 0);
  assert.equal(insertIndexForYear([], 1999), 0);
});

test('resolveRound: actief goed → geen steal; actief fout → snelste juiste uitdager wint', () => {
  const tl = [1978, 1991, 2004];
  assert.deepEqual(resolveRound({ timelineYears: tl, activeSlot: 1, year: 1985, challenges: [] }),
    { activeCorrect: true, stealWinner: null });
  const r = resolveRound({
    timelineYears: tl, activeSlot: 0, year: 1997,
    challenges: [
      { userId: 'laat-goed', slot: 2, at: 300 },
      { userId: 'vroeg-fout', slot: 0, at: 100 },
      { userId: 'vroeg-goed', slot: 2, at: 200 },
    ],
  });
  assert.deepEqual(r, { activeCorrect: false, stealWinner: 'vroeg-goed' });
  assert.deepEqual(resolveRound({ timelineYears: tl, activeSlot: null, year: 1997, challenges: [] }),
    { activeCorrect: false, stealWinner: null });
});

test('startOffsetSeconds: min(30, max(0, duur-60))', () => {
  assert.equal(startOffsetSeconds(240), 30);
  assert.equal(startOffsetSeconds(75), 15);
  assert.equal(startOffsetSeconds(45), 0);
  assert.equal(startOffsetSeconds(NaN), 0);
  assert.equal(startOffsetSeconds(undefined), 0);
});

test('clampCardsToWin', () => {
  assert.equal(clampCardsToWin(10), 10);
  assert.equal(clampCardsToWin(3), 5);
  assert.equal(clampCardsToWin(99), 15);
  assert.equal(clampCardsToWin('x'), 10);
});

test('canHostSkipTurn en shouldDeleteRoom: drempels', () => {
  assert.equal(canHostSkipTurn({ disconnectedAtMs: 0, nowMs: 60_000 }), true);
  assert.equal(canHostSkipTurn({ disconnectedAtMs: 0, nowMs: 59_999 }), false);
  assert.equal(canHostSkipTurn({ disconnectedAtMs: null, nowMs: 1e12 }), false);
  assert.equal(shouldDeleteRoom({ emptySinceMs: 0, nowMs: 5 * 60_000 }), true);
  assert.equal(shouldDeleteRoom({ emptySinceMs: null, nowMs: 1e12 }), false);
});

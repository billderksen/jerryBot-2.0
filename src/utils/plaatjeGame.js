// PLAATJE — regels en kamers. Dit deel is puur (geen IO); de Room-klasse en
// de room-manager (met jsonStore-leaderboard) staan eronder [Taak 4].

export function placementIsCorrect(timelineYears, slotIndex, year) {
  if (slotIndex == null || slotIndex < 0 || slotIndex > timelineYears.length) return false;
  const left = slotIndex === 0 ? -Infinity : timelineYears[slotIndex - 1];
  const right = slotIndex === timelineYears.length ? Infinity : timelineYears[slotIndex];
  return left <= year && year <= right; // gelijke jaartallen tellen als goed
}

export function insertIndexForYear(timelineYears, year) {
  let i = 0;
  while (i < timelineYears.length && timelineYears[i] <= year) i++;
  return i;
}

export function resolveRound({ timelineYears, activeSlot, year, challenges }) {
  const activeCorrect = activeSlot != null && placementIsCorrect(timelineYears, activeSlot, year);
  let stealWinner = null;
  if (!activeCorrect) {
    const winner = [...challenges]
      .sort((a, b) => a.at - b.at)
      .find((c) => placementIsCorrect(timelineYears, c.slot, year));
    stealWinner = winner ? winner.userId : null;
  }
  return { activeCorrect, stealWinner };
}

export function startOffsetSeconds(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.round(Math.min(30, Math.max(0, durationSec - 60)));
}

export function clampCardsToWin(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 10;
  return Math.min(15, Math.max(5, Math.round(v)));
}

export function canHostSkipTurn({ disconnectedAtMs, nowMs }) {
  return Number.isFinite(disconnectedAtMs) && nowMs - disconnectedAtMs >= 60_000;
}

export function shouldDeleteRoom({ emptySinceMs, nowMs }) {
  return Number.isFinite(emptySinceMs) && nowMs - emptySinceMs >= 5 * 60_000;
}

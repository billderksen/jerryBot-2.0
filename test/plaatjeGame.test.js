import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  placementIsCorrect, insertIndexForYear, resolveRound,
  startOffsetSeconds, clampCardsToWin, canHostSkipTurn, shouldDeleteRoom,
  createPlaatjeRoom, getPlaatjeRoom, deletePlaatjeRoom
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
  // Number(null) === 0, which is finite, so this clamps to 5, NOT the "no value" default of 10 —
  // a caller using null as an "option omitted" sentinel (e.g. Discord's getInteger()) must
  // coalesce to 10 itself before calling in (see src/commands/hitster.js).
  assert.equal(clampCardsToWin(null), 5);
});

test('canHostSkipTurn en shouldDeleteRoom: drempels', () => {
  assert.equal(canHostSkipTurn({ disconnectedAtMs: 0, nowMs: 60_000 }), true);
  assert.equal(canHostSkipTurn({ disconnectedAtMs: 0, nowMs: 59_999 }), false);
  assert.equal(canHostSkipTurn({ disconnectedAtMs: null, nowMs: 1e12 }), false);
  assert.equal(shouldDeleteRoom({ emptySinceMs: 0, nowMs: 5 * 60_000 }), true);
  assert.equal(shouldDeleteRoom({ emptySinceMs: null, nowMs: 1e12 }), false);
});

function maakKamer() {
  const room = createPlaatjeRoom('r1', { id: 'u1', displayName: 'Ben', avatar: null }, { cardsToWin: 10 });
  room.addPlayer({ id: 'u2', displayName: 'Koen', avatar: null });
  const startSongs = [
    { title: 'September', artist: 'Earth, Wind & Fire', year: 1978, youtubeId: 'aaaaaaaaaaa' },
    { title: 'Zombie', artist: 'The Cranberries', year: 1994, youtubeId: 'bbbbbbbbbbb' },
  ];
  let i = 0;
  room.start(() => startSongs[i++]);
  return room;
}

test('room: start deelt 1 kaart en 2 fiches uit, host is eerste actieve speler', () => {
  const room = maakKamer();
  assert.equal(room.phase, 'loading');
  for (const p of room.players.values()) {
    assert.equal(p.timeline.length, 1);
    assert.equal(p.tokens, 2);
  }
  assert.equal(room.publicState().activeUserId, 'u1');
  deletePlaatjeRoom('r1');
});

test('room: publicState lekt de mysterieplaat nooit vóór de reveal', () => {
  const room = maakKamer();
  room.beginRound({ title: 'GeheimNummer', artist: 'GeheimArtiest', year: 1997, youtubeId: 'ccccccccccc' }, 30);
  const json = JSON.stringify(room.publicState());
  assert.ok(!json.includes('GeheimNummer'));
  assert.ok(!json.includes('GeheimArtiest'));
  assert.ok(!json.includes('1997'));
  assert.ok(!json.includes('ccccccccccc'));
  deletePlaatjeRoom('r1');
});

test('room: goed leggen → kaart erbij; gok bij reveal beoordeeld; fiche voor goede gok', () => {
  const room = maakKamer();
  const mystery = { title: 'Bitter Sweet Symphony', artist: 'The Verve', year: 1997, youtubeId: 'ccccccccccc' };
  room.beginRound(mystery, 30);
  const active = room.players.get('u1');
  const jaar = active.timeline[0].year;
  const slot = mystery.year >= jaar ? 1 : 0;
  room.recordGuess('u1', 'the verve', 'bittersweet symphony');
  room.place('u1', slot);
  assert.equal(room.phase, 'challenge');
  const reveal = room.resolveReveal();
  assert.equal(reveal.activeCorrect, true);
  assert.equal(reveal.guessCorrect, true);
  assert.equal(active.timeline.length, 2);
  assert.equal(active.tokens, 3); // 2 + 1 gok-fiche
  deletePlaatjeRoom('r1');
});

test('room: HITSTER — uitdager betaalt altijd, steelt bij fout van actief', () => {
  const room = maakKamer();
  const u1jaar = room.players.get('u1').timeline[0].year;
  // kies een mysteriejaar dat gegarandeerd NIET vóór u1's kaart hoort als hij op slot 0 legt
  const mystery = { title: 'X', artist: 'Y', year: u1jaar + 1, youtubeId: 'ddddddddddd' };
  room.beginRound(mystery, 30);
  room.challenge('u2', 1, 1000);          // juiste plek (na de kaart)
  assert.equal(room.players.get('u2').tokens, 1); // betaald bij de druk
  room.place('u1', 0);                    // actief legt fout (vóór de kaart)
  const reveal = room.resolveReveal();
  assert.equal(reveal.activeCorrect, false);
  assert.equal(reveal.stolenBy, 'u2');
  assert.equal(room.players.get('u2').timeline.length, 2);
  assert.equal(room.players.get('u1').timeline.length, 1);
  deletePlaatjeRoom('r1');
});

test('room: winnen bij cardsToWin en beurtrotatie', () => {
  const room = createPlaatjeRoom('r2', { id: 'a', displayName: 'A', avatar: null }, { cardsToWin: 5 });
  room.addPlayer({ id: 'b', displayName: 'B', avatar: null });
  let n = 1900;
  room.start(() => ({ title: 't', artist: 'x', year: n += 2, youtubeId: String(n).padStart(11, '0') }));
  // A wint door 4 rondes goed te leggen (1 startkaart + 4 = 5)
  for (let ronde = 0; ronde < 7 && room.phase !== 'finished'; ronde++) {
    const activeId = room.publicState().activeUserId;
    room.beginRound({ title: 't', artist: 'x', year: n += 2, youtubeId: String(n).padStart(11, '0') }, 0);
    const speler = room.players.get(activeId);
    room.place(activeId, speler.timeline.length); // achteraan = altijd goed (jaren stijgen)
    room.resolveReveal();
    if (room.phase !== 'finished') room.nextTurn();
  }
  assert.equal(room.phase, 'finished');
  assert.ok(room.winnerId === 'a' || room.winnerId === 'b');
  deletePlaatjeRoom('r2');
});

test('room: swap kost 1 fiche en kan alleen met saldo', () => {
  const room = maakKamer();
  room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  assert.equal(room.paySwap('u1').ok, true);
  assert.equal(room.players.get('u1').tokens, 1);
  assert.equal(room.paySwap('u1').ok, true);
  assert.equal(room.paySwap('u1').ok, false); // saldo 0
  deletePlaatjeRoom('r1');
});

test('room: swap kan niet meer nadat HITSTER is geroepen', () => {
  const room = maakKamer();
  room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  room.challenge('u2', 0, 1000);
  const tokensVoor = room.players.get('u1').tokens;
  const r = room.paySwap('u1');
  assert.equal(r.ok, false);
  assert.equal(room.players.get('u1').tokens, tokensVoor);
  deletePlaatjeRoom('r1');
});

test('guard: round.nonce actually increments across rounds', () => {
  // Regressietest voor een bug waarbij resolveReveal() this.round al naar null zet vóórdat de
  // volgende beginRound() draait, waardoor de oude (this.round?.nonce ?? 0) + 1-berekening élke
  // ronde weer bij 1 begon — een persistente this.rondeTeller lost dat op.
  const room = maakKamer();
  room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  const eersteNonce = room.round.nonce;
  room.place('u1', room.players.get('u1').timeline.length); // achteraan = altijd goed
  room.resolveReveal();
  room.nextTurn();
  room.beginRound({ title: 'X2', artist: 'Y2', year: 1991, youtubeId: 'fffffffffff' }, 0);
  const tweedeNonce = room.round.nonce;
  assert.equal(eersteNonce, 1);
  assert.equal(tweedeNonce, eersteNonce + 1);
  deletePlaatjeRoom('r1');
});

test('guard: resolveReveal() before beginRound returns null, no throw', () => {
  const room = createPlaatjeRoom('r3', { id: 'u1', displayName: 'Ben', avatar: null }, { cardsToWin: 10 });
  room.addPlayer({ id: 'u2', displayName: 'Koen', avatar: null });
  room.start(() => ({ title: 't', artist: 'x', year: 1900, youtubeId: '00000000000' }));
  const result = room.resolveReveal();
  assert.equal(result, null); // graceful null, no throw
  deletePlaatjeRoom('r3');
});

test('guard: resolveReveal() twice — second returns null, state unchanged', () => {
  const room = maakKamer();
  room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  room.place('u1', 1);
  const reveal1 = room.resolveReveal();
  assert.ok(reveal1); // first succeeds
  const reveal2 = room.resolveReveal();
  assert.equal(reveal2, null); // second is null
  assert.equal(room.lastReveal, reveal1); // state unchanged
  deletePlaatjeRoom('r1');
});

test('guard: nextTurn() during active round does NOT rotate', () => {
  const room = maakKamer();
  const before = room.publicState().activeUserId;
  room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  room.nextTurn(); // attempt mid-listening
  assert.equal(room.publicState().activeUserId, before); // unchanged
  room.place('u1', 1);
  room.nextTurn(); // attempt mid-challenge
  assert.equal(room.publicState().activeUserId, before); // still unchanged
  deletePlaatjeRoom('r1');
});

test('guard: beginRound() on finished room returns { ok: false }, state intact', () => {
  const room = maakKamer();
  room.winnerId = 'u1'; // manually set (simulating end condition)
  room.phase = 'finished';
  const result = room.beginRound({ title: 'X', artist: 'Y', year: 1990, youtubeId: 'eeeeeeeeeee' }, 0);
  assert.equal(result.ok, false); // guard rejects
  assert.equal(room.phase, 'finished'); // unchanged
  assert.equal(room.winnerId, 'u1'); // unchanged
  assert.equal(room.round, null); // no round created
  deletePlaatjeRoom('r1');
});

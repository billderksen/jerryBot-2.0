# HITSTER-animaties — implementatierapport

Bron: `/tmp/claude-1000/-home-benin-Scripts-jerryBot-2-0/3c303dfc-9b87-4cdd-987d-0faeb81ed42e/scratchpad/hitster-animaties-mockup.html`
Doel: `src/web/public/plaatje.html`

## Belangrijke afwijking van de opdracht (en waarom)

De opdracht ging ervan uit dat `plaatje:round:audio` **vóór** de bijbehorende
`plaatje:state` binnenkomt. Ik heb `runPlaatjeRoundLoad()` in `server.js`
nagelezen: de server broadcast `broadcastPlaatjeState(roomId)` (regel 2825)
**vóórdat** hij `plaatje:round:audio` stuurt (regel 2826) — dus precies
andersom. Bij een client die actief luistert, komt er daarna vaak géén
volgende `renderState`-call meer totdat de speler zelf iets doet (hover
broadcast triggert geen render; het is een apart berichttype). Puur op de
"wacht tot renderState met matchend nonce" flag vertrouwen zou de
plaatdrop+ring dus regelmatig nooit afvuren. Oplossing: bij ontvangst van
`plaatje:round:audio` wordt **meteen** gecontroleerd of `currentRoom` het
nonce al heeft (vrijwel altijd waar, gegeven de bewezen berichtvolgorde); zo
niet, blijft de oorspronkelijke `pendingRoundFx`-vlag als fallback staan voor
de `renderState`-staart. `lastRondestartNonce` voorkomt een dubbele
plaatdrop bij de VC-fallback-herzending (dezelfde nonce, tweede
`round:audio`-bericht bij een mislukte VC-afspeelpoging).

Tweede afwijking: de opdracht suggereerde `prevRoom = currentRoom` te zetten
vóór `renderState(data.room)` in de `plaatje:state`-case. `renderState()`
wordt echter ook **buiten** die case aangeroepen (HITSTER-arm-klik,
skip-turn-timer, en mijn eigen FOUT-opruim-timeout) — als `prevRoom` alleen
bij het WS-bericht wordt bijgewerkt, zou zo'n handmatige her-render dezelfde
diff nóg een keer waar vinden en de beurtwissel/fiches/HITSTER-slam-FX
dubbel afvuren. Fix: `renderState()` legt zelf `vorigeRoom = prevRoom` vast
bij binnenkomst, en zet pas aan het eind `prevRoom = room`. Zo dift een
herhaalde render altijd tegen zichzelf (geen verschil, geen dubbele FX),
ongeacht wie `renderState()` aanroept.

`room.round` wordt genuld zodra `resolveReveal()` draait (game.js:214) — dus
tijdens `reveal`/`finished` bestaat er geen `room.round.placedSlot` meer.
Voor de FOUT-zonder-steal-tuimel gebruik ik daarom `prevRoom.round.placedSlot`
(de laatst bekende `challenge`-fase-stand, nog vers in de zelf-consumerende
`prevRoom` op het moment dat de reveal-FX draait).

## Per effect

**1 · Rondestart (plaatdrop + ring)** — `.deck` is statische markup (overleeft
renders), dus rechtstreeks aangesproken. Getriggerd via `pendingRoundFx` +
directe fire-check zoals hierboven. Guard: `lastRondestartNonce`.

**2 · Onthulling GOED** — `runGoedFx()`: groene flits, `vindKaart()` zoekt de
zojuist ingevoegde `.kaart` in `#spotLijn` op `data-year`/`data-title` (nieuwe
attributen op `kaartHtml()`'s output, betrouwbaarder dan tekst-matchen), krijgt
`flip-in gloei`. De stempel krijgt de `slam`-class direct in `stempelHtml()`'s
template (rendert toch al vers per reveal). Confetti-burst 320ms later vanaf
de stempel-rect. Als de winnende ronde is (`finished`-fase toont geen stempel,
bestaand gedrag), wordt de confetti-burst stil overgeslagen — null-check, geen
crash.

**3 · Onthulling FOUT zonder steal** — `runFoutFx()`: rode flits + `dreun` op
`.spotlight`. De kaart komt nooit in een echte tijdlijn terecht (server voegt
'm alleen toe bij `activeCorrect` of `stealWinner`), dus een synthetische
`.kaart` met `flip-in schud tuimel` wordt op de `[data-podium-slot]`-plek
gezet (uit `prevRoom.round.placedSlot`) en na 1.6s verwijderd + een
`renderState(currentRoom)` om het "+"-vak netjes terug te zetten (veilig dankzij
de zelf-consumerende `prevRoom`, zie boven).

**4 · HITSTER-slam** — diff op `room.round.challengers.length` t.o.v.
`vorigeRoom.round.challengers.length` bij gelijk nonce, in `runDiffFx()`.
Lite rode flits (nieuwe `.flits.rood.lite`-variant, minder heftig dan de volle
reveal-flits omdat dit per uitdager kan vuren), `dreun`, `schok`-ring vanaf
`#btnHitster` (of het podium als de knop niet gerenderd is voor deze client —
bv. voor de uitdager zelf, wiens knop al verdwenen is), en `roeper` in de
nieuwe statische `#roeperWrap` binnen `.spotlight`.

**5 · Steal-vlucht** — `runFoutStealFx()`: doelwit = `#dockLijn` als de dief
jijzelf bent, anders de `.pass[data-player="<id>"]` van de dief (nieuw
`data-player`-attribuut op elke pass-container). Kloont de echte (al
gerenderde) bestemmingskaart, positioneert de kloon op het midden van
`#spotLijn`, WAAPI-animatie ernaartoe (omgekeerde richting t.o.v. de demo,
want er is geen bronkaart om van te vertrekken — de gestolen kaart bestond
nooit bij de actieve speler). Echte kaart `opacity:0` tot de vlucht landt,
dan `jat`-flits op de pass + kleine confetti-burst. Geen doelwit gevonden →
stil overgeslagen.

**6 · Fiches** — diff per speler op `tokens` in `runDiffFx()`.
`chipsElFor()` kiest podium (actieve speler) > dock (jijzelf) > pass (ieder
ander), via de nieuwe `data-chips="<userId>"`-attributen op alle drie de
chip-containers. Munt-vlucht + "−1" bij verlies, `plop` + "+1 fiche" bij
winst.

**7 · Countdown-paniek** — `updatePaniek()`, aangeroepen vanuit
`bindInteractie()`'s bestaande challenge-tak (na de voortgangsbalk-update, zodat
`challengeAnim.startedAt` al klopt). Idempotent per `room.round.nonce`
(`paniekNonce`): plant maximaal één timeout per ronde, herstelt de
zichtbare staat synchroon bij elke render (nodig omdat `#spotStatus` bij elke
render vers wordt opgebouwd — de `paniek-tekst`-span verliest anders zijn
`display`-status). Wordt teruggezet zodra de fase niet meer `challenge` is.

**8 · Beurtwissel** — diff op `room.activeUserId` in `runDiffFx()`, met
`room.phase !== 'finished'`-guard. `.beam` is statisch (herstart via
remove+reflow+add), `.aanzet`/`.ava`/`.spot-name` zijn vers gerenderde
elementen (klasse toevoegen volstaat, geen restart-truc nodig).

**9 · Winnaar** — `renderWinOverlay()` uitgebreid met 3 `.win-beam`s,
`.win-titel`/`.win-kaart`/`.win-sub` (i.p.v. het generieke `.wordmark`/
`.hit-uitleg`), de winnende kaart via `kaartHtml()` op de reveal-data, en 34
`.regen`-confettideeltjes. `.win-overlay` kreeg `overflow:hidden`,
`z-index:90` (boven de vlieger/muntje-laag) en de `fadein`-intro.

**Reduced motion** — de hele `@media (prefers-reduced-motion: reduce)`-regel
1-op-1 overgenomen. Bekende beperking (al aanwezig in de demo, niet
geïntroduceerd door mij): de twee WAAPI-animaties (steal-vlucht, muntje) zijn
JS-`.animate()`-calls met een hardcoded duration en worden dus niet
ingekort door die media query — alleen CSS-`animation`/`transition` wel.

## Robuustheid

Elke `run*Fx`-functie is in zijn geheel try/catch'd en elke DOM-lookup is
null-checked vóór gebruik; een ontbrekend element betekent stilletjes
overslaan, nooit een throw. `Element.prototype.animate` wordt gecontroleerd
vóór gebruik (fallback: `setTimeout` voor de opruim-stap) voor het geval WAAPI
ontbreekt.

## Verificatie

- `node -e "...new Function(...)..."` → `OK` (geen syntaxfouten in de inline
  `<script>`).
- `npm test` → 337 tests, **335 pass, 0 fail, 2 skipped** (matcht de
  aangegeven baseline voor deze worktree).
- Handmatige controle van de event-flow: `plaatje:state` vóór
  `plaatje:round:audio` bevestigd in `server.js` (zie afwijking hierboven);
  `plaatje:reveal` vóór zijn `plaatje:state` bevestigd (`doPlaatjeReveal()`,
  regel 2885-2886) — dat deel klopte wél met de aanname in de opdracht.

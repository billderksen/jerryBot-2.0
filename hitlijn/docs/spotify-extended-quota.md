# Spotify extended quota aanvragen — voorbereide antwoorden

De app staat in **development mode**: maximaal ~25 handmatig toegevoegde gebruikers.
Extended quota mode haalt die grens weg. De aanvraag moet door de eigenaar van het
Spotify-account worden ingediend (inloggen + verklaring op naam), maar alle antwoorden
staan hieronder klaar om te plakken. Feiten komen uit de code, niet uit aannames.

## Waar

developer.spotify.com/dashboard → app **HITLIJN** → *Settings* → knop
*Request extension* (of *Extended quota mode*) → formulier.

## Vóór het indienen: eerst dit regelen

1. **Redirect URI's** moeten exact kloppen met wat de app gebruikt
   (`location.origin + '/callback'`):
   - `https://hitlijn.nl/callback`
   - `https://www.hitlijn.nl/callback`
   - `https://hitlijn.godcord.nl/callback`
2. **Attributie** — reviews kijken naar Spotify's design guidelines: het Spotify-logo
   tonen wanneer je content afspeelt, en naam van artiest/nummer correct weergeven.
   De app toont nu een groene "Verbind Spotify"-knop en de status "Spotify · <apparaat>";
   overweeg bij de onthulling een "open in Spotify"-link + logo toe te voegen.
3. **Screenshots/schermopname** van de lobby, een lopende ronde en de onthulling —
   het formulier vraagt vaak om beeldmateriaal of een demo-link.

## Antwoorden om te plakken

**App name**
HITLIJN

**App description / What does your app do?**
> HITLIJN is a free, non-commercial party game for a small group of friends, played in
> the browser on mobile phones. Players hear a song and place it on a timeline by its
> release year — a digital take on a music-timeline party game. Each player signs in
> with their own Spotify account; the app uses the Web Playback SDK so the music plays
> on that player's own device through their own Spotify Premium subscription. Players
> without Spotify hear a short preview clip from another provider instead. The app never
> stores, caches, downloads or redistributes Spotify audio.

**How does your app use the Spotify Platform?** (wees hier precies — dit is wat ze checken)
> - Authorization Code with PKCE login, entirely client-side. Access and refresh tokens
>   are kept in the browser's localStorage and are never sent to or stored on our server.
> - Scopes used: `streaming`, `user-read-playback-state`, `user-modify-playback-state`,
>   `user-read-email`.
> - Web Playback SDK (`sdk.scdn.co/spotify-player.js`) creates a player device named
>   "HITLIJN" in the player's own browser.
> - Web API endpoints: `PUT /me/player/play` (start the round's track),
>   `PUT /me/player/pause` (stop it), `GET /me/player` (show which device is playing),
>   `GET /me/player/devices` (pick the phone when no device is active).
> - Offline, at build time only: `GET /v1/search` with client-credentials, purely to map
>   our own song list (artist/title/year) to Spotify track IDs. No user data involved.

**Is your app commercial?**
> No. It is a hobby project for a private group of friends, free of charge, with no ads,
> no payments, no monetisation of any kind.

**Expected number of users**
> Tens of users (friends and family). No public marketing; people join via a room code
> or a shared link.

**Do you store Spotify content or user data?**
> No user data is stored. Tokens stay in the player's own browser. On the server we keep
> only the Spotify track ID of the currently playing round in memory, which is discarded
> as soon as the round ends. Nothing is written to disk, and no audio is ever downloaded.

**Which platforms?**
> Web (mobile browsers and desktop browsers). https://hitlijn.nl

## Waar je op moet letten

- De review kan vragen stellen of om aanvullend beeldmateriaal vragen; reken op enkele
  werkdagen wachttijd.
- Zolang de aanvraag loopt, blijft de allowlist gelden: vrienden mét Premium die mee
  willen doen, moeten in *User Management* met hun Spotify-e-mailadres worden toegevoegd.
- Wordt de aanvraag afgewezen, dan blijft het spel gewoon werken: iedereen speelt dan
  met de preview-clips, en de "eerlijke rondes"-regel schakelt de hele kamer automatisch
  naar previews zodra één speler geen Spotify-toegang heeft.

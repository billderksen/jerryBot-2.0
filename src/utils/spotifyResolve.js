// src/utils/spotifyResolve.js
// Spotify as a metadata/search source: URL parsing, client-credentials catalog access, and
// Spotify -> YouTube matching. Audio always plays through the existing YouTube pipeline —
// this module only ever resolves *which* YouTube video to play.
import { fetch } from 'undici';
import { similarity, normalizeField } from './plaatjeText.js';

const SPOTIFY_ACCOUNTS_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// --- URL parsing (pure) ------------------------------------------------------

// Recognizes open.spotify.com track/playlist/album links, with or without a locale segment
// (`/intl-nl/track/ID`) and with or without a trailing `?si=...` share token. Anything else,
// including spotify.com URLs that aren't open.spotify.com, returns null.
export function parseSpotifyUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  // spotify:track:ID style URIs
  const uriMatch = url.trim().match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)$/);
  if (uriMatch) return { type: uriMatch[1], id: uriMatch[2] };

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'open.spotify.com') return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  // Drop a locale prefix like "intl-nl" if present
  const parts = segments[0] && /^intl-[a-z]{2}$/i.test(segments[0]) ? segments.slice(1) : segments;
  const [type, id] = parts;
  if (!['track', 'playlist', 'album'].includes(type) || !id) return null;
  return { type, id };
}

// --- Normalization (pure) ----------------------------------------------------

// API-shape Spotify track -> the flat shape the rest of the music player uses.
export function normalizeTrack(apiTrack) {
  const track = apiTrack ?? {};
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const artist = artists.map((a) => a?.name).filter(Boolean).join(', ');
  const images = Array.isArray(track.album?.images) ? track.album.images : [];
  const thumbnail = images.length
    ? images.reduce((best, img) => ((img?.width ?? 0) > (best?.width ?? 0) ? img : best), images[0])?.url ?? null
    : null;

  return {
    title: track.name ?? '',
    artist,
    durationSec: Math.round((track.duration_ms ?? 0) / 1000),
    thumbnail,
    spotifyUrl: track.external_urls?.spotify ?? null
  };
}

// --- YouTube candidate scoring (pure) ----------------------------------------

// Streaming titles often carry a " - Remastered YYYY" / " - Live" / " - Single Version" tail
// that normalizeField doesn't strip (it only strips parenthesized content). Scoring the title
// both whole and truncated at the first " - " and taking the max keeps such candidates from
// missing the fuzzy match — same pattern as hitlijn/game.mjs's titelMatch.
function titleVariants(title) {
  const whole = normalizeField(title);
  const truncated = normalizeField(String(title ?? '').split(/\s+-\s+/)[0]);
  return whole === truncated ? [whole] : [whole, truncated];
}

const NEGATIVE_TITLE_MARKERS = ['karaoke', 'cover', 'instrumental', 'reaction', 'nightcore', '8d audio'];
const DURATION_PENALTY_THRESHOLD_SEC = 10;
const DURATION_PENALTY_PER_SEC = 0.02;
const MAX_DURATION_PENALTY = 0.5;

// candidate: a yt-dlp search entry, `{ title, duration, channel? }`.
// track: a normalized track, `{ title, artist, durationSec, ... }`.
// Returns a plain number (higher is better); not clamped, but centers around 0-1.
export function scoreYouTubeCandidate(candidate, track) {
  const candidateTitle = candidate?.title ?? '';
  const wantedFull = normalizeField(`${track?.artist ?? ''} ${track?.title ?? ''}`);
  const wantedTitle = normalizeField(track?.title ?? '');
  const variants = titleVariants(candidateTitle);

  const fullSim = Math.max(...variants.map((v) => similarity(v, wantedFull)));
  const titleSim = Math.max(...variants.map((v) => similarity(v, wantedTitle)));
  // A candidate that matches the bare title well is nearly as good as one that matches
  // "artist title" outright — the artist bonus below covers the rest of that gap.
  let score = Math.max(fullSim, titleSim * 0.9);

  const artistNorm = normalizeField(track?.artist ?? '');
  if (artistNorm) {
    const candidateNorm = normalizeField(candidateTitle);
    const channelNorm = normalizeField(candidate?.channel ?? '');
    if (candidateNorm.includes(artistNorm) || channelNorm.includes(artistNorm)) {
      score += 0.1;
    }
  }

  // Off-target markers (karaoke, cover, ...) only count against a candidate when the wanted
  // title itself doesn't legitimately contain that word. Checked on the raw title, since
  // normalizeField strips the parentheses these usually live in.
  const lowerCandidate = candidateTitle.toLowerCase();
  const lowerWanted = String(track?.title ?? '').toLowerCase();
  if (NEGATIVE_TITLE_MARKERS.some((marker) => lowerCandidate.includes(marker) && !lowerWanted.includes(marker))) {
    score -= 0.35;
  }
  if (String(candidate?.channel ?? '').toLowerCase().includes('karaoke')) {
    score -= 0.2;
  }

  const wantedDuration = track?.durationSec;
  const candidateDuration = candidate?.duration;
  if (typeof wantedDuration === 'number' && wantedDuration > 0
    && typeof candidateDuration === 'number' && candidateDuration > 0) {
    const diff = Math.abs(candidateDuration - wantedDuration);
    if (diff > DURATION_PENALTY_THRESHOLD_SEC) {
      score -= Math.min(MAX_DURATION_PENALTY, DURATION_PENALTY_PER_SEC * diff);
    }
  }

  return score;
}

// --- Spotify Web API (IO) -----------------------------------------------------

let cachedToken = null;
let tokenExpiresAt = 0;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

async function requestSpotifyToken() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env');
  }

  const response = await fetch(`${SPOTIFY_ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

// Client-credentials token, cached module-level with an early-refresh margin.
export async function getSpotifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) {
    return cachedToken;
  }
  return requestSpotifyToken();
}

async function spotifyFetch(pathOrUrl) {
  const token = await getSpotifyToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${SPOTIFY_API_BASE}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Spotify API request failed: ${response.status} ${response.statusText} (${pathOrUrl})`);
  }
  return response.json();
}

export async function getTrack(id) {
  const track = await spotifyFetch(`/tracks/${encodeURIComponent(id)}`);
  return normalizeTrack(track);
}

export async function getPlaylistTracks(id, cap = 100) {
  const tracks = [];
  let next = `/playlists/${encodeURIComponent(id)}/tracks?limit=100&offset=0`;
  while (next && tracks.length < cap) {
    const page = await spotifyFetch(next);
    for (const item of page.items ?? []) {
      const track = item?.track;
      // Local files and removed/unavailable tracks show up as null or id-less entries.
      if (!track || item.is_local || !track.id) continue;
      tracks.push(normalizeTrack(track));
      if (tracks.length >= cap) break;
    }
    next = page.next ?? null;
  }
  return tracks.slice(0, cap);
}

export async function getAlbumTracks(id) {
  // /albums/{id} carries both the album's cover art and its (paginated) track list; the
  // dedicated /albums/{id}/tracks endpoint omits the art entirely, so this saves a request
  // over fetching them separately.
  const album = await spotifyFetch(`/albums/${encodeURIComponent(id)}`);
  const images = Array.isArray(album.images) ? album.images : [];

  let items = album.tracks?.items ?? [];
  let next = album.tracks?.next ?? null;
  while (next) {
    const page = await spotifyFetch(next);
    items = items.concat(page.items ?? []);
    next = page.next ?? null;
  }

  return items
    .filter(Boolean)
    .map((track) => normalizeTrack({ ...track, album: { images } }));
}

export async function searchTracks(query, limit = 8) {
  const data = await spotifyFetch(`/search?type=track&limit=${encodeURIComponent(limit)}&q=${encodeURIComponent(query)}`);
  return (data.tracks?.items ?? []).filter(Boolean).map(normalizeTrack);
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;

// ytDlpExec is injected (the real one lives in src/utils/musicQueue.js) so this module stays
// free of that import and testable with a fake. Returns { url, confidence } for the best of
// an ytsearch3 lookup, or null only when the search itself returns zero entries.
export async function resolveToYouTube(track, ytDlpExec) {
  const query = `ytsearch3:${track?.artist ?? ''} ${track?.title ?? ''}`.trim();
  const results = await ytDlpExec(query, {
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    flatPlaylist: true,
    skipDownload: true
  });

  const entries = results?.entries ?? [];
  if (entries.length === 0) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const entry of entries) {
    const candidate = {
      title: entry.title,
      duration: entry.duration,
      channel: entry.channel || entry.uploader
    };
    const score = scoreYouTubeCandidate(candidate, track);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (bestScore < LOW_CONFIDENCE_THRESHOLD) {
    console.log(`[spotifyResolve] Low confidence match for "${track?.artist ?? ''} - ${track?.title ?? ''}": ${bestScore.toFixed(2)}`);
  }

  const url = best.url || (best.id ? `https://www.youtube.com/watch?v=${best.id}` : null);
  return { url, confidence: bestScore };
}

// --- Bulk resolve + queue (IO, orchestration only) ---------------------------

// Resolves a list of normalized tracks (see normalizeTrack) to YouTube and hands each one to
// `queueTrack` sequentially. ytDlpExec is injected here too, threaded straight through to
// resolveToYouTube — same pattern as that function, so this stays testable with a fake and has
// no dependency on any particular caller's module (the web dashboard's /api/queue/add and the
// /play command both drive it with their own "how do I actually queue a song" callback, rather
// than duplicating this loop).
export async function resolveAndQueueSpotifyTracks(tracks, queueTrack, ytDlpExec) {
  let added = 0;
  let failed = 0;

  for (const track of tracks) {
    try {
      const resolved = await resolveToYouTube(track, ytDlpExec);
      if (!resolved?.url) {
        failed++;
        continue;
      }
      const song = {
        title: `${track.artist} – ${track.title}`,
        artist: track.artist,
        url: resolved.url,
        thumbnail: track.thumbnail,
        duration: track.durationSec,
        spotify: true
      };
      const result = await queueTrack(song);
      if (result && result.success === false) {
        failed++;
      } else {
        added++;
      }
    } catch (error) {
      console.error(`[spotifyResolve] Failed to resolve/queue "${track?.artist ?? ''} - ${track?.title ?? ''}":`, error);
      failed++;
    }
  }

  return { added, failed, total: tracks.length };
}

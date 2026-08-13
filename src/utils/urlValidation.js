// Validation for user-supplied strings that reach yt-dlp as a positional argument.
//
// yt-dlp parses its positional argument as a CLI option if it starts with '-'
// (e.g. '--exec=id', '--load-info-json' → command execution), and otherwise treats
// it as an arbitrary URL to fetch (SSRF). Every value handed to yt-dlp must be
// EITHER a URL that passes isAllowedMediaUrl, OR a `ytsearch<N>:<query>` string
// built from a query sanitized with sanitizeSearchQuery.

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'open.spotify.com'
]);

export function isAllowedMediaUrl(str) {
  if (typeof str !== 'string') return false;

  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase());
}

export function sanitizeSearchQuery(str) {
  const stripped = String(str).replace(/^[\s-]+/, '').trim();
  return stripped.slice(0, 200);
}

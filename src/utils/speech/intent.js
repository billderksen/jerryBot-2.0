// Voice command intent parsing for the Hey Jerry voice assistant.
//
// Two layers:
//   1. fastPathMatch(text) - cheap, offline, anchored Dutch phrase/regex table
//      for the handful of very common short commands (skip, pause, volume, ...).
//      Matches are WHOLE-UTTERANCE only so longer sentences ("waarom stopt de
//      muziek steeds") never accidentally trigger a control command.
//   2. parseIntent(text) - falls back to an OpenRouter LLM call (JSON mode)
//      for anything the fast path doesn't recognize, e.g. "speel <song>",
//      "herinner me over 20 minuten aan de pizza", or free-form questions.
//
// parseIntent() never rejects: any failure (missing key, network, bad JSON,
// malformed shape) resolves to { action: 'unknown', error: <stage> }, since
// callers speak the result back to the user and can't do anything with a
// rejected promise.

import axios from 'axios';
import { getVoiceConfig } from '../openrouter.js';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 10_000;

const VALID_ACTIONS = new Set([
  'play', 'skip', 'pause', 'resume', 'stop', 'volume',
  'nowplaying', 'queue', 'remind', 'ask', 'unknown',
]);

// Whole-utterance exact matches (after normalize()). Keep this table in sync
// with test/intent.test.js's fast-path cases.
const EXACT_PHRASES = {
  'skip': 'skip',
  'volgende': 'skip',
  'volgend nummer': 'skip',

  'pauze': 'pause',
  'pauzeer': 'pause',
  'pauzeren': 'pause',

  'ga door': 'resume',
  'hervat': 'resume',
  'doorgaan': 'resume',
  'resume': 'resume',

  'stop': 'stop',
  'stoppen': 'stop',

  'wat speelt er': 'nowplaying',
  'wat speelt er nu': 'nowplaying',
  'welk nummer is dit': 'nowplaying',
};

// Anchored (whole-utterance) volume patterns. Capture group 1 is the number.
const VOLUME_PATTERNS = [
  /^volume (\d{1,3})$/,
  /^zet (?:het )?volume op (\d{1,3})$/,
];

const SYSTEM_PROMPT = `Je bent de intent-parser voor Jerry, een Nederlandstalige Discord voice-assistant.
Zet de uitspraak van de gebruiker om in EXACT een JSON-object, zonder uitleg, markdown of extra tekst.

Schema (alleen deze velden zijn toegestaan; laat velden weg die niet bij de gekozen action horen):
{
  "action": "play" | "skip" | "pause" | "resume" | "stop" | "volume" | "nowplaying" | "queue" | "remind" | "ask" | "unknown",
  "query": string,     // alleen bij "play": de liednaam/artiest die gevraagd is, zonder opdracht-woorden
  "volume": number,    // alleen bij "volume": geheel getal 0-100
  "minutes": number,   // alleen bij "remind": geheel getal 1-1440, hoeveel minuten vanaf nu
  "message": string,   // alleen bij "remind": waar de herinnering over gaat
  "question": string   // alleen bij "ask": de vraag van de gebruiker
}

Regels:
- Kies precies een "action".
- "play": gebruiker wil muziek afspelen of aan de wachtrij toevoegen ("speel ...", "zet ... op", "voeg ... toe aan de wachtrij/queue"). "query" is alleen de liednaam/artiest.
- "remind": gebruiker wil een herinnering ("herinner me over ...", "laat me over ... weten dat ..."). Reken de tijdsduur om naar minuten, ook als die met woorden geschreven is (bv. "twintig minuten" = 20).
- "ask": gebruiker stelt een DUIDELIJKE vraag (kennis, feiten, uitleg) die niets met muziekbediening of herinneringen te maken heeft. Gebruik "ask" alleen als het overduidelijk een vraag is.
- "skip" / "pause" / "resume" / "stop" / "nowplaying" / "queue" / "volume": muziekbediening die niet al door snelkoppelingen is afgehandeld.
- "unknown": alles wat niet duidelijk in een van bovenstaande categorieen past (onzin, ruis, opmerkingen zonder duidelijke opdracht). Kies bij twijfel "unknown", niet "ask".

Voorbeelden:
Gebruiker: "speel beat it van michael jackson"
{"action": "play", "query": "beat it van michael jackson"}

Gebruiker: "zet bohemian rhapsody in de wachtrij"
{"action": "play", "query": "bohemian rhapsody"}

Gebruiker: "herinner me over 20 minuten aan de pizza"
{"action": "remind", "minutes": 20, "message": "de pizza"}

Gebruiker: "hoe hoog is de eiffeltoren"
{"action": "ask", "question": "hoe hoog is de eiffeltoren"}

Gebruiker: "blablabla onzin"
{"action": "unknown"}

Antwoord ALLEEN met het JSON-object.`;

/**
 * Lowercase, trim, strip punctuation and diacritics so fast-path matching is
 * tolerant of casing, trailing punctuation, and accented input.
 */
function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/[.,!?;:'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cheap, offline, whole-utterance intent match for common short commands.
 * Returns null when nothing matches (including "matched the shape but the
 * value was out of range", e.g. "volume 150") so callers fall through to the
 * LLM/unknown path.
 * @param {string} text
 * @returns {{action: string, volume?: number}|null}
 */
export function fastPathMatch(text) {
  if (typeof text !== 'string') return null;
  const normalized = normalize(text);
  if (!normalized) return null;

  if (EXACT_PHRASES[normalized]) {
    return { action: EXACT_PHRASES[normalized] };
  }

  for (const pattern of VOLUME_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      const volume = parseInt(match[1], 10);
      if (volume >= 0 && volume <= 100) {
        return { action: 'volume', volume };
      }
      return null; // recognized the shape but out of range - not a fast-path match
    }
  }

  return null;
}

function coerceString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function coerceInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/**
 * Normalizes an arbitrary object (typically LLM JSON output) into a valid
 * intent, or { action: 'unknown' } if it doesn't fit the schema.
 * @param {*} obj
 * @returns {{action: string, query?: string, volume?: number, minutes?: number, message?: string, question?: string}}
 */
export function validateIntent(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { action: 'unknown' };
  }

  const action = obj.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.has(action)) {
    return { action: 'unknown' };
  }

  switch (action) {
    case 'play': {
      const query = coerceString(obj.query);
      if (!query) return { action: 'unknown' };
      return { action: 'play', query };
    }
    case 'volume': {
      const volume = coerceInt(obj.volume);
      if (volume === null || volume < 0 || volume > 100) return { action: 'unknown' };
      return { action: 'volume', volume };
    }
    case 'remind': {
      const minutes = coerceInt(obj.minutes);
      const message = coerceString(obj.message);
      if (minutes === null || minutes < 1 || minutes > 1440 || !message) {
        return { action: 'unknown' };
      }
      return { action: 'remind', minutes, message };
    }
    case 'ask': {
      const question = coerceString(obj.question);
      if (!question) return { action: 'unknown' };
      return { action: 'ask', question };
    }
    case 'skip':
    case 'pause':
    case 'resume':
    case 'stop':
    case 'nowplaying':
    case 'queue':
    case 'unknown':
      return { action };
    default:
      return { action: 'unknown' };
  }
}

/**
 * Parses a transcript into an intent: fast path first, then an OpenRouter
 * LLM call (JSON mode) as fallback. Never rejects - any failure resolves to
 * { action: 'unknown', error: <stage> } where stage is one of
 * 'config' | 'network' | 'api' | 'empty' | 'parse'.
 * @param {string} text
 * @returns {Promise<{action: string, [key: string]: *}>}
 */
export async function parseIntent(text) {
  const fastMatch = fastPathMatch(text);
  if (fastMatch) return fastMatch;

  // Read lazily so this module can be imported before loadEnv.js populates
  // process.env (import order must not matter) - matches transcribe.js.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { action: 'unknown', error: 'config' };
  }

  const { model, maxTokens } = getVoiceConfig();

  let response;
  try {
    response = await axios.post(
      OPENROUTER_API_URL,
      {
        model,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: String(text ?? '') },
        ],
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/billderksen/jerryBot-2.0',
          'X-Title': 'JerryBot Voice Assistant',
        },
      }
    );
  } catch (err) {
    return { action: 'unknown', error: err.response ? 'api' : 'network' };
  }

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    return { action: 'unknown', error: 'empty' };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { action: 'unknown', error: 'parse' };
  }

  return validateIntent(parsed);
}

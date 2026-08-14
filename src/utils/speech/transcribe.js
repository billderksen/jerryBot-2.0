// Speech-to-text via the Groq-hosted Whisper API. Wraps raw mono 16-bit PCM
// (e.g. from the wakeword/voice capture pipeline) in a WAV header and POSTs
// it as multipart/form-data using Node's built-in fetch/FormData/Blob — no
// npm dependency needed.

import { buildWavHeader } from '../voiceRecorder.js';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Sent as the `prompt` form field: Whisper conditions its decoding on it, which
 * biases the output towards this vocabulary. It is a style/context hint, not an
 * instruction - so it is written as a Dutch phrase list of the words this bot
 * actually hears, in the language of the audio (Groq caps it at 224 tokens).
 *
 * Live testing found short commands landing on same-sounding non-words ("pauze"
 * -> "maalige"); the words below are exactly the ones that were being missed.
 */
export const DEFAULT_TRANSCRIBE_PROMPT =
  "Nederlandse spraakcommando's voor een Discord muziekbot: hey Jerry, pauze, pauzeer, "
  + 'hervat, ga verder, overslaan, sla over, skip, stop, volume, speel, muziek, nummer, '
  + 'wachtrij, herinner me, hoe, wat, waarom.';

// Whisper decodes a very short clip far less reliably than a padded one - a
// single word arrives as an unrecognizable fragment, and the decoder fills the
// gap with whatever its language model likes ("pauze" -> "oh, is het"). Trailing
// silence costs one 30s-window API call either way, so anything under
// MIN_UNPADDED_MS is stretched to PAD_TARGET_MS of silence-padded audio.
const MIN_UNPADDED_MS = 1200;
const PAD_TARGET_MS = 1500;

/**
 * Error raised by transcribe(). `.stage` identifies where it failed:
 *   'network' - the request to Groq never got a response (DNS, timeout, etc.)
 *   'api'     - Groq responded with a non-2xx status
 *   'empty'   - Groq responded successfully but returned no usable transcript
 */
export class TranscribeError extends Error {
  constructor(message, stage, options) {
    super(message, options);
    this.name = 'TranscribeError';
    this.stage = stage;
  }
}

/**
 * Pads a short clip with trailing silence so Whisper has something to decode
 * around a single spoken word. Clips at or above MIN_UNPADDED_MS are returned
 * untouched (same Buffer instance, no copy).
 * @param {Buffer} pcmBuffer - raw mono 16-bit little-endian PCM samples.
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function padShortClip(pcmBuffer, sampleRate = 16000) {
  const bytesPerMs = (sampleRate * 2) / 1000; // mono, 16-bit
  if (pcmBuffer.length >= MIN_UNPADDED_MS * bytesPerMs) return pcmBuffer;
  const targetBytes = Math.round(PAD_TARGET_MS * bytesPerMs);
  return Buffer.concat([pcmBuffer, Buffer.alloc(targetBytes - pcmBuffer.length)]);
}

/**
 * Transcribes mono 16-bit PCM audio via Groq's hosted Whisper API.
 * @param {Buffer} pcmBuffer - raw mono 16-bit little-endian PCM samples (no header).
 * @param {{ sampleRate?: number, language?: string, prompt?: string|null }} [options]
 *   `prompt` defaults to DEFAULT_TRANSCRIBE_PROMPT; pass null/'' to send none.
 * @returns {Promise<string>} the trimmed transcript text.
 * @throws {TranscribeError}
 */
export async function transcribe(
  pcmBuffer,
  { sampleRate = 16000, language = 'nl', prompt = DEFAULT_TRANSCRIBE_PROMPT } = {},
) {
  // Read lazily so this module can be imported before loadEnv.js populates
  // process.env (import order must not matter).
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new TranscribeError('GROQ_API_KEY is not set', 'api');
  }

  const pcm = padShortClip(pcmBuffer, sampleRate);
  const wavHeader = buildWavHeader(pcm.length, { sampleRate, channels: 1, bitsPerSample: 16 });
  const wavBuffer = Buffer.concat([wavHeader, pcm]);

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', GROQ_MODEL);
  form.append('language', language);
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);

  let response;
  try {
    response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TranscribeError(`Groq request failed: ${err.message}`, 'network', { cause: err });
  }

  if (!response.ok) {
    const bodySnippet = await response.text().catch(() => '').then((text) => text.slice(0, 500));
    throw new TranscribeError(
      `Groq transcription API returned ${response.status}: ${bodySnippet}`,
      'api',
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new TranscribeError(`Failed to parse Groq response: ${err.message}`, 'network', { cause: err });
  }

  const transcript = (data?.text ?? '').trim();
  if (!transcript) {
    throw new TranscribeError('Groq returned an empty transcript', 'empty');
  }

  return transcript;
}

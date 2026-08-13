// Speech-to-text via the Groq-hosted Whisper API. Wraps raw mono 16-bit PCM
// (e.g. from the wakeword/voice capture pipeline) in a WAV header and POSTs
// it as multipart/form-data using Node's built-in fetch/FormData/Blob — no
// npm dependency needed.

import { buildWavHeader } from '../voiceRecorder.js';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
const REQUEST_TIMEOUT_MS = 10_000;

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
 * Transcribes mono 16-bit PCM audio via Groq's hosted Whisper API.
 * @param {Buffer} pcmBuffer - raw mono 16-bit little-endian PCM samples (no header).
 * @param {{ sampleRate?: number, language?: string }} [options]
 * @returns {Promise<string>} the trimmed transcript text.
 * @throws {TranscribeError}
 */
export async function transcribe(pcmBuffer, { sampleRate = 16000, language = 'nl' } = {}) {
  // Read lazily so this module can be imported before loadEnv.js populates
  // process.env (import order must not matter).
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new TranscribeError('GROQ_API_KEY is not set', 'api');
  }

  const wavHeader = buildWavHeader(pcmBuffer.length, { sampleRate, channels: 1, bitsPerSample: 16 });
  const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', GROQ_MODEL);
  form.append('language', language);
  form.append('response_format', 'json');

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

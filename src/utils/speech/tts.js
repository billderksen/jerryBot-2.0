// Text-to-speech for the "Hey Jerry" voice assistant.
//
// Speech is synthesized locally by Piper (tools/piper/piper plus the Dutch voice
// fetched by scripts/setup-voice.sh) into a wav in a temp directory, then played
// into the bot's voice channel through musicQueue's duckAndPlay(), which pauses
// the music for the length of the clip and puts it back afterwards.
//
// Nothing here rejects: a missing Piper install, a synthesis failure or a bot
// that isn't in a voice channel resolves to `false` with a log line. Callers are
// voice-command handlers reacting to something a user said out loud - there is
// no error they could usefully surface, and a rejected promise would just become
// an unhandled rejection somewhere up the pipeline.
//
// Clips are serialized per guild: two overlapping clips on one connection would
// fight over the same subscription, so the second waits for the first. Beyond
// MAX_PENDING_CLIPS queued clips the guild is clearly backed up and further ones
// are dropped rather than played minutes late.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAudioResource } from '@discordjs/voice';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const PIPER_BIN = path.join(PROJECT_ROOT, 'tools', 'piper', 'piper');
const PIPER_VOICE = path.join(PROJECT_ROOT, 'tools', 'piper', 'nl_voice.onnx');
const PIPER_VOICE_CONFIG = `${PIPER_VOICE}.json`;

/** The wake-acknowledgement blip, played when the wake word is detected. */
export const BEEP_PATH = path.join(PROJECT_ROOT, 'assets', 'beep.wav');

/** Where synthesized wavs live until they're played (and swept, see GC_MAX_AGE_MS). */
export const TTS_TMP_DIR = path.join(tmpdir(), 'jerrybot-tts');

const SYNTH_TIMEOUT_MS = 10_000;
const GC_MAX_AGE_MS = 5 * 60 * 1000;
// Piper runs at roughly 10x realtime here, so this stays well inside the timeout
// while still allowing ~45 seconds of speech for a spoken answer.
const MAX_TEXT_CHARS = 600;
const MAX_PENDING_CLIPS = 3;

/** True when Piper and its voice model are installed (scripts/setup-voice.sh). */
export function isTtsAvailable() {
  return existsSync(PIPER_BIN) && existsSync(PIPER_VOICE) && existsSync(PIPER_VOICE_CONFIG);
}

// Delete leftover wavs from earlier runs. Best-effort: a file that vanished
// underneath us (or a permission problem) must not fail the synthesis.
function sweepTmpDir() {
  let entries;
  try {
    entries = readdirSync(TTS_TMP_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - GC_MAX_AGE_MS;
  for (const entry of entries) {
    const filePath = path.join(TTS_TMP_DIR, entry);
    try {
      if (statSync(filePath).mtimeMs < cutoff) unlinkSync(filePath);
    } catch {
      // Already gone, or not ours to delete
    }
  }
}

/**
 * Synthesizes Dutch speech with Piper.
 * @param {string} text - what Jerry should say; trimmed, and capped at MAX_TEXT_CHARS.
 * @returns {Promise<string>} path to a mono 22050Hz wav in TTS_TMP_DIR. The caller
 *   owns the file and should delete it once played; anything left behind is swept
 *   by the next call.
 * @throws if the text is blank, Piper is missing, exits non-zero, or takes longer
 *   than SYNTH_TIMEOUT_MS (the child is killed in that case).
 */
export function synthesize(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return Promise.reject(new Error('synthesize requires non-empty text'));
  }
  if (!isTtsAvailable()) {
    return Promise.reject(new Error(`Piper is not installed at ${PIPER_BIN} (run scripts/setup-voice.sh)`));
  }

  const spoken = trimmed.slice(0, MAX_TEXT_CHARS);
  if (spoken.length < trimmed.length) {
    console.warn(`[TTS] Text truncated from ${trimmed.length} to ${MAX_TEXT_CHARS} characters`);
  }

  mkdirSync(TTS_TMP_DIR, { recursive: true });
  sweepTmpDir();

  const outPath = path.join(TTS_TMP_DIR, `tts-${Date.now()}-${randomUUID().slice(0, 8)}.wav`);

  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, [
      '--model', PIPER_VOICE,
      '--config', PIPER_VOICE_CONFIG,
      '--output_file', outPath,
      '--quiet',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let settled = false;
    let stderr = '';
    let timedOut = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try { unlinkSync(outPath); } catch { /* nothing was written */ }
        reject(err);
      } else {
        resolve(outPath);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      finish(new Error(`Piper timed out after ${SYNTH_TIMEOUT_MS}ms`));
    }, SYNTH_TIMEOUT_MS);

    // Writing to a child that already died raises EPIPE on the stream itself;
    // without a listener that throws process-wide instead of failing this call.
    child.stdin.on('error', (err) => finish(new Error(`Piper stdin failed: ${err.message}`)));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => finish(new Error(`Failed to spawn Piper: ${err.message}`)));
    child.on('close', (code) => {
      if (timedOut) return;
      if (code !== 0) {
        finish(new Error(`Piper exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
      } else if (!existsSync(outPath)) {
        finish(new Error('Piper exited cleanly but wrote no audio'));
      } else {
        finish(null);
      }
    });

    child.stdin.end(`${spoken}\n`);
  });
}

// One promise chain per guild, so clips never overlap on a connection.
// `pending` counts the running clip plus everything queued behind it.
const speechChains = new Map();

/**
 * Runs `job` after every clip already queued for this guild. Exported for tests.
 * @returns {Promise<*>} the job's result, or `false` if it was dropped or threw.
 */
export function enqueueSpeechJob(guildId, label, job) {
  const chain = speechChains.get(guildId) ?? { promise: Promise.resolve(), pending: 0 };
  speechChains.set(guildId, chain);

  if (chain.pending >= MAX_PENDING_CLIPS) {
    console.warn(`[TTS] Dropping "${label}" for guild ${guildId}: ${chain.pending} clips already pending`);
    return Promise.resolve(false);
  }

  chain.pending += 1;
  const result = chain.promise.then(job).catch((err) => {
    console.error(`[TTS] "${label}" failed for guild ${guildId}:`, err.message);
    return false;
  }).finally(() => {
    chain.pending -= 1;
    // Drop the entry once drained so idle guilds don't accumulate chains
    if (chain.pending === 0 && speechChains.get(guildId) === chain) {
      speechChains.delete(guildId);
    }
  });

  chain.promise = result;
  return result;
}

// musicQueue.js probes yt-dlp/ffmpeg and reads the stats files at import time, so
// it's pulled in only when a clip is actually played. index.js has already loaded
// it by then, making this a cache hit.
async function duckAndPlayClip(guildId, resourceFactory) {
  const { duckAndPlay } = await import('../musicQueue.js');
  return duckAndPlay(guildId, resourceFactory);
}

/**
 * Says something in the guild's voice channel, ducking the music for the clip.
 * @returns {Promise<boolean>} whether the clip was played.
 */
export function speak(guildId, text) {
  if (!isTtsAvailable()) {
    console.warn(`[TTS] Piper not installed, cannot speak in guild ${guildId}`);
    return Promise.resolve(false);
  }

  return enqueueSpeechJob(guildId, 'speak', async () => {
    const wavPath = await synthesize(text);
    try {
      return await duckAndPlayClip(guildId, () => createAudioResource(wavPath));
    } finally {
      try { unlinkSync(wavPath); } catch { /* swept later */ }
    }
  });
}

/**
 * Plays the short wake-acknowledgement beep, ducking the music for it.
 * @returns {Promise<boolean>} whether the clip was played.
 */
export function playBeep(guildId) {
  if (!existsSync(BEEP_PATH)) {
    console.warn(`[TTS] Beep asset missing at ${BEEP_PATH}`);
    return Promise.resolve(false);
  }

  return enqueueSpeechJob(guildId, 'beep', () =>
    duckAndPlayClip(guildId, () => createAudioResource(BEEP_PATH)));
}

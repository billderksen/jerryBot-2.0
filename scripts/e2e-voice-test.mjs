#!/usr/bin/env node
// End-to-end closed-loop diagnostic for the "Hey Jerry" voice pipeline
// (.superpowers/sdd/2026-08-13-hey-jerry/task-7-brief.md). Drives every real
// pipeline module directly - no Discord, no human in the loop:
//
//   STAGE 1  wake detection    - real sidecar via WakewordEngine
//   STAGE 2  speech-to-text    - real Groq Whisper call via transcribe()
//   STAGE 3  intent parsing    - real OpenRouter call via parseIntent()
//   STAGE 4  intent-on-transcript (bonus) - full wake->STT->intent chain
//   STAGE 5  text-to-speech    - real Piper call via synthesize()
//
// Run: node scripts/e2e-voice-test.mjs
// Exit code 0 only if every HARD stage (1, 2, 3, 5) PASSes. Stage 4 is
// informational (PASS/DATA only, never FAIL) and never affects the exit code.
//
// Why the layering: Task 2 found the pretrained hey_jarvis model triggers
// reliably on an English Piper voice but not on the bot's Dutch voice
// (score ~0.95 vs ~5e-5), so stage 1 synthesizes the wake phrase in English.
// Task 3 found the Dutch voice garbles Whisper transcripts of English proper
// nouns embedded in a Dutch sentence (and occasionally pure Dutch too) - a
// synthetic-TTS-quality confound, not a pipeline bug. So stage 2 uses a
// pure-Dutch phrase and grades on "did transcription work at all", stage 3
// grades intent parsing against the canonical (ground-truth) text so a bad
// transcript can't fail it, and stage 4 separately reports whether the
// actual stage-2 transcript also happened to route correctly - a bonus
// signal about the full chain, not a hard requirement.
//
// Every precondition (tools/ missing, no GROQ/OPENROUTER key, no network for
// the English voice download) is checked per stage and reported as SKIP with
// a clear reason rather than throwing, so this stays a useful diagnostic on
// a box that isn't fully provisioned.

import '../src/loadEnv.js';

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WakewordEngine } from '../src/utils/speech/wakeword.js';
import { transcribe } from '../src/utils/speech/transcribe.js';
import { parseIntent } from '../src/utils/speech/intent.js';
import { synthesize, isTtsAvailable } from '../src/utils/speech/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PIPER_BIN = path.join(PROJECT_ROOT, 'tools', 'piper', 'piper');
const NL_VOICE = path.join(PROJECT_ROOT, 'tools', 'piper', 'nl_voice.onnx');
const NL_VOICE_CONFIG = `${NL_VOICE}.json`;

// English Piper voice for the wake phrase only (see header comment). Not one
// of setup-voice.sh's assets, so this script fetches+caches its own copy
// under the OS tmp dir on first run - never into tools/, never committed -
// so the diagnostic stays runnable anywhere without touching repo assets.
const EN_VOICE_CACHE_DIR = path.join(tmpdir(), 'jerrybot-e2e-en-voice');
const EN_VOICE = path.join(EN_VOICE_CACHE_DIR, 'en_US-lessac-medium.onnx');
const EN_VOICE_CONFIG = `${EN_VOICE}.json`;
const EN_VOICE_BASE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium';

const WORK_DIR = path.join(tmpdir(), 'jerrybot-e2e-voice-test');

const PURE_DUTCH_PHRASE = 'herinner me over twintig minuten aan de pizza';
const CANONICAL_PLAY_TEXT = 'speel beat it van michael jackson';
const CONFIRMATION_TEXT = 'Oké, ik speel Beat It van Michael Jackson.';

const WAKEWORD_THRESHOLD_ENV = process.env.WAKEWORD_THRESHOLD !== undefined
  ? Number(process.env.WAKEWORD_THRESHOLD)
  : undefined;

// Thrown by a stage to mean "environment doesn't support this check" rather
// than "the pipeline is broken" - reported as SKIP, never counts as a FAIL.
class StageSkip extends Error {
  constructor(message) {
    super(message);
    this.name = 'StageSkip';
  }
}

function requirePiperOrSkip() {
  if (!existsSync(PIPER_BIN)) {
    throw new StageSkip(`Piper binary not found at ${PIPER_BIN} (run scripts/setup-voice.sh)`);
  }
}

// ---------------------------------------------------------------------------
// Process helpers (spawn Piper with an arbitrary voice, ffmpeg, ffprobe)
// ---------------------------------------------------------------------------

function synthWithVoice(voiceModel, voiceConfig, text, outPath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, [
      '--model', voiceModel,
      '--config', voiceConfig,
      '--output_file', outPath,
      '--quiet',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let settled = false;
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`piper timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(outPath);
    };

    child.stdin.on('error', (err) => finish(new Error(`piper stdin failed: ${err.message}`)));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => finish(new Error(`failed to spawn piper: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`piper exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
      else if (!existsSync(outPath)) finish(new Error('piper exited cleanly but wrote no audio'));
      else finish(null);
    });

    child.stdin.end(`${text}\n`);
  });
}

function convertTo16kMonoRaw(wavPath, rawPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-i', wavPath, '-ar', '16000', '-ac', '1', '-f', 's16le', rawPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(new Error(`failed to spawn ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
      else resolve(rawPath);
    });
  });
}

function ffprobeInfo(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=sample_rate,channels:format=duration',
      '-of', 'json',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => reject(new Error(`failed to spawn ffprobe: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0] ?? {};
        resolve({
          sampleRate: Number(stream.sample_rate) || null,
          channels: Number(stream.channels) || null,
          duration: Number(data.format?.duration) || 0,
        });
      } catch (err) {
        reject(new Error(`failed to parse ffprobe output: ${err.message}`));
      }
    });
  });
}

function rawPcmToInt16Array(buf) {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const partPath = `${destPath}.part`;
  writeFileSync(partPath, buf);
  renameSync(partPath, destPath);
}

async function ensureEnglishVoiceOrSkip() {
  try {
    mkdirSync(EN_VOICE_CACHE_DIR, { recursive: true });
    if (existsSync(EN_VOICE) && existsSync(EN_VOICE_CONFIG)) return;
    console.log(`  (downloading English Piper voice to ${EN_VOICE_CACHE_DIR} - one-time, ~60MB)`);
    await downloadFile(`${EN_VOICE_BASE_URL}/en_US-lessac-medium.onnx`, EN_VOICE);
    await downloadFile(`${EN_VOICE_BASE_URL}/en_US-lessac-medium.onnx.json`, EN_VOICE_CONFIG);
  } catch (err) {
    throw new StageSkip(`could not obtain the English Piper voice for the wake phrase (${err.message})`);
  }
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

async function runStage(label, hard, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    return { label, hard, status: result.status ?? 'PASS', ms: Date.now() - startedAt, detail: result.detail ?? '' };
  } catch (err) {
    const ms = Date.now() - startedAt;
    if (err instanceof StageSkip) {
      return { label, hard, status: 'SKIP', ms, detail: err.message };
    }
    const detail = err.stage ? `[${err.stage}] ${err.message}` : err.message;
    return { label, hard, status: 'FAIL', ms, detail };
  }
}

// Filled in by stage 2, consumed by stage 3/4 - the actual (possibly garbled)
// transcript that real STT produced, kept separate from the canonical text
// stage 3 is graded against.
let stage2Transcript = null;
let stage4TranscriptIntent = null;

// ---------------------------------------------------------------------------
// STAGE 1 - wake detection
// ---------------------------------------------------------------------------

function tryWakeDetection(padded, threshold) {
  const BOOT_DELAY_MS = 1500;
  const DETECT_TIMEOUT_MS = 8000;

  return new Promise((resolve, reject) => {
    const engine = new WakewordEngine({ threshold });
    let settled = false;
    let feedStartedAt = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      engine.stop();
      if (err) reject(err);
      else resolve(result);
    };

    const overallTimer = setTimeout(() => {
      finish(new Error(`no wake detection within ${DETECT_TIMEOUT_MS}ms of feeding audio (threshold ${threshold})`));
    }, BOOT_DELAY_MS + DETECT_TIMEOUT_MS);

    engine.on('wake', ({ slot, score }) => {
      const detectedMs = feedStartedAt !== null ? Date.now() - feedStartedAt : null;
      finish(null, { slot, score, detectedMs });
    });

    engine.start();

    setTimeout(() => {
      feedStartedAt = Date.now();
      const CHUNK = 3200; // arbitrary size (not 1280-aligned) to exercise internal buffering
      let offset = 0;
      const feedNext = () => {
        if (settled) return;
        if (offset >= padded.length) {
          engine.releaseSlot(0);
          return;
        }
        engine.feedAudio(0, padded.subarray(offset, offset + CHUNK));
        offset += CHUNK;
        setTimeout(feedNext, 5);
      };
      feedNext();
    }, BOOT_DELAY_MS);
  });
}

async function stage1_wake() {
  if (!WakewordEngine.isAvailable()) {
    throw new StageSkip('wake-word sidecar not available (python venv or model missing under tools/ - run scripts/setup-voice.sh)');
  }
  requirePiperOrSkip();
  await ensureEnglishVoiceOrSkip();

  const wavPath = path.join(WORK_DIR, 'stage1-wake-en.wav');
  const rawPath = path.join(WORK_DIR, 'stage1-wake-en-16k.raw');
  try {
    await synthWithVoice(EN_VOICE, EN_VOICE_CONFIG, 'hey jarvis', wavPath);
    await convertTo16kMonoRaw(wavPath, rawPath);

    const speechSamples = rawPcmToInt16Array(readFileSync(rawPath));
    const lead = new Int16Array(16000 * 1.0); // 1s lead silence
    const trail = new Int16Array(16000 * 2.0); // 2s trail silence
    const padded = new Int16Array(lead.length + speechSamples.length + trail.length);
    padded.set(lead, 0);
    padded.set(speechSamples, lead.length);
    padded.set(trail, lead.length + speechSamples.length);

    // Default threshold (0.5) is what Task 2's closed-loop smoke confirmed
    // reliable (scores 0.9496 / 0.8627) - try it first; only fall back to a
    // lower threshold if this box's audio path needs it. An explicit
    // WAKEWORD_THRESHOLD env var pins a single value instead.
    const thresholds = WAKEWORD_THRESHOLD_ENV !== undefined ? [WAKEWORD_THRESHOLD_ENV] : [0.5, 0.3];

    let lastError = null;
    for (const threshold of thresholds) {
      try {
        const { slot, score, detectedMs } = await tryWakeDetection(padded, threshold);
        return {
          status: 'PASS',
          detail: `slot=${slot} score=${score.toFixed(4)} threshold=${threshold}${detectedMs !== null ? ` detected +${detectedMs}ms after feed started` : ''}`,
        };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error('wake detection failed for an unknown reason');
  } finally {
    try { unlinkSync(wavPath); } catch { /* nothing to clean up */ }
    try { unlinkSync(rawPath); } catch { /* nothing to clean up */ }
  }
}

// ---------------------------------------------------------------------------
// STAGE 2 - speech-to-text
// ---------------------------------------------------------------------------

async function stage2_stt() {
  requirePiperOrSkip();
  if (!existsSync(NL_VOICE) || !existsSync(NL_VOICE_CONFIG)) {
    throw new StageSkip('Dutch Piper voice not found under tools/piper (run scripts/setup-voice.sh)');
  }
  if (!process.env.GROQ_API_KEY) {
    throw new StageSkip('GROQ_API_KEY is not set');
  }

  const wavPath = await synthesize(PURE_DUTCH_PHRASE); // real tts.js module, Dutch voice
  const rawPath = path.join(WORK_DIR, 'stage2-stt-nl-16k.raw');
  try {
    await convertTo16kMonoRaw(wavPath, rawPath);
    const pcm = readFileSync(rawPath);
    const transcript = await transcribe(pcm, { sampleRate: 16000, language: 'nl' }); // real Groq call
    stage2Transcript = transcript;
    // Reaching here already proves non-empty: transcribe() throws a stage
    // 'empty' TranscribeError otherwise. Accuracy against PURE_DUTCH_PHRASE
    // is recorded as data (printed verbatim), not scored - synthetic-voice
    // quality is a known confound (Task 3 finding), not what this asserts.
    return {
      status: 'PASS',
      detail: `expected: "${PURE_DUTCH_PHRASE}" | got: "${transcript}"`,
    };
  } finally {
    try { unlinkSync(wavPath); } catch { /* swept by tts.js's own GC anyway */ }
    try { unlinkSync(rawPath); } catch { /* nothing to clean up */ }
  }
}

// ---------------------------------------------------------------------------
// STAGE 3 - intent parsing (decoupled from STT quality)
// ---------------------------------------------------------------------------

async function stage3_intent() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new StageSkip('OPENROUTER_API_KEY is not set');
  }

  const canonicalResult = await parseIntent(CANONICAL_PLAY_TEXT); // real OpenRouter call
  const canonicalPass = canonicalResult.action === 'play'
    && typeof canonicalResult.query === 'string'
    && canonicalResult.query.toLowerCase().includes('beat it');

  const detailParts = [`canonical "${CANONICAL_PLAY_TEXT}" -> ${JSON.stringify(canonicalResult)}`];

  if (stage2Transcript) {
    // Data only: whatever stage 2 actually transcribed, routed through the
    // real parser too, but its outcome does NOT gate stage 3's pass/fail.
    stage4TranscriptIntent = await parseIntent(stage2Transcript);
    detailParts.push(`stage-2 transcript "${stage2Transcript}" -> ${JSON.stringify(stage4TranscriptIntent)} (data - see stage 4)`);
  } else {
    detailParts.push('stage 2 produced no transcript to test (skipped/failed above) - no data point for stage 4');
  }

  if (!canonicalPass) {
    throw new Error(`canonical text did not route to action=play with a "beat it" query: ${JSON.stringify(canonicalResult)}`);
  }

  return { status: 'PASS', detail: detailParts.join(' | ') };
}

// ---------------------------------------------------------------------------
// STAGE 4 - intent-on-transcript (bonus: the true full-chain result)
// ---------------------------------------------------------------------------

async function stage4_bonus() {
  if (!stage2Transcript) {
    return { status: 'DATA', detail: 'no stage-2 transcript available to test (stage 2 skipped/failed)' };
  }
  if (!stage4TranscriptIntent) {
    return { status: 'DATA', detail: 'stage 3 did not evaluate the stage-2 transcript (missing OPENROUTER_API_KEY or stage 3 skipped)' };
  }
  const fullChainPass = stage4TranscriptIntent.action === 'remind' && stage4TranscriptIntent.minutes === 20;
  return {
    status: fullChainPass ? 'PASS' : 'DATA',
    detail: fullChainPass
      ? `full chain confirmed: real STT of "${PURE_DUTCH_PHRASE}" -> "${stage2Transcript}" -> ${JSON.stringify(stage4TranscriptIntent)}`
      : `did not route to remind/20min: "${stage2Transcript}" -> ${JSON.stringify(stage4TranscriptIntent)} (synthetic-voice STT accuracy artifact, not a pipeline bug - see Task 3 finding)`,
  };
}

// ---------------------------------------------------------------------------
// STAGE 5 - text-to-speech
// ---------------------------------------------------------------------------

async function stage5_tts() {
  if (!isTtsAvailable()) {
    throw new StageSkip('Piper (Dutch voice) not installed (run scripts/setup-voice.sh)');
  }

  const wavPath = await synthesize(CONFIRMATION_TEXT); // real tts.js module
  try {
    const info = await ffprobeInfo(wavPath);
    if (!info.duration || info.duration <= 0) {
      throw new Error(`ffprobe reported a non-positive duration (${info.duration}s) for ${wavPath}`);
    }
    return {
      status: 'PASS',
      detail: `"${CONFIRMATION_TEXT}" -> ${path.basename(wavPath)}: ${info.sampleRate}Hz, ${info.channels}ch, ${info.duration.toFixed(2)}s (ffprobe-verified)`,
    };
  } finally {
    try { unlinkSync(wavPath); } catch { /* swept by tts.js's own GC anyway */ }
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printResults(results) {
  const width = 100;
  console.log('='.repeat(width));
  console.log(' Hey Jerry - End-to-End Voice Pipeline Diagnostic');
  console.log('='.repeat(width));

  for (const r of results) {
    console.log('');
    console.log(`[${r.status}] ${r.label} (${r.ms}ms)${r.hard ? '' : '  [informational - does not affect exit code]'}`);
    if (r.detail) console.log(`    ${r.detail}`);
  }

  console.log('');
  console.log('-'.repeat(width));
  console.log('Summary');
  console.log('-'.repeat(width));
  const nameWidth = Math.max(...results.map((r) => r.label.length)) + 2;
  for (const r of results) {
    console.log(`${r.label.padEnd(nameWidth)} ${r.status.padEnd(6)} ${String(r.ms).padStart(6)}ms${r.hard ? '' : '  (bonus)'}`);
  }
  console.log('='.repeat(width));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(WORK_DIR, { recursive: true });

  const results = [];
  results.push(await runStage('STAGE 1: Wake detection (English voice, real sidecar)', true, stage1_wake));
  results.push(await runStage('STAGE 2: Speech-to-text (Dutch voice, real Groq Whisper)', true, stage2_stt));
  results.push(await runStage('STAGE 3: Intent parsing (real OpenRouter)', true, stage3_intent));
  results.push(await runStage('STAGE 4: Intent-on-transcript (bonus, full chain)', false, stage4_bonus));
  results.push(await runStage('STAGE 5: Text-to-speech (real Piper, ffprobe-verified)', true, stage5_tts));

  printResults(results);

  const hardFailures = results.filter((r) => r.hard && r.status !== 'PASS');
  console.log('');
  if (hardFailures.length === 0) {
    console.log('RESULT: all hard stages PASSED (exit 0)');
  } else {
    console.log(`RESULT: ${hardFailures.length} hard stage(s) did not pass (exit 1): ${hardFailures.map((r) => r.label).join(', ')}`);
  }
  console.log(`Wake-word threshold: ${WAKEWORD_THRESHOLD_ENV !== undefined ? WAKEWORD_THRESHOLD_ENV : '0.5 (default, with 0.3 fallback if needed)'}`);

  process.exitCode = hardFailures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('[e2e-voice-test] unexpected failure:', err);
  process.exitCode = 1;
});
